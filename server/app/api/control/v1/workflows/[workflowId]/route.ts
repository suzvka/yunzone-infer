/**
 * GET /api/control/v1/workflows/{workflowId} — 工作流状态查询
 *
 * 契约：WorkflowStatus（状态机：登记→检视→绑定→派发→执行→回推→聚合）；
 * 未找到 404 + E_WORKFLOW_NOT_FOUND。骨架期账本为空（状态推进入口 P1）。
 */

import type { WorkflowStatus } from "@/lib/contracts";
import { getWorkflowLedger } from "@/lib/workflow-ledger";
import { jsonError } from "@/lib/responses";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workflowId: string }> }
): Promise<Response> {
  const { workflowId } = await params;
  const record = getWorkflowLedger().get(workflowId);
  if (!record) {
    return jsonError("E_WORKFLOW_NOT_FOUND", `workflow "${workflowId}" not found`, 404);
  }
  const payload: WorkflowStatus = {
    version: 1,
    workflowId: record.workflowId,
    status: record.status,
    ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
    ...(record.finalOutputUri !== undefined
      ? { finalOutputUri: record.finalOutputUri }
      : {}),
    updatedAtMs: record.updatedAtMs,
  };
  return Response.json(payload);
}
