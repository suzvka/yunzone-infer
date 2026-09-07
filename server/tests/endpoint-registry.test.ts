/**
 * 端点注册中心单测（D4 语义）— register / heartbeat / TTL / 检视辅助
 */

import { describe, expect, it } from "vitest";
import { EndpointRegistry, DEFAULT_TTL_MS } from "../lib/endpoint-registry";
import type { EndpointCapability } from "../lib/contracts";

/** 固定时间源（毫秒） */
function mockClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function capability(version: number = 1, modelKeys: string[] = ["models/demo-onnx"]): EndpointCapability {
  return {
    // as 1：测试可故意构造非法 version（如 2）验证 E_CAPABILITY_VERSION_MISMATCH 路径
    version: version as 1,
    models: modelKeys.map((modelKey) => ({ modelKey, queueRemaining: 4 })),
    vramFreeBytes: null,
  };
}

describe("EndpointRegistry", () => {
  it("registerEndpoint：首次注册建账并返回条目", () => {
    const clock = mockClock();
    const registry = new EndpointRegistry({ now: clock.now });

    const result = registry.registerEndpoint("ep-1", capability(), "acc-1");

    expect(result.ok).toBe(true);
    expect(registry.listAlive()).toHaveLength(1);
    expect(registry.listAlive()[0]?.accountId).toBe("acc-1");
  });

  it("registerEndpoint：重复注册拒绝（E_ENDPOINT_ALREADY_REGISTERED）", () => {
    const registry = new EndpointRegistry({ now: mockClock().now });

    registry.registerEndpoint("ep-1", capability());
    const again = registry.registerEndpoint("ep-1", capability());

    expect(again).toMatchObject({
      ok: false,
      errorCode: "E_ENDPOINT_ALREADY_REGISTERED",
    });
  });

  it("registerEndpoint：能力域版本不匹配拒绝（E_CAPABILITY_VERSION_MISMATCH）", () => {
    const registry = new EndpointRegistry({ now: mockClock().now });

    const result = registry.registerEndpoint("ep-1", capability(2));

    expect(result).toMatchObject({
      ok: false,
      errorCode: "E_CAPABILITY_VERSION_MISMATCH",
    });
  });

  it("heartbeat：未知端点拒绝（E_ENDPOINT_UNKNOWN）", () => {
    const registry = new EndpointRegistry({ now: mockClock().now });

    const result = registry.heartbeat("ghost", capability());

    expect(result).toMatchObject({ ok: false, errorCode: "E_ENDPOINT_UNKNOWN" });
  });

  it("heartbeat：全量覆盖能力视图（V6）并刷新 lastSeen", () => {
    const clock = mockClock();
    const registry = new EndpointRegistry({ now: clock.now });
    registry.registerEndpoint("ep-1", capability());

    clock.advance(10_000);
    const updated = capability(1, ["models/other"]);
    const result = registry.heartbeat("ep-1", updated);

    expect(result.ok).toBe(true);
    const entry = registry.listAlive()[0];
    expect(entry?.capability.models[0]?.modelKey).toBe("models/other");
    expect(entry?.lastSeenMs).toBe(1_010_000);
  });

  it("TTL 判死：超时端点被 sweep 注销；心跳续命", () => {
    const clock = mockClock();
    const registry = new EndpointRegistry({ now: clock.now });
    registry.registerEndpoint("ep-alive", capability());
    registry.registerEndpoint("ep-gone", capability());

    clock.advance(DEFAULT_TTL_MS + 1);
    registry.heartbeat("ep-alive", capability()); // 续命

    expect(registry.isAlive("ep-alive")).toBe(true);
    expect(registry.isAlive("ep-gone")).toBe(false);
    expect(registry.listAlive().map((e) => e.endpointId)).toEqual(["ep-alive"]);
  });

  it("hasModel：模型引用 ∈ 清单（检视布尔判断）", () => {
    const registry = new EndpointRegistry({ now: mockClock().now });
    registry.registerEndpoint("ep-1", capability(1, ["models/a", "models/b"]));

    expect(registry.hasModel("ep-1", "models/a")).toBe(true);
    expect(registry.hasModel("ep-1", "models/missing")).toBe(false);
    expect(registry.hasModel("ghost", "models/a")).toBe(false);
  });

  it("getStatus：ops 快照投影（数量 / 余量合计 / 水位）", async () => {
    const registry = new EndpointRegistry({ now: mockClock().now });
    registry.registerEndpoint("ep-1", capability(1, ["models/a", "models/b"]));

    const status = await registry.getStatus();

    expect(status.registeredCount).toBe(1);
    const provider = status.providers[0];
    expect(provider).toMatchObject({
      id: "ep-1",
      available: true,
      modelCount: 2,
      queueTotalRemaining: 8,
      vramFreeBytes: null,
    });
  });
});
