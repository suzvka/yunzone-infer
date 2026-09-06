# 算力报酬存入模型

> 状态：设计定稿（2026-09-06）
> 关联：[server/DESIGN.md](../server/DESIGN.md) D12（生态计费）+ §3（service-kit `/points` 落点）
> 依赖：yunzone-service-kit 0.25.0+（`/points` deposit 契约）

## 1. 核心思路

**奖励积分是 infer 内部业务，用户必须手动将积累的积分存入平台账户。**

这将问题拆为两层，每层各自干净：

```
┌─ infer 内部 ─────────────────────────────────────┐
│  任务完成 → 验证 → 记入内部积分台账（零散记录）       │
│  用户发起"存入" → 汇总零散记录 → 一笔存入请求         │
│                                                    │
│  防滥用全在这里：验证、限额、声誉、冻结、撤回          │
│  频率：每任务一条（高频，但 infer 自己的 DB）          │
└──────────────────────┬─────────────────────────────┘
                       │ 一笔存入（低频，用户主动发起）
                       ▼
┌─ uc 账本 ────────────────────────────────────────┐
│  收到存入请求 → 创建订单 → 直接交付 → 积分入账        │
│                                                    │
│  无需风控判断（infer 已验证）                         │
│  频率：每用户每周期一笔（低频）                        │
└─────────────────────────────────────────────────────┘
```

## 2. 为什么不是"每任务直接发放"

| 每任务发放（grant） | 汇总存入（deposit） |
|---|---|
| uc 每任务一条账本事件 | uc 每存入周期一条订单 + 一条账本事件 |
| 防滥用逻辑必须在 uc 侧（但 uc 无任务上下文） | 防滥用逻辑全在 infer（有完整任务上下文） |
| 高频调用 uc（每任务一次） | 低频调用 uc（用户主动发起） |
| 无订单记录（纯账本事件） | 订单记录 = 存入凭证（可审计、可对账） |
| 语义："平台奖励你" | 语义："你赚到了，现在存入账户" |

## 3. infer 内部积分台账

### 3.1 数据模型

infer 控制面经 service-kit `/db` 模块持久化内部台账：

```sql
-- 算力报酬台账（infer 内部，非 uc 表）
CREATE TABLE infer_reward_ledger (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,       -- 算力提供者（经 /auth 注册）
  account_id   TEXT NOT NULL,       -- 对应的平台账户（uc 侧 accountId）
  task_id      TEXT NOT NULL,       -- 任务标识
  points       INTEGER NOT NULL,    -- 本次报酬（正整数）＝ 模型单价 × 难度系数（D12/V13，2026-09-07）
  difficulty   REAL,                -- 难度系数（模型难度钩子计算值，client 上报；原「档位」语义废止）
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | deposited | frozen
  verified_at  TIMESTAMPTZ,         -- 验证通过时间
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, task_id)       -- 幂等：同一客户端同一任务只记一次
);

-- 存入批次（汇总零散记录 → 一笔存入）
CREATE TABLE infer_deposit_batch (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  request_id   TEXT NOT NULL UNIQUE, -- 幂等键（传给 uc 的 requestId）
  total_points INTEGER NOT NULL,     -- 汇总总额
  task_count   INTEGER NOT NULL,     -- 包含的任务数
  period_start TIMESTAMPTZ,          -- 批次覆盖的时间范围
  period_end   TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | submitted | confirmed | failed
  uc_order_no  TEXT,                 -- uc 返回的存入订单号
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.2 生命周期

```
任务完成 → 验证通过 → infer_reward_ledger (status=confirmed, points=N)
                                    ↓
用户发起存入 → 汇总所有 confirmed 记录 → infer_deposit_batch (status=pending)
                                    ↓
调 uc deposit API → 成功 → batch.status=submitted, reward_ledger.status=deposited
                  → 失败 → batch.status=failed（可重试）
                  → 幂等命中 → 同 submitted
```

### 3.3 存入触发

- **用户主动**：算力提供者在 infer 控制台点击"存入账户"
- **自动周期**（可选）：每周/每月自动汇总存入（需用户预先授权）
- **最低门槛**：积累 ≥ N 积分才允许存入（避免高频小额调用 uc）

## 4. 与 uc 的对接契约

### 4.1 调用方式

```typescript
import { createPointsClient } from 'yunzone-service-kit/points';

const points = createPointsClient({
  baseUrl: process.env.UC_BASE_URL!,
  apiKey: process.env.INFER_SERVICE_CREDENTIAL!,  // B 端凭证（productId 在白名单内）
});

const result = await points.deposit({
  requestId: batch.request_id,        // 幂等键（infer 生成）
  accountId: batch.account_id,        // 算力提供者的平台账户
  points: batch.total_points,         // 汇总总额
  metadata: {
    batchId: batch.id,
    taskCount: batch.task_count,
    period: `${batch.period_start}~${batch.period_end}`,
  },
});

// result: { ok, duplicate, orderNo?, balance?, reason? }
```

### 4.2 uc 侧行为

1. 鉴权：`authenticateLedgerRequest` + productId 白名单
2. 创建 `payment_order`（status=PAID, channel=infer-deposit, amount_cents=0）
3. `postLedgerEvent(credit, eventType="deposit", requestId=幂等键)`
4. 返回 `{ ok, duplicate, orderNo, balance }`

### 4.3 幂等保证

- infer 侧：`infer_deposit_batch.request_id` UNIQUE
- uc 订单层：`UNIQUE(channel, provider_trade_no)`，provider_trade_no = requestId
- uc 账本层：`UNIQUE(request_id)`

三层幂等根相同（requestId），网络超时/重试安全。

## 5. 对账

### 5.1 uc 侧

- `listProductStatement(productId)`：deposit 的 credit 计入 total_in（与 topup 共享）
  - 若需区分：按 eventType 过滤（需 uc 侧 listProductStatement 增加 eventType 参数）
  - 或：infer 使用独立 productId，天然隔离
- `listBenefitEvents(productId)`：deposit 订单（status=PAID）自动出现在权益事件中
- 订单记录：每笔存入有完整的 payment_order 行（who/when/how much/which batch）

### 5.2 infer 侧

- `infer_reward_ledger`：每任务一条，可追溯"这笔积分来自哪个任务"
- `infer_deposit_batch`：每存入一条，可追溯"这批积分何时存入、uc 订单号是什么"
- 两者关联：batch 包含的 reward 记录（通过 status=deposited + 时间范围）

## 6. 生态循环定位

```
auth 鉴权(机器凭证) → uc 账户(平台积分) → infer 存入(产出侧) → 产品 deduct(消费侧)
         ↑                                                              │
         └──────────────────── 循环 ←───────────────────────────────────┘
```

- **infer 是产出侧**：算力提供者赚取积分 → 存入 uc 账户
- **relay 等产品是消费侧**：用户花费积分 → 从 uc 账户扣减
- **uc 是账本**：不判断"该不该发"，只执行"存入/扣减"并记账
- **auth 是信任根**：机器凭证鉴权，productId 白名单区分信任层级
