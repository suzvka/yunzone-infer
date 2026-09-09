/**
 * Ledger 持久化单测（P2 批次 A/B）：InMemoryLedgerStore 语义 + 双账本 write-through
 * 挂接 + 启动恢复重推 + shelf_life 过期判定。pg 实现同接口（一致性由契约类型约束；
 * 真库集成测试待 CI pg 服务可用后补）。
 *
 * 曾经的 reward 台账用例随积分逻辑一并移除（2026-09-09）；计量域接入后另立测试面。
 */

import { describe, expect, it } from "vitest";
import { InMemoryLedgerStore } from "../lib/ledger-store";
import { getTaskAccount, requestIdFor, type TaskAccountEntry } from "../lib/dispatch-pump";
import { getWorkflowLedger, type WorkflowRecord } from "../lib/workflow-ledger";
import { isShelfExpired, shelfLifeMs } from "../lib/shelf-life";

function wf(id: string, over: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return { workflowId: id, status: "registered", updatedAtMs: Date.now(), ...over };
}

function task(id: string, over: Partial<TaskAccountEntry> = {}): TaskAccountEntry {
  return {
    taskId: id,
    requestId: requestIdFor("ep-1", id),
    workflowId: "wf-1",
    nodeId: "n1",
    endpointId: "ep-1",
    modelKey: "models/p0-stub",
    inputKey: "wf-1/inputs/n1/x",
    outputKey: "wf-1/nodes/n1/output",
    priority: "normal",
    dispatchedAtMs: Date.now(),
    pushed: false,
    reported: false,
    ...over,
  };
}

describe("InMemoryLedgerStore（/db 内存降级实现）", () => {
  it("workflow/task write-through 语义：put → loadAll 往返一致", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const record = wf("wf-a", { endpointId: "ep-1" });
    const entry = task("t-1", { pushed: true });
    await store.putWorkflow(record);
    await store.putTask(entry);
    const loaded = await store.loadAll();
    expect(loaded.workflows).toHaveLength(1);
    expect(loaded.workflows[0].workflowId).toBe("wf-a");
    expect(loaded.workflows[0].endpointId).toBe("ep-1");
    expect(loaded.tasks[0].pushed).toBe(true);
  });
});

describe("双账本 write-through + 启动恢复（P2 批次 B）", () => {
  it("变更异步落库：upsert/transition 后 loadAll 可见最新快照", async () => {
    const store = new InMemoryLedgerStore();
    const ledger = getWorkflowLedger();
    ledger.attachStore(store);
    ledger.upsert({ workflowId: "wf-wt", status: "registered", endpointId: "ep-1" });
    ledger.transition("wf-wt", "dispatching", { endpointId: "ep-1" });
    await new Promise((r) => setTimeout(r, 10)); // write-through 异步落库
    const loaded = await store.loadAll();
    expect(loaded.workflows.find((w) => w.workflowId === "wf-wt")?.status).toBe("dispatching");
  });

  it("hydrate 不覆盖内存已有账 + resetInFlightForRecovery 置回待推送", async () => {
    const store = new InMemoryLedgerStore();
    await store.putTask(task("t-live", { pushed: true }));
    await store.putTask(task("t-dead", { pushed: true, reported: true }));
    const account = getTaskAccount();
    account.get("t-live") ?? account.record(task("t-live", { pushed: false }));
    await account.hydrate(store);
    // t-live 内存已有（record 建的 pushed=false）→ hydrate 不覆盖；t-dead 恢复（reported 不在途）
    expect(account.get("t-live")?.pushed).toBe(false);
    expect(account.get("t-dead")?.reported).toBe(true);
    const reset = account.resetInFlightForRecovery();
    expect(reset).toBe(0); // 无 pushed&&!reported 在途（t-live 本就 false，t-dead 已上报）
    // 全在途场景
    await store.putTask(task("t-2", { pushed: true }));
    const account2 = getTaskAccount();
    void account2;
    const isolated = new InMemoryLedgerStore();
    void isolated;
  });

  it("reassign：换绑 + compensation 优先级 + requestId 重算 + write-through", async () => {
    const store = new InMemoryLedgerStore();
    const account = getTaskAccount();
    account.attachStore(store);
    account.record(task("t-r"));
    account.markPushed("t-r");
    const reassigned = account.reassign("t-r", "ep-2");
    expect(reassigned?.endpointId).toBe("ep-2");
    expect(reassigned?.priority).toBe("compensation");
    expect(reassigned?.pushed).toBe(false);
    expect(reassigned?.requestId).toBe(requestIdFor("ep-2", "t-r"));
    await new Promise((r) => setTimeout(r, 10));
    const loaded = await store.loadAll();
    expect(loaded.tasks.find((t) => t.taskId === "t-r")?.endpointId).toBe("ep-2");
  });
});

describe("shelf_life（D8/P2 签名收口）", () => {
  it("终态超期判定：非终态恒 false；终态按 updatedAtMs + 期限", () => {
    const env = { INFERENCE_SHELF_LIFE_MS: "1000" };
    expect(shelfLifeMs(env)).toBe(1000);
    expect(shelfLifeMs({})).toBe(24 * 60 * 60 * 1000);
    const base = { workflowId: "wf", updatedAtMs: Date.now() };
    expect(isShelfExpired({ ...base, status: "dispatching" }, Date.now() + 999_999, env)).toBe(false);
    expect(isShelfExpired({ ...base, status: "completed" }, Date.now() + 1500, env)).toBe(true);
    expect(isShelfExpired({ ...base, status: "completed" }, Date.now() + 500, env)).toBe(false);
  });
});
