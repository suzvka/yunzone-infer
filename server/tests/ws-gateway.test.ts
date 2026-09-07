/**
 * WS 下发网关单测（V5 / 批次 A）：连接鉴权 / 登记推送 / 断连清理 / 重连替换。
 * ws 包双端复用（服务端经 gateway.handleUpgrade 接管，客户端直连 http server）。
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CONTROL_WS_PATH, WsGateway, bearerEndpointIdAuth } from "../lib/ws-gateway";

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    server = http.createServer();
    server.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function startGateway(gateway: WsGateway): void {
  server.on("upgrade", (req, socket, head) => {
    void gateway.handleUpgrade(req, socket, head);
  });
}

function connect(headers: Record<string, string> = {}): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl}${CONTROL_WS_PATH}?endpointId=ep-1`, { headers });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** 期望连接被拒（ws 非 101 响应 → unexpected-response / error） */
function expectRejected(headers: Record<string, string> = {}, endpointId: string | null = "ep-1"): Promise<void> {
  const url = endpointId
    ? `${baseUrl}${CONTROL_WS_PATH}?endpointId=${endpointId}`
    : `${baseUrl}${CONTROL_WS_PATH}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("unexpected-response", (_req, res) => {
      expect(res.statusCode).toBe(401);
      resolve();
    });
    ws.once("open", () => reject(new Error("连接应被拒绝")));
    ws.once("error", (e) => reject(new Error(`应走 unexpected-response：${e.message}`)));
  });
}

function waitMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => ws.once("message", (d) => resolve(String(d))));
}

describe("WsGateway（控制通道下发面）", () => {
  it("鉴权失败（缺 Bearer / 缺 endpointId）→ 401 拒绝 upgrade", async () => {
    const gateway = new WsGateway({ authenticate: bearerEndpointIdAuth });
    startGateway(gateway);
    await expectRejected({}); // 无 Authorization
    await expectRejected({ authorization: "Bearer some-token" }, null); // 无 endpointId
  });

  it("连接登记 → pushToEndpoint 送达 → 断连清理 → 未连接推送 false", async () => {
    const gateway = new WsGateway({ authenticate: bearerEndpointIdAuth });
    startGateway(gateway);

    const ws = await connect({ authorization: "Bearer token-1" });
    expect(gateway.isOnline("ep-1")).toBe(true);
    expect(gateway.connectionCount()).toBe(1);

    const incoming = waitMessage(ws);
    expect(gateway.pushToEndpoint("ep-1", { version: 1, type: "task.dispatch" })).toBe(true);
    expect(JSON.parse(await incoming)).toEqual({ version: 1, type: "task.dispatch" });
    expect(gateway.pushToEndpoint("ep-missing", {})).toBe(false);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(gateway.isOnline("ep-1")).toBe(false);
    expect(gateway.connectionCount()).toBe(0);
    gateway.closeAll();
  });

  it("同 endpointId 重连 → 旧连接关闭、新连接在线", async () => {
    const gateway = new WsGateway({ authenticate: bearerEndpointIdAuth });
    startGateway(gateway);

    const first = await connect({ authorization: "Bearer token-1" });
    const oldClosed = new Promise<number>((resolve) =>
      first.once("close", (code) => resolve(code))
    );

    const second = await connect({ authorization: "Bearer token-2" });
    expect(gateway.connectionCount()).toBe(1);
    expect((await oldClosed) as unknown).toBe(4000); // 关旧留新（replaced）
    expect(gateway.isOnline("ep-1")).toBe(true);

    const incoming = waitMessage(second);
    expect(gateway.pushToEndpoint("ep-1", { hello: 1 })).toBe(true);
    expect(JSON.parse(await incoming)).toEqual({ hello: 1 });

    second.close();
    gateway.closeAll();
  });

  it("authenticate 抛错 → 按 401 拒绝", async () => {
    const gateway = new WsGateway({
      authenticate: async () => {
        throw new Error("auth center unreachable");
      },
    });
    startGateway(gateway);
    await expectRejected({ authorization: "Bearer token-1" });
  });
});
