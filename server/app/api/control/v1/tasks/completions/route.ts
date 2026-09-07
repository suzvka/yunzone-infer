/**
 * POST /api/control/v1/tasks/completions — 完成上报（D8 事件驱动回收入口）
 *
 * 契约：CompletionReport → CompletionReportResponse（requestId 幂等）。
 * 骨架期：受理即确认（ok:true），转发 sidecar 唤醒图节点（D8）与 requestId 幂等账
 * （E_TASK_UNKNOWN / E_TASK_ALREADY_REPORTED / duplicate 语义）随 sidecar IPC 接线
 * 与任务账本 P1 落地——此时上报先落日志，供对拍 spike 观测。
 */

import type { CompletionReport, CompletionReportResponse } from "@/lib/contracts";
import { requireMachineToken } from "@/lib/control-auth";
import { jsonError } from "@/lib/responses";

export async function POST(request: Request): Promise<Response> {
  const auth = requireMachineToken(request);
  if (auth) return auth;

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

  // TODO(P1)：requestId 幂等账本（先到先得）+ 转发 sidecar node-completions（D8 唤醒）
  // + 耗时下限校验（security §2 结果验证辅助信号）
  console.log(
    `[control] completion report: task=${report.taskId} endpoint=${report.endpointId} errorCode=${report.errorCode ?? "none"}`
  );

  const payload: CompletionReportResponse = { version: 1, ok: true };
  return Response.json(payload);
}
