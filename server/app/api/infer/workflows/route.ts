/**
 * POST /api/infer/workflows — 推理请求入口（消费者，D19①）
 *
 * 全链路（server/DESIGN §5 工作流的控制面半边）：
 *   用户 token 鉴权（/auth introspect）→ 请求校验（zod，单方消费面不入 contracts）
 *   → 建账 registered → 绑定（D9 MVP 整图单端点，scheduler）→ 全量检视（D6，
 *   inspectWorkflowGraph）→ 失败落 rejected + E_INSPECTION_REJECTED（HTTP 422）
 *   → sidecar 启动工作流（StartWorkflowRequest：图 + 绑定计划 + 对象键/签名 URL）
 *   → dispatching → 202 返回 workflowId。
 *
 * 键规则（scheduler.planObjectKeys）：输入对象由消费者按规则预置总线
 * （`workflows/{id}/inputs/{node}/{port}`；上传预签名端点 P1 末按需补），
 * sidecar/端点按 URI 语义取用（V8：张量不进 JSON）。
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StartWorkflowRequest, WorkflowStatus } from "@/lib/contracts";
import { requireUserAuth } from "@/lib/control-auth";
import { getEndpointRegistry } from "@/lib/endpoint-registry";
import { inspectWorkflowGraph, type InspectableModel } from "@/lib/inspection";
import { getBusSigner } from "@/lib/dispatch-pump";
import { bindWorkflow, planObjectKeys } from "@/lib/scheduler";
import { jsonError } from "@/lib/responses";
import { getIpcSidecarClient } from "@/lib/sidecar-supervisor";
import { getWorkflowLedger } from "@/lib/workflow-ledger";

const submitSchema = z.object({
  /** 消费者自带工作流标识（两步流：先预置输入再提交；不带则服务端生成，一步流）。
   *  已存在且非 registered → 409 E_WORKFLOW_STATE_CONFLICT（防重复启动） */
  workflowId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  /** DCIr 序列化图（opaque，D3：控制面静态读图不 link DCinfer） */
  graph: z.record(z.string(), z.unknown()),
  /** 远程节点意图（nodeId → modelKey）；空数组 = 纯本地图（全 sidecar 执行） */
  remoteNodes: z
    .array(
      z.object({
        nodeId: z.string().min(1),
        modelKey: z.string().min(1),
      })
    )
    .default([]),
  /** 本地图级输入声明（仅限 sidecar 本地执行节点的输入：sidecar 启动时经 workflowInputs
   *  拉取注入，值不入 JSON，V8；对象由消费者预置总线。远程节点的输入不在此声明——
   *  scheduler.remoteInputBindings 自动枚举其端口为对象键，经 TaskDispatch 由端点下载，
   *  消费者只须按同键空间 workflows/{id}/inputs/{node}/{port} 预置对象） */
  localInputs: z
    .array(
      z.object({
        node: z.string().min(1),
        port: z.string().min(1),
      })
    )
    .default([]),
});

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUserAuth(request);
  if (auth instanceof Response) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError("E_INTERNAL", "request body is not valid JSON");
  }
  const parsed = submitSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError("E_INTERNAL", `malformed submit request: ${parsed.error.message}`);
  }
  const { graph, remoteNodes, localInputs, workflowId: clientWorkflowId } = parsed.data;

  // 两步流：id 由消费者自带（键规则含 id，输入预置须先行）；一步流服务端生成
  const ledger = getWorkflowLedger();
  const workflowId = clientWorkflowId ?? randomUUID();
  const existing = ledger.get(workflowId);
  if (existing && existing.status !== "registered") {
    return jsonError(
      "E_WORKFLOW_STATE_CONFLICT",
      `workflow "${workflowId}" is already ${existing.status}`,
      409
    );
  }
  if (!existing) {
    ledger.upsert({ workflowId, status: "registered" });
  }

  // 绑定（D9 MVP：整图单端点；含 IO 复核与余量前置）+ 全量检视（两层防线静态半边）
  const bind = bindWorkflow({
    workflowId,
    graph,
    intents: remoteNodes,
    endpoints: getEndpointRegistry().listAlive(),
  });
  const allModels: InspectableModel[] = getEndpointRegistry()
    .listAlive()
    .flatMap((e) => e.capability.models);
  if (!bind.ok) {
    ledger.transition(workflowId, "rejected", { errorCode: "E_INSPECTION_REJECTED" });
    return jsonError("E_INSPECTION_REJECTED", bind.reason, 422);
  }
  const inspection = inspectWorkflowGraph(graph, bind.bindings, allModels);
  if (!inspection.ok) {
    ledger.transition(workflowId, "rejected", { errorCode: "E_INSPECTION_REJECTED" });
    return jsonError(
      "E_INSPECTION_REJECTED",
      inspection.failures.map((f) => `${f.nodeId}(${f.modelKey}): ${f.detail}`).join("; "),
      422
    );
  }

  // sidecar 启动（对象键规划 + 签名 URL 双语义：bindings=对象键 / final+inputs=URL）
  const sidecar = getIpcSidecarClient();
  if (!sidecar) {
    ledger.transition(workflowId, "failed", { errorCode: "E_INTERNAL" });
    return jsonError("E_INTERNAL", "sidecar IPC 未就绪（SIDECAR_BIN 未配置或尚未拉起）", 502);
  }
  const keys = planObjectKeys(workflowId);
  const signer = getBusSigner();
  const startRequest: StartWorkflowRequest = {
    version: 1,
    workflowId,
    graph,
    bindingPlan: { remoteNodes: bind.bindings },
    finalOutputUri: await signer(keys.finalKey(), "PUT"),
    ...(localInputs.length > 0
      ? {
          workflowInputs: await Promise.all(
            localInputs.map(async (li) => ({
              node: li.node,
              port: li.port,
              uri: await signer(keys.localInputKey(li.node, li.port), "GET"),
            }))
          ),
        }
      : {}),
  };
  try {
    await sidecar.startWorkflow(startRequest);
  } catch (e) {
    ledger.transition(workflowId, "failed", { errorCode: "E_INTERNAL" });
    return jsonError("E_INTERNAL", `sidecar startWorkflow failed: ${(e as Error).message}`, 502);
  }

  ledger.transition(workflowId, "dispatching", {
    ...(bind.endpointId ? { endpointId: bind.endpointId } : {}),
  });
  console.log(
    `[infer] workflow started: ${workflowId} → endpoint ${bind.endpointId || "(local-only)"} ` +
      `(remote nodes: ${bind.bindings.length}, consumer account: ${auth.accountId ?? "anonymous"})`
  );

  const payload: WorkflowStatus = {
    version: 1,
    workflowId,
    status: "dispatching",
  };
  return Response.json(payload, { status: 202 });
}
