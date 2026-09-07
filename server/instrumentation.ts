/**
 * Next.js Instrumentation Hook（server/DESIGN.md §6 定案，2026-09-07 确认）：
 * 服务启动时拉起 sidecar（崩溃重启）+ 启动派发泵（V7 轮询 → WS 推送，V5）。
 * SIDECAR_BIN 未配置时两者均不启动（CI / 纯单测 / 外部自管 sidecar）。
 *
 * 泵装配（P1）：
 * - transport = WS 网关推送（未连接/失败 → 暂缓重试）；
 * - resolveEndpoint = 工作流绑定账（ledger.endpointId，批次 C 写入）；
 * - canDispatch = 端点存活（registry TTL）+ WS 在线（gateway）+ per-model 余量
 *   （D9 反压：余量软控制，注入侧挡下）；
 * - onExpired = TTL 判死 → 在途任务重派（D7：补偿优先级 + 重签 URL，requestId
 *   幂等先到先得）。
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getSidecarSupervisor } = await import("./lib/sidecar-supervisor");
  const supervisor = getSidecarSupervisor();
  if (!supervisor) return;

  supervisor.start();

  const [
    { pollSidecarDispatches, getBusSigner, reassignInFlightTasks },
    { getWsGateway },
    { getEndpointRegistry },
    { getWorkflowLedger },
  ] = await Promise.all([
    import("./lib/dispatch-pump"),
    import("./lib/ws-gateway"),
    import("./lib/endpoint-registry"),
    import("./lib/workflow-ledger"),
  ]);

  const registry = getEndpointRegistry({
    // D7 判死重派：sweep 出的端点其在途任务换绑 + 补偿优先级（candidates = 存活视图）
    onExpired: (expired) => {
      for (const endpointId of expired) {
        reassignInFlightTasks(endpointId, registry.listAlive());
      }
    },
  });
  const gateway = getWsGateway();
  const ledger = getWorkflowLedger();
  const signer = getBusSigner();

  const tick = () => {
    void pollSidecarDispatches(supervisor.ipcClient(), {
      signer,
      transport: (endpointId, dispatch) => gateway.pushToEndpoint(endpointId, dispatch),
      resolveEndpoint: (workflowId) => ledger.get(workflowId)?.endpointId ?? null,
      canDispatch: (endpointId, modelKey) => {
        if (!gateway.isOnline(endpointId)) return false; // WS 未连接：推送无门
        const entry = registry.listAlive().find((e) => e.endpointId === endpointId);
        if (!entry) return false; // TTL 判死（sweep 顺带触发重派钩子）
        const model = entry.capability.models.find((m) => m.modelKey === modelKey);
        return (model?.queueRemaining ?? 0) >= 1; // D9 余量软控制
      },
      onUnreachable: () => {
        // 探活失败静默（拉不到即探活；崩溃重启由 supervisor 负责）
      },
    }).catch((e) => console.error("[dispatch-pump] poll failed:", e));
  };
  tick();
  setInterval(tick, 2_000);
}
