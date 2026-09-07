# server/ — 服务器（孙项目 2）：Next.js 全栈控制面 + C++ 执行面 sidecar

> 决策权威见 [server/DESIGN.md](./DESIGN.md)：D1（双平面，不可让）· D2 / D16（sidecar + 本地 IPC）· D11（自托管 standalone，node runtime）；全局架构见根 [DESIGN.md](../DESIGN.md) §3

服务器 = **控制面（TS/Next）+ 执行面（C++ sidecar）** 双平面。控制面消费 yunzone-service-kit 做生态集成 + 调度编排 + UI；执行面 link DCinfer 做图执行 / 聚合，远程节点经**对象存储总线**（预签名 URL，V8）驱动 client。二者经本地 IPC（HTTP over loopback TCP + JSON + 每次启动随机 token，D16）通信，契约 = DCIr 序列化图 JSON + 绑定计划。

## 控制面职责（[server/DESIGN.md](./DESIGN.md) §1）

- **节点注册中心**：继承 service-kit `/registry` ProviderRegistry 骨架 + **自建 TTL 存活 / 注销 / 多能力匹配**（D4）
- **能力检视**：读 DCIr 图需求 × 已登记能力匹配，不满足则拒绝启动
- **调度器**：图分区 → 任务到客户端绑定（策略可替换接口）
- **工作流状态机**：登记 → 检视 → 绑定 → 派发 → 回收 → 聚合（`/db` Ledger 持久化）
- **管理控制台 + 生态集成**：`/ops` · `/auth` · `/points` · `/storage` · `/config` · `/app`

## 3 受众 UI（D19）

| 受众 | 场景 | 鉴权 |
|---|---|---|
| 推理消费者 | 提交推理请求 / 看自己历史任务 | `/auth` introspect（+ `/points` deduct 计量） |
| 管理员 | 看整个算力网络运行状况 | `/ops/next` `requireAdminAuth`（session cookie） |
| 算力提供者 | 看收益台账 + 点「存入账户」(deposit) | end-user `/auth`（**信任域，禁落 client**，D19；见 docs/deposit-model.md） |

## 执行面 sidecar（`sidecar/`）

C++ 子进程，link DCinfer（`BUILD_DCNET=OFF`，V9）：DCIr 反序列化重建图 → 按绑定计划标记远程节点 → 数据驱动执行（本地节点进程内；远程节点生成「模型引用 + 输入 URI」经 WS 下发 client，V5/V8）→ 完成上报唤醒 + 对象存储拉取 → 聚合 → 最终输出经 `/storage` 上传（控制面仅持元数据 + URI）。控制面轮询 `GET /status` 获取状态（V7）。详见 [`sidecar/README.md`](./sidecar/README.md)。

## 开发

```bash
pnpm install                              # 于 workspace 根执行（contracts 类型由 pre hook 自动生成）
cp .env.example .env                      # 填部署面 / 鉴权 / uc / sidecar / db
pnpm --filter @yunzone-infer/server dev   # next dev -p 3002
pnpm --filter @yunzone-infer/server ts-check && pnpm --filter @yunzone-infer/server test && pnpm --filter @yunzone-infer/server build
```

> ⚠️ house Next 16.1.1 包内**无** `dist/docs/`（AGENTS 指引路径失效，见 CouplingRecord）——编写 `app/` 代码遵循保守 API 面（标准 Web Request/Response + 稳定 App Router 形态），以 build/ts-check 反馈为准。
> 控制通道 REST 四端点 + ops report 已落地（骨架，内存态）；**WS 推送（V5）留 P1**——Next route handler 不支持 WS upgrade，需自定义 server 包装或网关，单独 spike。三受众 UI 见 [`app/README.md`](./app/README.md)。
