/**
 * 派发泵 + 任务账本（D7/D9）— 控制面的任务注入与回收记账
 *
 * 语义（server/DESIGN.md D9「任务注入与反压」+ D7「任务在途账本」）：
 * - 派发泵轮询 sidecar（V7 /status 聚合 + /workflows/{id}/status 快照），取走
 *   pendingDispatches，签名 inputUri/outputUri（sidecar 侧为对象键语义）后经
 *   transport 下发。P1：transport = WS 网关推送优先（V5；未连接/失败 → 暂缓，
 *   记账保留 pushed=false 下轮重试），泵轮询为兜底驱动。
 * - 任务账本：taskId → (workflowId, nodeId, endpointId) 映射 + requestId 幂等
 *   （先到先得），完成上报端点消费（E_TASK_UNKNOWN / duplicate 语义）。
 *   requestId = hash(endpointId, taskId)（security §4.1，P1 对齐端点维度）。
 * - 反压（余量软控制）与 TTL 判死重派为批次 E 项；P2 迁 /db 持久化。
 */

import { createHash } from "node:crypto";
import type { TaskDispatch, TaskRevoke } from "./contracts";
import type { EndpointEntry } from "./endpoint-registry";
import { SidecarClient, type SidecarLiveness } from "./ipc/sidecar-client";

// 总线 URL 签发已迁至 lib/bus-signer（P1 正式化：kit /storage 预签名 + 替身回退）；
// 此处 re-export 保持既有 import 路径（dispatch-pump 为控制面派发链路的主消费面）
import type { BusUrlSigner } from "./bus-signer";
export { getBusSigner, makeStandinBusSigner, normalizeBusKey } from "./bus-signer";
export type { BusSignOptions, BusUrlSigner } from "./bus-signer";

/** 任务账目（账本存储形态；inputKey/outputKey 为 sidecar 对象键语义） */
export interface TaskAccountEntry {
  taskId: string;
  requestId: string;
  workflowId: string;
  nodeId: string;
  modelKey: string;
  inputKey: string;
  outputKey: string;
  priority: TaskDispatch["priority"];
  dispatchedAtMs: number;
  /** 目标端点（P1 绑定账解析；缺省回退 DEFAULT_DISPATCH_ENDPOINT_ID） */
  endpointId: string;
  /** WS 推送是否成功；false = 暂缓（泵下轮重推，URL 重签） */
  pushed: boolean;
  reported: boolean;
}

/** 未接入绑定账（workflow → endpointId）时的回退端点（单端点 dev/对拍语义） */
export const DEFAULT_DISPATCH_ENDPOINT_ID = "default-endpoint";

export class TaskAccount {
  private readonly entries = new Map<string, TaskAccountEntry>();

  /** 记账（taskId 幂等：已存在返回 false，不重复派发；pushed 初始为 false） */
  record(entry: Omit<TaskAccountEntry, "pushed" | "reported">): boolean {
    if (this.entries.has(entry.taskId)) return false;
    this.entries.set(entry.taskId, { ...entry, pushed: false, reported: false });
    return true;
  }

  get(taskId: string): TaskAccountEntry | null {
    return this.entries.get(taskId) ?? null;
  }

  /** requestId 幂等（D7 先到先得）：首次置 reported 返回 true，重复返回 false */
  markReported(taskId: string): boolean {
    const entry = this.entries.get(taskId);
    if (!entry || entry.reported) return false;
    entry.reported = true;
    return true;
  }

  /** WS 推送成功置位（暂缓任务下轮重推） */
  markPushed(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (entry) entry.pushed = true;
  }

  /** 端点在途任务（已推送未上报；TTL 判死重派消费，批次 E） */
  listInFlight(endpointId: string): TaskAccountEntry[] {
    return [...this.entries.values()].filter(
      (e) => e.endpointId === endpointId && e.pushed && !e.reported
    );
  }

