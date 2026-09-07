/**
 * sidecar IPC 客户端（D2/D16）— 控制面 → 执行面的本地调用表面
 *
 * D16 定案：HTTP over loopback TCP（localhost:port）+ JSON 载荷 + 每次启动随机 token
 * 鉴权（x-ipc-token header）。契约 = contracts ipc 域（StartWorkflowRequest /
 * WorkflowStatusSnapshot / NodeCompletionNotice，codegen 类型）。
 *
 * P0 已接线：sidecar 二进制（server/sidecar，serve 模式）实现同契约端点；生命周期
 * （instrumentation 拉起 + 崩溃重启 + 端口回读）见 lib/sidecar-supervisor.ts 与
 * server/DESIGN.md §6。V7：控制面轮询 GET /workflows/{id}/status（探活一体）；
 * ping() 为 GET /status 聚合探活（P0 IPC 内部面，未入 contracts）。
 */

import type {
  NodeCompletionNotice,
  StartWorkflowRequest,
  WorkflowStatusSnapshot,
} from "../contracts";

export interface SidecarClientOptions {
  port: number;
  token: string;
}

/** GET /status 聚合探活载荷（P0 IPC 内部面；未入 contracts，正式面随 /storage·WS 收口） */
export interface SidecarLiveness {
  version: number;
  ok: boolean;
  workflows: { workflowId: string; status: string }[];
}

export class SidecarClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: SidecarClientOptions) {
    this.baseUrl = `http://127.0.0.1:${options.port}`;
    this.token = options.token;
  }

  /** V7 探活（GET /status 聚合）：不可达返回 null（拉不到即探活） */
  async ping(): Promise<SidecarLiveness | null> {
    try {
      const response = await fetch(`${this.baseUrl}/status`, {
        headers: { "x-ipc-token": this.token },
      });
      if (!response.ok) return null;
      return (await response.json()) as SidecarLiveness;
    } catch {
      return null;
    }
  }

  /** 启动工作流（POST /workflows：DCIr 序列化图 + 绑定计划） */
  async startWorkflow(request: StartWorkflowRequest): Promise<void> {
    await this.call("POST", "/workflows", request);
  }

  /** 工作流状态快照（GET /workflows/{id}/status，V7 轮询；返回 null = sidecar 不可达） */
  async status(workflowId: string): Promise<WorkflowStatusSnapshot | null> {
    return this.call<WorkflowStatusSnapshot>(
      "GET",
      `/workflows/${encodeURIComponent(workflowId)}/status`
    );
  }

  /** 节点完成通知（POST /workflows/{id}/node-completions，D8 事件驱动唤醒） */
  async notifyNodeCompletion(notice: NodeCompletionNotice): Promise<void> {
    await this.call(
      "POST",
      `/workflows/${encodeURIComponent(notice.workflowId)}/node-completions`,
      notice
    );
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "x-ipc-token": this.token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`sidecar IPC ${method} ${path} → ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

// sidecar 二进制已实现同契约端点（server/sidecar serve 模式）；接线由
// lib/sidecar-supervisor.ts（instrumentation 拉起）与 lib/dispatch-pump.ts（V7 轮询泵）消费
