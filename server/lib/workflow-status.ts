/**
 * 工作流状态推进（P1 聚合）— ledger × sidecar 快照联动（V7 轮询，探活一体）
 *
 * control（机器面状态查询）与 infer（消费者结果查询）共用：
 * - 账不存在 → null（调用方回 404）；
 * - 非终态账目随 sidecar 快照映射推进（starting→dispatching / waitingRemote·
 *   executing→executing / completed→completed 回填 finalOutputUri / failed→failed
 *   回填 errorCode）；sidecar 不可达保持账目现状（重启后账本内存丢失可见）；
 * - 终态（completed/failed）触发撤销下发（D7 标记式懒惰撤销）。
 */

import type { ErrorCode, GraphExecutionStatus } from "@/lib/contracts";
import type { WorkflowRecord } from "@/lib/workflow-ledger";
import { revokeTasksOfWorkflow } from "@/lib/dispatch-pump";
import { getIpcSidecarClient } from "@/lib/sidecar-supervisor";
import { getWsGateway } from "@/lib/ws-gateway";
import { getWorkflowLedger } from "@/lib/workflow-ledger";

export const WORKFLOW_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "rejected",
  "cancelled",
]);

/** sidecar 图执行态 → 控制面生命周期态（contracts 两域状态集映射） */
export function sidecarToLifecycle(status: GraphExecutionStatus): WorkflowRecord["status"] {
  switch (status) {
    case "starting":
      return "dispatching";
    case "waitingRemote":
    case "executing":
      return "executing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

/**
 * 读取并推进工作流账目（原地 transition + 终态撤销副作用）；
 * sidecar 拉取失败不抛错（保持现状，调用方拿到的 record 仍可用）。
 */
export async function advanceWorkflowStatus(workflowId: string): Promise<WorkflowRecord | null> {
  const ledger = getWorkflowLedger();
  const record = ledger.get(workflowId);
  if (!record) return null;

  if (!WORKFLOW_TERMINAL_STATUSES.has(record.status)) {
    const sidecar = getIpcSidecarClient();
    const snapshot = sidecar ? await sidecar.status(workflowId).catch(() => null) : null;
    if (snapshot) {
      const next = sidecarToLifecycle(snapshot.status);
      if (next !== record.status || snapshot.finalOutputUri || snapshot.errorCode) {
        const finalOutputUri = snapshot.finalOutputUri; // 原样回填（控制面签发 URL，时效内可取；V8 控制面仅持元数据 + URI）
        ledger.transition(workflowId, next, {
          ...(snapshot.errorCode !== undefined ? { errorCode: snapshot.errorCode as ErrorCode } : {}),
          ...(finalOutputUri !== undefined ? { finalOutputUri } : {}),
        });
        // 终态撤销下发（D7 标记式懒惰撤销）：已推送未上报任务通知端点跳过
        if (next === "completed" || next === "failed") {
          const gateway = getWsGateway();
          const revoked = revokeTasksOfWorkflow(
            workflowId,
            (endpointId, revoke) => gateway.pushToEndpoint(endpointId, revoke),
            `workflow-${next}`
          );
          if (revoked > 0) {
            console.log(`[workflow] ${workflowId} ${next}: ${revoked} task(s) revoked`);
          }
        }
      }
    }
  }

  return ledger.get(workflowId) ?? record;
}
