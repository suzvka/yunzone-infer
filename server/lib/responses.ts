/**
 * 契约化响应助手 — 控制通道 REST 的统一出参形态
 *
 * 失败：errors 域 ErrorEnvelope（version/ok/errorCode 必带，message 可选）；
 * 成功：各端点响应 schema（RegisterResponse / HeartbeatResponse / CompletionReportResponse / WorkflowStatus）。
 * HTTP 状态码建议：400 请求形态错 / 401 鉴权 / 404 资源不存在 / 409 冲突（重复注册）。
 */

import type { ErrorCode } from "./contracts";

/** ErrorEnvelope 构造（契约形态：version 恒 1、ok 恒 false） */
export function errorEnvelope(errorCode: ErrorCode, message?: string) {
  return {
    version: 1 as const,
    ok: false as const,
    errorCode,
    ...(message !== undefined ? { message } : {}),
  };
}

/** 失败响应：ErrorEnvelope + HTTP 状态码 */
export function jsonError(
  errorCode: ErrorCode,
  message?: string,
  status = 400
): Response {
  return Response.json(errorEnvelope(errorCode, message), { status });
}
