# contracts/ — 契约设计决策（孙项目 1 架构权威）

> 本文承载 **contracts 主导的设计决策**（原根 [DESIGN.md](../DESIGN.md) §4 的 D6/D15 + §7 能力 Schema 详解），供 contracts 独立开发时自包含查阅。
> **全局约束**（D13 只复用不修改 / D14 三孙项目 / D17 整栈跨平台）与**阶段**（P0–P3）见根 [DESIGN.md](../DESIGN.md)，contracts 同样受其约束。
> 决策编号（D1–D20）为全项目通用语言、全局唯一；本文只定义归属 contracts 的编号，其余编号在对应子项目 DESIGN.md 定义。

## 1. 定位（承接根 DESIGN §3 / D14 / D15）

`contracts/` 是 3 孙项目之一，协议契约的**单一事实源**：能力声明 Schema / 控制通道 API / IPC 线格式 / 错误码以 **JSON(Schema)** 定义于此，经 codegen 生成 **TS 类型**（供 `server` 控制面 / sidecar IPC 消费）+ **C++（nlohmann-json）结构**（供 `client` / `sidecar` 消费），两栈共用，**防契约副本漂移**（仓库群 `CouplingRecord` 反复出现的教训）。

**无共享 C++ core**（D14）：DCNet 以外部依赖引入，`server/sidecar` 与 `client` 各自维护封装 glue；跨两栈的共享语义**只靠本孙项目 codegen 收口**。

## 2. 决策

### D15 — 契约形态：JSON 单一事实源 + codegen

**JSON 单一事实源 + codegen**：能力 Schema / 控制通道 API / IPC 线格式 / 错误码以 JSON(Schema) 定义于 `contracts/`，生成 TS 类型 + C++（nlohmann-json）结构，两侧共用防副本漂移。

- **张量数据面走对象存储总线（URI + 元数据契约，V8），不进 JSON 载荷**（本孙项目只管控制 / 元数据契约；2026-09-07 修正，原「DCNet 二进制」表述退役）。
- `generated/` **不入库**（构建期生成，见根 `.gitignore`）；`server`/`client`/`sidecar` 构建前置运行 `pnpm codegen`。
- **工具链已定（V1，2026-09-07）**：TS 侧 `json-schema-to-typescript` + C++ 侧自研生成器（nlohmann-json struct + `to_json`/`from_json`）；`scripts/codegen.mjs` 已实现（P0 首版：14 schema → TS/C++ 双产物，`pnpm codegen` 一键生成，`pnpm ts-check` 校验 TS 侧）。

### D6 — 能力声明 Schema：复用 DCinfer EngineDescriptor + 端口 Schema

复用 DCinfer `EngineDescriptor` + 端口 Schema 作能力基底（详见 §3）；**检视 = 图需求 Schema 与节点能力 Schema 匹配**。**运行时同构（2026-09-07 升级）**：client 经 EngineRegistry 直出 Descriptor 生成声明，与 server 检视端为同一运行时对象，漂移风险归零。

- 能力 Schema 的**定义权威在 contracts**（`schema/capability/`）。
- **检视逻辑**在 server 控制面（图节点模型引用 × 已登记模型清单匹配 → 不满足拒绝启动），见 [server/DESIGN.md](../server/DESIGN.md)。
- **能力声明的产生**在 client（EngineRegistry + 队列/水位运行时状态上报），见 [client/DESIGN.md](../client/DESIGN.md)。

## 3. 能力声明 Schema 详解（2026-09-07 capability 访谈重定：端点语义）

**算力提供者的身份是「端点」而非「终端」**：server 无需理解端点配置细节（型号类规格不收集），取而代之以**运行时测量**与**队列/水位状态**。原「EngineDescriptor 四维度」中引擎类型 / 端口形状规则**下沉至模型元数据**（DCIr/模型产物自带），并发容量字段**废止**：

| 面 | 内容 | 上报通道 |
|---|---|---|
| 静态 | **可服务模型清单**（`/storage` 产物键；引擎兼容性 / 端口形状由模型元数据承载，端点不重复声明） | 注册 + 心跳全量（V6） |
| 动态·调度 | **per-model 队列余量**（任务数；每模型配置静态上限，超出由 server 反压挡在注入侧） | 心跳 + 完成上报 |
| 动态·部署 | **终端级显存水位**（当前可用显存；后续用于「自动拉取服务器需要的模型并部署」） | 心跳 |
| 运行时指标 | 分段耗时：`queue_wait`（排队）/ `download` / `infer` / `upload`（qingge-api 分段审计模式） | 完成上报 |

> **检视** = 图节点模型引用 ∈ 端点模型清单（布尔判断，不满足拒绝启动）；**打分** = 运行时指标聚合，影响调度排序（D9 打分调度，P3）与 ops 展示，不改变检视拒绝语义。**耗时下限校验**兼作结果验证辅助信号（security §2）。
> **并发容量语义废止**：端点任务队列模型替代——server **过量注入**、端点队列缓冲保持满负荷（见 [client/DESIGN.md](../client/DESIGN.md) §3.5）；原「单 engineType+模型 并发=1」退役（DCNet 串行遗产）。

## 4. 四个契约域（`schema/`）

| 域 | 内容 | 消费方 | 状态 |
|---|---|---|---|
| `capability/` | 能力声明 Schema（端点语义：模型清单 + 队列余量 + 显存水位 + 分段耗时指标，§3） | client 声明 · server 检视/注入反压 · sidecar 绑定 | P0 版本化锁定（形态已定 2026-09-07；字段细节待 submodule 对照） |
| `control-channel/` | 控制通道 API：REST（注册 / 心跳全量能力 / 完成上报 / 状态）+ WS 单向推送（任务下发，V5/V6） | client ↔ server 控制面 | P0 |
| `ipc/` | 控制面 ↔ 执行面 IPC 线格式（DCIr JSON 图 + 绑定计划，见 [server/DESIGN.md](../server/DESIGN.md) D16 / V7 / V8） | server 控制面 ↔ sidecar | P0 |
| `errors/` | infer 自有错误码（控制通道 + IPC + 完成上报） | 全栈 | P0 |

## 5. 版本化与边界

- **版本号规则已定（V2，2026-09-07）**：每个 schema 带 `version` 整数字段，每域独立递增；破坏性变更 +1 + 迁移说明；三方比对只看整数相等。
- **张量数据面不走 JSON**（对象存储总线 URI + 元数据承载，D20/V8）；本孙项目只管控制 / 元数据契约。
- `errors/` **不含基础工程错误族**（infer 自有错误码；client 完成上报经 `errors/` 映射图级失败，见根 [DESIGN.md](../DESIGN.md) §9）。

## 6. 待确认（原根 DESIGN §12.2）

- **能力声明 Schema 字段细节**（§3）——形态已定（2026-09-07 端点语义 + 队列/水位/指标四面）；字段命名与粒度待 submodule 就位后对照模型元数据（EngineDescriptor / DCIr 产物）收口。

## 7. 交叉引用

- 全局架构 / 阶段 / 全局决策（D13/D14/D17）+ V 决策索引：根 [DESIGN.md](../DESIGN.md)
- 能力 Schema 的**检视消费**（D4/D9）：[server/DESIGN.md](../server/DESIGN.md)
- 能力 Schema 的**声明产生**（D10/D18）：[client/DESIGN.md](../client/DESIGN.md)
- codegen 输入输出约定 / 构建前置：[README.md](./README.md)
