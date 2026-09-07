/**
 * 机器凭证鉴权 — 控制通道端点共用守卫（V3）
 *
 * 骨架期：仅校验 Authorization: Bearer 凭证存在性；
 * TODO(P1)：接入 /auth introspect（AUTH_CENTER_BASE_URL 配置后），校验凭证 active +
 * productId 匹配并绑定 accountId（server/DESIGN.md §6 / V3 P1 即强制）。
 */

import { jsonError } from "./responses";

/** 校验失败时返回 401 响应，通过时返回 null */
export function requireMachineToken(request: Request): Response | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) {
    return jsonError(
      "E_AUTH_REJECTED",
      "missing machine credential (Authorization: Bearer)",
      401
    );
  }
  return null;
}
