/**
 * sidecar IPC 客户端骨架（D2/D16）— 控制面 → 执行面的本地调用表面
 *
 * D16 定案：HTTP over loopback TCP（localhost:port）+ JSON 载荷 + 每次启动随机 token
 * 鉴权（x-ipc-token header）。契约 = contracts ipc 域（StartWorkflowRequest /
 * WorkflowStatusSnapshot / NodeCompletionNotice，codegen 类型）。
 *
 * 骨架期：sidecar 二进制未落地（sidecar/ C++ 占位），本模块固化调用表面与端点路径，
 * 方法体 P0 随 sidecar 最小实现接线；生命周期（instrumentation 拉起 + 崩溃重启）见
 * server/DESIGN.md §6。V7：控制面轮询 GET /workflows/{id}/status（探活一体）。
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

export class SidecarClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: SidecarClientOptions) {
    this.baseUrl = `http://127.0.0.1:${options.port}`;
    this.token = options.token;
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

/** 骨架期占位：sidecar 未接线前抛错，固化调用面供 P0 接线 */
export function createSidecarClientNotWired(): never {
  throw new Error(
    "sidecar IPC not wired (P0): sidecar binary 未落地，接线见 server/DESIGN.md §4 / §6"
  );
}
