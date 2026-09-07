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
  /**
   * 静态手动分区（D9/P2 批次 D）：分组约束声明——同组节点强制绑定同一端点
   * （互斥/环语义的消费者载体）；未出现在任何组里的意图节点 = 自由节点（独立
   * 贪心绑定）。**环校验**：图内环 SCC 中的远程节点必须同组（跨机环塌语义与
   * 性能，根 §11），违反 → 绑定拒绝。
   */
  nodeGroups?: readonly string[][];
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
      /** 首组绑定端点（兼容 WorkflowRecord.endpointId 单值语义；分区后为展示摘要） */
      endpointId: string;
      /** RemoteNodeBinding（uri 为对象键语义，派发时签 URL） */
      bindings: RemoteNodeBinding[];
      /** nodeId → endpointId（P2 分区绑定摘要；泵按节点解析端点） */
      nodeEndpoint: Record<string, string>;
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
 * 环校验（静态读图，控制面不 link DCinfer）：edges 邻接 → SCC（Tarjan 迭代版）→
 * size > 1 或自环的分量 = 环；环内远程节点必须落在同一声明组（无声明 → 全部
 * 同组才合法）。返回违规描述，null = 通过。
 */
export function cycleViolation(graph: unknown, nodeGroups?: readonly string[][]): string | null {
  const nodesRaw = typeof graph === "object" && graph !== null ? (graph as { nodes?: unknown }).nodes : undefined;
  const edgesRaw = typeof graph === "object" && graph !== null ? (graph as { edges?: unknown }).edges : undefined;
  if (!Array.isArray(nodesRaw) || !Array.isArray(edgesRaw)) return null;

  const nameOf = (v: unknown): string | null => {
    const n = asNodeEntry(v);
    return n ? n.name : null;
  };
  const all = new Set<string>();
  for (const n of nodesRaw) {
    const name = nameOf(n);
    if (name) all.add(name);
  }
  const adj = new Map<string, Set<string>>();
  for (const name of all) adj.set(name, new Set());
  const remote = new Set<string>();
  if (nodeGroups) for (const g of nodeGroups) for (const n of g) remote.add(n);

  for (const e of edgesRaw) {
    const edge = e as { srcNode?: unknown; dstNode?: unknown };
    if (typeof edge.srcNode !== "string" || typeof edge.dstNode !== "string") continue;
    if (!all.has(edge.srcNode) || !all.has(edge.dstNode)) continue;
    adj.get(edge.srcNode)?.add(edge.dstNode); // 自环天然表达（src == dst）
  }

  // Tarjan SCC（迭代版，防深图栈溢出）
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const sccs: string[][] = [];
  for (const root of all) {
    if (index.has(root)) continue;
    const call: Array<{ node: string; iter: Iterator<string> }> = [{ node: root, iter: adj.get(root)![Symbol.iterator]() }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (call.length > 0) {
      const frame = call[call.length - 1];
      const next = frame.iter.next();
      if (next.done) {
        call.pop();
        if (call.length > 0) {
          const parent = call[call.length - 1].node;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
        }
        if (low.get(frame.node) === index.get(frame.node)) {
          const component: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            component.push(w);
            if (w === frame.node) break;
          }
          sccs.push(component);
        }
        continue;
      }
      const w = next.value;
      if (!index.has(w)) {
        index.set(w, counter);
        low.set(w, counter);
        counter += 1;
        stack.push(w);
        onStack.add(w);
        call.push({ node: w, iter: adj.get(w)![Symbol.iterator]() });
      } else if (onStack.has(w)) {
        low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
      }
    }
  }

  for (const component of sccs) {
    const isCycle = component.length > 1 || (adj.get(component[0])?.has(component[0]) ?? false);
    if (!isCycle) continue;
    const cycleRemote = component.filter((n) => remote.has(n));
    if (cycleRemote.length === 0) continue; // 纯本地环（sidecar 内），无分区面
    const groupsOf = cycleRemote.map(
      (n) => nodeGroups?.findIndex((g) => g.includes(n)) ?? -1
    );
    const distinct = new Set(groupsOf);
    if (distinct.size > 1) {
      return `环 [${component.join(" → ")}] 内远程节点必须绑定同一端点（nodeGroups 同组约束，D9）`;
    }
  }
  return null;
}
/**
 * 绑定入口：意图 × 能力视图 → 绑定计划（含对象键规划）。
 * 空 intents（纯本地图）→ 绑定 formality 端点 null 语义由入口处理（无端点参与）。
 *
 * P2 静态手动分区：nodeGroups 同组节点强制同端点（逐组贪心，组间端点可复用——
 * 分组语义是「必须同端点」约束而非「必须不同端点」）；未分组节点各自独立贪心。
 * **环校验前置**：环内远程节点同组约束（cycleViolation）。
 * **拍板（2026-09-08）**：任一组/节点无可服务端点 → 直接拒绝，不等待、不做拉模型兜底
 * （调度面只对端点；缺端点自动化后置）。
 */
