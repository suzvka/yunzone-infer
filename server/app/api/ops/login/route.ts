/**
 * POST /api/ops/login — 管理控制台登录（D5/D19②）
 *
 * kit v1.0 Admin Session Protocol：ADMIN_PASSWORD 校验 → createSignedAdminSession
 * 签发 HMAC 会话 cookie（admin_session）；ADMIN_PASSWORD 未配置 → 503 禁用态
 * （禁止默认密码回退，集群统一语义）。
 */

import { NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_DEFAULT_MAX_AGE_SECONDS,
  createSignedAdminSession,
  resolveAdminConfig,
} from "yunzone-service-kit/ops";

export async function POST(request: Request): Promise<Response> {
  const admin = resolveAdminConfig();
  if (!admin.enabled || !admin.password) {
    return NextResponse.json(
      { code: "ADMIN_DISABLED", message: "管理后台已禁用（ADMIN_PASSWORD 未配置）" },
      { status: 503 }
    );
  }

  let body: { password?: unknown };
  try {
    body = (await request.json()) as { password?: unknown };
  } catch {
    return NextResponse.json({ code: "INVALID_ARGUMENT", message: "请求体非法" }, { status: 400 });
  }
  if (typeof body.password !== "string" || body.password.length === 0) {
    return NextResponse.json({ code: "INVALID_ARGUMENT", message: "缺少 password" }, { status: 400 });
  }

  const session = createSignedAdminSession(admin.password);
  const response = NextResponse.json({ ok: true, username: "admin" });
  response.cookies.set(ADMIN_SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: admin.sessionMaxAgeSeconds || ADMIN_SESSION_DEFAULT_MAX_AGE_SECONDS,
    path: "/",
  });
  return response;
}
