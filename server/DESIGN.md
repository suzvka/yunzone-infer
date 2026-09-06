# server/ — 服务器设计决策（孙项目 2 架构权威）

> 本文承载 **server 主导的设计决策**（原根 [DESIGN.md](../DESIGN.md) §4 的 D1–D5 / D7 / D9 / D11 / D12 / D16 / D19 / D20 + §5 落点映射 + §6 IPC + §8 工作流），供 server 独立开发时自包含查阅。
> **全局约束**（D13 只复用不修改 / D14 三孙项目 / D17 整栈跨平台）、**阶段**（P0–P3）、**回收事件驱动语义**（D8）见根 [DESIGN.md](../DESIGN.md)。
> **能力 Schema 定义**（D6/D15/V1/V2/V5）见 [contracts/DESIGN.md](../contracts/DESIGN.md)；**client 侧决策**（D10/D18/V6/V10/V11）见 [client/DESIGN.md](../client/DESIGN.md)。决策编号 D1–D20 / V1–V13 全局唯一（V 索引见根 DESIGN §4.1.1）。

## 1. 定位：强制双平面（D1）

服务器 = **控制面（TS/Next）+ 执行面（C++ sidecar）** 双平面：

```
server/                       # 自托管 Next.js standalone（node runtime，D11）
├── 控制面（TS / Next，消费 service-kit）
│   ├── 节点注册中心   ← 继承 /registry ProviderRegistry 骨架 + 自建 TTL存活/注销/多能力匹配（D4）
│   ├── 能力检视       读 DCIr 序列化图 → 图需求 Schema × 已登记能力 匹配；不满足则拒绝启动（D6→contracts）
│   ├── 调度器         图分区 → 任务到客户端绑定（策略可替换接口，D9）
│   ├── 工作流状态机   登记→检视→绑定→派发→回收→聚合 的编排与状态持久化（/db Ledger，§5）
│   ├── 管理控制台     /ops + /ops/next requireAdminAuth；getStatus 快照投影"检视全部节点"（D5）
│   ├── 生态集成       /auth 鉴权 · /points 计量 · /storage 模型产物 · /config env facets · /app 目录（D12/D20）
│   └── 控制通道端点   REST（注册 / 心跳 / 完成上报 / 状态）+ WS 推送（任务下发，V5）；心跳全量携带能力声明（V6）
│
└── 执行面（C++ sidecar 子进程，link DCinfer，D2）
    ├── 图持有 / 重建  DCIr 反序列化 → 按绑定计划把节点标记为远程（远程节点经对象存储 URI 交互，V8）
    ├── 数据驱动执行   本地节点（聚合 / 算子）进程内执行；远程节点「模型引用 + 输入 URI」经 WS 下发 client（V5）
    ├── 聚合           完成上报唤醒 + 对象存储拉取 → 回收结果汇入图执行流，直至产出最终输出（D8 事件驱动）
    └── 最终输出       经 /storage 预签名 URL 上传；控制面仅持元数据 + URI（V8）
```

**控制面 ↔ 执行面**：本地 IPC（sidecar，§4 / D16）；契约 = DCIr 序列化图 JSON + 绑定计划（D3）。

## 2. 决策

### D1 — 服务器形态：双平面（不可让）

TS/Next 控制面（生态集成 + 调度编排）+ C++ DCinfer 执行面（图执行 + 聚合 + 张量传输）。**约束链**：service-kit 是纯 TS 库 → 控制面必须 TS/Next；开题写死服务器是「推理图唯一持有者 + 结果聚合者」（= DCinfer 数据驱动图执行）→ 执行面必须 C++ DCinfer。两者皆不可让，故**强制双平面**。

### D2 — 执行面宿主方式：Sidecar 子进程 + 本地 IPC

（非 N-API addon）**进程隔离**：C++ 崩溃 / 长阻塞不拖垮 Next；契合工作流异步本质。生命周期（拉起 / 崩溃重启）见 §6 待确认。

### D3 — 控制面 ↔ 执行面契约：DCIr 序列化图产物（JSON）

控制面**静态读图**（节点引擎引用 + 端口 Schema）做检视 / 分区 / 绑定，**无需 link DCinfer**（解耦）。契约载体见 [contracts/DESIGN.md](../contracts/DESIGN.md) `ipc/` 域。

### D11 — Next 运行时：自托管 standalone（node runtime）

非 serverless/edge：需**长连接 + 拉起 sidecar + 持状态**。

### D16 — IPC 定案：HTTP over loopback TCP + JSON + 启动随机 token

