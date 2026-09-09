/**
 * 工作流账本（内存版，P1）— 工作流状态机的存储位
 *
 * 状态机（WorkflowLifecycleStatus，contracts control-channel/workflow-status）：
 * registered → inspecting → binding → dispatching → executing → collecting →
 * aggregating → completed，任一执行态可落 failed；检视/绑定不满足 → rejected；
 * 终态（completed/failed/rejected/cancelled）不可再迁移（transition 校验拒绝）。
 * P1 同步入口把检视/绑定的短暂态折叠（registered → dispatching/rejected）；
 * 执行链路态由 sidecar 快照映射推进（GET 路由聚合时回写，V7 轮询探活一体）。
 *
 * TODO(P2)：迁移 service-kit /db（PgSqlDb）持久化（Ledger / 端点账目 / 状态机
 * 持久化，D7）——控制面重启后内存账本丢失（完成上报 E_TASK_UNKNOWN 已注释）。
 */

import type { ErrorCode, WorkflowLifecycleStatus } from "./contracts";
import type { LedgerStore } from "./ledger-store";

/** 工作流账目（WorkflowStatus 响应的存储形态） */
export interface WorkflowRecord {
  workflowId: string;
  status: WorkflowLifecycleStatus;
  errorCode?: ErrorCode;
  finalOutputUri?: string;
  /** 绑定端点（D9 MVP 整图单端点；空串/缺省 = 纯本地图无端点参与；分区后为首组端点） */
  endpointId?: string;
  /** 静态分区绑定摘要（P2 批次 D：nodeId → endpointId JSON，泵按节点解析端点） */
  bindingsJson?: string;
  /** 建账时刻（shelf_life 期限基准之一；write-through 恢复用） */
  createdAtMs?: number;
  updatedAtMs: number;
}

const TERMINAL_STATUSES: ReadonlySet<WorkflowLifecycleStatus> = new Set([
  "completed",
  "failed",
  "rejected",
  "cancelled",
]);

/** 合法迁移表（P1 状态机口径；越界迁移拒绝并告警） */
const LEGAL_TRANSITIONS: Readonly<Record<WorkflowLifecycleStatus, readonly WorkflowLifecycleStatus[]>> = {
  registered: ["inspecting", "binding", "dispatching", "rejected", "failed"],
  inspecting: ["rejected", "binding", "failed"],
  binding: ["rejected", "dispatching", "failed"],
  dispatching: ["executing", "completed", "failed", "cancelled"],
  executing: ["collecting", "completed", "failed", "cancelled"],
  collecting: ["aggregating", "completed", "failed", "cancelled"],
  aggregating: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  rejected: [],
  cancelled: [],
};

export class WorkflowLedger {
  private readonly records = new Map<string, WorkflowRecord>();
  private store: LedgerStore | null = null;

  /**
   * 挂接持久化存储位（P2 /db write-through）：内存权威不变，每次变更异步落库
   * （失败告警不抛——状态可经重派/恢复收敛，D7）；启动期 hydrate 后挂接。
   */
  attachStore(store: LedgerStore): void {
    this.store = store;
  }

  /** 启动恢复：pg 快照填充内存账（仅 hydrate 一次；空快照无操作） */
  async hydrate(store: LedgerStore): Promise<void> {
    const { workflows } = await store.loadAll();
    for (const wf of workflows) {
      if (!this.records.has(wf.workflowId)) this.records.set(wf.workflowId, wf);
    }
  }

  private persist(record: WorkflowRecord): void {
    if (!this.store) return;
    void this.store.putWorkflow(record).catch((e) =>
      console.warn(`[workflow-ledger] persist ${record.workflowId} failed: ${(e as Error).message}`)
    );
  }

  get(workflowId: string): WorkflowRecord | null {
    return this.records.get(workflowId) ?? null;
  }

  /** 建账 / 无校验覆写（P0 查询端点兼容面；新代码用 transition；updatedAtMs 自管） */
  upsert(record: Omit<WorkflowRecord, "updatedAtMs">): void {
    const full: WorkflowRecord = { ...record, createdAtMs: record.createdAtMs ?? Date.now(), updatedAtMs: Date.now() };
    this.records.set(record.workflowId, full);
    this.persist(full);
  }

  /**
   * 状态迁移（校验合法迁移表）：非法迁移返回 null（账目不变）。
   * patch 允许同步回填 errorCode / finalOutputUri / endpointId。
   */
  transition(
    workflowId: string,
    next: WorkflowLifecycleStatus,
    patch: Partial<Omit<WorkflowRecord, "workflowId" | "status" | "updatedAtMs">> = {}
  ): WorkflowRecord | null {
    const current = this.records.get(workflowId);
    if (!current) return null;
    if (TERMINAL_STATUSES.has(current.status)) {
      console.warn(`[workflow-ledger] ${workflowId}: ${current.status} 为终态，拒绝迁移到 ${next}`);
      return null;
    }
    if (!LEGAL_TRANSITIONS[current.status].includes(next)) {
      console.warn(`[workflow-ledger] ${workflowId}: 非法迁移 ${current.status} → ${next}`);
      return null;
    }
    const updated: WorkflowRecord = {
      ...current,
      ...patch,
      workflowId,
      status: next,
      updatedAtMs: Date.now(),
    };
    this.records.set(workflowId, updated);
    this.persist(updated);
    return updated;
  }

  /** 全量快照（ops/admin 投影用；P1 内存账本） */
  list(): WorkflowRecord[] {
    return [...this.records.values()];
  }
}

// ── 进程级单例（dev 热重载下经 globalThis 保持）─────────────────────────

const globalForLedger = globalThis as unknown as {
  __inferWorkflowLedger?: WorkflowLedger;
};

export function getWorkflowLedger(): WorkflowLedger {
  globalForLedger.__inferWorkflowLedger ??= new WorkflowLedger();
  return globalForLedger.__inferWorkflowLedger;
}

/** 启动期接线（instrumentation register）：建表/探活 → 恢复 → write-through 挂接 */
export async function ensureWorkflowLedger(): Promise<WorkflowLedger> {
  const { ensureLedgerStore } = await import("./ledger-store");
  const store = await ensureLedgerStore();
  const ledger = getWorkflowLedger();
  await ledger.hydrate(store);
  ledger.attachStore(store);
  return ledger;
}
