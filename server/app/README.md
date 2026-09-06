# server/app/ — Next.js App Router（P1 初始化）

> 骨架期占位。实际 `layout` / `page` / `route` 在 **P1** 初始化——**编写前先读 `node_modules/next/dist/docs/`**（house Next 16.x 可能与既有认知不同，见根 `AGENTS.md`）。

## 规划路由树（对照 [server/DESIGN.md](../DESIGN.md) §1 控制面 + D19 三受众）

```
app/
├── layout.tsx                    # 根布局
├── page.tsx                      # 落地页
├── (consumer)/tasks/             # 受众① 推理消费者（/auth introspect）：提交请求 / 历史任务（D19 场景①）
├── (provider)/                   # 受众③ 算力提供者（end-user /auth，信任域）
│   ├── earnings/                 #   收益台账（infer_reward_ledger 投影）
│   └── deposit/                  #   「存入账户」→ /points deposit（docs/deposit-model.md）
├── admin/                        # 受众② 管理员（/ops/next requireAdminAuth）：全网运行状况（D5「检视全部节点」）
└── api/
    ├── control/                  # 控制通道端点（client ↔ 控制面）：REST 注册/心跳/完成上报 + WS 任务下发（V5）
    ├── infer/                    # 推理请求入口（消费者；/points deduct 计量）
    ├── ops/                      # service-kit /ops 运维报告
    └── internal/                 # sidecar IPC（V7 定案：控制面轮询 /status，回调端点仅在需要时启用）
```

## 注意

- **三受众鉴权不同**（D19）：消费者 / provider 走 `/auth`，admin 走 `requireAdminAuth` session cookie——用 route groups 隔离。
- **provider 收益 / deposit 必须在此（信任域），不可落 client**（D19 信任约束；client 属不信任域，禁自助触发 deposit）。
- 控制通道 API 契约来自 `contracts/schema/control-channel/`（codegen 类型，P0）。
