/**
 * GET /api/ops/report — 运维报告（service-kit /ops，D5）
 *
 * requireAdminAuth 守卫（ADMIN_PASSWORD 未配置 → 503 禁用态；未登录 → 401），
 * 聚合端点注册中心快照（「检视全部已登记节点」投影）+ env 指纹。
 */

import { requireAdminAuth } from "yunzone-service-kit/ops/next";
import { getOpsReporter } from "@/lib/ops";

export const GET = requireAdminAuth(async () =>
  Response.json(await getOpsReporter().report())
);
