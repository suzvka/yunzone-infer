/**
 * /auth 机器凭证鉴权单测（V3 / 批次 B）：三态语义 + productId 匹配 + fail-closed。
 * kit AuthCenterClient 走全局 fetch → 注入 stub；单例经 globalThis 槽位重置。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  getAuthCenterClient,
  requireMachineAuth,
  requireUserAuth,
} from "../lib/control-auth";

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

const authSlots = globalThis as unknown as {
  __inferAuthCenterClient?: unknown;
  __inferAuthSkipWarned?: boolean;
};

function resetAuth(env: Record<string, string | undefined>): void {
  for (const key of ["AUTH_CENTER_BASE_URL", "AUTH_SERVICE_CREDENTIAL", "INFER_AUTH_PRODUCT_ID"]) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  delete authSlots.__inferAuthCenterClient;
  delete authSlots.__inferAuthSkipWarned;
  getAuthCenterClient(); // 预建单例（按当前 env）
}

function stubFetch(fn: FetchStub): void {
  globalThis.fetch = fn as typeof fetch;
}

function bearerRequest(token?: string): Request {
  return new Request("http://localhost/api/control/v1/endpoints", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function introspectBody(body: unknown): Response {
  return Response.json(body);
}

afterEach(() => {
  resetAuth({});
});

describe("requireMachineAuth（V3 三态）", () => {
  it("未配置 AUTH_CENTER_BASE_URL → 放行（accountId null）", async () => {
    resetAuth({});
    const result = await requireMachineAuth(bearerRequest("any-token"));
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({ accountId: null, productId: null });
  });

  it("无 Bearer → 401 E_AUTH_REJECTED（配置与否都拒）", async () => {
    resetAuth({});
    const result = await requireMachineAuth(bearerRequest());
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("配置后强制 introspect：active:false → 401", async () => {
    resetAuth({ AUTH_CENTER_BASE_URL: "http://auth.test" });
    stubFetch(() => Promise.resolve(introspectBody({ active: false })));
    const result = await requireMachineAuth(bearerRequest("bad-token"));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("active:true → 放行并提取 claims.accountId / productId", async () => {
    resetAuth({ AUTH_CENTER_BASE_URL: "http://auth.test" });
    stubFetch(() =>
      Promise.resolve(
        introspectBody({
          active: true,
          productId: "infer",
          claims: { accountId: "acc-42" },
        })
      )
    );
    const result = await requireMachineAuth(bearerRequest("good-token"));
    expect(result).toMatchObject({ accountId: "acc-42", productId: "infer" });
  });

  it("INFER_AUTH_PRODUCT_ID 配置后：productId 不匹配 → 401，匹配 → 放行", async () => {
    resetAuth({
      AUTH_CENTER_BASE_URL: "http://auth.test",
      INFER_AUTH_PRODUCT_ID: "infer",
    });
    stubFetch(() =>
      Promise.resolve(introspectBody({ active: true, productId: "other-product", claims: {} }))
    );
    const mismatch = await requireMachineAuth(bearerRequest("t"));
    expect(mismatch).toBeInstanceOf(Response);

    stubFetch(() =>
      Promise.resolve(introspectBody({ active: true, productId: "infer", claims: {} }))
    );
    const matched = await requireMachineAuth(bearerRequest("t"));
    expect(matched).not.toBeInstanceOf(Response);
  });

  it("鉴权中心不可达（协议层失败）→ fail-closed 503", async () => {
    resetAuth({ AUTH_CENTER_BASE_URL: "http://auth.test" });
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const result = await requireMachineAuth(bearerRequest("t"));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
  });

  it("requireUserAuth：消费者 token introspect 即过（不校验 productId）", async () => {
    resetAuth({
      AUTH_CENTER_BASE_URL: "http://auth.test",
      INFER_AUTH_PRODUCT_ID: "infer",
    });
    stubFetch(() =>
      Promise.resolve(introspectBody({ active: true, productId: "consumer-app", claims: {} }))
    );
    const result = await requireUserAuth(bearerRequest("user-token"));
    expect(result).not.toBeInstanceOf(Response);
  });
});
