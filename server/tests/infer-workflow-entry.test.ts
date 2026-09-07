/**
 * 推理入口单测（批次 C）：检视拒绝路径 + 正常启动（mock sidecar IPC）。
 * registry/ledger 走 globalThis 单例 → 每用例重置；auth 未配置 = 放行态。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StartWorkflowRequest } from "../lib/contracts";

// sidecar IPC mock（正常启动路径捕获 StartWorkflowRequest）
const startWorkflowMock = vi.fn(async (_request: StartWorkflowRequest) => {});
vi.mock("../lib/sidecar-supervisor", () => ({
  getIpcSidecarClient: () => ({
    startWorkflow: startWorkflowMock,
    status: async () => null,
    ping: async () => null,
    notifyNodeCompletion: async () => {},
  }),
  getSidecarSupervisor: () => null,
}));

import { POST } from "../app/api/infer/workflows/route";
import { getEndpointRegistry } from "../lib/endpoint-registry";
import { getWorkflowLedger } from "../lib/workflow-ledger";

const singletons = globalThis as unknown as {
  __inferEndpointRegistry?: unknown;
  __inferWorkflowLedger?: unknown;
  __inferBusSigner?: unknown;
};

/** 对拍图（P0 parity 同构）+ 端点 io 声明（同构直出语义） */
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

function submitRequest(body: unknown): Request {
  return new Request("http://localhost/api/infer/workflows", {
    method: "POST",
    headers: { authorization: "Bearer user-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  delete singletons.__inferEndpointRegistry;
  delete singletons.__inferWorkflowLedger;
  delete singletons.__inferBusSigner;
  startWorkflowMock.mockClear();
});

describe("POST /api/infer/workflows", () => {
  it("无存活端点覆盖意图 → 422 E_INSPECTION_REJECTED + ledger rejected", async () => {
    const res = await POST(
      submitRequest({ graph: parityGraph(), remoteNodes: [{ nodeId: "model_node", modelKey: "models/p0-stub" }] })
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errorCode?: string };
    expect(body.errorCode).toBe("E_INSPECTION_REJECTED");
  });

  it("正常启动 → 202 dispatching；StartWorkflowRequest 对象键/URL 双语义正确", async () => {
    const registry = getEndpointRegistry();
    registry.registerEndpoint("ep-1", {
      version: 1,
      models: [
        {
          modelKey: "models/p0-stub",
          queueRemaining: 4,
          io: {
            inputs: [{ name: "x", tensorType: "Float", typeSize: 4, shape: [], required: true }],
            outputs: [{ name: "y", tensorType: "Float", typeSize: 4, shape: [], required: true }],
          },
        },
      ],
      vramFreeBytes: null,
    });

    const res = await POST(
      submitRequest({
        graph: parityGraph(),
        remoteNodes: [{ nodeId: "model_node", modelKey: "models/p0-stub" }],
        localInputs: [{ node: "add_node", port: "b" }],
      })
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { version: number; workflowId: string; status: string };
    expect(body.version).toBe(1);
    expect(body.status).toBe("dispatching");

    expect(startWorkflowMock).toHaveBeenCalledTimes(1);
    const started = startWorkflowMock.mock.calls[0][0] as StartWorkflowRequest;
    expect(started.workflowId).toBe(body.workflowId);
    expect(started.bindingPlan.remoteNodes).toEqual([
      {
        nodeId: "model_node",
        modelKey: "models/p0-stub",
        outputUri: `workflows/${body.workflowId}/nodes/model_node/output`,
        inputs: [{ port: "x", uri: `workflows/${body.workflowId}/inputs/model_node/x` }],
      },
    ]);
    // finalOutputUri / workflowInputs 为已签 URL（替身 signer 直链）
    expect(started.finalOutputUri).toContain(`/objects/workflows/${body.workflowId}/final.out`);
    expect(started.workflowInputs).toEqual([
      { node: "add_node", port: "b", uri: expect.stringContaining(`/objects/workflows/${body.workflowId}/inputs/add_node/b`) },
    ]);

    // ledger 推进 + endpointId 绑定
    const record = getWorkflowLedger().get(body.workflowId);
    expect(record?.status).toBe("dispatching");
    expect(record?.endpointId).toBe("ep-1");
  });

  it("请求体形态非法 → 400 E_INTERNAL", async () => {
    const res = await POST(submitRequest({ graph: "not-an-object" }));
    expect(res.status).toBe(400);
  });
});
