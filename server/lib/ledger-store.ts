/**
 * Ledger 持久化存储位（D7 /db，P2 批次 A）— kit /db（SQL 抽象）消费
 *
 * 分层持久化策略（拍板：pg 为主 + 内存降级，与 /auth 三态同构）：
 * - 工作流账 / 任务账：**内存权威 + pg write-through + 启动恢复**——状态可重建
 *   （重派/恢复兜底），最佳努力持久化（崩溃丢最近写由重启重推 + requestId 幂等
 *   + 懒惰撤销收敛）；调用点保持同步语义零改动。
 * - reward 台账（D12 计费流水）：**pg 权威**——资金面必须可靠落库（UNIQUE 幂等），
 *   无内存态（读走 pg）；内存降级模式下记账拒绝（不虚记账目）。
 *
 * 渠道（kit /db 契约）：DATABASE_URL 配置 → postgres 渠道（init probe + DDL，
 * 失败 fail-fast）；未配置 → 内存 + 进程级一次性告警（dev/CI 兼容）。
 */

import type { WorkflowRecord } from "./workflow-ledger";
import type { TaskAccountEntry } from "./dispatch-pump";

/** provider 侧计费台账行（deposit-model.md §3.1：infer_reward_ledger） */
export interface RewardLedgerRow {
  id: string;
  /** 算力提供者端点（经 /auth 注册绑定 accountId） */
  clientId: string;
  /** 对应平台账户（uc 侧） */
  accountId: string;
  taskId: string;
  workflowId: string;
  /** 本次报酬（正整数）＝ 模型单价 × 难度系数（D12/V13） */
  points: number;
  /** 难度系数（模型难度钩子计算值；P2 = 静态目录值，client 上报值 P3） */
  difficulty?: number;
  /** pending | confirmed | deposited | frozen */
  status: string;
}

export interface LedgerStore {
  readonly kind: "pg" | "memory";
  /** pg：连接 probe + DDL 建表（幂等）；memory：no-op */
  init(): Promise<void>;
  /** write-through 持久化（内存权威下的副本写入；失败由调用方告警不抛） */
  putWorkflow(record: WorkflowRecord): Promise<void>;
  putTask(entry: TaskAccountEntry): Promise<void>;
  /** 启动恢复：全量加载（内存权威 hydrate 数据源） */
  loadAll(): Promise<{ workflows: WorkflowRecord[]; tasks: TaskAccountEntry[] }>;
  /** reward 台账（pg 权威；内存降级模式 reject） */
  insertReward(row: RewardLedgerRow): Promise<void>;
  listRewards(accountId?: string): Promise<RewardLedgerRow[]>;
}

// ── 内存实现（dev/CI 降级；reward 记账拒绝）────────────────────────────────

export class InMemoryLedgerStore implements LedgerStore {
  readonly kind = "memory" as const;
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly tasks = new Map<string, TaskAccountEntry>();
  private readonly rewards = new Map<string, RewardLedgerRow>();

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

  async insertReward(row: RewardLedgerRow): Promise<void> {
    // UNIQUE(client_id, task_id) 幂等（与 pg ON CONFLICT DO NOTHING 同语义）
    const dup = [...this.rewards.values()].some(
      (r) => r.clientId === row.clientId && r.taskId === row.taskId
    );
    if (dup) return;
    this.rewards.set(row.id, { ...row });
  }

  async listRewards(accountId?: string): Promise<RewardLedgerRow[]> {
    const all = [...this.rewards.values()];
    return accountId ? all.filter((r) => r.accountId === accountId) : all;
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
     consumer_account_id TEXT,
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
  `CREATE TABLE IF NOT EXISTS infer_reward_ledger (
     id TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     account_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     workflow_id TEXT NOT NULL,
     points INTEGER NOT NULL,
     difficulty REAL,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (client_id, task_id)
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
         (workflow_id, status, endpoint_id, error_code, final_output_uri, consumer_account_id, bindings_json, created_at_ms, updated_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (workflow_id) DO UPDATE SET
         status=$2, endpoint_id=$3, error_code=$4, final_output_uri=$5,
         consumer_account_id=$6, bindings_json=$7, updated_at_ms=$9`,
      [
        r.workflowId,
        r.status,
        r.endpointId ?? null,
        r.errorCode ?? null,
        r.finalOutputUri ?? null,
        r.consumerAccountId ?? null,
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
        ...(row.consumer_account_id !== null ? { consumerAccountId: String(row.consumer_account_id) } : {}),
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

  async insertReward(row: RewardLedgerRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO infer_reward_ledger (id, client_id, account_id, task_id, workflow_id, points, difficulty, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (client_id, task_id) DO NOTHING`,
      [row.id, row.clientId, row.accountId, row.taskId, row.workflowId, row.points, row.difficulty ?? null, row.status]
    );
  }

  async listRewards(accountId?: string): Promise<RewardLedgerRow[]> {
    const rows = accountId
      ? await this.db.query<Record<string, unknown>>(
          "SELECT * FROM infer_reward_ledger WHERE account_id = $1 ORDER BY created_at ASC",
          [accountId]
        )
      : await this.db.query<Record<string, unknown>>(
          "SELECT * FROM infer_reward_ledger ORDER BY created_at ASC"
        );
    return rows.map((row) => ({
      id: String(row.id),
      clientId: String(row.client_id),
      accountId: String(row.account_id),
      taskId: String(row.task_id),
      workflowId: String(row.workflow_id),
      points: Number(row.points),
      ...(row.difficulty !== null ? { difficulty: Number(row.difficulty) } : {}),
      status: String(row.status),
    }));
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
        "[ledger-store] DATABASE_URL 未配置：账本运行于内存模式（重启丢失，reward 台账不可用）；" +
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
