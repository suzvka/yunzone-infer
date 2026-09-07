/**
 * WS 下发网关（V5：WS 单向推送）— 2026-09-07 P1 拍板：custom server 同端口 upgrade 承载
 *
 * server.ts 在 http server 的 upgrade 事件上把控制通道 WS 请求转交本网关：
 * 连接鉴权（机器凭证，V3）通过后按 endpointId 登记连接；派发泵（dispatch-pump）
 * 经 pushToEndpoint 下发 TaskDispatch / TaskRevoke（contracts control-channel 域，
 * type 字段判别消息形态）。
 *
 * 语义：
 * - 同 endpointId 重复连接（断线重连场景）→ 关旧留新；
 * - pushToEndpoint 未连接 / 非 OPEN → false，调用方按「暂缓」处理（泵下轮重试）；
 * - 无应用层 ping/pong：僵尸连接由 send() 失败或端点 TTL 判死重派兜底（D7）；
 * - client → server 方向消息忽略（控制通道 server→client 单向，V5）。
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

/** 控制通道 WS 路径（custom server upgrade 分发依据） */
export const CONTROL_WS_PATH = "/api/control/v1/ws";

/** 连接鉴权：通过返回 endpointId，拒绝返回 null（或抛错按 401 处理） */
export type WsAuthenticator = (
  request: IncomingMessage
) => Promise<string | null>;

export interface WsGatewayOptions {
  authenticate?: WsAuthenticator;
}

export class WsGateway {
  private readonly connections = new Map<string, WebSocket>();
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(private readonly options: WsGatewayOptions = {}) {}

  /** http server upgrade 事件转交点（仅控制通道路径调用） */
  async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    const reject = (reason: string) => {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n", () =>
        socket.destroy()
      );
      console.warn(`[ws-gateway] upgrade rejected: ${reason}`);
    };

    let endpointId: string | null = null;
    try {
      endpointId = this.options.authenticate
        ? await this.options.authenticate(request)
        : await bearerEndpointIdAuth(request);
    } catch (e) {
      reject(`authenticator error: ${(e as Error).message}`);
      return;
    }
    if (!endpointId) {
      reject("missing machine credential or endpointId");
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      // 同 id 重连：关旧留新（旧连接可能已僵死）
      const existing = this.connections.get(endpointId);
      if (existing && existing !== ws) {
        existing.close(4000, "replaced by newer connection");
      }
      this.connections.set(endpointId, ws);
      console.log(`[ws-gateway] endpoint connected: ${endpointId}`);

      ws.on("close", () => {
        if (this.connections.get(endpointId) === ws) {
          this.connections.delete(endpointId);
          console.log(`[ws-gateway] endpoint disconnected: ${endpointId}`);
        }
      });
      ws.on("error", (err) => {
        console.warn(`[ws-gateway] endpoint ${endpointId} error: ${err.message}`);
      });
      ws.on("message", (data) => {
        // 单向推送通道：client 上行仅忽略（诊断日志留 P1 按需）
        console.log(`[ws-gateway] unexpected upstream from ${endpointId}: ${String(data).slice(0, 120)}`);
      });
    });
  }

  /** 端点 WS 是否在线（OPEN） */
  isOnline(endpointId: string): boolean {
    return this.connections.get(endpointId)?.readyState === WebSocket.OPEN;
  }

  /** 当前在线连接数（诊断） */
  connectionCount(): number {
    return this.connections.size;
  }

  /** 单向推送：未连接 / 非 OPEN / send 异常 → false（调用方暂缓） */
  pushToEndpoint(endpointId: string, payload: unknown): boolean {
    const ws = this.connections.get(endpointId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (e) {
      console.warn(`[ws-gateway] push to ${endpointId} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** 关闭全部连接（进程退出 / 测试收尾） */
  closeAll(): void {
    for (const ws of this.connections.values()) ws.close(1001, "server shutdown");
    this.connections.clear();
  }
}

// ── 进程级单例（dev 热重载下经 globalThis 保持）─────────────────────────────

const globalForGateway = globalThis as unknown as {
  __inferWsGateway?: WsGateway;
};

export function getWsGateway(): WsGateway {
  globalForGateway.__inferWsGateway ??= new WsGateway({
    // A 批次骨架：Bearer 存在性 + endpointId query；B 批次升级为 /auth introspect（V3）
    authenticate: bearerEndpointIdAuth,
  });
  return globalForGateway.__inferWsGateway;
}

/** 骨架期连接鉴权：Authorization: Bearer 存在 + query 携带非空 endpointId */
export async function bearerEndpointIdAuth(
  request: IncomingMessage
): Promise<string | null> {
  const header = request.headers.authorization ?? "";
  if (!/^Bearer\s+.+$/i.test(header)) return null;
  const endpointId = new URL(request.url ?? "/", "http://localhost").searchParams.get(
    "endpointId"
  );
  return endpointId && endpointId.length > 0 ? endpointId : null;
}
