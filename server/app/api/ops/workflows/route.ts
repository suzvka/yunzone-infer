/**
 * GET /api/ops/workflows — 工作流账本快照（管理后台投影，D5/D19②）
 *
 * requireAdminAuth 守卫；P1 内存账本（WorkflowLedger.list()），P2 随 /db 持久化。
 */

import { requireAdminAuth } from "yunzone-service-kit/ops/next";
import { getWorkflowLedger } from "@/lib/workflow-ledger";

export const GET = requireAdminAuth(async () =>
  Response.json({ workflows: getWorkflowLedger().list() })
);
