/**
 * 结果保质期（shelf_life，D8/P2 批次 B）— 签名收口方案
 *
 * 终态工作流的结果（finalOutputUri / 节点输出）在保质期内可经控制面取回
 * （预签名 GET）；超期后结果端点不再签发（410 + E_SHELF_LIFE_EXPIRED）——
 * 控制面签发面收口即语义收口，对象存储物理清理交 S3 lifecycle 规则（运维面），
 * 控制面不做删除表面（D20：控制面仅持元数据 + URI）。
 *
 * 期限基准 = 账目 updatedAtMs（终态落账时刻）+ INFERENCE_SHELF_LIFE_MS
 * （缺省 24h；到期前消费者应取回，重取可依赖自身留存或运维侧延长）。
 */

import type { WorkflowRecord } from "./workflow-ledger";

const DEFAULT_SHELF_LIFE_MS = 24 * 60 * 60 * 1000;

export function shelfLifeMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.INFERENCE_SHELF_LIFE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SHELF_LIFE_MS;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "rejected", "cancelled"]);

/** 终态工作流是否已过结果保质期（非终态恒 false——执行中无过期语义；env 可注入便于测试） */
export function isShelfExpired(
  record: WorkflowRecord,
  now = Date.now(),
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!TERMINAL.has(record.status)) return false;
  return now - record.updatedAtMs > shelfLifeMs(env);
}
