/**
 * 结构化检视（D6，2026-09-07 拍板：server 承担，两层防线的静态半边）
 *
 * 工作流启动前验证图（contracts/DESIGN §3）：
 * ① 节点存在性：每个远程节点的 modelKey ∈ 至少一个登记端点的模型清单；
 * ② IO 结构匹配：图节点端口声明 × 端点 per-model `io` 声明——端口名 / tensorType /
 *    typeSize 相等，shape 维度数相等且各维 -1 动态维度兼容。存在任一可服务端点
 *    通过即过（绑定阶段对具体端点复核，防检视与绑定间端点变化）。
 * 不满足 → E_INSPECTION_REJECTED，工作流落 rejected，不允许进入绑定/派发。
 * 执行期错误归 DCinfer 错误机制（ErrorTracker 记录 + 节点失败传播，sidecar 状态机
 * 消费为图级 failed）——检视只拦静态结构错误，不预测运行时行为。
 *
 * graph 为 opaque JSON（D3：控制面静态读图不 link DCinfer，契约不建模其内部结构）。
 * 此处按 DCIr 序列化公开格式窄化读取（nodes[].inputs/outputs 端口数组），仅消费
 * 格式不消费实现；端口编码与 capability 域 IoPort 逐字段同构（三方比对的基础）。
 *
 * 消费点（P1 接线）：工作流启动入口（检视 → rejected/completed 状态机）+
 * 绑定阶段对具体端点的复核。P0 先落纯函数 + 单测，数据源（端点登记视图）P1 就位。
 */
import type { RemoteNodeBinding } from "./contracts";

// ── DCIr 序列化格式的窄读取（防御式：图 JSON 来自 sidecar 契约外的基础工程格式） ──

/** DCIr 序列化端口（与 endpoint-capability IoPort 同编码） */
export interface DcirPortJson {
  name?: unknown;
  tensorType?: unknown;
  typeSize?: unknown;
  shape?: unknown;
  required?: unknown;
}

export interface DcirNodeJson {
  name?: unknown;
  inputs?: unknown;
  outputs?: unknown;
}

/** 端点能力视图中 per-model 的检视输入（EndpointCapability.models[].io 投影） */
export interface InspectablePort {
  name: string;
  tensorType: string;
  typeSize: number;
  shape: number[];
}

export interface InspectableModel {
  modelKey: string;
  io?: {
    inputs?: InspectablePort[];
    outputs?: InspectablePort[];
  };
}

export type InspectionFailureKind = "model-unknown" | "io-mismatch" | "graph-shape";

export interface InspectionFailure {
  kind: InspectionFailureKind;
  nodeId: string;
  modelKey: string;
  detail: string;
}

export interface InspectionResult {
  ok: boolean;
  failures: InspectionFailure[];
}

/** shape 兼容：维度数相等，各维 -1（动态）或相等（DCIr int64 直通语义） */
export function shapeCompatible(graphShape: readonly number[], declaredShape: readonly number[]): boolean {
  if (graphShape.length !== declaredShape.length) return false;
  return graphShape.every((g, i) => {
    const d = declaredShape[i];
    return g === -1 || d === -1 || g === d;
  });
}

/** 图端口 × 声明端口的单端口匹配；返回 null 表示匹配，否则为不匹配原因 */
function portMismatch(
  graphPort: DcirPortJson,
  declared: readonly InspectablePort[],
): string | null {
  if (typeof graphPort.name !== "string" || graphPort.name.length === 0) {
    return "图端口缺少合法 name";
  }
  const target = declared.find((p) => p.name === graphPort.name);
  if (!target) return `端口 '${graphPort.name}' 未在端点声明中`;
  if (typeof graphPort.tensorType !== "string" || graphPort.tensorType !== target.tensorType) {
    return `端口 '${graphPort.name}' tensorType 不匹配（图 ${String(graphPort.tensorType)} vs 声明 ${target.tensorType}）`;
  }
  if (typeof graphPort.typeSize !== "number" || graphPort.typeSize !== target.typeSize) {
    return `端口 '${graphPort.name}' typeSize 不匹配（图 ${String(graphPort.typeSize)} vs 声明 ${target.typeSize}）`;
  }
  if (
    !Array.isArray(graphPort.shape) ||
    !graphPort.shape.every((n) => typeof n === "number") ||
    !shapeCompatible(graphPort.shape as number[], target.shape)
  ) {
    return `端口 '${graphPort.name}' shape 不兼容（图 ${JSON.stringify(graphPort.shape)} vs 声明 ${JSON.stringify(target.shape)}）`;
  }
  return null;
}

