/**
 * POST /api/control/v1/endpoints/{endpointId}/heartbeat — 心跳（V6 全量能力）
 *
 * 契约：请求体 = capability 域 EndpointCapability 全量（每跳覆盖能力视图）；
 * 响应 HeartbeatResponse；未知端点 404 + E_ENDPOINT_UNKNOWN；能力域版本不匹配
 * 400 + E_CAPABILITY_VERSION_MISMATCH（V2 三方比对只看整数相等）。
 */

import type { EndpointCapability, HeartbeatResponse } from "@/lib/contracts";
import { requireMachineToken } from "@/lib/control-auth";
import { getEndpointRegistry } from "@/lib/endpoint-registry";
import { jsonError } from "@/lib/responses";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ endpointId: string }> }
): Promise<Response> {
  const auth = requireMachineToken(request);
  if (auth) return auth;
  const { endpointId } = await params;

  let capability: EndpointCapability;
  try {
    capability = (await request.json()) as EndpointCapability;
  } catch {
    return jsonError("E_INTERNAL", "request body is not valid JSON");
  }
  if (capability?.version !== 1 || !Array.isArray(capability?.models)) {
    return jsonError("E_INTERNAL", "malformed EndpointCapability");
  }

  const result = getEndpointRegistry().heartbeat(endpointId, capability);
  if (!result.ok) {
    const status = result.errorCode === "E_ENDPOINT_UNKNOWN" ? 404 : 400;
    return jsonError(result.errorCode, result.message, status);
  }

  const payload: HeartbeatResponse = { version: 1, ok: true, serverTimeMs: Date.now() };
  return Response.json(payload);
}
