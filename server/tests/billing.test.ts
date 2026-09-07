/**
 * 计量单测（P2 批次 C）：模型目录解析 / 计费金额（上报难度优先）/ 预估 / 结算
 * （内存 store 台账 + /points 未配置三态跳过）。
 */

import { describe, expect, it } from "vitest";
import {
  estimateCost,
  getModelCatalog,
  resolveCost,
  settleTaskCompletion,
} from "../lib/billing";
import { getLedgerStore } from "../lib/ledger-store";

const CATALOG_ENV = {
  INFER_MODEL_CATALOG: JSON.stringify({
    "models/p0-stub": { unitPrice: 10, staticDifficulty: 1.5 },
    "models/free": { unitPrice: 0, staticDifficulty: 1 },
  }),
};

describe("model catalog + 计费金额（D12/V13）", () => {
  it("目录解析：合法条目收编，非法/零单价剔除", () => {
    const catalog = getModelCatalog(CATALOG_ENV);
    expect(catalog.get("models/p0-stub")).toEqual({ unitPrice: 10, staticDifficulty: 1.5 });
    expect(catalog.has("models/free")).toBe(false); // unitPrice=0 剔除
  });

  it("resolveCost：上报难度优先，缺省用静态值；向上取整", () => {
    expect(resolveCost("models/p0-stub", undefined, CATALOG_ENV)).toEqual({ points: 15, difficulty: 1.5 });
    expect(resolveCost("models/p0-stub", 2, CATALOG_ENV)).toEqual({ points: 20, difficulty: 2 });
    expect(resolveCost("models/unknown", undefined, CATALOG_ENV)).toBeNull(); // 不可计费
  });

  it("estimateCost：Σ(单价×难度)；目录缺失模型计 0（免费语义）", () => {
    expect(estimateCost(["models/p0-stub", "models/p0-stub"], CATALOG_ENV)).toBe(30);
    expect(estimateCost(["models/unknown"], CATALOG_ENV)).toBe(0);
  });
});

describe("settleTaskCompletion（完成即 deduct 链路）", () => {
  it("reward 台账落库 + 同 (client,task) 幂等 + /points 未配置跳过实扣", async () => {
    const base = {
      taskId: "t-bill",
      workflowId: "wf-bill",
      endpointId: "ep-1",
      providerAccountId: "provider-1",
      consumerAccountId: "consumer-1",
      modelKey: "models/p0-stub",
      reportedDifficulty: 2,
    };
    await settleTaskCompletion(base); // 测试环境无 POINTS_BASE_URL → 仅台账
    await settleTaskCompletion(base); // 重放：UNIQUE(client_id, task_id) 幂等
    const store = getLedgerStore();
    const rewards = await store.listRewards("provider-1");
    const mine = rewards.filter((r) => r.taskId === "t-bill");
    expect(mine).toHaveLength(1);
    expect(mine[0].points).toBe(20); // 2 × 10
    expect(mine[0].status).toBe("confirmed");
  });
});
