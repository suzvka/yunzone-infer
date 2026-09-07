/**
 * 模型目录与计费（D12/V13，P2 批次 C）
 *
 * 模型报价 = 单价 × 难度系数：
 * - 单价 + 静态难度：控制面持有（INFER_MODEL_CATALOG env JSON）——单价是消费者侧
 *   价格，**不由端点自报**（不信任域）；P2 难度取静态目录值，client 真钩子计算值
 *   （completion-report.difficulty）P3 接入——上报值优先于静态值（存在即用）。
 * - 扣费链路（拍板：完成即 deduct）：完成上报成功 → ① provider 侧 reward 台账
 *   落库（pg 权威，UNIQUE(client_id,task_id) 幂等）② kit /points deduct（消费者
 *   accountId，requestId = deduct:{taskId} 派生幂等）。
 * - 三态降级（与 /auth 同构）：POINTS_BASE_URL 未配置 → 仅台账不实扣 + 一次性告警；
 *   台账存储（/db）内存模式 → 记账拒绝告警（不虚记账目）。
 */

import type { PointsClient } from "yunzone-service-kit/points";
import type { RewardLedgerRow } from "./ledger-store";

export interface ModelPricing {
  /** 模型单价（积分/次） */
  unitPrice: number;
  /** 静态难度系数（P2；client 钩子计算值 P3 优先） */
  staticDifficulty: number;
}

export interface TaskSettlement {
  taskId: string;
  workflowId: string;
  /** 提供者端点（reward 台账 client_id） */
  endpointId: string;
  /** 提供者平台账户（完成上报的机器凭证 introspect） */
  providerAccountId: string;
  /** 消费者平台账户（提交账 consumerAccountId） */
  consumerAccountId?: string;
  modelKey: string;
  /** 端点上报纸道难度（可缺省 → 静态目录值） */
  reportedDifficulty?: number;
}

const globalForBilling = globalThis as unknown as {
  __inferModelCatalog?: Map<string, ModelPricing>;
  __inferPointsClient?: PointsClient | null;
  __inferPointsWarned?: boolean;
  __inferCatalogWarned?: boolean;
};

/** 模型目录解析（env JSON：{modelKey: {unitPrice, staticDifficulty}}；进程内缓存） */
export function getModelCatalog(env: Record<string, string | undefined> = process.env): Map<string, ModelPricing> {
  if (globalForBilling.__inferModelCatalog) return globalForBilling.__inferModelCatalog;
  const catalog = new Map<string, ModelPricing>();
  const raw = env.INFER_MODEL_CATALOG;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<ModelPricing>>;
      for (const [modelKey, pricing] of Object.entries(parsed)) {
        if (typeof pricing?.unitPrice === "number" && pricing.unitPrice > 0 && typeof pricing.staticDifficulty === "number") {
          catalog.set(modelKey, { unitPrice: pricing.unitPrice, staticDifficulty: pricing.staticDifficulty });
        }
      }
    } catch (e) {
      console.warn(`[model-catalog] INFER_MODEL_CATALOG 解析失败（计费目录为空）: ${(e as Error).message}`);
    }
  } else if (!globalForBilling.__inferCatalogWarned) {
    globalForBilling.__inferCatalogWarned = true;
    console.warn("[model-catalog] INFER_MODEL_CATALOG 未配置：模型不可计费（完成上报仅记账元数据）");
  }
  globalForBilling.__inferModelCatalog = catalog;
  return catalog;
}

/** 计费金额解析：难度取上报值优先（V13 自报信任语义），无目录 → null（不可计费） */
export function resolveCost(
  modelKey: string,
  reportedDifficulty?: number,
  env: Record<string, string | undefined> = process.env
): { points: number; difficulty: number } | null {
  const pricing = getModelCatalog(env).get(modelKey);
  if (!pricing) return null;
  const difficulty = typeof reportedDifficulty === "number" && reportedDifficulty > 0 ? reportedDifficulty : pricing.staticDifficulty;
  // 积分为正整数：难度 × 单价向上取整（单价为最小计费粒度）
  return { points: Math.max(1, Math.ceil(difficulty * pricing.unitPrice)), difficulty };
}

