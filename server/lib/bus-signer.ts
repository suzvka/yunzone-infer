/**
 * 数据面总线 URL 签发（D20/V8）— P1 正式化：kit /storage（S3 channel）预签名
 *
 * 双形态（2026-09-07 P1 拍板：接 kit /storage + 本地 MinIO 对拍）：
 * - S3 env 齐（S3_ENDPOINT_URL + S3_BUCKET_NAME）→ kit createObjectStore({channel:"s3"})，
 *   GET = getSignedUrl / PUT = getUploadUrl（真预签名 URL；MinIO 等 S3 兼容端点
 *   forcePathStyle 默认 true）；
 * - env 未配置 → 本地替身直链（P0 形态，V12）+ 进程级一次性告警（CI/纯单测兼容；
 *   对拍闭环验签不依赖 MinIO 在场）。
 *
 * 签名时效：GET/PUT 统一默认 3600s（队列积压 + sidecar 聚合耗时的缓冲；过期风险
 * 由过量注入吸收与 TTL 判死重派重签兜底，D7/D9）。env INFERENCE_BUS_URL_TTL_S 覆盖。
 * P0 同步签发已废弃：kit 签名是异步面，BusUrlSigner 全链路 async。
 */

import { createObjectStore } from "yunzone-service-kit/storage";
import type { ObjectStore } from "yunzone-service-kit/storage";

export interface BusSignOptions {
  /** 有效期秒覆盖（缺省 INFERENCE_BUS_URL_TTL_S 或 3600） */
  expireSeconds?: number;
}

export type BusUrlSigner = (
  key: string,
  method: "GET" | "PUT",
  options?: BusSignOptions
) => Promise<string>;

/** 默认签名时效（秒） */
export const DEFAULT_BUS_URL_TTL_S = 3600;

function resolveTtl(options?: BusSignOptions): number {
  const envTtl = Number(process.env.INFERENCE_BUS_URL_TTL_S);
  return options?.expireSeconds ?? (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : DEFAULT_BUS_URL_TTL_S);
}

/** P0 本地对象存储替身（V12）签发：直连 URL，无时效签名 */
export function makeStandinBusSigner(baseUrl?: string): BusUrlSigner {
  const base = (baseUrl ?? process.env.INFERENCE_BUS_BASE_URL ?? "http://127.0.0.1:43120").replace(
    /\/$/,
    ""
  );
  return async (key) => `${base}/objects/${key}`;
}

/** 正式语义：kit /storage 预签名（GET 读 / PUT 写） */
export function makeStorageBusSigner(store: ObjectStore): BusUrlSigner {
  return async (key, method, options) => {
    const expireSeconds = resolveTtl(options);
    if (method === "GET") return store.getSignedUrl(key, expireSeconds);
    return store.getUploadUrl({ key, expireSeconds });
  };
}

const globalForSigner = globalThis as unknown as {
  __inferBusSigner?: BusUrlSigner;
  __inferBusSignerWarned?: boolean;
};

/**
 * 进程级默认 signer 工厂：
 * - S3_ENDPOINT_URL + S3_BUCKET_NAME 齐 → kit /storage 预签名（MinIO/OSS 均可）；
 * - 否则 → 替身直链 + 一次性告警（数据面对拍继续可跑，正式部署必须配置 S3）。
 */
export function getBusSigner(): BusUrlSigner {
  globalForSigner.__inferBusSigner ??= (() => {
    const endpoint = process.env.S3_ENDPOINT_URL;
    const bucket = process.env.S3_BUCKET_NAME;
    if (endpoint && bucket) {
      // 凭证缺失时 kit 走 SDK 默认凭证链 / fail-fast（resolveStorageConfig 诊断）
      const store = createObjectStore({ channel: "s3" });
      console.log(`[bus-signer] storage channel: s3 (${bucket}) — kit /storage 预签名（D20/V8）`);
      return makeStorageBusSigner(store);
    }
    if (!globalForSigner.__inferBusSignerWarned) {
      globalForSigner.__inferBusSignerWarned = true;
      console.warn(
        "[bus-signer] S3_ENDPOINT_URL / S3_BUCKET_NAME 未配置：数据面使用本地替身直链" +
          "（无签名时效；正式部署与对拍闭环请配置 S3 兼容存储，D20/V8）"
      );
    }
    return makeStandinBusSigner();
  })();
  return globalForSigner.__inferBusSigner;
}

/** 完成上报的输出 URI → 对象键（兼容上报回传全 URL 或裸键两种形态） */
export function normalizeBusKey(uri: string): string {
  const match = /\/objects\/(.+?)(?:\?.*)?$/.exec(uri);
  return match?.[1] ?? uri;
}