export function bindWorkflow(input: BindingInput): BindingResult {
  const { graph, intents, endpoints } = input;

  // 空 intents（纯本地图）：无端点参与，endpointId 返回空串由入口处理
  if (intents.length === 0) {
    return { ok: true, endpointId: "", bindings: [], nodeEndpoint: {} };
  }

  // 环校验前置（静态约束，先于端点能力检查）
  const cycle = cycleViolation(graph, input.nodeGroups);
  if (cycle) return { ok: false, reason: cycle };

  // 图形态窄读取（与 inspection 同构：nodes[].name + inputs/outputs 端口数组）
  const nodesRaw = (typeof graph === "object" && graph !== null ? (graph as { nodes?: unknown }).nodes : undefined);
  const nodeIndex = new Map<string, { inputs: DcirPortJson[]; outputs: DcirPortJson[] }>();
  if (Array.isArray(nodesRaw)) {
    for (const n of nodesRaw) {
      const parsed = asNodeEntry(n);
      if (parsed) nodeIndex.set(parsed.name, { inputs: parsed.inputs, outputs: parsed.outputs });
    }
  }

  // 分区组装配：声明组 ∪ 自由节点（未分组的意图节点各自成组，独立绑定）
  const intentById = new Map(intents.map((i) => [i.nodeId, i]));
  const grouped = new Set<string>();
  const partitions: RemoteNodeIntent[][] = [];
  for (const group of input.nodeGroups ?? []) {
    const members = group.map((n) => intentById.get(n)).filter((i): i is RemoteNodeIntent => i !== undefined);
    if (members.length === 0) continue; // 声明组无对应意图节点（本地/未知节点）→ 不产生绑定约束
    for (const m of members) grouped.add(m.nodeId);
    partitions.push(members);
  }
  for (const intent of intents) {
    if (!grouped.has(intent.nodeId)) partitions.push([intent]); // 自由节点独立绑定
  }

  // 多端点可服务 → queueTotalRemaining 最大（MVP 贪心；打分调度 P3）
  const candidates = [...endpoints].sort(
    (a, b) =>
      b.capability.models.reduce((s, m) => s + m.queueRemaining, 0) -
      a.capability.models.reduce((s, m) => s + m.queueRemaining, 0)
  );

  const keys = planObjectKeys(input.workflowId);
  const nodeEndpoint: Record<string, string> = {};
  for (const members of partitions) {
    const reasons: string[] = [];
    let picked: EndpointEntry | null = null;
    for (const entry of candidates) {
      const reason = endpointServes(entry, members, nodeIndex);
      if (reason === null) {
        picked = entry;
        break;
      }
      reasons.push(reason);
    }
    if (!picked) {
      return {
        ok: false,
        reason: `节点 [${members.map((m) => m.nodeId).join(", ")}] 无存活端点可服务：${[...new Set(reasons)].join("；")}`,
      };
    }
    for (const m of members) nodeEndpoint[m.nodeId] = picked.endpointId;
  }

  const bindings: RemoteNodeBinding[] = intents.map((intent) => ({
    nodeId: intent.nodeId,
    modelKey: intent.modelKey,
    outputUri: keys.remoteOutputKey(intent.nodeId),
    inputs: remoteInputBindings(graph, intent.nodeId, keys),
  }));
  const endpointId = nodeEndpoint[intents[0]!.nodeId] ?? "";
  return { ok: true, endpointId, bindings, nodeEndpoint };
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
