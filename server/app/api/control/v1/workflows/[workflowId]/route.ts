/**
 * GET /api/control/v1/workflows/{workflowId} — 工作流状态查询（机器面）
 *
 * 契约：WorkflowStatus；未找到 404 + E_WORKFLOW_NOT_FOUND。
 * P1 聚合：ledger × sidecar 快照联动（advanceWorkflowStatus 共享实现，
 * lib/workflow-status.ts——消费者结果端点同款推进语义）。
 */

import type { WorkflowStatus } from "@/lib/contracts";
import { advanceWorkflowStatus } from "@/lib/workflow-status";
import { jsonError } from "@/lib/responses";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workflowId: string }> }
): Promise<Response> {
  const { workflowId } = await params;
  const updated = await advanceWorkflowStatus(workflowId);
  if (!updated) {
    return jsonError("E_WORKFLOW_NOT_FOUND", `workflow "${workflowId}" not found`, 404);
  }

  const payload: WorkflowStatus = {
    version: 1,
    workflowId: updated.workflowId,
    status: updated.status,
    ...(updated.errorCode !== undefined ? { errorCode: updated.errorCode } : {}),
    ...(updated.finalOutputUri !== undefined
      ? { finalOutputUri: updated.finalOutputUri }
      : {}),
    updatedAtMs: updated.updatedAtMs,
  };
  return Response.json(payload);
}
