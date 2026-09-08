"use client";

/**
 * /admin — 管理控制台（D5/D19② 管理员受众）：全网运行状况投影
 *
 * 数据面：GET /api/ops/report（已登记端点快照）+ GET /api/ops/workflows
 * （工作流账本），requireAdminAuth 会话 cookie 守卫（本页登录表单签发）。
 * 客户端组件轮询刷新（P1 最简形态；三受众完整 UI P2 按路由树展开）。
 * 视觉重设计（2026-09-08）：仅改版呈现，状态机 / 轮询 / 数据源保持不变。
 */

import { useCallback, useEffect, useState } from "react";

interface EndpointStatus {
  id: string;
  modelCount: number;
  queueTotalRemaining: number;
  vramFreeBytes: number | null;
  lastSeenMs: number;
}

interface WorkflowRow {
  workflowId: string;
  status: string;
  errorCode?: string;
  endpointId?: string;
  updatedAtMs: number;
}

type LoginState = "checking" | "need-login" | "ready" | "disabled";

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 工作流 / 端点状态 → 语义徽标类与文案。 */
function statusBadge(status: string): { cls: string; label: string } {
  const s = status.toLowerCase();
  if (/(succeed|success|done|complet|finish|settle)/.test(s)) return { cls: "ok", label: status };
  if (/(running|dispatch|execut|binding|inflight|in_flight|process|pending_ack)/.test(s))
    return { cls: "run", label: status };
  if (/(retry|warn|degrad|expire|shelf|timeout_wait|queued|pending|regist|inspect)/.test(s))
    return { cls: "warn", label: status };
  if (/(fail|error|revok|reject|dead|terminat)/.test(s)) return { cls: "err", label: status };
  return { cls: "idle", label: status };
}