  /** 工作流的已推送未上报任务（终态撤销下发消费，批次 E） */
  listByWorkflow(workflowId: string): TaskAccountEntry[] {
    return [...this.entries.values()].filter(
      (e) => e.workflowId === workflowId && e.pushed && !e.reported
    );
  }
}

const globalForAccount = globalThis as unknown as {
  __inferTaskAccount?: TaskAccount;
};

export function getTaskAccount(): TaskAccount {
  globalForAccount.__inferTaskAccount ??= new TaskAccount();
  return globalForAccount.__inferTaskAccount;
}

// ── requestId 与派发 ────────────────────────────────────────────────────────

/**
 * requestId 生成。契约语义 = hash(endpointId, taskId)（security §4.1）；
 * P0 曾退化为 hash(taskId)（无端点上下文），P1 泵按绑定账解析端点后对齐。
 */
export function requestIdFor(endpointId: string, taskId: string): string {
  return createHash("sha256").update(`${endpointId}\u0000${taskId}`).digest("hex").slice(0, 32);
}

export interface PollDispatchOptions {
  signer: BusUrlSigner;
  /**
   * 下发通道注入点：P1 = WS 网关推送（gateway.pushToEndpoint，false = 暂缓）。
   * 对拍 harness 经此接管端点角色（同步返回 true 即可）。
   */
  transport?: (
    endpointId: string,
    dispatch: TaskDispatch
  ) => boolean | Promise<boolean>;
  /** workflowId → endpointId 绑定解析（P1 绑定账接线；缺省回退单端点默认值） */
  resolveEndpoint?: (workflowId: string) => string | null;
  /**
   * 反压门控（D9 余量软控制，P1）：false = 暂缓（不调 transport，pushed 保持 false）。
   * instrumentation 装配 = 端点存活（registry）+ WS 在线（gateway）+ modelKey 余量 ≥ 1。
   */
  canDispatch?: (endpointId: string, modelKey: string) => boolean;
  /** 探活失败（sidecar 不可达）时的回调（如日志/告警） */
  onUnreachable?: () => void;
}

/** 轮询一次 sidecar 并派发新增任务，返回本次派发的任务列表 */
export async function pollSidecarDispatches(
  sidecar: SidecarClient,
  options: PollDispatchOptions
): Promise<TaskDispatch[]> {
  const liveness: SidecarLiveness | null = await sidecar.ping();
  if (!liveness) {
    options.onUnreachable?.();
    return [];
  }
  const account = getTaskAccount();
  const dispatched: TaskDispatch[] = [];
  const transport = options.transport ?? defaultTransport;
  for (const wf of liveness.workflows) {
    if (!["starting", "waitingRemote", "executing"].includes(wf.status)) continue;
    const snapshot = await sidecar.status(wf.workflowId);
    if (!snapshot?.pendingDispatches?.length) continue;
    for (const pending of snapshot.pendingDispatches) {
      // 端点解析：已记账优先（绑定不漂移），否则按绑定账解析（缺省单端点回退）
      const existing = account.get(pending.taskId);
      const endpointId =
        existing?.endpointId ??
        options.resolveEndpoint?.(pending.workflowId) ??
        DEFAULT_DISPATCH_ENDPOINT_ID;
      if (existing?.pushed) continue; // 已推送未上报：等完成上报/重派（批次 E），不重推
      if (options.canDispatch && !options.canDispatch(endpointId, pending.modelKey)) {
        continue; // 反压：不记账外推（新任务也不入账，余量恢复后下轮自然取走）
      }
      const entry: Omit<TaskAccountEntry, "pushed" | "reported"> = {
        taskId: pending.taskId,
        requestId: requestIdFor(endpointId, pending.taskId),
        workflowId: pending.workflowId,
        nodeId: pending.nodeId,
        modelKey: pending.modelKey,
        inputKey: pending.inputUri,
        outputKey: pending.outputUri,
        priority: pending.priority,
        dispatchedAtMs: pending.dispatchedAtMs ?? Date.now(),
        endpointId,
      };
      if (!existing && !account.record(entry)) continue; // 并发记账兜底（V7 重轮询幂等）
      const signed: TaskDispatch = {
        ...pending,
        requestId: entry.requestId,
        inputUri: await options.signer(entry.inputKey, "GET"),
        outputUri: await options.signer(entry.outputKey, "PUT"),
      };
      const ok = await transport(endpointId, signed);
      if (!ok) continue; // 暂缓：记账保留（pushed=false），下轮重推（URL 重签）
      account.markPushed(pending.taskId);
      dispatched.push(signed);
    }
  }
  return dispatched;
}

