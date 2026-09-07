/**
 * POST /api/control/v1/tasks/completions — 完成上报（D8 事件驱动回收入口）
 *
 * 契约：CompletionReport → CompletionReportResponse（requestId 幂等，先到先得）。
 * P0 接线：任务账本（dispatch-pump，taskId → workflowId/nodeId）→ 转发 sidecar
 * node-completions（输出对象签名 GET URL，sidecar 拉取并唤醒图节点）；sidecar
 * 不可达回 502 E_INTERNAL。requestId 幂等账本 P2 迁 /db 持久化。
 */

import type { CompletionReport, CompletionReportResponse, NodeCompletionNotice } from "@/lib/contracts";
import { getBusSigner, getTaskAccount, normalizeBusKey } from "@/lib/dispatch-pump";
import { requireMachineAuth } from "@/lib/control-auth";
import { jsonError } from "@/lib/responses";
import { getIpcSidecarClient } from "@/lib/sidecar-supervisor";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMachineAuth(request);
  if (auth instanceof Response) return auth;

  let report: CompletionReport;
  try {
    report = (await request.json()) as CompletionReport;
  } catch {
    return jsonError("E_INTERNAL", "request body is not valid JSON");
  }
  if (
    report?.version !== 1 ||
    typeof report?.taskId !== "string" ||
    typeof report?.endpointId !== "string" ||
    typeof report?.requestId !== "string" ||
    report?.metrics === undefined
  ) {
    return jsonError("E_INTERNAL", "malformed CompletionReport");
  }

  const account = getTaskAccount();
  const entry = account.get(report.taskId);
  if (!entry) {
    // 未派发任务的上报（或控制面重启后内存账本丢失，P2 迁 /db）
    return jsonError(
      "E_TASK_UNKNOWN",
      `task "${report.taskId}" not dispatched to this control plane`,
      404
    );
  }
  if (!account.markReported(report.taskId)) {
    // requestId 幂等命中：重复上报先到先得，端点可安全丢弃（契约 duplicate 语义）
    const duplicate: CompletionReportResponse = { version: 1, ok: true, duplicate: true };
    return Response.json(duplicate);
  }

  const sidecar = getIpcSidecarClient();
  if (!sidecar) {
    return jsonError("E_INTERNAL", "sidecar IPC 未就绪（SIDECAR_BIN 未配置或尚未拉起）", 502);
  }

  // 输出对象 → 签名 GET URL（sidecar 拉取语义；P1 kit /storage 预签名 / 替身回退）
  const signer = getBusSigner();
  const notice: NodeCompletionNotice = {
    version: 1,
    workflowId: entry.workflowId,
    taskId: report.taskId,
    nodeId: entry.nodeId,
    outputUri: report.outputUri ? await signer(normalizeBusKey(report.outputUri), "GET") : null,
    ...(report.outputMeta !== undefined ? { outputMeta: report.outputMeta } : {}),
    ...(report.errorCode !== undefined ? { errorCode: report.errorCode } : {}),
    ...(report.metrics !== undefined ? { metrics: report.metrics } : {}),
  };
  try {
    await sidecar.notifyNodeCompletion(notice);
  } catch (e) {
    return jsonError("E_INTERNAL", `sidecar notify failed: ${(e as Error).message}`, 502);
  }

  const payload: CompletionReportResponse = { version: 1, ok: true };
  return Response.json(payload);
}
