/**
 * Ledger 持久化存储位（D7 /db，P2 批次 A）— kit /db（SQL 抽象）消费
 *
 * 分层持久化策略（拍板：pg 为主 + 内存降级，与 /auth 三态同构）：
 * - 工作流账 / 任务账：**内存权威 + pg write-through + 启动恢复**——状态可重建
 *   （重派/恢复兜底），最佳努力持久化（崩溃丢最近写由重启重推 + requestId 幂等
 *   + 懒惰撤销收敛）；调用点保持同步语义零改动。
 *
 * 历史上的 reward 台账（infer_reward_ledger，D12 计费流水）与 `consumer_account_id`
 * 列已随积分逻辑整体移除（2026-09-09）：计量与定价不在产品侧，扣款参考不应是
 * 签发方自报的账户号。重建时 pg 存表不动，另立新契约面。
 *
 * 渠道（kit /db 契约）：DATABASE_URL 配置 → postgres 渠道（init probe + DDL，
 * 失败 fail-fast）；未配置 → 内存 + 进程级一次性告警（dev/CI 兼容）。
 */

import type { WorkflowRecord } from "./workflow-ledger";
import type { TaskAccountEntry } from "./dispatch-pump";

export interface LedgerStore {
  readonly kind: "pg" | "memory";
  /** pg：连接 probe + DDL 建表（幂等）；memory：no-op */
  init(): Promise<void>;
  /** write-through 持久化（内存权威下的副本写入；失败由调用方告警不抛） */
  putWorkflow(record: WorkflowRecord): Promise<void>;
  putTask(entry: TaskAccountEntry): Promise<void>;
  /** 启动恢复：全量加载（内存权威 hydrate 数据源） */
  loadAll(): Promise<{ workflows: WorkflowRecord[]; tasks: TaskAccountEntry[] }>;
}

// ── 内存实现（dev/CI 降级）─────────────────────────────────────────────────

export class InMemoryLedgerStore implements LedgerStore {
  readonly kind = "memory" as const;
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly tasks = new Map<string, TaskAccountEntry>();

  async init(): Promise<void> {}

  async putWorkflow(record: WorkflowRecord): Promise<void> {
    this.workflows.set(record.workflowId, { ...record });
  }

  async putTask(entry: TaskAccountEntry): Promise<void> {
    this.tasks.set(entry.taskId, { ...entry });
  }

  async loadAll(): Promise<{ workflows: WorkflowRecord[]; tasks: TaskAccountEntry[] }> {
    return { workflows: [...this.workflows.values()], tasks: [...this.tasks.values()] };
  }
}

// ── pg 实现（kit /db postgres 渠道；SQL 字符串即真理）──────────────────────

const DDL = [
  `CREATE TABLE IF NOT EXISTS infer_workflows (
     workflow_id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     endpoint_id TEXT,
     error_code TEXT,
     final_output_uri TEXT,
     bindings_json TEXT,
     created_at_ms BIGINT NOT NULL,
     updated_at_ms BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS infer_task_account (
     task_id TEXT PRIMARY KEY,
     request_id TEXT NOT NULL,
     workflow_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     endpoint_id TEXT NOT NULL,
     model_key TEXT NOT NULL,
     input_key TEXT NOT NULL,
     output_key TEXT NOT NULL,
     priority TEXT NOT NULL,
     dispatched_at_ms BIGINT NOT NULL,
     pushed BOOLEAN NOT NULL DEFAULT FALSE,
     reported BOOLEAN NOT NULL DEFAULT FALSE
   )`,
];

export class PgLedgerStore implements LedgerStore {
  readonly kind = "pg" as const;
  constructor(private readonly db: import("yunzone-service-kit/db").SqlDb) {}

  async init(): Promise<void> {
    await this.db.query("SELECT 1"); // probe（连接凭证/网络错误在启动期 fail-fast）
    for (const ddl of DDL) await this.db.execute(ddl);
  }

