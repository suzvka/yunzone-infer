# server/app/ — Next.js App Router

> 骨架已落（2026-09-07）：`layout` / `page` / `api/control/v1` 四端点 / `api/ops/report`；**P1 已追加**：`admin/` 管理控制台（D19②）+ `api/ops/login` / `api/ops/workflows` + `api/infer/workflows`（推理入口）+ WS upgrade（`api/control/v1/ws`，custom server 同端口）；**消费者 / 提供者完整 UI（route groups）留 P2**。house Next 16.1.1 包内无 `dist/docs/`（见 CouplingRecord）——遵循保守 API 面，以 build/ts-check 反馈为准。

## 规划路由树（对照 [server/DESIGN.md](../DESIGN.md) §1 控制面 + D19 三受众）

```
app/
├── layout.tsx                    # 根布局
├── page.tsx                      # 落地页
├── (consumer)/tasks/             # 受众① 推理消费者（/auth introspect）：提交请求 / 历史任务（D19 场景①）
├── (provider)/                   # 受众③ 算力提供者（end-user /auth，信任域）
│   └── status/                   #   本端点贡献与存活状态（收益/发放 UI 待计量域接入，D12）
├── admin/                        # 受众② 管理员（/ops/next requireAdminAuth）：全网运行状况（D5「检视全部节点」）
└── api/
    ├── control/                  # 控制通道端点（client ↔ 控制面）：REST 注册/心跳/完成上报 + WS 任务下发（V5）
    ├── infer/                    # 推理请求入口（消费者）
    ├── ops/                      # service-kit /ops 运维报告
    └── internal/                 # sidecar IPC（V7 定案：控制面轮询 /status，回调端点仅在需要时启用）
```

## 注意

- **三受众鉴权不同**（D19）：消费者 / provider 走 `/auth`，admin 走 `requireAdminAuth` session cookie——用 route groups 隔离。
- **provider 侧发放类页面必须在此（信任域），不可落 client**（D19 信任约束；client 属不信任域，禁自助触发发放）。计量面已退场（D12，2026-09-09），接入时沿用本约束。
- 控制通道 API 契约来自 `contracts/schema/control-channel/`（codegen 类型，P0）。
