"use client";

/**
 * /admin — 管理控制台（D5/D19② 管理员受众）：全网运行状况投影
 *
 * 数据面：GET /api/ops/report（已登记端点快照）+ GET /api/ops/workflows
 * （工作流账本），requireAdminAuth 会话 cookie 守卫（本页登录表单签发）。
 * 客户端组件轮询刷新（P1 最简形态；三受众完整 UI P2 按路由树展开）。
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
    return <main style={{ fontFamily: "monospace", padding: "2rem" }}>加载中…</main>;
  }
  if (state === "disabled") {
    return (
      <main style={{ fontFamily: "monospace", padding: "2rem" }}>
        管理后台已禁用（服务端 ADMIN_PASSWORD 未配置）。
      </main>
    );
  }
  if (state === "need-login") {
    return (
      <main style={{ fontFamily: "monospace", padding: "2rem", lineHeight: 2 }}>
        <h1>管理员登录</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void login()}
          placeholder="ADMIN_PASSWORD"
        />{" "}
        <button onClick={() => void login()}>登录</button>
        {error && <p style={{ color: "crimson" }}>{error}</p>}
      </main>
    );
  }

  return (
    <main style={{ fontFamily: "monospace", padding: "2rem", lineHeight: 1.8 }}>
      <h1>管理控制台 — 全网运行状况</h1>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <section>
        <h2>已登记端点：{endpoints.length}</h2>
        <table cellPadding={6} style={{ borderCollapse: "collapse" }}>
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
                <td>{p.id}</td>
                <td>{p.modelCount}</td>
                <td>{p.queueTotalRemaining}</td>
                <td>{p.vramFreeBytes ?? "—"}</td>
                <td>{new Date(p.lastSeenMs).toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>工作流账本：{workflows.length}</h2>
        <table cellPadding={6} style={{ borderCollapse: "collapse" }}>
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
            {workflows.map((w) => (
              <tr key={w.workflowId}>
                <td>{w.workflowId}</td>
                <td>{w.status}</td>
                <td>{w.errorCode ?? "—"}</td>
                <td>{w.endpointId ?? "—"}</td>
                <td>{new Date(w.updatedAtMs).toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p style={{ color: "gray" }}>5s 自动刷新 · GET /api/ops/report + /api/ops/workflows</p>
    </main>
  );
}