export default function AdminPage() {
  const [state, setState] = useState<LoginState>("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [endpoints, setEndpoints] = useState<EndpointStatus[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      const reportRes = await fetch("/api/ops/report", { cache: "no-store" });
      if (reportRes.status === 401) {
        setState("need-login");
        return;
      }
      if (reportRes.status === 503) {
        setState("disabled");
        return;
      }
      const report = (await reportRes.json()) as { registries?: Record<string, { providers?: EndpointStatus[] }> };
      const registry = report.registries?.endpoints as { providers?: EndpointStatus[] } | undefined;
      setEndpoints(registry?.providers ?? []);

      const wfRes = await fetch("/api/ops/workflows", { cache: "no-store" });
      if (wfRes.ok) {
        const body = (await wfRes.json()) as { workflows?: WorkflowRow[] };
        setWorkflows(body.workflows ?? []);
      }
      // 成功轮询即清除上一次瞬时故障（服务器重启 / HMR / 网络抖动导致的 Failed to fetch），
      // 使红色告警仅反映「最近一次」拉取状态，可自愈而非永久残留。
      setError("");
      setState("ready");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const login = async () => {
    setError("");
    const res = await fetch("/api/ops/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      setPassword("");
      await refresh();
    } else {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? `登录失败（HTTP ${res.status}）`);
    }
  };

  if (state === "checking") {
    return (
      <main className="page">
        <div className="loading-stage">
          <div className="spinner" />
          <div className="t">校验管理会话…</div>
        </div>
      </main>
    );
  }

  if (state === "disabled") {
    return (
      <main className="page">
        <div className="auth-stage">
          <div className="auth-card" style={{ textAlign: "center" }}>
            <h1>管理后台已禁用</h1>
            <p className="hint" style={{ marginBottom: 0 }}>
              服务端未配置 <span className="mono">ADMIN_PASSWORD</span>，管理控制台暂不可用。
            </p>
          </div>
        </div>
      </main>
    );
  }

  if (state === "need-login") {
    return (
      <main className="page">
        <div className="auth-stage">
          <form
            className="auth-card"
            onSubmit={(e) => {
              e.preventDefault();
              void login();
            }}
          >
            <div className="lock">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
            </div>
            <h1>管理员登录</h1>
            <p className="hint">输入 ADMIN_PASSWORD 以签发管理会话，查看全网运行状况。</p>
            {error && (
              <div className="alert err">
                <span>{error}</span>
              </div>
            )}
            <div className="field">
              <label htmlFor="admin-password">密码</label>
              <input
                id="admin-password"
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="ADMIN_PASSWORD"
                autoFocus
              />
            </div>
            <button type="submit" className="btn btn-primary btn-block">
              登录控制台
            </button>
          </form>
        </div>
      </main>
    );
  }

  const totalModels = endpoints.reduce((s, p) => s + p.modelCount, 0);
  const totalQueue = endpoints.reduce((s, p) => s + p.queueTotalRemaining, 0);

  return (
    <main className="page">
      <div className="toolbar">
        <span className="title">管理控制台</span>
        <span className="pulse">
          <span className="live" />
          实时 · 5s 自动刷新
        </span>
        <span className="spacer" />
        <a className="btn btn-ghost" href="/">
          ← 返回概览
        </a>
      </div>

      {error && (
        <div className="alert err">
          <span>{error}</span>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat">
          <div className="label">已登记端点</div>
          <div className="value">{endpoints.length}</div>
        </div>
        <div className="stat">
          <div className="label">在线模型总数</div>
          <div className="value">{totalModels}</div>
        </div>
        <div className="stat">
          <div className="label">队列总余量</div>
          <div className="value">{totalQueue}</div>
        </div>
        <div className="stat">
          <div className="label">工作流账本</div>
          <div className="value">{workflows.length}</div>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>已登记端点</h2>
          <span className="count">{endpoints.length}</span>
          <span className="rule" />
        </div>
        {endpoints.length === 0 ? (
          <div className="empty">
            <div className="big">暂无已登记端点</div>
            <div>等待算力终端注册后将实时投影于此。</div>
          </div>
        ) : (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>endpointId</th>
                    <th>模型数</th>
                    <th>队列余量</th>
                    <th>显存可用</th>
                    <th>lastSeen</th>
                  </tr>
                </thead>
                <tbody>
                  {endpoints.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <span className="cell-id" style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                          <span className="dot" />
                          {p.id}
                        </span>
                      </td>
                      <td className="num">{p.modelCount}</td>
                      <td className="num">{p.queueTotalRemaining}</td>
                      <td className="num">{formatBytes(p.vramFreeBytes)}</td>
                      <td className="cell-id">{new Date(p.lastSeenMs).toISOString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>工作流账本</h2>
          <span className="count">{workflows.length}</span>
          <span className="rule" />
        </div>
        {workflows.length === 0 ? (
          <div className="empty">
            <div className="big">暂无工作流记录</div>
            <div>经 POST /api/infer/workflows 提交推理请求后，任务状态将汇入此账本。</div>
          </div>
        ) : (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>workflowId</th>
                    <th>状态</th>
                    <th>错误码</th>
                    <th>绑定端点</th>
                    <th>updatedAt</th>
                  </tr>
                </thead>
                <tbody>
                  {workflows.map((w) => {
                    const b = statusBadge(w.status);
                    return (
                      <tr key={w.workflowId}>
                        <td className="cell-id">{w.workflowId}</td>
                        <td>
                          <span className={`badge ${b.cls}`}>
                            <span className="bdot" />
                            {b.label}
                          </span>
                        </td>
                        <td className="cell-id">{w.errorCode ?? "—"}</td>
                        <td className="cell-id">{w.endpointId ?? "—"}</td>
                        <td className="cell-id">{new Date(w.updatedAtMs).toISOString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <footer className="foot">
        <span>GET /api/ops/report · /api/ops/workflows</span>
        <span>5s 自动刷新</span>
      </footer>
    </main>
  );
}
