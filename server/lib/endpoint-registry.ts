/**
 * 端点注册中心（D4）— 控制面的节点存活与能力视图
 *
 * 继承 service-kit /registry ProviderRegistry 骨架（addRegistry 类型兼容 +
 * getStatus 快照形态），但**自建存储**：基座是「选单个最佳 Provider」模型，
 * 管理海量动态端点所需的 TTL 存活 / 注销 / 能力视图由本类补齐（D4）。
 *
 * 语义（对齐 contracts capability/control-channel 域）：
 * - 注册仅首次握手建账，重复注册拒绝（E_ENDPOINT_ALREADY_REGISTERED）
 * - 心跳每跳全量覆盖能力视图（V6，最防漂移），未知端点拒绝（E_ENDPOINT_UNKNOWN）
 * - TTL 判死（默认 90s = 3 × 30s 心跳，可配），惰性 sweep（无定时器）
 * - 检视 = 图节点模型引用 ∈ 端点模型清单（布尔判断；P1 检视消费 hasModel）
 */

import { ProviderRegistry } from "yunzone-service-kit/registry";
import type {
  KitProviderStatus,
  KitRegistryStatus,
} from "yunzone-service-kit/registry";
import type { EndpointCapability } from "./contracts";

/** 心跳 TTL 默认值（V6：默认 30s 心跳 × 3 次缺席判死；可配） */
export const DEFAULT_TTL_MS = 90_000;
/** server 下发给端点的心跳间隔建议（V6） */
export const DEFAULT_HEARTBEAT_INTERVAL_S = 30;

/** 端点账目（capability 全量 + 存活时间戳；accountId P1 接 /auth 后绑定） */
export interface EndpointEntry {
  endpointId: string;
  accountId: string | null;
  capability: EndpointCapability;
  lastSeenMs: number;
}

/** 注册/心跳结果：失败时携带 errors 域错误码 */
export type EndpointUpsertResult =
  | { ok: true; entry: EndpointEntry }
  | { ok: false; errorCode: "E_ENDPOINT_ALREADY_REGISTERED" | "E_ENDPOINT_UNKNOWN" | "E_CAPABILITY_VERSION_MISMATCH"; message: string };

/** ops 投影的单端点状态条目（KitProviderStatus 形态 + 领域字段） */
export interface EndpointProviderStatus extends KitProviderStatus {
  modelCount: number;
  queueTotalRemaining: number;
  vramFreeBytes: number | null;
  lastSeenMs: number;
}

/** ops 投影构造用最小 Provider 形态（KitProvider 兼容） */
interface EndpointProvider {
  meta: { id: string; name: string };
  isAvailable: () => boolean;
}

export interface EndpointRegistryOptions {
  /** 时间源（可注入用于测试） */
  now?: () => number;
  /** TTL（毫秒），默认 90s */
  ttlMs?: number;
  /** TTL 判死回调（D7 重派链路：sweep 出的端点其在途任务重派，instrumentation 装配） */
  onExpired?: (endpointIds: string[]) => void;
}

export class EndpointRegistry extends ProviderRegistry<EndpointProvider> {
  private readonly clockNow: () => number;
  private readonly ttlMs: number;
  private readonly onExpired?: (endpointIds: string[]) => void;
  private readonly entries = new Map<string, EndpointEntry>();

  constructor(options: EndpointRegistryOptions = {}) {
    super({ name: "EndpointRegistry" });
    this.clockNow = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.onExpired = options.onExpired;
  }

  /** 注册（首次握手建账；重复 id 拒绝，契约 E_ENDPOINT_ALREADY_REGISTERED） */
  registerEndpoint(
    endpointId: string,
    capability: EndpointCapability,
    accountId: string | null = null
  ): EndpointUpsertResult {
    if (this.entries.has(endpointId)) {
      return {
        ok: false,
        errorCode: "E_ENDPOINT_ALREADY_REGISTERED",
        message: `endpoint "${endpointId}" already registered`,
      };
    }
    if (capability.version !== 1) {
      return this.versionMismatch(capability.version);
    }
    const entry: EndpointEntry = {
      endpointId,
      accountId,
      capability,
      lastSeenMs: this.clockNow(),
    };
    this.entries.set(endpointId, entry);
    return { ok: true, entry };
  }

