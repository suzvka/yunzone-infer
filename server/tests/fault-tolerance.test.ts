/**
 * 容错场景测试（P2 批次 E，D8/D9 容错验收）：
 * ① 端点掉线 → TTL sweep → onExpired 钩子 → 在途任务重派他端点（补偿优先级）
 * ② 控制面重启 → pg/内存账本恢复 → 在途任务重置待推送（requestId 幂等 + 懒惰撤销兜底）
 * 过载反压 / 撤销下发已由 dispatch-backpressure.test.ts 覆盖；shelf_life 判定由
 * ledger-store.test.ts 覆盖。
 */

import { describe, expect, it } from "vitest";
import type { EndpointCapability } from "../lib/contracts";
import { EndpointRegistry } from "../lib/endpoint-registry";
import { requestIdFor, reassignInFlightTasks, getTaskAccount, type TaskAccountEntry } from "../lib/dispatch-pump";
import { InMemoryLedgerStore } from "../lib/ledger-store";

function capability(modelKey: string, queueRemaining = 8): EndpointCapability {
  return {
    version: 1,
    models: [
      {
        modelKey,
        queueRemaining,
        io: {
          inputs: [{ name: "x", tensorType: "Float", typeSize: 4, shape: [], required: true }],
          outputs: [{ name: "y", tensorType: "Float", typeSize: 4, shape: [], required: true }],
        },
      },
    ],
    vramFreeBytes: null,
  };
}

function task(id: string, endpointId: string, over: Partial<TaskAccountEntry> = {}): TaskAccountEntry {
  return {
    taskId: id,
    requestId: requestIdFor(endpointId, id),
    workflowId: "wf-ft",
    nodeId: "model_node",
    endpointId,
    modelKey: "models/p0-stub",
    inputKey: `wf-ft/inputs/model_node/x`,
    outputKey: `wf-ft/nodes/model_node/output`,
    priority: "normal",
    dispatchedAtMs: Date.now(),
    pushed: true,
    reported: false,
    ...over,
  };
}

describe("容错：端点掉线 → TTL 判死 → 在途重派（D7）", () => {
  it("sweep 钩子触发重派：ep-a 掉线 → 任务换绑 ep-b（compensation）", () => {
    let clock = Date.now();
    const expired: string[] = [];
    const registry = new EndpointRegistry({
      now: () => clock,
      ttlMs: 90_000,
      onExpired: (ids) => {
        expired.push(...ids);
        reassignInFlightTasks(ids[0], registry.listAlive());
      },
    });
    registry.registerEndpoint("ep-a", capability("models/p0-stub"));
    registry.registerEndpoint("ep-b", capability("models/p0-stub", 4));

    const account = getTaskAccount();
    account.record(task("t-offline", "ep-a"));
    account.markPushed("t-offline");
    expect(account.get("t-offline")?.endpointId).toBe("ep-a");

    // TTL 推进：ep-a 掉线（无心跳）；ep-b 持续心跳（lastSeen 随 clock 刷新）
    clock += 91_000;
    registry.heartbeat("ep-b", capability("models/p0-stub", 4));
    registry.listAlive();
    expect(expired).toContain("ep-a");
    const after = account.get("t-offline");
    expect(after?.endpointId).toBe("ep-b");
    expect(after?.priority).toBe("compensation");
    expect(after?.pushed).toBe(false);
    expect(after?.requestId).toBe(requestIdFor("ep-b", "t-offline"));
  });

  it("全部端点掉线 → 任务暂挂原账（等重注册），不丢账", () => {
    let clock = Date.now();
    const registry = new EndpointRegistry({ now: () => clock, ttlMs: 90_000 });
    registry.registerEndpoint("ep-solo", capability("models/p0-stub"));
    const account = getTaskAccount();
    account.record(task("t-hang", "ep-solo"));
    account.markPushed("t-hang");

    clock += 91_000;
    reassignInFlightTasks("ep-solo", registry.listAlive()); // listAlive 为空
    const after = account.get("t-hang");
    expect(after?.endpointId).toBe("ep-solo"); // 暂挂原账
    expect(after?.reported).toBe(false);
  });
});

describe("容错：控制面重启 → 账本恢复 → 在途重推（P2 /db）", () => {
  it("重启模拟：隔离实例 hydrate → in-flight 重置待推送 → 泵可重派", async () => {
    const store = new InMemoryLedgerStore();
    // 「上次进程」：任务已推送未上报
    await store.putTask(task("t-recover", "ep-1", { pushed: true, reported: false }));
    await store.putTask(task("t-done", "ep-1", { pushed: true, reported: true }));

    // 「新进程」：隔离实例（避免全局单例跨用例污染）+ ensureTaskAccount 等价序列
    const { TaskAccount } = await import("../lib/dispatch-pump");
    const account = new TaskAccount();
    await account.hydrate(store);
    const reset = account.resetInFlightForRecovery();
    expect(reset).toBe(1); // 仅 t-recover（t-done 已上报不重推）
    expect(account.get("t-recover")?.pushed).toBe(false); // 泵可重推
    // requestId 保持原端点派生（重推同端点同 requestId → 端点侧幂等兜底重复执行）
    expect(account.get("t-recover")?.requestId).toBe(requestIdFor("ep-1", "t-recover"));
  });
});