选 loopback TCP（localhost:port）而非 UDS/named pipe 以**跨平台单一实现**（D17→根）；选 HTTP+JSON 而非 gRPC 以对齐 D15 契约（→contracts）。详见 §4。

### D4 — 节点注册中心：继承 /registry ProviderRegistry + 自建存活与匹配层

基座仅提供 `register`（去重+优先级排序）/ `getStatus`（枚举快照）/ `isAvailable`（拉取式探针）；节点注册中心所需的**下线注销、心跳/TTL 存活、多能力匹配枚举、并发容量**基座均无，**须在子类补齐**（基座本是「选单个最佳 Provider」模型，非「管理海量动态节点」）。

### D5 — 管理控制台：复用 /ops + /ops/next

`requireAdminAuth`；`getStatus()` 快照直接投影「检视全部已登记节点」。

### D9 — 图分区：MVP 整图绑定单客户端 / 静态手动分区

自动最优分区后置（图割 / 装箱难题，非 MVP 目标）。**调度层约束**（承接根 §11）：有互斥关系的节点、环 / 反馈回路**必须绑定同一客户端**（跨机拆分塌语义与性能）。

**任务注入与反压（2026-09-07 capability 访谈定案）**：调度器对端点采用**过量注入**——任务持续下发至端点 per-model 队列（qingge-api TaskPool 模式），队列恒非空保持满负荷，网络延迟气泡被队列吸收。**反压 = 余量软控制**：端点余量（任务数）随心跳/完成上报，注入前查余量，满则暂缓推送。**失败重派任务带补偿优先级**（已排过队，失败是端点的问题——升入端点优先子队列）。调度打分（P3）消费端点运行时指标（分段耗时聚合）。

### D7 — 结果回收寻址：(客户端, 任务) 二元组 + /db Ledger

`(客户端, 任务)` 二元组为基本键；控制面 `/db` 持 Ledger；张量结果经**对象存储总线**承载（完成上报携带输出 URI，执行面拉取唤醒，D8 事件驱动，V8）。回收语义见根 DESIGN。client 上报侧见 [client/DESIGN.md](../client/DESIGN.md)。**任务在途账本**：端点 TTL 判死后，其在途任务**重新入池重派**（重签预签名 URL，requestId 幂等先到先得）；任务撤销 = 标记式（下发「不再执行」，端点出队前检查跳过），无任务级超时。

### D12 — 生态计费：/points 双向流 + 模型报价

deduct（计量扣费，消费侧）+ deposit（算力报酬存入，产出侧）。**模型报价（2026-09-07 定案，V13 配套）**：每模型带「输入张量 → 难度系数」钩子（内容级，模型开发者定义，client 执行时计算并随完成上报）+ 模型单价，计费 = 难度 × 单价；Ledger 预留 meter 字段。可信度信任市场竞争 + 直营模型精算，不建抽样审计（V13）。`requestId` 幂等天然对齐 `(客户端,任务)` 去重。deposit 走 infer 内部台账汇总后存入（非每任务直接发放），详见 [deposit-model.md](../docs/deposit-model.md)。**门禁**：验证强度达「抽样审计+声誉」前不启用真实 deposit 兑付（[security-compute-providers.md](../docs/security-compute-providers.md)）。

### D19 — UI 三场景 + 信任约束

① 用户 web 看自己历史任务 ② 管理员后台看全网 ③ 算力终端(C++)看本机；**①② 在 Next 全栈**，③ 在 client CLI/TUI（见 [client/DESIGN.md](../client/DESIGN.md)）。**信任约束**：provider 收益 / 存入(deposit) UI **只能在 Next（信任域）**，不可落 C++ 客户端（不信任域，禁自助触发 deposit）；③ 限本机只读状态。

### D20 — 对象存储总线：/storage + 控制面签发预签名 URL

经 `/storage` 对象存储；**2026-09-07 扩展为数据面总线（V8）**：模型分发 + 节点输入 / 输出 / 最终输出的全部张量交互，均以 URI + 元数据寻址，client 纯 C++ 不消费 service-kit，一切传输走控制面签发的**预签名 URL**（service-kit 已依赖 `@aws-sdk/s3-request-presigner`），**张量不经服务器转发、不进 TS 控制面**；C++ 端只做 HTTPS GET/PUT + hash 校验 + 本地缓存（消费侧见 [client/DESIGN.md](../client/DESIGN.md)）。

## 3. service-kit 落点映射（原根 DESIGN §5）

