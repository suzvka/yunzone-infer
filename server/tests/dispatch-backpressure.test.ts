/**
 * 派发泵批次 E 单测：反压门控（D9 余量软控制）、暂缓重推、TTL 判死重派
 * （D7 补偿优先级 + requestId 重算）、终态撤销下发（标记式懒惰撤销）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDispatch, TaskRevoke, WorkflowStatusSnapshot } from "../lib/contracts";
import type { EndpointEntry } from "../lib/endpoint-registry";
import {
  getTaskAccount,
  pollSidecarDispatches,
  reassignInFlightTasks,
  revokeTasksOfWorkflow,
} from "../lib/dispatch-pump";

const singletons = globalThis as unknown as {
  __inferTaskAccount?: unknown;
};

beforeEach(() => {
  delete singletons.__inferTaskAccount;
});

const signer = async (key: string, method: "GET" | "PUT") => `signed:${method}:${key}`;

function fakeSidecar(workflows: { workflowId: string; status: string }[], pending: TaskDispatch[]) {
  return {
    ping: async () => ({ version: 1, ok: true, workflows }),
    status: async (_id: string): Promise<WorkflowStatusSnapshot | null> =>
      pending.length > 0
        ? { version: 1, workflowId: pending[0].workflowId, status: "starting", pendingDispatches: pending }
        : null,
  } as never;
}

function pendingDispatch(overrides: Partial<TaskDispatch> = {}): TaskDispatch {
  return {
    version: 1,
    type: "task.dispatch",
    taskId: "task-1",
    requestId: "req",
    workflowId: "wf-1",
    nodeId: "model_node",
    modelKey: "models/p0-stub",
    inputUri: "workflows/wf-1/inputs/model_node/x",
    outputUri: "workflows/wf-1/nodes/model_node/output",
    priority: "normal",
    ...overrides,
  };
}

function entry(endpointId: string, modelKey: string, queueRemaining: number): EndpointEntry {
  return {
    endpointId,
    accountId: null,
    capability: { version: 1, models: [{ modelKey, queueRemaining }], vramFreeBytes: null },
    lastSeenMs: Date.now(),
  };
}

describe("派发泵反压（D9 余量软控制）", () => {
  it("canDispatch=false → 不调 transport、不入账", async () => {
    const transport = vi.fn(async () => true);
    const dispatched = await pollSidecarDispatches(fakeSidecar([{ workflowId: "wf-1", status: "starting" }], [pendingDispatch()]), {
      signer,
      transport,
      resolveEndpoint: () => "ep-1",
      canDispatch: () => false,
    });
    expect(dispatched).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(getTaskAccount().get("task-1")).toBeNull();
  });

  it("transport=false（WS 未连）→ 记账待推，下轮重推成功", async () => {
    const pending = [pendingDispatch()];
    let online = false;
    const transport = vi.fn(async () => online);
    const options = {
      signer,
      transport,
      resolveEndpoint: () => "ep-1",
    };

    const first = await pollSidecarDispatches(fakeSidecar([{ workflowId: "wf-1", status: "starting" }], pending), options);
    expect(first).toEqual([]);
    expect(getTaskAccount().get("task-1")?.pushed).toBe(false);

    online = true; // WS 重连
    const second = await pollSidecarDispatches(fakeSidecar([{ workflowId: "wf-1", status: "starting" }], pending), options);
    expect(second).toHaveLength(1);
    expect(second[0].inputUri).toBe("signed:GET:workflows/wf-1/inputs/model_node/x");
    expect(getTaskAccount().get("task-1")?.pushed).toBe(true);

    // 已推送未上报：不重推
    const third = await pollSidecarDispatches(fakeSidecar([{ workflowId: "wf-1", status: "starting" }], pending), options);
    expect(third).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("TTL 判死重派（D7）", () => {
  it("在途任务换绑其他端点 + compensation + requestId 重算 + 待推送", () => {
    const account = getTaskAccount();
    account.record({
      taskId: "task-1",
      requestId: "old-req",
      workflowId: "wf-1",
      nodeId: "model_node",
      modelKey: "models/p0-stub",
      inputKey: "k-in",
      outputKey: "k-out",
      priority: "normal",
      dispatchedAtMs: Date.now(),
      endpointId: "ep-dead",
    });
    account.markPushed("task-1");

    const count = reassignInFlightTasks("ep-dead", [
      entry("ep-dead", "models/p0-stub", 0),
      entry("ep-small", "models/p0-stub", 1),
      entry("ep-big", "models/p0-stub", 3),
    ]);
    expect(count).toBe(1);
    const task = account.get("task-1")!;
    expect(task.endpointId).toBe("ep-big"); // 余量最大者
    expect(task.priority).toBe("compensation");
    expect(task.pushed).toBe(false);
    expect(task.requestId).not.toBe("old-req");
  });

  it("无替代端点 → 保持原账（暂挂）", () => {
    const account = getTaskAccount();
    account.record({
      taskId: "task-2",
      requestId: "req-2",
      workflowId: "wf-2",
      nodeId: "model_node",
      modelKey: "models/p0-stub",
      inputKey: "k-in",
      outputKey: "k-out",
      priority: "normal",
      dispatchedAtMs: Date.now(),
      endpointId: "ep-dead",
    });
    account.markPushed("task-2");

    const count = reassignInFlightTasks("ep-dead", [entry("ep-dead", "models/p0-stub", 0)]);
    expect(count).toBe(0);
    expect(account.get("task-2")?.endpointId).toBe("ep-dead");
  });
});

describe("终态撤销下发（标记式懒惰撤销）", () => {
  it("已推送未上报任务 → TaskRevoke 推送原派发端点", () => {
    const account = getTaskAccount();
    account.record({
      taskId: "task-3",
      requestId: "req-3",
      workflowId: "wf-3",
      nodeId: "model_node",
      modelKey: "models/p0-stub",
      inputKey: "k-in",
      outputKey: "k-out",
      priority: "normal",
      dispatchedAtMs: Date.now(),
      endpointId: "ep-1",
    });
    account.markPushed("task-3");
    account.record({
      taskId: "task-4",
      requestId: "req-4",
      workflowId: "wf-other",
      nodeId: "model_node",
      modelKey: "models/p0-stub",
      inputKey: "k-in",
      outputKey: "k-out",
      priority: "normal",
      dispatchedAtMs: Date.now(),
      endpointId: "ep-1",
    });
    account.markPushed("task-4");

    const pushes: TaskRevoke[] = [];
    const revoked = revokeTasksOfWorkflow("wf-3", (_endpointId, revoke) => {
      pushes.push(revoke);
      return true;
    });
    expect(revoked).toBe(1);
    expect(pushes).toEqual([
      { version: 1, type: "task.revoke", taskId: "task-3", endpointId: "ep-1", reason: "workflow-finalized" },
    ]);
  });
});