  async putWorkflow(r: WorkflowRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO infer_workflows
         (workflow_id, status, endpoint_id, error_code, final_output_uri, bindings_json, created_at_ms, updated_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workflow_id) DO UPDATE SET
         status=$2, endpoint_id=$3, error_code=$4, final_output_uri=$5,
         bindings_json=$6, updated_at_ms=$8`,
      [
        r.workflowId,
        r.status,
        r.endpointId ?? null,
        r.errorCode ?? null,
        r.finalOutputUri ?? null,
        r.bindingsJson ?? null,
        r.createdAtMs ?? r.updatedAtMs,
        r.updatedAtMs,
      ]
    );
  }

  async putTask(t: TaskAccountEntry): Promise<void> {
    await this.db.execute(
      `INSERT INTO infer_task_account
         (task_id, request_id, workflow_id, node_id, endpoint_id, model_key, input_key, output_key, priority, dispatched_at_ms, pushed, reported)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (task_id) DO UPDATE SET
         request_id=$2, endpoint_id=$5, priority=$9, dispatched_at_ms=$10, pushed=$11, reported=$12`,
      [
        t.taskId,
        t.requestId,
        t.workflowId,
        t.nodeId,
        t.endpointId,
        t.modelKey,
        t.inputKey,
        t.outputKey,
        t.priority,
        t.dispatchedAtMs,
        t.pushed,
        t.reported,
      ]
    );
  }

  async loadAll(): Promise<{ workflows: WorkflowRecord[]; tasks: TaskAccountEntry[] }> {
    const wfRows = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM infer_workflows ORDER BY updated_at_ms ASC"
    );
    const taskRows = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM infer_task_account ORDER BY dispatched_at_ms ASC"
    );
    return {
      workflows: wfRows.map((row) => ({
        workflowId: String(row.workflow_id),
        status: String(row.status) as WorkflowRecord["status"],
        ...(row.endpoint_id !== null ? { endpointId: String(row.endpoint_id) } : {}),
        ...(row.error_code !== null ? { errorCode: String(row.error_code) as WorkflowRecord["errorCode"] } : {}),
        ...(row.final_output_uri !== null ? { finalOutputUri: String(row.final_output_uri) } : {}),
        ...(row.bindings_json !== null ? { bindingsJson: String(row.bindings_json) } : {}),
        ...(row.created_at_ms !== null ? { createdAtMs: Number(row.created_at_ms) } : {}),
        updatedAtMs: Number(row.updated_at_ms),
      })),
      tasks: taskRows.map((row) => ({
        taskId: String(row.task_id),
        requestId: String(row.request_id),
        workflowId: String(row.workflow_id),
        nodeId: String(row.node_id),
        endpointId: String(row.endpoint_id),
        modelKey: String(row.model_key),
        inputKey: String(row.input_key),
        outputKey: String(row.output_key),
        priority: String(row.priority) as TaskAccountEntry["priority"],
        dispatchedAtMs: Number(row.dispatched_at_ms),
        pushed: Boolean(row.pushed),
        reported: Boolean(row.reported),
      })),
    };
  }
}

// ── 组合根单例 ──────────────────────────────────────────────────────────────

const globalForStore = globalThis as unknown as {
  __inferLedgerStore?: LedgerStore;
  __inferLedgerStoreWarned?: boolean;
};

/** 存储工厂：DATABASE_URL 配置 → pg（init 失败 fail-fast）；未配置 → 内存 + 一次性告警 */
export function createLedgerStore(env: Record<string, string | undefined> = process.env): LedgerStore {
  if (!env.DATABASE_URL) {
    if (!globalForStore.__inferLedgerStoreWarned) {
      globalForStore.__inferLedgerStoreWarned = true;
      console.warn(
        "[ledger-store] DATABASE_URL 未配置：账本运行于内存模式（重启丢失）；" +
          "生产部署必须配置 Postgres（D7 /db 持久化）"
      );
    }
    return new InMemoryLedgerStore();
  }
  // kit /db 延迟加载（避免无 DATABASE_URL 时拉入 pg 依赖初始化路径）
  const { createSqlDb } = require("yunzone-service-kit/db") as typeof import("yunzone-service-kit/db");
  return new PgLedgerStore(createSqlDb({ channel: "postgres" }, env));
}

/** 同步取已创建单例（未创建时惰性创建；init 由 ensureLedgerStore 在启动期执行） */
export function getLedgerStore(): LedgerStore {
  globalForStore.__inferLedgerStore ??= createLedgerStore();
  return globalForStore.__inferLedgerStore;
}

/** 启动期初始化（instrumentation register 调用）：probe + DDL，失败 fail-fast */
export async function ensureLedgerStore(): Promise<LedgerStore> {
  const store = getLedgerStore();
  await store.init();
  return store;
}
