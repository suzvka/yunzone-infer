/**
 * /auth 机器凭证鉴权 — 控制通道端点共用守卫（V3：P1 即强制）
 *
 * 三态语义（2026-09-07 P1 拍板）：
 * - AUTH_CENTER_BASE_URL **未配置** → 放行 + 进程级一次性告警（开发/CI 态；
 *   生产部署必须配置，「强制」由配置纪律保证——server/DESIGN.md §6 已同步）；
 * - 配置后 **强制 introspect**：无效 token（active:false）→ 401 E_AUTH_REJECTED；
 *   鉴权中心不可达（AuthCenterError）→ fail-closed 503（拒绝优于放行）；
 * - INFER_AUTH_PRODUCT_ID 配置后，机器凭证路径校验 introspect 响应 productId
 *   匹配（防跨产品凭证）；消费者 token 路径不校验（用户 token 产品另属）。
 *
 * accountId 提取：introspect claims.accountId（token-contract v1.6：业务用户 token
 * 不做账户锚定，accountId 由签发方自报 publicClaims）。绑定时机 = 注册（心跳复用
 * 已建账；会话内不重查，撤销联动 P2）。WS 连接鉴权复用 introspectBearer 内核
 * （ws-gateway authenticate 钩子）。
 */

import { createAuthCenterClient, AuthCenterError } from "yunzone-service-kit/auth";
import type { AuthCenterClient } from "yunzone-service-kit/auth";
import { jsonError } from "./responses";

/** 鉴权通过/放行的最小上下文（accountId 为 null = 未配置或无自报账户） */
export interface AuthContext {
  token: string;
  accountId: string | null;
  productId: string | null;
}

const globalForAuth = globalThis as unknown as {
  __inferAuthCenterClient?: AuthCenterClient;
  __inferAuthSkipWarned?: boolean;
};

/** kit AuthCenterClient 单例（AUTH_CENTER_BASE_URL 未配置 → null） */
export function getAuthCenterClient(): AuthCenterClient | null {
  const baseUrl = process.env.AUTH_CENTER_BASE_URL;
  if (!baseUrl) return null;
  globalForAuth.__inferAuthCenterClient ??= createAuthCenterClient({
    baseUrl,
    // 鉴权中心 B 端服务凭证（全量视图 introspect）；未配置走匿名（公开视图）
    ...(process.env.AUTH_SERVICE_CREDENTIAL
      ? { apiKey: process.env.AUTH_SERVICE_CREDENTIAL }
      : {}),
  });
  return globalForAuth.__inferAuthCenterClient;
}

/** 未配置放行的一次性告警（进程级） */
function warnOnceSkipped(): void {
  if (globalForAuth.__inferAuthSkipWarned) return;
  globalForAuth.__inferAuthSkipWarned = true;
  console.warn(
    "[control-auth] AUTH_CENTER_BASE_URL 未配置：/auth introspect 跳过，控制通道放行" +
      "（开发/CI 态；生产部署必须配置，V3 P1 即强制）"
  );
}

/** Bearer 提取（无 → null） */
function extractBearer(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

/**
 * introspect 内核（机器凭证 / 消费者 token 共用）：
 * 失败返回 Response（401/503），成功返回 AuthContext（未配置 = 放行跳过）。
 */
async function introspectBearer(request: Request): Promise<AuthContext | Response> {
  const token = extractBearer(request);
  if (!token) {
    return jsonError("E_AUTH_REJECTED", "missing bearer credential (Authorization)", 401);
  }

  const client = getAuthCenterClient();
  if (!client) {
    warnOnceSkipped();
    return { token, accountId: null, productId: null };
  }

  try {
    const result = await client.introspect({ token });
    if (!result.active) {
      return jsonError("E_AUTH_REJECTED", "credential is not active", 401);
    }
    const claims = result.claims as { accountId?: unknown } | undefined;
    return {
      token,
      accountId: typeof claims?.accountId === "string" ? claims.accountId : null,
      productId: typeof result.productId === "string" ? result.productId : null,
    };
  } catch (e) {
    if (e instanceof AuthCenterError) {
      // fail-closed：鉴权中心不可达时拒绝优于放行（V3 强制语义）
      return jsonError("E_AUTH_REJECTED", `auth center unavailable: ${e.message}`, 503);
    }
    throw e;
  }
}

/** 机器凭证守卫（控制通道端点）：introspect + 可选 productId 匹配 */
export async function requireMachineAuth(
  request: Request
): Promise<AuthContext | Response> {
  const context = await introspectBearer(request);
  if (context instanceof Response) return context;
  const expected = process.env.INFER_AUTH_PRODUCT_ID;
  if (expected && context.productId !== expected) {
    return jsonError("E_AUTH_REJECTED", "credential product mismatch", 401);
  }
  return context;
}

/** 消费者 token 守卫（推理入口，D19①）：introspect 即可（产品归属不限） */
export async function requireUserAuth(request: Request): Promise<AuthContext | Response> {
  return introspectBearer(request);
}
