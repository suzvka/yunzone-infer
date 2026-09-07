/**
 * 自定义服务器入口 — 2026-09-07 P1 拍板：WS 任务下发（V5）以 custom server
 * 同端口 upgrade 承载（Next 无 WS route handler）。
 *
 * - dev：NODE_ENV != production → next({ dev: true })（HMR 照常）；
 * - prod：NODE_ENV=production + next build 产物 → next({ dev: false })；
 *   standalone（D11 原形态）保留为回退：若 custom server 与 house Next 16 不兼容，
 *   退回 `next start` + 独立端口 WS（记 CouplingRecord 后迁移）。
 * - upgrade 分发：仅控制通道路径（CONTROL_WS_PATH）转交 WS 网关，其余销毁。
 * - 监听地址：PORT / HOST env（.env.example 部署面；kit resolveListenAddress
 *   接入随部署面专项，P1 直接读 env）。
 * - sidecar 拉起 + 派发泵仍由 instrumentation.register 驱动（本文件不重复）。
 */

import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import {
  CONTROL_WS_PATH,
  bearerEndpointIdAuth,
  getWsGateway,
} from "./lib/ws-gateway";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3002);
const host = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = next({ dev, dir });
  await app.prepare();
  const handle = app.getRequestHandler();
  const gateway = getWsGateway();

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (pathname === CONTROL_WS_PATH) {
      void gateway.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  server.listen(port, host, () => {
    console.log(
      `[infer-server] listening on http://${host}:${port} (dev=${dev}; WS upgrade path: ${CONTROL_WS_PATH})`
    );
  });
}

void main().catch((e) => {
  console.error("[infer-server] fatal:", e);
  process.exit(1);
});
