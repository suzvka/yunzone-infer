/**
 * 调度器（D9 MVP：整图绑定单端点 / 静态手动分区）
 *
 * 绑定语义（server/DESIGN.md D9 + contracts/DESIGN §3 检视）：
 * - 选端点：全部远程节点意图的 modelKey ∈ 端点模型清单（节点存在性）且
 *   per-model queueRemaining ≥ 1（余量软控制前置）；多端点可服务时取
 *   queueTotalRemaining 最大者（MVP 贪心，打分调度 P3，D9）。
 * - IO 复核：选中端点的 per-model io 声明 × 图节点端口（复用 inspection
 *   端口匹配逻辑——检视「任一端点过即过」，绑定对具体端点复核，防两者间
 *   端点能力视图漂移）。
 * - 互斥 / 环约束：MVP 整图绑定单端点天然满足（跨机拆分不存在）。
 * - 对象键规划：工作流级前缀（键即 URI 语义，签名由控制面派发时进行——
 *   RemoteNodeBinding.outputUri/inputs 为对象键，finalOutputUri/workflowInputs
 *   为已签 URL，双语义规则见 start-workflow-request 契约）。
 *
 * 拒绝 → 入口落 rejected + E_INSPECTION_REJECTED（错误码域无独立绑定拒绝码，
 * 绑定拒绝属静态结构不满足的检视族）。
 */

import type { RemoteNodeBinding } from "./contracts";
import type { EndpointEntry } from "./endpoint-registry";
import { asNodeEntry, portsMismatch, type DcirPortJson } from "./inspection";

/** 远程节点绑定意图（消费者请求体声明，server 检视/绑定校验） */
export interface RemoteNodeIntent {
  nodeId: string;
  modelKey: string;
}

/** 本地图级输入声明（workflowInputs 键规划依据；值不入 JSON——V8） */
export interface LocalInputIntent {
  node: string;
  port: string;
}

export interface BindingInput {
  workflowId: string;
  graph: unknown;
  intents: readonly RemoteNodeIntent[];
  /** registry.listAlive() 能力视图（绑定即消费，防检视后漂移） */
  endpoints: readonly EndpointEntry[];
}

/** 工作流级对象键规划（server 统一规则；对拍脚本按同规则预置输入对象） */
export interface WorkflowObjectKeys {
  remoteInputKey(nodeId: string, port: string): string;
  remoteOutputKey(nodeId: string): string;
  localInputKey(node: string, port: string): string;
  finalKey(): string;
}

export function planObjectKeys(workflowId: string): WorkflowObjectKeys {
  const prefix = `workflows/${workflowId}`;
  return {
    remoteInputKey: (nodeId, port) => `${prefix}/inputs/${nodeId}/${port}`,
    remoteOutputKey: (nodeId) => `${prefix}/nodes/${nodeId}/output`,
    localInputKey: (node, port) => `${prefix}/inputs/${node}/${port}`,
    finalKey: () => `${prefix}/final.out`,
  };
}

export type BindingResult =
  | {
      ok: true;
      endpointId: string;
      /** RemoteNodeBinding（uri 为对象键语义，派发时签 URL） */
      bindings: RemoteNodeBinding[];
    }
  | { ok: false; reason: string };

/** 单端点对全部意图的可服务性（存在性 + 余量 + IO 复核）；不可服务返回原因 */
function endpointServes(
  entry: EndpointEntry,
  intents: readonly RemoteNodeIntent[],
  nodeIndex: Map<string, { inputs: DcirPortJson[]; outputs: DcirPortJson[] }>
): string | null {
  for (const intent of intents) {
    const model = entry.capability.models.find((m) => m.modelKey === intent.modelKey);
    if (!model) {
      return `端点 ${entry.endpointId} 未声明模型 ${intent.modelKey}`;
    }
    if (model.queueRemaining < 1) {
      return `端点 ${entry.endpointId} 模型 ${intent.modelKey} 队列余量为 0`;
    }
    const node = nodeIndex.get(intent.nodeId);
    if (!node) {
      return `binding 指向的节点 ${intent.nodeId} 不在 graph.nodes 中`;
    }
    const inputReason = portsMismatch(node.inputs, model.io?.inputs, "inputs");
    if (inputReason) return `端点 ${entry.endpointId}：${inputReason}`;
    const outputReason = portsMismatch(node.outputs, model.io?.outputs, "outputs");
    if (outputReason) return `端点 ${entry.endpointId}：${outputReason}`;
  }
  return null;
}

/**
 * 绑定入口：意图 × 能力视图 → 单端点绑定计划（含对象键规划）。
 * 空 intents（纯本地图）→ 绑定 formality 端点 null 语义由入口处理（无端点参与）。
 */
export function bindWorkflow(input: BindingInput): BindingResult {
  const { graph, intents, endpoints } = input;

  // 空 intents（纯本地图）：无端点参与，endpointId 返回空串由入口处理
  if (intents.length === 0) {
    return { ok: true, endpointId: "", bindings: [] };
  }

  // 图形态窄读取（与 inspection 同构：nodes[].name + inputs/outputs 端口数组）
  const nodesRaw = (typeof graph === "object" && graph !== null ? (graph as { nodes?: unknown }).nodes : undefined);
  const nodeIndex = new Map<string, { inputs: DcirPortJson[]; outputs: DcirPortJson[] }>();
  if (Array.isArray(nodesRaw)) {
    for (const n of nodesRaw) {
      const parsed = asNodeEntry(n);
      if (parsed) nodeIndex.set(parsed.name, { inputs: parsed.inputs, outputs: parsed.outputs });
    }
  }

  // 多端点可服务 → queueTotalRemaining 最大（MVP 贪心；打分调度 P3）
  const candidates = [...endpoints].sort(
    (a, b) =>
      b.capability.models.reduce((s, m) => s + m.queueRemaining, 0) -
      a.capability.models.reduce((s, m) => s + m.queueRemaining, 0)
  );

  const reasons: string[] = [];
  for (const entry of candidates) {
    const reason = endpointServes(entry, intents, nodeIndex);
    if (reason === null) {
      const keys = planObjectKeys(input.workflowId);
      const bindings: RemoteNodeBinding[] = intents.map((intent) => ({
        nodeId: intent.nodeId,
        modelKey: intent.modelKey,
        outputUri: keys.remoteOutputKey(intent.nodeId),
        inputs: remoteInputBindings(graph, intent.nodeId, keys),
      }));
      return { ok: true, endpointId: entry.endpointId, bindings };
    }
    reasons.push(reason);
  }

  return {
    ok: false,
    reason:
      reasons.length > 0
        ? reasons.join("; ")
        : "无存活端点可服务全部远程节点（整图单端点绑定，D9 MVP）",
  };
}

/** 远程节点输入端口枚举 → 对象键绑定（端口名来自图节点 inputs 声明顺序） */
function remoteInputBindings(
  graph: unknown,
  nodeId: string,
  keys: WorkflowObjectKeys
): RemoteNodeBinding["inputs"] {
  const nodesRaw = (typeof graph === "object" && graph !== null ? (graph as { nodes?: unknown }).nodes : undefined);
  if (!Array.isArray(nodesRaw)) return [];
  for (const n of nodesRaw) {
    const parsed = asNodeEntry(n);
    if (parsed?.name !== nodeId) continue;
    return parsed.inputs
      .filter((p) => typeof p.name === "string" && (p.name as string).length > 0)
      .map((p) => ({ port: p.name as string, uri: keys.remoteInputKey(nodeId, p.name as string) }));
  }
  return [];
}
