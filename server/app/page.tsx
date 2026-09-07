/**
 * 落地页 — 控制面自述 + 已登记端点快照（D5「检视全部已登记节点」的公开投影）
 *
 * 三受众完整 UI（消费者 / 管理员 / 提供者）P1 按路由树初始化（app/README.md）；
 * 本页为骨架冒烟入口。运行时数据（内存注册中心）→ 强制动态渲染。
 */

import { getEndpointRegistry } from "@/lib/endpoint-registry";

export const dynamic = "force-dynamic";

export default async function Home() {
  const status = await getEndpointRegistry().getStatus();
  return (
    <main style={{ fontFamily: "monospace", padding: "2rem", lineHeight: 1.8 }}>
      <h1>yunzone-infer 控制面</h1>
      <p>分布式推理资源池 — 服务器持有推理图、客户端持有算力</p>
      <section>
        <h2>已登记端点：{status.registeredCount}</h2>
        <ul>
          {status.providers.map((p) => (
            <li key={p.id}>
              {p.id} · 模型 {p.modelCount} 个 · 队列余量 {p.queueTotalRemaining} ·{" "}
              显存 {p.vramFreeBytes ?? "—"} · lastSeen {new Date(p.lastSeenMs).toISOString()}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>控制通道（骨架期已就位）</h2>
        <ul>
          <li>POST /api/control/v1/endpoints — 注册</li>
          <li>POST /api/control/v1/endpoints/&#123;endpointId&#125;/heartbeat — 心跳（全量能力）</li>
          <li>POST /api/control/v1/tasks/completions — 完成上报</li>
          <li>GET /api/control/v1/workflows/&#123;workflowId&#125; — 工作流状态</li>
          <li>GET /api/ops/report — 运维报告（requireAdminAuth）</li>
        </ul>
      </section>
    </main>
  );
}
