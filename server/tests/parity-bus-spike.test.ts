/**
 * P0 对拍骨架（DESIGN §9②/§13：确定性对拍——同图单机执行 vs 经总线分布式执行逐节点比对）
 *
 * 运行前提：sidecar 二进制已构建，环境变量注入：
 *   INFER_SIDECAR_BIN      infer-sidecar 可执行文件路径（未设置则整组跳过）
 *   INFER_ENDPOINT_STUB    infer-endpoint-stub 路径（缺省取 INFER_SIDECAR_BIN 同目录）
 *
 * 场景（对拍图：workflow 输入 x=3 → model_node[P0StubModel, 远程] → add_node[Add, 本地]）：
 *   1. 分布式半边：sidecar serve（D16 token）→ startWorkflow（对象键语义 bindingPlan）
 *      → 派发泵取走 pendingDispatches 并签名 URL → endpoint-stub 总线下载/执行/上传
 *      → 完成上报转发（D8）→ sidecar 拉取唤醒 → 聚合 → finalOutput PUT 总线（V8）
 *   2. 单机半边：run-local（同图全本地算子执行）逐节点输出落盘
 *   3. 逐节点比对：remote 输出（总线对象）与 final 输出逐一相等
 *   错误路径（根 DESIGN §9：对拍专测错误路径）：token 不匹配 / 未知工作流通知 /
 *   未知节点类型图。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SidecarClient } from "../lib/ipc/sidecar-client";
import type { StartWorkflowRequest, TaskDispatch, WorkflowStatusSnapshot } from "../lib/contracts";
import { makeStandinBusSigner, normalizeBusKey, pollSidecarDispatches } from "../lib/dispatch-pump";

const SIDECAR_BIN = process.env.INFER_SIDECAR_BIN ?? "";
const ENDPOINT_STUB =
  process.env.INFER_ENDPOINT_STUB ??
  (SIDECAR_BIN ? path.join(path.dirname(SIDECAR_BIN), `infer-endpoint-stub${process.platform === "win32" ? ".exe" : ""}`) : "");

/** float32 标量 ↔ 裸字节（P0 总线张量编码，与 sidecar scalarBytes 对应，原生端序） */
function scalarBytes(v: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(v, 0);
  return buf;
}
function bytesToScalar(buf: Buffer): number {
  return buf.readFloatLE(0);
}

/** 对拍图（DCIr 格式）：x=3 → model_node（y=x*2+1）→ add_node（sum=y+b），b=10 */
function parityGraphJson(): Record<string, unknown> {
  const floatPort = (name: string) => ({
    name,
    tensorType: "Float",
    typeSize: 4,
    shape: [],
    required: true,
  });
  return {
    version: "1.0",
    nodes: [
      {
        name: "model_node",
        type: "P0StubModel",
        affinity: "Operator",
        inputs: [floatPort("x")],
        outputs: [floatPort("y")],
      },
      {
        name: "add_node",
        type: "Add",
        affinity: "Operator",
        inputs: [floatPort("a"), floatPort("b")],
        outputs: [floatPort("sum")],
      },
    ],
    edges: [{ srcNode: "model_node", srcPort: "y", dstNode: "add_node", dstPort: "a" }],
    inputBindings: [
      { nodeName: "model_node", portName: "x" },
      { nodeName: "add_node", portName: "b" },
    ],
    outputBindings: [{ nodeName: "add_node", portName: "sum" }],
  };
}