| service-kit 模块 | 在 infer 承担 | 对应开题概念 |
|---|---|---|
| `/registry` `ProviderRegistry` | 节点注册中心基座（能力登记 / 存活检查 / 集群快照，D4） | 注册中心 |
| `/ops` + `/ops/next` | 运维报告 + `requireAdminAuth` 管理控制台（D5） | "检视全部已登记节点" |
| `/auth` | 推理请求 / 管理面鉴权中心对接（introspect `active:false` 防枚举） | 生态集成 |
| `/config` | env facets（deployment/authCenter/admin）+ `resolveListenAddress` 自托管监听（D11） | 部署面 |
| `/db` | Ledger(任务→客户端) / 注册信息 / 工作流状态持久化（D7） | 结果回收基本键 |
| `/storage` | **数据面总线**：DCIr 打包模型产物 + 全部张量交互经预签名 URL（D20/V8）；客户端声明持有模型 | 模型分发 + 张量总线 |
| `/points` | deduct 计量扣费（消费侧）+ deposit 算力报酬存入（产出侧，D12） | 生态闭环 |
| `/app` + `/app/next` | 服务目录自述，接入云洲应用目录 | 生态集成 |

## 4. 控制面 ↔ 执行面 IPC（原根 DESIGN §6，D16 展开）

- **形态**：执行面为独立 C++ 子进程（sidecar），控制面经 **HTTP over loopback TCP + JSON 载荷 + 每次启动随机 token 鉴权**驱动。
- **交互**：控制面下发「绑定计划 + 序列化图」→ 执行面重建图并异步驱动 → **控制面轮询 GET `/status` 获取工作流状态（V7 定案，探活一体）**；**最终输出经 `/storage` 预签名 URL 上传，控制面仅持元数据 + URI（V8）**。
- **理由**：图执行是长任务、数据驱动、等待远程节点，Next 请求线程不可阻塞；sidecar 隔离 C++ 崩溃域；轮询无反向鉴权面，拉不到即探活。
- **契约**：DCIr JSON（图结构）+ 绑定计划（节点→远程 URI 语义），来自 [contracts/DESIGN.md](../contracts/DESIGN.md) `ipc/` 域；执行面不感知生态，控制面不 link DCinfer（D3）。
- 落地见 [sidecar/README.md](./sidecar/README.md)；sidecar 侧执行职责原文见根 DESIGN §3 执行面。

## 5. 工作流（原根 DESIGN §8，对齐开题 §4）

```
登记   客户端上线 → 控制面控制通道注册（机器凭证，V3）+ 维持心跳（全量能力，V6；/registry，D4）
检视   推理请求到达 → 读 DCIr 图需求 × 已登记能力匹配；不满足拒绝（D6→contracts）
绑定   调度器划分图执行职责 → 绑定到具体客户端（MVP 整图单客户端，D9）
派发   执行面重建图，远程节点生成「模型引用 + 输入 URI + 输出上传目标」→ WS 下发 client 入队（**过量注入 + 余量反压**，V5/V8）
执行   client 出队（检查撤销标记）→ 下载输入 → EngineRegistry 执行 → 上传输出（对象存储总线）
回推   client 完成上报（输出 URI + 元数据 + 难度系数 + **分段耗时**）→ 执行面拉取并唤醒等待中的图节点（D8 事件驱动）
聚合   执行面将回收结果汇入图执行流，直至产出最终输出 → 经 /storage 上传，回控制面仅元数据 + URI（V8）
```

## 6. 待确认（原根 DESIGN §12 中 server 相关项）

- ~~§12.4 客户端注册是否需鉴权~~ **已定（V3，2026-09-07）**：P1 即强制 `/auth` 机器凭证；影响控制通道端点与 client `register`。
- ~~§12.6 /points 计量维度~~ 方向**已定（V13，2026-09-07）**：模型报价（单价 × 难度钩子），P2 起启用；deposit 门禁不变（D12）。
- ~~§12.7 sidecar 生命周期~~ **已定（2026-09-07 确认）**：Next `instrumentation` 启动时拉起 + 崩溃重启（根 §11「双平面 IPC 故障域」）；**状态回传走控制面轮询 `/status`（V7）**；独立部署形态后置。

## 7. 交叉引用

- 全局架构 / 阶段 / 全局决策（D8/D13/D14/D17）：根 [DESIGN.md](../DESIGN.md)
- 能力 Schema / 契约形态（D6/D15）：[contracts/DESIGN.md](../contracts/DESIGN.md)
- client 侧（D10/D18 + D19③/D20 消费侧）：[client/DESIGN.md](../client/DESIGN.md)
- 执行面 sidecar 落地：[sidecar/README.md](./sidecar/README.md) · 路由树规划：[app/README.md](./app/README.md)
- 计费 / 安全专项：[deposit-model.md](../docs/deposit-model.md) · [security-compute-providers.md](../docs/security-compute-providers.md)
