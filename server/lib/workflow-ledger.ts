/**
 * 工作流账本（内存版，P0 骨架）— 工作流状态机的存储位
 *
 * 状态机：登记→检视→绑定→派发→执行→回推→聚合（server/DESIGN.md §5）。
 * P0 骨架仅提供账本形态与 GET 查询端点的数据源（未找到 → E_WORKFLOW_NOT_FOUND）；
 * 状态推进入口（推理请求 → 检视 → 绑定 → 派发）P1 落地。
 * TODO(P2)：迁移 service-kit /db（PgSqlDb）持久化（Ledger / 端点账目 / 状态机持久化，D7）。
 */

import type { ErrorCode, WorkflowLifecycleStatus } from "./contracts";

/** 工作流账目（WorkflowStatus 响应的存储形态） */
export interface WorkflowRecord {
  workflowId: string;
  status: WorkflowLifecycleStatus;
  errorCode?: ErrorCode;
  finalOutputUri?: string;
  updatedAtMs: number;
}

export class WorkflowLedger {
  private readonly records = new Map<string, WorkflowRecord>();

  get(workflowId: string): WorkflowRecord | null {
    return this.records.get(workflowId) ?? null;
  }

  /** 状态推进 / 建账（P1 推理入口与执行链路消费） */
  upsert(record: WorkflowRecord): void {
    this.records.set(record.workflowId, { ...record, updatedAtMs: Date.now() });
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