/** 本地对象存储替身（V12）：内存对象 + GET/PUT /objects/{key}；返回 stop 函数与实际端口 */
function startBusStandin(): Promise<{
  baseUrl: string;
  put: (key: string, data: Buffer) => Promise<void>;
  get: (key: string) => Promise<Buffer>;
  close: () => Promise<void>;
}> {
  const objects = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? "").replace(/^\/objects\//, "").split("?")[0]);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (req.method === "GET") {
      const data = objects.get(key);
      if (!data) {
        res.writeHead(404, { "content-type": "text/plain", "content-length": 9 });
        res.end("not found");
        return;
      }
      // 显式 content-length：避免 Node 自动 chunked（sidecar/stub 的极小 HTTP 客户端不拆块）
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": data.length,
      });
      res.end(data);
      return;
    }
    res.writeHead(405);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        baseUrl,
        put: async (key, data) => {
          const res = await fetch(`${baseUrl}/objects/${key}`, {
            method: "PUT",
            body: new Uint8Array(data),
          });
          expect(res.status).toBe(201);
        },
        get: async (key) => {
          const res = await fetch(`${baseUrl}/objects/${key}`);
          expect(res.status).toBe(200);
          return Buffer.from(await res.arrayBuffer());
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** 启动 sidecar serve（随机端口 + 随机 token），轮询探活就绪 */
function startSidecar(): Promise<{ client: SidecarClient; port: number; token: string; stop: () => void }> {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const token = `p0-parity-${Math.random().toString(36).slice(2)}`;
  const child = spawn(SIDECAR_BIN, ["serve", "--port", String(port), "--token", token], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (c: Buffer) => console.log("[sidecar:stderr]", c.toString().trim()));
  child.on("error", (e) => console.log("[sidecar:spawn-error]", e.message));
  child.on("exit", (code, signal) => console.log("[sidecar:exit]", code, signal));
  const client = new SidecarClient({ port, token });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const probe = async () => {
      try {
        const liveness = await client.ping();
        if (liveness?.ok) {
          resolve({ client, port, token, stop: () => child.kill() });
          return;
        }
      } catch {
        // 未就绪
      }
      if (Date.now() > deadline) {
        reject(new Error("sidecar 未在 15s 内就绪"));
        return;
      }
      setTimeout(probe, 150);
    };
    void probe();
  });
}

/** 跑一次 endpoint-stub（对拍端点替身）：下载 → 引擎前向 → 上传 → stdout JSON */
function runEndpointStub(dispatch: TaskDispatch): Promise<{ outputKey: string; meta: { shape: number[]; dtype: string } }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ENDPOINT_STUB, [
      "--task", dispatch.taskId,
      "--model-key", dispatch.modelKey,
      "--input", dispatch.inputUri,
      "--output", dispatch.outputUri,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`endpoint-stub exit ${code}: ${stderr}`));
        return;
      }
      const parsed = JSON.parse(stdout.trim()) as {
        outputUri: string;
        outputMeta: { shape: number[]; dtype: string };
        metrics: Record<string, number>;
      };
      expect(parsed.metrics.queueWaitMs).toBe(0);
      resolve({ outputKey: normalizeBusKey(parsed.outputUri), meta: parsed.outputMeta });
    });
  });
}

