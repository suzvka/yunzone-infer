/**
 * GET /api/infer/workflows/{workflowId}/nodes/{node}/output — 远程节点输出取回预签名（D19①）
 *
 * 键规则 workflows/{id}/nodes/{nodeId}/output：端点上传、sidecar 聚合消费，
 * 消费者可在执行中途或终态取回做逐节点对拍/展示。对象未生成时按 URL 拉取为存储侧 404。
 */

import type { NodeOutputUrlResponse } from "@/lib/contracts";
import { requireUserAuth } from "@/lib/control-auth";
import { getBusSigner } from "@/lib/dispatch-pump";
import { jsonError } from "@/lib/responses";
import { planObjectKeys } from "@/lib/scheduler";
import { getWorkflowLedger } from "@/lib/workflow-ledger";

const KEY_SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workflowId: string; node: string }> }
): Promise<Response> {
  const auth = await requireUserAuth(request);
  if (auth instanceof Response) return auth;
  const { workflowId, node } = await params;

  if (!KEY_SEGMENT.test(node)) {
    return jsonError("E_INTERNAL", `invalid node segment: "${node}"`, 400);
  }

  const record = getWorkflowLedger().get(workflowId);
  if (!record) {
    return jsonError("E_WORKFLOW_NOT_FOUND", `workflow "${workflowId}" not found`, 404);
  }

  const outputUrl = await getBusSigner()(planObjectKeys(workflowId).remoteOutputKey(node), "GET");
  const payload: NodeOutputUrlResponse = { version: 1, workflowId, node, outputUrl };
  return Response.json(payload);
}
