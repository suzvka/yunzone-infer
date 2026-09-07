/**
 * 调度器单测（D9 MVP / 批次 C）：单端点覆盖选择、贪心余量、IO 复核、拒绝路径、键规划。
 */

import { describe, expect, it } from "vitest";
import type { EndpointCapability } from "../lib/contracts";
import { bindWorkflow, planObjectKeys } from "../lib/scheduler";
import type { EndpointEntry } from "../lib/endpoint-registry";

/** 对拍图（P0 parity 同构）：model_node（x→y）+ add_node（a,b→sum） */
function parityGraph(): Record<string, unknown> {
  const floatPort = (name: string) => ({ name, tensorType: "Float", typeSize: 4, shape: [], required: true });
  return {
    version: "1.0",
    nodes: [
      { name: "model_node", type: "P0StubModel", affinity: "Operator", inputs: [floatPort("x")], outputs: [floatPort("y")] },
      { name: "add_node", type: "Add", affinity: "Operator", inputs: [floatPort("a"), floatPort("b")], outputs: [floatPort("sum")] },
    ],
    edges: [{ srcNode: "model_node", srcPort: "y", dstNode: "add_node", dstPort: "a" }],
    inputBindings: [
      { nodeName: "model_node", portName: "x" },
      { nodeName: "add_node", portName: "b" },
    ],
    outputBindings: [{ nodeName: "add_node", portName: "sum" }],
  };
}

function entry(
  endpointId: string,
  models: EndpointCapability["models"]
): EndpointEntry {
  return {
    endpointId,
    accountId: null,
    capability: { version: 1, models, vramFreeBytes: null },
    lastSeenMs: Date.now(),
  };
}

const stubModelIo = {
  inputs: [{ name: "x", tensorType: "Float", typeSize: 4, shape: [], required: true }],
  outputs: [{ name: "y", tensorType: "Float", typeSize: 4, shape: [], required: true }],
};

const INTENTS = [{ nodeId: "model_node", modelKey: "models/p0-stub" }];

describe("bindWorkflow（D9 MVP 整图单端点）", () => {
  it("单端点覆盖 → 绑定成功，bindings 为对象键语义", () => {
    const result = bindWorkflow({
      workflowId: "wf-1",
      graph: parityGraph(),
      intents: INTENTS,
      endpoints: [entry("ep-1", [{ modelKey: "models/p0-stub", queueRemaining: 4, io: stubModelIo }])],
    });
    expect(result).toMatchObject({ ok: true, endpointId: "ep-1" });
    if (result.ok) {
      expect(result.bindings).toEqual([
        {
          nodeId: "model_node",
          modelKey: "models/p0-stub",
          outputUri: "workflows/wf-1/nodes/model_node/output",
          inputs: [{ port: "x", uri: "workflows/wf-1/inputs/model_node/x" }],
        },
      ]);
    }
  });

  it("多端点可服务 → queueTotalRemaining 最大者胜出", () => {
    const result = bindWorkflow({
      workflowId: "wf-2",
      graph: parityGraph(),
      intents: INTENTS,
      endpoints: [
        entry("ep-small", [{ modelKey: "models/p0-stub", queueRemaining: 1, io: stubModelIo }]),
        entry("ep-big", [
          { modelKey: "models/p0-stub", queueRemaining: 3, io: stubModelIo },
          { modelKey: "models/other", queueRemaining: 5 },
        ]),
      ],
    });
    expect(result).toMatchObject({ ok: true, endpointId: "ep-big" });
  });

  it("模型未登记 → 拒绝（归因含端点与模型）", () => {
    const result = bindWorkflow({
      workflowId: "wf-3",
      graph: parityGraph(),
      intents: INTENTS,
      endpoints: [entry("ep-1", [{ modelKey: "models/other", queueRemaining: 4 }])],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("models/p0-stub");
  });

  it("IO 不匹配（shape 维度不符）→ 拒绝", () => {
    const mismatchedIo = {
      inputs: [{ name: "x", tensorType: "Float", typeSize: 4, shape: [1, 2], required: true }],
      outputs: stubModelIo.outputs,
    };
    const result = bindWorkflow({
      workflowId: "wf-4",
      graph: parityGraph(),
      intents: INTENTS,
      endpoints: [entry("ep-1", [{ modelKey: "models/p0-stub", queueRemaining: 4, io: mismatchedIo }])],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("shape");
  });

  it("队列余量为 0 → 拒绝（反压前置）", () => {
    const result = bindWorkflow({
      workflowId: "wf-5",
      graph: parityGraph(),
      intents: INTENTS,
      endpoints: [entry("ep-1", [{ modelKey: "models/p0-stub", queueRemaining: 0, io: stubModelIo }])],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("余量为 0");
  });

  it("无存活端点 → 拒绝", () => {
    const result = bindWorkflow({
      workflowId: "wf-6",
      graph: parityGraph(),
      intents: INTENTS,
      endpoints: [],
    });
    expect(result.ok).toBe(false);
  });

  it("空 intents（纯本地图）→ 绑定通过且无端点", () => {
    const result = bindWorkflow({
      workflowId: "wf-7",
      graph: parityGraph(),
      intents: [],
      endpoints: [],
    });
    expect(result).toEqual({ ok: true, endpointId: "", bindings: [] });
  });
});

describe("planObjectKeys（对象键规则）", () => {
  it("工作流级前缀：inputs / nodes output / final", () => {
    const keys = planObjectKeys("wf-9");
    expect(keys.remoteInputKey("n1", "p")).toBe("workflows/wf-9/inputs/n1/p");
    expect(keys.remoteOutputKey("n1")).toBe("workflows/wf-9/nodes/n1/output");
    expect(keys.localInputKey("n2", "b")).toBe("workflows/wf-9/inputs/n2/b");
    expect(keys.finalKey()).toBe("workflows/wf-9/final.out");
  });
});
