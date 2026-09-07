/**
 * POST /api/control/v1/endpoints — 端点注册（控制通道，V3/V6）
 *
 * 契约：contracts control-channel 域（RegisterRequest → RegisterResponse；
 * 失败 → errors 域 ErrorEnvelope）。鉴权：Authorization: Bearer 机器凭证（骨架期
 * 存在性校验，/auth introspect P1 接入）。
 */

import type { RegisterRequest, RegisterResponse } from "@/lib/contracts";
import { requireMachineToken } from "@/lib/control-auth";
import {
  DEFAULT_HEARTBEAT_INTERVAL_S,
  getEndpointRegistry,
} from "@/lib/endpoint-registry";
import { jsonError } from "@/lib/responses";

export async function POST(request: Request): Promise<Response> {
  const auth = requireMachineToken(request);
  if (auth) return auth;

  let body: RegisterRequest;
  try {
    body = (await request.json()) as RegisterRequest;
  } catch {
    return jsonError("E_INTERNAL", "request body is not valid JSON");
  }
  // 最小运行时校验（形态级）；完整校验策略 P1 专项（ajv 编译 contracts schema，
  // 避免 zod 手写副本漂移——D15 单一事实源）
  if (
    body?.version !== 1 ||
    typeof body?.endpointId !== "string" ||
    body.endpointId.length === 0 ||
    body?.capability === undefined
  ) {
    return jsonError("E_INTERNAL", "malformed RegisterRequest");
  }

  const result = getEndpointRegistry().registerEndpoint(
    body.endpointId,
    body.capability
  );
  if (!result.ok) {
    const status =
      result.errorCode === "E_ENDPOINT_ALREADY_REGISTERED" ? 409 : 400;
    return jsonError(result.errorCode, result.message, status);
  }
  console.log(`[control] endpoint registered: ${body.endpointId}`);

  const payload: RegisterResponse = {
    version: 1,
    ok: true,
    heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_S,
  };
  return Response.json(payload);
}