  /** 心跳（全量能力覆盖，V6；未知端点拒绝） */
  heartbeat(
    endpointId: string,
    capability: EndpointCapability
  ): EndpointUpsertResult {
    const entry = this.entries.get(endpointId);
    if (!entry) {
      return {
        ok: false,
        errorCode: "E_ENDPOINT_UNKNOWN",
        message: `endpoint "${endpointId}" is not registered`,
      };
    }
    if (capability.version !== 1) {
      return this.versionMismatch(capability.version);
    }
    entry.capability = capability;
    entry.lastSeenMs = this.clockNow();
    return { ok: true, entry };
  }

  /** TTL 存活判断（惰性 sweep 后判断） */
  isAlive(endpointId: string): boolean {
    this.sweep();
    const entry = this.entries.get(endpointId);
    return entry !== undefined;
  }

  /** 检视辅助（P1 消费）：图节点模型引用 ∈ 端点模型清单 */
  hasModel(endpointId: string, modelKey: string): boolean {
    const entry = this.entries.get(endpointId);
    if (!entry) return false;
    return entry.capability.models.some((m) => m.modelKey === modelKey);
  }

  /** 注销过期端点（TTL 判死），返回被注销的 endpointId 列表（onExpired 钩子同步触发） */
  sweep(): string[] {
    const now = this.clockNow();
    const expired: string[] = [];
    for (const [id, entry] of this.entries) {
      if (now - entry.lastSeenMs > this.ttlMs) {
        this.entries.delete(id);
        expired.push(id);
      }
    }
    if (expired.length > 0) {
      console.warn(`[endpoint-registry] TTL expired: ${expired.join(", ")}`);
      this.onExpired?.(expired);
    }
    return expired;
  }

  /** 在途端点快照（sweep 后） */
  listAlive(): EndpointEntry[] {
    this.sweep();
    return [...this.entries.values()];
  }

  /**
   * ops 快照投影（D5「检视全部已登记节点」）。
   * 覆盖基座 getStatus：数据源为自建 entries（基座 private providers 不承载端点）。
   */
  override getStatus(): Promise<KitRegistryStatus<EndpointProviderStatus>> {
    this.sweep();
    const providers: EndpointProviderStatus[] = [...this.entries.values()].map(
      (entry) => ({
        id: entry.endpointId,
        name: entry.endpointId,
        priority: 0,
        available: true,
        modelCount: entry.capability.models.length,
        queueTotalRemaining: entry.capability.models.reduce(
          (sum, m) => sum + m.queueRemaining,
          0
        ),
        vramFreeBytes: entry.capability.vramFreeBytes,
        lastSeenMs: entry.lastSeenMs,
      })
    );
    return Promise.resolve({
      registeredCount: providers.length,
      availableCount: providers.length,
      activeProvider: null,
      providers,
    });
  }

  private versionMismatch(actual: number): EndpointUpsertResult {
    return {
      ok: false,
      errorCode: "E_CAPABILITY_VERSION_MISMATCH",
      message: `capability version ${actual} != 1 (V2: 三方比对只看整数相等)`,
    };
  }
}

// ── 进程级单例（dev 热重载下经 globalThis 保持）─────────────────────────

const globalForRegistry = globalThis as unknown as {
  __inferEndpointRegistry?: EndpointRegistry;
};

/**
 * 进程级单例（dev 热重载下经 globalThis 保持）。
 * options 仅首次创建时生效（instrumentation 装配 onExpired 重派钩子；
 * 路由热重载后二次调用不带参即复用既有实例）。
 */
export function getEndpointRegistry(options?: EndpointRegistryOptions): EndpointRegistry {
  globalForRegistry.__inferEndpointRegistry ??= new EndpointRegistry(options);
  return globalForRegistry.__inferEndpointRegistry;
}
