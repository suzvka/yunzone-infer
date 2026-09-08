/**
 * 落地页 — 控制面自述 + 已登记端点快照（D5「检视全部已登记节点」的公开投影）
 *
 * 三受众完整 UI（消费者 / 管理员 / 提供者）P1 按路由树初始化（app/README.md）；
 * 本页为骨架冒烟入口。运行时数据（内存注册中心）→ 强制动态渲染。
 * 视觉重设计（2026-09-08）：仅改版呈现，数据源与字段保持不变。
 */

import { getEndpointRegistry } from "@/lib/endpoint-registry";

export const dynamic = "force-dynamic";

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.floor(s / 60)}m 前`;
  if (s < 86400) return `${Math.floor(s / 3600)}h 前`;
  return `${Math.floor(s / 86400)}d 前`;
}

const CONTROL_CHANNELS: { method: "GET" | "POST"; path: string; desc: string }[] = [
  { method: "POST", path: "/api/control/v1/endpoints", desc: "端点注册（首次握手建账）" },
  { method: "POST", path: "/api/control/v1/endpoints/{endpointId}/heartbeat", desc: "心跳 · 全量能力声明" },
  { method: "POST", path: "/api/control/v1/tasks/completions", desc: "任务完成上报" },
  { method: "GET", path: "/api/control/v1/workflows/{workflowId}", desc: "工作流状态查询" },
  { method: "GET", path: "/api/ops/report", desc: "运维报告（requireAdminAuth）" },
];

export default async function Home() {
  const status = await getEndpointRegistry().getStatus();
  const now = Date.now();
  const providers = status.providers;
  const totalModels = providers.reduce((s, p) => s + p.modelCount, 0);
  const totalQueue = providers.reduce((s, p) => s + p.queueTotalRemaining, 0);

  return (
    <main className="page">
      <section className="hero">
        <span className="eyebrow">分布式推理资源池</span>
        <h1>服务器持有推理图，客户端持有算力</h1>
        <p>
          把分散的算力组织成可被统一检视、统一调度的推理资源池 —— 以叠加层方式实现，
          只复用不修改 DCinfer。以下为控制面实时快照。
        </p>
        <div className="stat-grid" style={{ marginTop: "1.8rem" }}>
          <div className="stat">
            <div className="label">已登记端点</div>
            <div className="value">{status.registeredCount}</div>
          </div>
          <div className="stat">
            <div className="label">在线模型总数</div>
            <div className="value">{totalModels}</div>
          </div>
          <div className="stat">
            <div className="label">队列总余量</div>
            <div className="value">{totalQueue}</div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>已登记端点</h2>
          <span className="count">{providers.length}</span>
          <span className="rule" />
        </div>
        {providers.length === 0 ? (
          <div className="empty">
            <div className="big">暂无已登记端点</div>
            <div>算力终端经 POST /api/control/v1/endpoints 注册后，将实时出现在此。</div>
          </div>
        ) : (
          <div className="card-grid">
            {providers.map((p) => (
              <div className="endpoint-card" key={p.id}>
                <div className="ep-id">
                  <span className="dot" />
                  {p.id}
                </div>
                <div className="ep-metrics">
                  <div className="m">
                    <div className="k">模型数</div>
                    <div className="v num">{p.modelCount}</div>
                  </div>
                  <div className="m">
                    <div className="k">队列余量</div>
                    <div className="v num">{p.queueTotalRemaining}</div>
                  </div>
                  <div className="m">
                    <div className="k">显存可用</div>
                    <div className="v num">{formatBytes(p.vramFreeBytes)}</div>
                  </div>
                  <div className="m">
                    <div className="k">最近心跳</div>
                    <div className="v num">{formatAgo(p.lastSeenMs, now)}</div>
                  </div>
                </div>
                <div className="ep-foot">
                  <span>lastSeen</span>
                  <span>{new Date(p.lastSeenMs).toISOString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>控制通道（骨架期已就位）</h2>
          <span className="rule" />
        </div>
        <div className="chip-list">
          {CONTROL_CHANNELS.map((c) => (
            <div className="chip-row" key={c.path}>
              <span className={`chip-method ${c.method.toLowerCase()}`}>{c.method}</span>
              <span className="chip-path">{c.path}</span>
              <span className="chip-desc">{c.desc}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="foot">
        <span>yunzone-infer · 控制面（TS / Next）</span>
        <a href="/admin">进入管理控制台 →</a>
      </footer>
    </main>
  );
}
