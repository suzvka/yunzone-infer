/**
 * 结构化检视单测（lib/inspection.ts）——对拍图形态为基准 fixture（D6 两层防线的静态半边）。
 * 不依赖端点设施：InspectableModel 为能力视图投影，P1 接注册中心数据源时语义不变。
 */
import { describe, expect, it } from "vitest";

import {
  inspectWorkflowGraph,
  shapeCompatible,
  type InspectableModel,
} from "../lib/inspection";

/** 对拍 parity 图的远程节点形态（BusProxy outputs-only：outputs 声明，无 inputs） */
const PARITY_GRAPH = {
  version: "1.0",
  nodes: [
    {
      name: "model_node",
      type: "Builtin",
      affinity: "Operator",
      outputs: [{ name: "y", tensorType: "Float", typeSize: 4, shape: [1], required: true }],
    },
    {
      name: "add_node",
      type: "Builtin",
      affinity: "Operator",
      inputs: [{ name: "a", tensorType: "Float", typeSize: 4, shape: [1], required: true }],
      outputs: [{ name: "sum", tensorType: "Float", typeSize: 4, shape: [1], required: true }],
    },
  ],
  edges: [{ srcNode: "model_node", srcPort: "y", dstNode: "add_node", dstPort: "a" }],
};

const BINDINGS = [
  { nodeId: "model_node", modelKey: "models/parity-stub", outputUri: "objects/w1/model_node" },
];

function model(io: InspectableModel["io"], modelKey = "models/parity-stub"): InspectableModel {
  return { modelKey, io };
}

describe("inspectWorkflowGraph", () => {
  it("对拍图形态：端口全匹配则通过", () => {
    const result = inspectWorkflowGraph(PARITY_GRAPH, BINDINGS, [
      model({
        inputs: [{ name: "x", tensorType: "Float", typeSize: 4, shape: [1] }],
        outputs: [{ name: "y", tensorType: "Float", typeSize: 4, shape: [1] }],
      }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("空 bindings（纯本地图）恒过", () => {
    const result = inspectWorkflowGraph(PARITY_GRAPH, [], []);
    expect(result.ok).toBe(true);
  });

  it("model-unknown：无端点声明可服务该模型", () => {
    const result = inspectWorkflowGraph(PARITY_GRAPH, BINDINGS, [
      model(undefined, "models/other"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      expect.objectContaining({ kind: "model-unknown", nodeId: "model_node" }),
    ]);
  });

  it("io-mismatch：tensorType 不符", () => {
    const result = inspectWorkflowGraph(PARITY_GRAPH, BINDINGS, [
      model({
        outputs: [{ name: "y", tensorType: "Double", typeSize: 8, shape: [1] }],
      }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatchObject({ kind: "io-mismatch" });
    expect(result.failures[0].detail).toContain("tensorType 不匹配");
  });

  it("io-mismatch：typeSize 不符", () => {
    const result = inspectWorkflowGraph(PARITY_GRAPH, BINDINGS, [
      model({
        outputs: [{ name: "y", tensorType: "Float", typeSize: 8, shape: [1] }],
      }),
    ]);
    expect(result.failures[0].detail).toContain("typeSize 不匹配");
  });

  it("io-mismatch：shape 维度数不等或各维不等", () => {
    const dimCount = inspectWorkflowGraph(PARITY_GRAPH, BINDINGS, [
      model({ outputs: [{ name: "y", tensorType: "Float", typeSize: 4, shape: [1, 2] }] }),
    ]);
    expect(dimCount.failures[0].detail).toContain("shape 不兼容");

    const dimValue = inspectWorkflowGraph(PARITY_GRAPH, BINDINGS, [
      model({ outputs: [{ name: "y", tensorType: "Float", typeSize: 4, shape: [2] }] }),
    ]);
    expect(dimValue.failures[0].detail).toContain("shape 不兼容");
  });

  it("shape -1 动态维度双向兼容（DCIr int64 直通语义）", () => {
    expect(shapeCompatible([1], [-1])).toBe(true);
    expect(shapeCompatible([-1], [1])).toBe(true);
    expect(shapeCompatible([1, 224], [-1, 224])).toBe(true);
    expect(shapeCompatible([1, 224], [1, -1, 3])).toBe(false);
    expect(shapeCompatible([2], [3])).toBe(false);
  });

  it("io-mismatch：图端口名未在端点声明中", () => {
    const result = inspectWorkflowGraph(PARITY_GRAPH, BINDINGS, [
      model({ outputs: [{ name: "out", tensorType: "Float", typeSize: 4, shape: [1] }] }),
    ]);
    expect(result.failures[0].detail).toContain("端口 'y' 未在端点声明中");
  });

  it("io-mismatch：端点候选缺 io 声明时如实报因", () => {
    const result = inspectWorkflowGraph(PARITY_GRAPH, BINDINGS, [model(undefined)]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatchObject({ kind: "io-mismatch" });
    expect(result.failures[0].detail).toContain("无可服务端点携带 io 声明");
  });

  it("存在性语义：任一候选通过即过（另一候选 io 不符不阻断）", () => {
    const result = inspectWorkflowGraph(PARITY_GRAPH, BINDINGS, [
      model({ outputs: [{ name: "y", tensorType: "Double", typeSize: 8, shape: [1] }] }),
      model({ outputs: [{ name: "y", tensorType: "Float", typeSize: 4, shape: [1] }] }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("graph-shape：binding 指向图中不存在的节点", () => {
    const result = inspectWorkflowGraph(
      PARITY_GRAPH,
      [{ nodeId: "ghost_node", modelKey: "models/parity-stub", outputUri: "objects/w1/ghost" }],
      [model({ outputs: [{ name: "y", tensorType: "Float", typeSize: 4, shape: [1] }] })],
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatchObject({ kind: "graph-shape", nodeId: "ghost_node" });
  });

  it("graph-shape：graph.nodes 缺失且有 bindings 时不可检视", () => {
    const result = inspectWorkflowGraph({ version: "1.0" }, BINDINGS, [
      model({ outputs: [{ name: "y", tensorType: "Float", typeSize: 4, shape: [1] }] }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatchObject({ kind: "graph-shape" });
  });

  it("防御式：图端口字段类型非法视为不匹配而非抛错", () => {
    const brokenGraph = {
      nodes: [
        {
          name: "model_node",
          outputs: [{ name: "y", tensorType: 42, typeSize: "4", shape: "nope" }],
        },
      ],
    };
    const result = inspectWorkflowGraph(brokenGraph, BINDINGS, [
      model({ outputs: [{ name: "y", tensorType: "Float", typeSize: 4, shape: [1] }] }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0].kind).toBe("io-mismatch");
  });
});