/** 方向端口组匹配：图声明的每个端口都须在端点声明中找到匹配项（端点可声明图未消费的多余端口）。绑定阶段对具体端点复核时复用（scheduler） */
export function portsMismatch(
  graphPorts: readonly DcirPortJson[],
  declared: readonly InspectablePort[] | undefined,
  direction: "inputs" | "outputs",
): string | null {
  if (graphPorts.length === 0) return null; // 无要求（如 BusProxy 无 inputs）
  if (!Array.isArray(declared)) return `${direction} 端点未声明`;
  for (const gp of graphPorts) {
    const reason = portMismatch(gp, declared);
    if (reason) return reason;
  }
  return null;
}

function asPortArray(value: unknown): DcirPortJson[] {
  if (!Array.isArray(value)) return [];
  return value.filter((p): p is DcirPortJson => typeof p === "object" && p !== null);
}

/** 图节点窄读取：合法 name 的节点 → 端口数组（scheduler 绑定复核复用）；不合法返回 null */
export function asNodeEntry(value: unknown): { name: string; inputs: DcirPortJson[]; outputs: DcirPortJson[] } | null {
  if (typeof value !== "object" || value === null) return null;
  const name = (value as DcirNodeJson).name;
  if (typeof name !== "string" || name.length === 0) return null;
  return {
    name,
    inputs: asPortArray((value as DcirNodeJson).inputs),
    outputs: asPortArray((value as DcirNodeJson).outputs),
  };
}

/**
 * 检视入口：图（opaque DCIr JSON）× 绑定计划 × 已登记能力视图 → 通过与否 + 失败明细。
 * 空 bindings（纯本地图）恒过——检视只对远程节点负责。
 */
export function inspectWorkflowGraph(
  graph: unknown,
  bindings: readonly RemoteNodeBinding[],
  models: readonly InspectableModel[],
): InspectionResult {
  const failures: InspectionFailure[] = [];

  // 图形态窄读取：nodes[] 数组，name → node 索引
  const nodesRaw = (typeof graph === "object" && graph !== null ? (graph as { nodes?: unknown }).nodes : undefined);
  const nodeIndex = new Map<string, DcirNodeJson>();
  if (Array.isArray(nodesRaw)) {
    for (const n of nodesRaw) {
      if (typeof n === "object" && n !== null && typeof (n as DcirNodeJson).name === "string") {
        nodeIndex.set((n as DcirNodeJson).name as string, n as DcirNodeJson);
      }
    }
  } else if (bindings.length > 0) {
    failures.push({
      kind: "graph-shape",
      nodeId: "",
      modelKey: "",
      detail: "graph.nodes 缺失或非数组，无法检视",
    });
  }

  for (const binding of bindings) {
    const candidates = models.filter((m) => m.modelKey === binding.modelKey);
    if (candidates.length === 0) {
      failures.push({
        kind: "model-unknown",
        nodeId: binding.nodeId,
        modelKey: binding.modelKey,
        detail: "无任何登记端点声明可服务该模型",
      });
      continue;
    }

    const node = nodeIndex.get(binding.nodeId);
    if (!node) {
      failures.push({
        kind: "graph-shape",
        nodeId: binding.nodeId,
        modelKey: binding.modelKey,
        detail: "binding 指向的节点不在 graph.nodes 中",
      });
      continue;
    }

    const graphInputs = asPortArray(node.inputs);
    const graphOutputs = asPortArray(node.outputs);

    // 存在性语义：任一可服务端点通过即过（MVP 整图单端点绑定，检视先按能力视图全量判断）
    let matched = false;
    const candidateReasons: string[] = [];
    for (const candidate of candidates) {
      const inputReason = portsMismatch(graphInputs, candidate.io?.inputs, "inputs");
      if (inputReason) {
        candidateReasons.push(`端点候选（io.inputs）：${inputReason}`);
        continue;
      }
      const outputReason = portsMismatch(graphOutputs, candidate.io?.outputs, "outputs");
      if (outputReason) {
        candidateReasons.push(`端点候选（io.outputs）：${outputReason}`);
        continue;
      }
      matched = true;
      break;
    }
    if (!matched) {
      // 归因语义：候选存在但全部未携带 io 声明 → 汇总提示；部分携带而不匹配 → 罗列具体原因
      const hasAnyIo = candidates.some((c) => c.io !== undefined);
      failures.push({
        kind: "io-mismatch",
        nodeId: binding.nodeId,
        modelKey: binding.modelKey,
        detail: hasAnyIo
          ? candidateReasons.join("; ")
          : "无可服务端点携带 io 声明",
      });
    }
  }

  return { ok: failures.length === 0, failures };
}
