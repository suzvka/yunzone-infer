# server/ — 服务器（孙项目 2）：Next.js 全栈控制面 + C++ 执行面 sidecar

> 决策权威见 [server/DESIGN.md](./DESIGN.md)：D1（双平面，不可让）· D2 / D16（sidecar + 本地 IPC）· D11（自托管，P1 拍板 custom server 同端口 WS）；全局架构见根 [DESIGN.md](../DESIGN.md) §3

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

## 执行面 sidecar（`sidecar/`，P0 已落地最小实现）

C++ 子进程，link DCinfer（`DCINFER_BUILD_DCNET=OFF`，V9）：DCIr JSON 重建图（远程节点物化为 BusProxy，等待完成上报 + 总线拉取唤醒，D8）→ 数据驱动执行本地节点 → 远程节点组装 TaskDispatch（经 `GET /workflows/{id}/status` 轮询被控制面取走，V7/V5）→ 聚合 → 最终输出 PUT finalOutputUri（V8，控制面仅持元数据 + URI）。生命周期：`instrumentation` 拉起 + 崩溃重启 + 端口回读（`SIDECAR_BIN` / `SIDECAR_PORT=0`）。详见 [`sidecar/README.md`](./sidecar/README.md)。

控制面接线（P1）：`lib/sidecar-supervisor.ts`（生命周期）· `lib/dispatch-pump.ts`（派发泵 + 任务账本 + WS 优先 transport + 反压/重派）· `lib/ws-gateway.ts`（V5 连接管理）· `lib/scheduler.ts`（D9 MVP 绑定）· `lib/bus-signer.ts`（D20 预签名 / 替身回退）· `lib/control-auth.ts`（V3 introspect）· 完成上报端点转发 sidecar（D8）。

## P0 对拍骨架（§9②）

```bash
cmake -S server/sidecar -B build/sidecar -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build/sidecar --config Release
# 仓库根：分布式闭环（serve + 总线替身 + endpoint-stub）vs run-local 逐节点比对 + 错误路径
INFER_SIDECAR_BIN=build/sidecar/infer-sidecar pnpm --filter @yunzone-infer/server exec vitest run tests/parity-bus-spike.test.ts
```

## 开发

```bash
pnpm install                              # 于 workspace 根执行（contracts 类型由 pre hook 自动生成）
cp .env.example .env                      # 填部署面 / 鉴权 / uc / sidecar / db / S3
pnpm --filter @yunzone-infer/server dev   # custom server（tsx server.ts，WS 同端口 upgrade）
pnpm --filter @yunzone-infer/server ts-check && pnpm --filter @yunzone-infer/server test && pnpm --filter @yunzone-infer/server build
```

## P1 单跳闭环（已落，2026-09-07）

- **WS 任务下发（V5）**：custom server 同端口 upgrade（`server/server.ts`，dev/prod 双形态）；派发泵 WS 推送优先，未连接/失败暂缓重试。
- **机器凭证（V3）**：`AUTH_CENTER_BASE_URL` 配置后强制 introspect（未配置放行告警，开发/CI 态；`INFER_AUTH_PRODUCT_ID` 可选 productId 白名单）。
- **推理入口**：`POST /api/infer/workflows`（`graph` + `remoteNodes[{nodeId,modelKey}]` + `localInputs`）→ 检视（`E_INSPECTION_REJECTED` → 422）→ D9 整图单端点绑定 → sidecar 启动 → 202。状态查询：`GET /api/control/v1/workflows/{id}`。
- **数据面（D20/V8）**：`S3_ENDPOINT_URL` + `S3_BUCKET_NAME` 配置后经 kit `/storage` 签发预签名 URL（GET 读 / PUT 写，默认 3600s）；未配置回退替身直链 + 告警。本地 MinIO：

```bash
docker run -d --name infer-minio -p 9000:9000 minio/minio server /data   # 桶名须与 S3_BUCKET_NAME 一致
```

- **反压 + 重派（D9/D7）**：注入前查端点余量（心跳携带）+ WS 在线；TTL 判死 → 在途任务换绑其他端点（compensation 优先级 + 重签 URL + requestId 幂等先到先得）；工作流终态 → TaskRevoke 标记式懒惰撤销。
- **管理控制台（D5/D19②）**：`/admin`（`ADMIN_PASSWORD` 登录 → 端点表 + 工作流账本，5s 刷新）。
- **client daemon**：见 [`../client/daemon/config.example.json`](../client/daemon/config.example.json)，`infer-clientd --config daemon.json`。

## 对拍

```bash
cmake -S server/sidecar -B build/sidecar -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build/sidecar --config Release
# 仓库根：分布式闭环（serve + 总线替身 + endpoint-stub）vs run-local 逐节点比对 + 错误路径
INFER_SIDECAR_BIN=build/sidecar/infer-sidecar pnpm --filter @yunzone-infer/server exec vitest run tests/parity-bus-spike.test.ts
```

P1 真链路对拍（本机五进程，已实测通过 2026-09-08）：custom server（`SIDECAR_BIN`，instrumentation 拉起 sidecar）+ `infer-clientd`（WS 在线 + 能力直出）+ 总线（MinIO 配 S3 env；本机无 docker 时可起任意 GET/PUT `/objects/{key}` 内存替身，bus-signer 默认直链 127.0.0.1:43120）→ 消费者两步流：① 按键规则预置输入（`workflows/{id}/inputs/{node}/{port}`，首个上传签名调用即开账）② 提交（自带 `workflowId`，`localInputs` 只声明 sidecar 本地执行节点的输入——远程节点输入由 scheduler 自动枚举为 TaskDispatch 键）→ 轮询 `GET /api/infer/workflows/{id}`（completed 含 `finalOutputUrl`）→ `nodes/{node}/output` 取回远程节点输出 → vs `run-local` 逐节点比对（对拍图 x=3 → y=7 → sum=17，双半边精确一致）。