describe.skipIf(!SIDECAR_BIN)("P0 对拍骨架（sidecar + 对象存储总线替身 + endpoint-stub）", () => {
  let bus: Awaited<ReturnType<typeof startBusStandin>>;
  let sidecar: Awaited<ReturnType<typeof startSidecar>>;
  // signer 依赖替身实际端口（随机），afterAll 前在 beforeAll 构造
  let signer: ReturnType<typeof makeStandinBusSigner>;

  beforeAll(async () => {
    bus = await startBusStandin();
    signer = makeStandinBusSigner(bus.baseUrl);
    sidecar = await startSidecar();
  });
  afterAll(async () => {
    sidecar?.stop();
    await bus?.close();
  });

  it("对拍：同图单机执行 vs 经总线分布式执行逐节点比对", { timeout: 60_000 }, async () => {
    const WORKFLOW = "wf-parity-p0";
    // ① 图级输入先行入总线（控制面上传语义）：x=3 由端点自取（远程）；b=10 由 sidecar 拉取（本地）
    await bus.put(`${WORKFLOW}/inputs/x`, scalarBytes(3.0));
    await bus.put(`${WORKFLOW}/inputs/b`, scalarBytes(10.0));

    // ② startWorkflow（对象键语义：sidecar 组装 pendingDispatch，控制面取走后签 URL）
    const request: StartWorkflowRequest = {
      version: 1,
      workflowId: WORKFLOW,
      graph: parityGraphJson(),
      bindingPlan: {
        remoteNodes: [
          {
            nodeId: "model_node",
            modelKey: "models/p0-stub",
            outputUri: `${WORKFLOW}/model_node.out`,
            inputs: [{ port: "x", uri: `${WORKFLOW}/inputs/x` }],
          },
        ],
      },
      workflowInputs: [
        // 本地节点图级输入：sidecar 提交前拉取注入（URL 语义，控制面已签发）
        { node: "add_node", port: "b", uri: await signer(`${WORKFLOW}/inputs/b`, "GET") },
      ],
      finalOutputUri: await signer(`${WORKFLOW}/final.out`, "PUT"),
    };
    await sidecar.client.startWorkflow(request);

    // ③ 派发泵循环：取走 pendingDispatches → 签名 → transport（stub 执行 + D8 上报转发）
    // P1 泵接口：transport(endpointId, dispatch) → false = 暂缓；stub 同步返回 true
    const deadline = Date.now() + 30_000;
    let snapshot: WorkflowStatusSnapshot | null = null;
    while (Date.now() < deadline) {
      await pollSidecarDispatches(sidecar.client, {
        signer,
        transport: async (_endpointId, task) => {
          const { outputKey, meta } = await runEndpointStub(task);
          expect(meta.dtype).toBe("float32");
          await sidecar.client.notifyNodeCompletion({
            version: 1,
            workflowId: task.workflowId,
            taskId: task.taskId,
            nodeId: task.nodeId,
            outputUri: await signer(outputKey, "GET"),
            outputMeta: { shape: meta.shape, dtype: "float32" },
            metrics: { queueWaitMs: 0, downloadMs: 1, inferMs: 1, uploadMs: 1 },
          });
          return true;
        },
      });
      snapshot = await sidecar.client.status(WORKFLOW);
      if (snapshot?.status === "completed" || snapshot?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.errorCode).toBeUndefined();

    // ④ 分布式半边逐节点取值：remote 输出（总线对象）+ 最终输出（finalOutputUri，V8）
    expect(snapshot?.finalOutputUri).toBeTruthy();
    const remoteOut = bytesToScalar(await bus.get(`${WORKFLOW}/model_node.out`));
    const finalKey = normalizeBusKey(snapshot!.finalOutputUri!);
    const finalOut = bytesToScalar(await bus.get(finalKey));

    // ⑤ 单机半边：run-local 同图全本地执行，逐节点输出落盘
    const dir = mkdtempSync(path.join(tmpdir(), "infer-parity-"));
    const graphPath = path.join(dir, "graph.json");
    const feedPath = path.join(dir, "feed.json");
    const outPath = path.join(dir, "results.json");
    writeFileSync(graphPath, JSON.stringify(parityGraphJson()));
    writeFileSync(feedPath, JSON.stringify({ "model_node.x": 3.0, "add_node.b": 10.0 }));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(SIDECAR_BIN, [
        "run-local", "--graph", graphPath, "--feed", feedPath, "--out", outPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`run-local exit ${code}: ${stderr}`))));
    });
    const local = JSON.parse(readFileSync(outPath, "utf8")) as {
      nodes: Record<string, Record<string, number>>;
    };

    // ⑥ 逐节点比对（x=3：y=3*2+1=7；sum=7+10=17）
    expect(remoteOut).toBe(local.nodes.model_node!.y!);
    expect(finalOut).toBe(local.nodes.add_node!.sum!);
    expect(remoteOut).toBeCloseTo(7.0, 5);
    expect(finalOut).toBeCloseTo(17.0, 5);
  });

  it("错误路径：token 不匹配 → E_IPC_UNAUTHORIZED（D16）", async () => {
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/status`, {
      headers: { "x-ipc-token": "wrong-token" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { errorCode?: string };
    expect(body.errorCode).toBe("E_IPC_UNAUTHORIZED");
  });

  it("错误路径：未知工作流完成通知 → E_IPC_WORKFLOW_UNKNOWN", async () => {
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/workflows/ghost/node-completions`, {
      method: "POST",
      headers: { "x-ipc-token": sidecar.token, "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        workflowId: "ghost",
        taskId: "ghost:model_node",
        nodeId: "model_node",
        outputUri: null,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { errorCode?: string };
    expect(body.errorCode).toBe("E_IPC_WORKFLOW_UNKNOWN");
  });

  it("错误路径：未知节点类型图 → E_IPC_INVALID_GRAPH", async () => {
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/workflows`, {
      method: "POST",
      headers: { "x-ipc-token": sidecar.token, "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        workflowId: "wf-bad-graph",
        graph: {
          version: "1.0",
          nodes: [{ name: "n1", type: "NoSuchEngineType", inputs: [], outputs: [] }],
          edges: [],
          outputBindings: [],
        },
        bindingPlan: { remoteNodes: [] },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errorCode?: string };
    expect(body.errorCode).toBe("E_IPC_INVALID_GRAPH");
  });
});
