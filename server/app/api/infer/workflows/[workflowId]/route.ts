/**
 * GET /api/infer/workflows/{workflowId} — 消费者结果查询（D19①）
 *
 * 契约：WorkflowStatus（finalOutputUrl 为本端点新增语义字段：status=completed
 * 时按 finalOutputUri 的对象键签发 GET 预签名——Uri 是控制面派发时的 PUT 形态，
 * 消费者取回需 GET 语义重签）。状态推进与机器面共用 advanceWorkflowStatus。
 */

import type { WorkflowStatus } from "@/lib/contracts";
import { normalizeBusKey } from "@/lib/bus-signer";
import { requireUserAuth } from "@/lib/control-auth";
import { getBusSigner } from "@/lib/dispatch-pump";
import { jsonError } from "@/lib/responses";
import { advanceWorkflowStatus } from "@/lib/workflow-status";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workflowId: string }> }
): Promise<Response> {
  const auth = await requireUserAuth(request);
  if (auth instanceof Response) return auth;
  const { workflowId } = await params;

  const record = await advanceWorkflowStatus(workflowId);
  if (!record) {
    return jsonError("E_WORKFLOW_NOT_FOUND", `workflow "${workflowId}" not found`, 404);
  }

  // completed → finalOutputUri（PUT 形态）取对象键重签 GET（时效内可取，V8）
  let finalOutputUrl: string | undefined;
  if (record.status === "completed" && record.finalOutputUri !== undefined) {
    finalOutputUrl = await getBusSigner()(normalizeBusKey(record.finalOutputUri), "GET");
  }

  const payload: WorkflowStatus = {
    version: 1,
    workflowId: record.workflowId,
    status: record.status,
    ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
    ...(record.finalOutputUri !== undefined ? { finalOutputUri: record.finalOutputUri } : {}),
    ...(finalOutputUrl !== undefined ? { finalOutputUrl } : {}),
    updatedAtMs: record.updatedAtMs,
  };
  return Response.json(payload);
}