async function defaultTransport(endpointId: string, dispatch: TaskDispatch): Promise<boolean> {
  // 无 WS 网关注入时的缺省（对拍/调试）：日志即成功，任务仅入账本
  console.log(
    `[dispatch-pump] task dispatched (log transport) → ${endpointId}: ${JSON.stringify(dispatch)}`
  );
  return true;
}

// ── TTL 判死重派 + 撤销下发（D7，批次 E）────────────────────────────────

/**
 * 端点 TTL 判死 → 其在途任务（已推送未上报）重派（D7 任务在途账本）：
 * 换绑到其他可服务端点（modelKey ∈ 模型清单且余量 ≥ 1，贪心取余量最大），
 * 升入补偿优先级（priority=compensation，已排过队，失败是端点的问题）、
 * 置回待推送（泵下轮重推，URL 重签 + requestId 按新端点重算）。无替代端点
 * 的任务保持原账（等端点重新注册或 P2 /db 兼容面收敛；不重派不上报的悬挂
 * 由下次 sweep 重试覆盖）。
 */
export function reassignInFlightTasks(
  deadEndpointId: string,
  candidates: readonly EndpointEntry[]
): number {
  const account = getTaskAccount();
  const alive = [...candidates]
    .filter((e) => e.endpointId !== deadEndpointId)
    .sort(
      (a, b) =>
        b.capability.models.reduce((s, m) => s + m.queueRemaining, 0) -
        a.capability.models.reduce((s, m) => s + m.queueRemaining, 0)
    );
  let reassigned = 0;
  for (const task of account.listInFlight(deadEndpointId)) {
    const alt = alive.find((e) =>
      e.capability.models.some((m) => m.modelKey === task.modelKey && m.queueRemaining >= 1)
    );
    if (!alt) {
      console.warn(
        `[dispatch-pump] task ${task.taskId} 无替代端点可服务 ${task.modelKey}，暂挂（等重注册）`
      );
      continue;
    }
    task.endpointId = alt.endpointId;
    task.priority = "compensation";
    task.pushed = false;
    task.dispatchedAtMs = Date.now();
    task.requestId = requestIdFor(alt.endpointId, task.taskId);
    reassigned += 1;
    console.log(
      `[dispatch-pump] task ${task.taskId} reassigned: ${deadEndpointId} → ${alt.endpointId} (compensation)`
    );
  }
  return reassigned;
}

/**
 * 工作流终态（completed/failed/cancelled）→ 其已推送未上报任务的撤销下发
 * （标记式懒惰撤销：端点出队执行前检查跳过，不中断执行中任务）。push 回调
 * 由调用方注入（WS 网关推送），返回成功下发的撤销数。
 */
export function revokeTasksOfWorkflow(
  workflowId: string,
  push: (endpointId: string, revoke: TaskRevoke) => boolean,
  reason = "workflow-finalized"
): number {
  const account = getTaskAccount();
  const pending = account.listByWorkflow(workflowId);
  let revoked = 0;
  for (const task of pending) {
    if (
      push(task.endpointId, {
        version: 1,
        type: "task.revoke",
        taskId: task.taskId,
        endpointId: task.endpointId,
        reason,
      })
    ) {
      revoked += 1;
    }
  }
  return revoked;
}
