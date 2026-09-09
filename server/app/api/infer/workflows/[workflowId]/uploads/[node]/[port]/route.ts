/**
 * GET /api/infer/workflows/{workflowId}/uploads/{node}/{port} — 输入上传预签名（D19① 两步流第 2 步）
 *
 * 消费者先按键规则预置输入对象（键含 workflowId，须先申请/自带 id）、再提交工作流；
 * 本端点签发 PUT URL（S3 模式 = kit getUploadUrl 预签名；替身模式 = 直链）。
 * 非 registered 态（已启动/已终态）→ 409 E_WORKFLOW_STATE_CONFLICT（输入键已固化）。
 * node/port 直接拼入对象键：严格字符白名单防路径穿越（.. 与分隔符拒绝）。
 */

import type { InputUploadUrlResponse } from "@/lib/contracts";
import { requireUserAuth } from "@/lib/control-auth";
import { getBusSigner } from "@/lib/dispatch-pump";
import { jsonError } from "@/lib/responses";
import { planObjectKeys } from "@/lib/scheduler";
import { getWorkflowLedger } from "@/lib/workflow-ledger";

/** 对象键段白名单（节点名/端口名同规则；scheduler 键规则的消费侧防御） */
const KEY_SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workflowId: string; node: string; port: string }> }
): Promise<Response> {
  const auth = await requireUserAuth(request);
  if (auth instanceof Response) return auth;
  const { workflowId, node, port } = await params;

  if (!KEY_SEGMENT.test(node) || !KEY_SEGMENT.test(port)) {
    return jsonError("E_INTERNAL", `invalid node/port segment: "${node}"/"${port}"`, 400);
  }

  const ledger = getWorkflowLedger();
  const record = ledger.get(workflowId);
  if (record && record.status !== "registered") {
    return jsonError(
      "E_WORKFLOW_STATE_CONFLICT",
      `workflow "${workflowId}" is ${record.status}; inputs must be uploaded before submit`,
      409
    );
  }
  if (!record) {
    // 两步流时序：键含 id，输入预置必须先于提交——首个上传意图即开账（registered），
    // 提交端点对已存在账复用（两步流与一步流在同一提交语义上会合）
    ledger.upsert({ workflowId, status: "registered" });
    console.log(
      `[infer] workflow account opened by upload intent: ${workflowId}`
    );
  }

  const uploadUrl = await getBusSigner()(planObjectKeys(workflowId).localInputKey(node, port), "PUT");
  const payload: InputUploadUrlResponse = { version: 1, workflowId, node, port, uploadUrl };
  return Response.json(payload);
}
