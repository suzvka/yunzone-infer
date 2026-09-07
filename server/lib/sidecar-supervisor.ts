/**
 * sidecar 生命周期管理（D2 / server DESIGN §6 定案：Next `instrumentation` 拉起 +
 * 崩溃重启；状态回传走控制面轮询 /status，V7）
 *
 * - 二进制与端口经环境变量注入：SIDECAR_BIN（未配置则不拉起——CI / 纯单测环境）；
 *   SIDECAR_PORT=0 表示 OS 分配端口，经 sidecar stderr 的监听行回读（D16）。
 * - token：每次启动随机生成（D16），经 --token 注入 sidecar。
 * - 崩溃重启：指数退避简化为固定间隔，超限放弃并日志告警（P1 随 §11「双平面 IPC
 *   故障域」的探活/告警专项收敛）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { SidecarClient } from "./ipc/sidecar-client";

export interface SidecarHandle {
  binPath: string;
  port: number;
  token: string;
}

export interface SidecarSupervisorOptions {
  binPath: string;
  /** 0 = OS 分配端口（回读），默认取 env SIDECAR_PORT */
  port: number;
  /** 缺省随机生成（D16） */
  token: string;
  maxRestarts?: number;
}

export const SIDECAR_DEFAULT_PORT = 0;

export class SidecarSupervisor {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopped = false;
  private port: number;
  private readonly maxRestarts: number;

  constructor(private readonly options: SidecarSupervisorOptions) {
    this.port = options.port;
    this.maxRestarts = options.maxRestarts ?? 5;
  }

  /** 幂等启动（instrumentation 每次服务启动调用） */
  start(): void {
    if (this.child || this.stopped) return;
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
  }

  /** 当前端口（SIDECAR_PORT=0 时，回读完成前为 0） */
  get handle(): SidecarHandle {
    return { binPath: this.options.binPath, port: this.port, token: this.options.token };
  }

  /** 控制面 → 执行面的 IPC 客户端（端口回读完成前调用会拿到 port=0） */
  ipcClient(): SidecarClient {
    return new SidecarClient({ port: this.port, token: this.options.token });
  }

  private spawnChild(): void {
    const { binPath, token } = this.options;
    console.log(`[sidecar-supervisor] spawn: ${binPath} serve --port ${this.port}`);
    const child = spawn(binPath, ["serve", "--port", String(this.port), "--token", token], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;

    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (!line) return;
      // 回读实际端口："[infer-sidecar] listening on 127.0.0.1:<port> (D16 loopback + token)"
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(line);
      if (match?.[1]) {
        const discovered = Number(match[1]);
        if (discovered !== this.port) {
          console.log(`[sidecar-supervisor] sidecar port discovered: ${discovered}`);
        }
        this.port = discovered;
      }
      console.log(`[sidecar] ${line}`);
    });

    child.on("exit", (code, signal) => {
      this.child = null;
      if (this.stopped) return;
      console.error(`[sidecar-supervisor] sidecar exited (code=${code} signal=${signal})`);
      if (this.restarts < this.maxRestarts) {
        this.restarts += 1;
        console.error(`[sidecar-supervisor] restart ${this.restarts}/${this.maxRestarts} in 500ms`);
        setTimeout(() => {
          if (!this.stopped && !this.child) this.spawnChild();
        }, 500);
      } else {
        console.error("[sidecar-supervisor] restart limit reached; giving up（§11 故障域告警接入 P1）");
      }
    });
  }
}

// ── 进程级单例（dev 热重载下经 globalThis 保持）─────────────────────────────

const globalForSupervisor = globalThis as unknown as {
  __inferSidecarSupervisor?: SidecarSupervisor;
};

/** SIDECAR_BIN 未配置时返回 null（不拉起 sidecar：CI / 纯单测 / 外部自管 sidecar） */
export function getSidecarSupervisor(): SidecarSupervisor | null {
  const binPath = process.env.SIDECAR_BIN;
  if (!binPath) return null;
  globalForSupervisor.__inferSidecarSupervisor ??= new SidecarSupervisor({
    binPath,
    port: Number(process.env.SIDECAR_PORT ?? SIDECAR_DEFAULT_PORT) || SIDECAR_DEFAULT_PORT,
    // D16：每次启动随机 token；显式注入（对拍/调试）经 SIDECAR_TOKEN 覆盖
    token: process.env.SIDECAR_TOKEN ?? crypto.randomBytes(16).toString("hex"),
  });
  return globalForSupervisor.__inferSidecarSupervisor;
}

/** 控制面任意处获取 IPC 客户端（sidecar 未配置/未拉起时返回 null） */
export function getIpcSidecarClient(): SidecarClient | null {
  const supervisor = getSidecarSupervisor();
  if (!supervisor) return null;
  const { port } = supervisor.handle;
  if (!port) return null; // SIDECAR_PORT=0 尚未回读实际端口
  return supervisor.ipcClient();
}