/** 提交预检：预估成本 = Σ(远程节点 单价×难度)；目录缺失的模型不计入（不可计费模型免费语义） */
export function estimateCost(modelKeys: readonly string[], env: Record<string, string | undefined> = process.env): number {
  return modelKeys.reduce((sum, key) => sum + (resolveCost(key, undefined, env)?.points ?? 0), 0);
}

/** kit /points 客户端（三态：未配置 → null + 一次性告警；配置 → 单例） */
export function getPointsClient(env: Record<string, string | undefined> = process.env): PointsClient | null {
  if (globalForBilling.__inferPointsClient !== undefined) return globalForBilling.__inferPointsClient;
  const baseUrl = env.POINTS_BASE_URL;
  if (!baseUrl) {
    if (!globalForBilling.__inferPointsWarned) {
      globalForBilling.__inferPointsWarned = true;
      console.warn(
        "[billing] POINTS_BASE_URL 未配置：/points 实扣关闭（仅内部台账）；生产部署必须配置（D12 计量）"
      );
    }
    globalForBilling.__inferPointsClient = null;
    return null;
  }
  const { createPointsClient } = require("yunzone-service-kit/points") as typeof import("yunzone-service-kit/points");
  globalForBilling.__inferPointsClient = createPointsClient({
    baseUrl,
    apiKey: env.INFER_SERVICE_CREDENTIAL,
  });
  return globalForBilling.__inferPointsClient;
}

/**
 * 任务结算（完成上报成功后调用；**不抛错**——计费失败不阻塞回收主链路，幂等键
 * 在可安全重放）：① reward 台账落库（pg 权威 / 内存模式拒绝告警）② /points deduct
 * （未配置跳过；协议失败告警，同一 requestId 重试安全）。
 */
export async function settleTaskCompletion(task: TaskSettlement): Promise<void> {
  const cost = resolveCost(task.modelKey, task.reportedDifficulty);
  if (!cost) {
    console.warn(`[billing] task ${task.taskId} model ${task.modelKey} 不在计费目录，跳过结算`);
    return;
  }
  const { getLedgerStore } = await import("./ledger-store");
  const store = getLedgerStore();
  const row: RewardLedgerRow = {
    id: `reward:${task.taskId}:${task.endpointId}`,
    clientId: task.endpointId,
    accountId: task.providerAccountId,
    taskId: task.taskId,
    workflowId: task.workflowId,
    points: cost.points,
    difficulty: cost.difficulty,
    status: "confirmed",
  };
  try {
    await store.insertReward(row);
  } catch (e) {
    console.error(`[billing] reward ledger insert failed (task ${task.taskId}): ${(e as Error).message}`);
  }

  const points = getPointsClient();
  if (!points) return; // 三态：仅台账（getPointsClient 首次已告警）
  if (!task.consumerAccountId) {
    console.warn(`[billing] task ${task.taskId} 无消费者账户（旧账/放行态），跳过实扣`);
    return;
  }
  try {
    const result = await points.deduct({
      requestId: `deduct:${task.taskId}`,
      accountId: task.consumerAccountId,
      points: cost.points,
      metadata: { taskId: task.taskId, workflowId: task.workflowId, modelKey: task.modelKey, difficulty: cost.difficulty },
    });
    if (!result.ok) {
      console.warn(`[billing] deduct rejected (task ${task.taskId}): ${result.reason ?? "unknown"}`);
    }
  } catch (e) {
    // 协议失败：服务端是否入账不可确知——同一 requestId 幂等，可安全重试（运维补偿重放）
    console.error(`[billing] deduct failed (task ${task.taskId}, requestId=deduct:${task.taskId}): ${(e as Error).message}`);
  }
}
