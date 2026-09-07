/**
 * ops 运维聚合 — service-kit /ops 落点（D5）
 *
 * 聚合端点注册中心快照（「检视全部已登记节点」投影）+ env 指纹，
 * 经 /api/ops/report 暴露（requireAdminAuth 守卫，/ops/next 协议）。
 */

import { createOpsReporter } from "yunzone-service-kit/ops";
import { getEndpointRegistry } from "./endpoint-registry";

const globalForOps = globalThis as unknown as {
  __inferOpsReporter?: ReturnType<typeof createOpsReporter>;
};

export function getOpsReporter() {
  globalForOps.__inferOpsReporter ??= (() => {
    const reporter = createOpsReporter({
      name: "yunzone-infer-server",
      version: "0.0.0",
    });
    reporter.addRegistry("endpoints", getEndpointRegistry());
    reporter.setEnvKeys([
      "PORT",
      "HOST",
      "AUTH_CENTER_BASE_URL",
      "ADMIN_PASSWORD",
      "UC_BASE_URL",
      "DATABASE_URL",
      "SIDECAR_PORT",
    ]);
    return reporter;
  })();
  return globalForOps.__inferOpsReporter;
}
