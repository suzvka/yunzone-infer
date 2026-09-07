# yunzone-infer — 分布式推理资源池设计文档（全局架构权威）

> 状态：立项设计（双平面架构定稿；技术选型专项结论固化 — 2026-09-06；**数据面架构修正 — 2026-09-07**：DCNet 出站直驱退役 → 对象存储总线，client 轻量化为引擎适配器，见 §9）
> 文档性质：承接 [开题文档.md](./开题文档.md)，界定**全局架构、边界与阶段**；实现细节另议。
> **决策下沉（2026-09-06）**：子项目主导决策（D1–D7/D9–D12/D15/D16/D18–D20）已**物理移至各子项目 DESIGN.md**（[server](./server/DESIGN.md) / [client](./client/DESIGN.md) / [contracts](./contracts/DESIGN.md)），方便独立开发；本文只保留**全局决策**（D8/D13/D14/D17，无法归属单一孙项目）+ **决策下沉索引**（§4）+ 架构总览（§1–§3）+ 阶段（§13）+ 验收（§14）。
> 关联决策：服务器双平面 / 生态集成经 yunzone-service-kit / 叠加层只复用不修改 DCinfer / 3 孙项目 + 整栈跨平台 + **数据面＝对象存储总线（§9，DCNet 不启用）** — 2026-09-06 固化 · 2026-09-07 数据面修正

## 1. 定位

构建"服务器持有推理图、客户端持有算力"的分布式推理系统：把分散的算力组织成可被统一检视、统一调度的推理资源池，以**叠加层**方式实现，不侵入 DCinfer / DCNet 本体。

- 面向推理任务的分发与协同，不是通用计算平台，不涉足训练。
- 服务器检视系统中已登记的全部节点，确认具备任务所需能力后启动工作流，并为每个 `(客户端, 任务)` 二元组提供结果回收通道。

## 2. 基础工程与生态依赖

| 资产 | 形态 | 本项目关系 |
|---|---|---|
| **DCinfer** | C++20 推理图编排运行时（数据驱动并发、EngineRegistry 插件式引擎、端口 Schema 校验、零依赖核心静态库） | 复用图持有 / 执行 / 聚合能力，**只读不改** |
| **DCIr** | 推理图序列化 / 反序列化 + 模型打包（nlohmann-json + minizip + zlib） | 序列化图产物 = 控制面 ↔ 执行面的**契约载体** |
| **DCNet** | 张量网络传输框架（DCinfer 仓库内模块，出站已建成） | **2026-09-07 修正：不启用**（`DCINFER_BUILD_DCNET=OFF`，submodule 仍锁仓库）——数据面改走对象存储总线（§9）；直连低延迟需求留 P3，经 D13 提案机制反馈 |
| **调度器策略参考** | 成熟 C++ 调度器实现（打分调度 / 多级优先级队列防饥饿 / 异步播种-收割 sowing·harvesting / 结果保质期 shelf_life） | **策略参考**，不引入代码依赖 |
| **yunzone-service-kit** | TS/Node 集群基础设施（`/registry` `/ops` `/auth` `/config` `/db` `/storage` `/points` `/app`；`next` 为 optional peer） | 控制面**必然依赖**，生态集成落点见 [server/DESIGN.md](./server/DESIGN.md) §3 |

> 关键约束：service-kit 是纯 TS 库 → 控制面必须 TS/Next；开题文档写死服务器是"推理图唯一持有者 + 结果聚合者"（= DCinfer 数据驱动图执行）→ 执行面必须 C++ DCinfer。两者皆不可让，故服务器**强制双平面**（D1，见 [server/DESIGN.md](./server/DESIGN.md)）。

## 3. 架构总览

```
yunzone-infer（多语言 monorepo · 3 孙项目，见 §4 D14）
│
├── contracts/                    # 协议契约（JSON 单一事实源 + codegen → TS/C++）→ contracts/DESIGN.md
│
├── server/                       # 服务器（自托管 Next.js standalone，node runtime）→ server/DESIGN.md
│   ├── 控制面（TS / Next，消费 service-kit）
│   │   ├── 节点注册中心   ← 继承 /registry ProviderRegistry 骨架 + 自建 TTL存活/注销/多能力匹配（D4）
│   │   ├── 能力检视       读 DCIr 序列化图 → 图需求 Schema × 已登记能力 匹配；不满足则拒绝启动
│   │   ├── 调度器         图分区 → 任务到客户端绑定（策略可替换接口，D9）
│   │   ├── 工作流状态机   登记→检视→绑定→派发→回收→聚合 的编排与状态持久化（/db Ledger）
│   │   ├── 管理控制台     /ops + /ops/next requireAdminAuth；getStatus 快照投影"检视全部节点"（D5）
│   │   ├── 生态集成       /auth 鉴权 · /points 计量 · /storage 模型产物 · /config env facets · /app 目录
│   │   └── 控制通道端点   REST（注册 / 心跳 / 完成上报 / 状态）+ WS 推送（任务下发，V5）；心跳全量携带能力声明（V6）
│   └── 执行面（C++ sidecar 子进程，link DCinfer，D2）
│       ├── 图持有 / 重建  DCIr 反序列化 → 按绑定计划把节点标记为远程（远程节点经对象存储 URI 交互，§9）
│       ├── 数据驱动执行   本地节点进程内执行；远程节点下发「模型引用 + 输入 URI」经 WS 通知 client（§9）
│       ├── 聚合           回收结果（完成上报唤醒 + 对象存储拉取）汇入图执行流，直至产出最终输出
│       └── 最终输出       经 /storage 预签名 URL 上传，控制面仅持元数据 + URI（V8）
│   控制面 ↔ 执行面：本地 IPC（sidecar，D16）；契约 = DCIr 序列化图 JSON + 绑定计划
│
└── client/                       # 算力提供者代理（纯 C++ daemon + CLI，不消费 service-kit）→ client/DESIGN.md
    ├── 注册 / 心跳        REST 客户端 → 控制面控制通道；心跳全量携带（模型清单 + 队列余量 + 显存水位，V6）
    ├── 任务接收           WS 单向推送：「执行节点」通知入队（任务键 + 模型引用 + 输入 URI + 输出目标 + 优先级标志，V5）
    ├── 任务队列           per-model 多级优先级队列（qingge-api TaskPool 模式）：过量注入缓冲保持满负荷
    ├── 本地执行           InferGraph 单节点驱动（模型→图内节点；端点=图拓扑，D10 修订）+ OnnxRuntime 适配器（V10）；出队前检查撤销标记
    └── 结果交互           下载输入 / 上传输出均经 /storage 预签名 URL（对象存储总线，§9）+ 完成上报（含分段耗时）
```

**两条通道分离（不可混用；2026-09-07 修正后形态）**：
- **控制通道（TS / REST + WS 推送，轻量 JSON）**：注册、心跳（全量携带能力声明）、任务下发通知（WS 单向推送）、完成上报、工作流状态（V5/V6）。
- **数据面（对象存储总线，§9）**：一切张量（节点输入 / 输出 / 最终结果）以 **URI + 元数据**寻址，经 `/storage` 预签名 URL 在执行面 ↔ client 之间直传，**不经服务器转发、不进 TS 控制面**（V8）；原「DCNet 出站直驱 / 变体 A·B 监听端」已退役（DCNet 不启用，V9）。

## 4. 决策记录

### 4.1 全局决策（跨子项目，无法归属单一孙项目 — 本文保留全文）

| # | 决策 | 结论 |
|---|---|---|
| D8 | 回收语义 | **事件驱动统一（2026-09-07 重写）**：client 完成 → 上传输出（对象存储）→ 控制通道完成上报 → 执行面拉取并唤醒等待中的图节点；同步 / 异步不再分阶段，P2 仅增调度策略（多任务在途 / shelf_life 超时清理）。跨 server（执行面回收）+ client（上报），故留全局 |
| D13 | 对基础工程 | **只复用不修改**；通用性新需求（如高效张量格式）以提案形式反馈基础工程路线图，不私自分叉 |
| D14 | 孙项目划分 | **3 个孙项目**：`contracts/`（协议契约）+ `server/`（Next 全栈控制面 + C++ 执行面 sidecar）+ `client/`（纯 C++ daemon + CLI）。**无共享 C++ core**——两 C++ 工程各自维护封装 glue（引擎适配 / 总线交互），共享语义靠 `contracts/` codegen 收口 |
| D17 | 跨平台 | **整栈跨平台**（Windows/Linux/macOS）：控制面 Node 天然跨平台；C++ 经 CMake+vcpkg+POCO 单一实现；client 服务安装分平台包装（systemd/Windows Service）；引擎按平台/硬件条件注册（TensorRT 仅 NVIDIA+Win/Linux，首版仅 ORT，V10）；CI 走 OS 矩阵（P0 仅 Win+Linux，V4）。**头号未知＝外部 DCinfer/DCIr 双平台可移植性，P0 须 spike 实证** |

### 4.1.1 访谈新增决策（V1–V13，2026-09-07 决策访谈定案）

> 本次访谈修正了原架构中「DCNet 出站直驱 / 变体 A·B」设定，新增工程基座决策；V 编号全局唯一，落点随 D 编号惯例下沉至各子项目 DESIGN.md。

| # | 决策 | 结论 | 权威落点 |
|---|---|---|---|
| V1 | codegen 工具链 | `json-schema-to-typescript`（TS）+ C++ 自研生成器（nlohmann-json struct + to_json/from_json） | [contracts/DESIGN.md](./contracts/DESIGN.md) |
| V2 | Schema 版本号 | 每契约域整数递增，破坏性变更 +1 + 迁移说明 | [contracts/DESIGN.md](./contracts/DESIGN.md) |
| V3 | 注册鉴权 | P1 即强制 `/auth` 机器凭证（control-channel 首版含凭证字段） | [server/DESIGN.md](./server/DESIGN.md) |
| V4 | CI 矩阵 | P0 仅 Win+Linux；macOS 待风险收敛后补 | 本文 §10 |
| V5 | 控制通道形态 | REST（注册/心跳/完成上报/状态）+ WS 单向推送（任务下发） | [contracts/DESIGN.md](./contracts/DESIGN.md) |
| V6 | 心跳语义 | 全量能力随心跳（默认 30s / TTL 90s 可配），注册仅首次握手 | [client/DESIGN.md](./client/DESIGN.md) |
| V7 | 状态回传 | 控制面轮询 GET sidecar `/status`（探活一体，无反向鉴权面） | [server/DESIGN.md](./server/DESIGN.md) |
| V8 | 数据面大载荷 | 一切张量以 URI + 元数据寻址，不经服务器转发、不进 TS 控制面 | 本文 §9 |
| V9 | DCNet | **不启用**（DCINFER_BUILD_DCNET=OFF）；P3 直连需求走 D13 提案机制 | 本文 §2 |
| V10 | 引擎运行时 | 首版仅 ONNX Runtime（复用 DCinfer OnnxRuntime 引擎适配器）；TensorRT 后置 | [client/DESIGN.md](./client/DESIGN.md) |
| V11 | CLI↔daemon 管控 | loopback HTTP + 随机 token（与 D16 同构） | [client/DESIGN.md](./client/DESIGN.md) |
| V12 | 对拍拓扑 | 两段式：P0 本机多进程 + 本地对象存储替身；P1 末真双机验收 | 本文 §9 |
| V13 | 计费可信度 | 难度钩子（内容级）信任市场竞争 + 直营模型精算，不建抽样审计 | [security-compute-providers.md](./docs/security-compute-providers.md) |

### 4.2 决策下沉索引（D1–D20 全局唯一编号；权威定义已移至子项目 DESIGN.md）

| # | 决策 | 结论（摘要） | 权威定义 |
|---|---|---|---|
| D1 | 服务器形态 | 双平面：TS/Next 控制面 + C++ DCinfer 执行面（不可让） | [server/DESIGN.md](./server/DESIGN.md) |
| D2 | 执行面宿主 | Sidecar 子进程 + 本地 IPC（非 N-API addon） | [server/DESIGN.md](./server/DESIGN.md) |
| D3 | 控制面↔执行面契约 | DCIr 序列化图产物（JSON），控制面不 link DCinfer | [server/DESIGN.md](./server/DESIGN.md) |
| D4 | 注册中心实现 | 继承 /registry ProviderRegistry + 自建存活/匹配层 | [server/DESIGN.md](./server/DESIGN.md) |
| D5 | 管理控制台 | 复用 /ops + /ops/next `requireAdminAuth` | [server/DESIGN.md](./server/DESIGN.md) |
| D6 | 能力声明 Schema | 复用 DCinfer EngineDescriptor + 端口 Schema 作能力基底（client 经 EngineRegistry 直出，运行时同构） | [contracts/DESIGN.md](./contracts/DESIGN.md) |
| D7 | 结果回收寻址 | `(客户端,任务)` 二元组 + 控制面 /db Ledger | [server/DESIGN.md](./server/DESIGN.md) |
| **D8** | 回收语义 | 事件驱动统一（完成上报 + 对象存储拉取） | **本文 §4.1** |
| D9 | 图分区 | MVP 整图绑定单客户端 / 静态手动分区 | [server/DESIGN.md](./server/DESIGN.md) |
| D10 | 客户端栈 | 纯 C++（DCinfer 本地执行编排层：InferGraph 单节点驱动 + REST/WS），不消费 service-kit | [client/DESIGN.md](./client/DESIGN.md) |
| D11 | Next 运行时 | 自托管 standalone（node runtime） | [server/DESIGN.md](./server/DESIGN.md) |
| D12 | 生态计费 | /points 双向流 + **模型报价**（单价 × 难度钩子） | [server/DESIGN.md](./server/DESIGN.md) |
| **D13** | 对基础工程 | 只复用不修改 + 提案反馈路线图 | **本文 §4.1** |
| **D14** | 孙项目划分 | 3 孙项目 + 无共享 C++ core | **本文 §4.1** |
| D15 | 契约形态 | JSON 单一事实源 + codegen（→ TS + C++） | [contracts/DESIGN.md](./contracts/DESIGN.md) |
| D16 | IPC 定案 | HTTP over loopback TCP + JSON + 启动随机 token | [server/DESIGN.md](./server/DESIGN.md) |
| **D17** | 跨平台 | 整栈跨平台（Win/Linux/macOS） | **本文 §4.1** |
| D18 | client 形态与分发 | daemon + CLI 双二进制 + installer | [client/DESIGN.md](./client/DESIGN.md) |
| D19 | UI 三场景 | ①②在 Next（信任域）/ ③在 client（只读）；禁 client 自助 deposit | [server/DESIGN.md](./server/DESIGN.md) |
| D20 | 对象存储总线 | /storage + 预签名 URL：模型分发 + 全部张量交互（URI + 元数据契约） | [server/DESIGN.md](./server/DESIGN.md) |

## 5. service-kit 落点映射

> **已下沉至 [server/DESIGN.md](./server/DESIGN.md) §3**（8 个 service-kit 模块 → infer 承担映射，server 控制面专属）。

## 6. 控制面 ↔ 执行面 IPC

> **已下沉至 [server/DESIGN.md](./server/DESIGN.md) §4**（D16：HTTP over loopback TCP + JSON + 每次启动随机 token）。

## 7. 能力声明 Schema

> **已下沉至 [contracts/DESIGN.md](./contracts/DESIGN.md) §3**（D6：引擎类型 / 模型 / 端口形状规则 / 并发容量 4 维度 + 检视 + 版本化）。

## 8. 工作流

> **已下沉至 [server/DESIGN.md](./server/DESIGN.md) §5**（登记→检视→绑定→派发→执行→回推→聚合，对齐开题 §4）。

## 9. P0 专项（早期锁定，风险前置）

1. **数据面（对象存储总线）**（2026-09-07 重写，替代原「变体 A/B 入站监听端」专项）：
   - **形态**：一切张量以 **URI + 元数据**寻址（V8）——执行面为远程节点生成「模型引用 + 输入 URI + 输出上传目标」→ 控制通道 WS 下发（V5）→ client 下载输入、InferGraph 单节点驱动执行（DCinfer OnnxRuntime 适配器，V10；D10 修订）、上传输出 → **完成上报** → 执行面拉取并唤醒等待中的图节点（D8 事件驱动）。
   - **P0 须完成**：① URI + 元数据契约（contracts `control-channel/` + `ipc/`）与最小总线闭环（本地对象存储替身，V12）；② **对拍**（同图单机执行 vs 经总线分布式执行逐节点比对）；③ **client 执行形态已定（2026-09-07 spike + 决策访谈）**：Node/EngineRegistry 独立表面与图驱动表面均经实证（`client/probe/` 12/12；DCinfer 核心 MSVC 10/10），采纳 **InferGraph 单节点驱动**（端点 = 图拓扑，client/DESIGN.md D10 修订），薄包装保留为备选面；不动本体（D13）；④ **双平台可移植性实证**（DCinfer/DCIr 在 Windows MSVC + Linux GCC/Clang build+run，D17 头号未知）。
   - **已知约束**：张量经对象存储中转，延迟高于直连——由端点**任务队列**吸收（server 过量注入 + 队列缓冲保持满负荷，[client/DESIGN.md](./client/DESIGN.md) §3.5），直连列为 P3 优化（D13 提案机制）；预签名 URL 天然 HTTPS，原「数据通道无 TLS」风险大体消解（§11）；队列深度上限 = 端点配置静态值，反压 = 余量软控制。
2. **能力声明 Schema 版本化**（[contracts/DESIGN.md](./contracts/DESIGN.md) §3）：控制面 / 客户端 / 执行面三方共同契约。
3. **控制面 ↔ 执行面 IPC 协议**（[server/DESIGN.md](./server/DESIGN.md) §4）：DCIr JSON + 绑定计划的具体线格式。
4. **多机集成测试骨架**：确定性对拍（同图单机执行 vs 分布式执行逐节点比对），作为验收自动化载体。

## 10. 仓库形态与工程惯例

- **多语言 monorepo（项目组首个）· 3 孙项目（D14）**：
  - `contracts/`（**独立孙项目**）：JSON 单一事实源 + codegen（→ TS 类型 + C++ nlohmann-json 结构），两侧共用防副本漂移（D15）。详见 [contracts/DESIGN.md](./contracts/DESIGN.md)。
  - `server/`（pnpm + Next.js TS 全栈控制面 + 3 受众 UI）内嵌 **C++ 执行面 sidecar**（link DCinfer）。详见 [server/DESIGN.md](./server/DESIGN.md)。
  - `client/`（CMake + vcpkg，submodule 引 DCinfer）：**daemon + CLI 双二进制 + installer 分发**（D18），纯 C++ 不消费 service-kit。详见 [client/DESIGN.md](./client/DESIGN.md)。
  - **无共享 C++ core**：两 C++ 工程各自维护封装 glue（引擎适配 / 总线交互）；共享语义靠 `contracts/` codegen 收口（D14/D15）。
- **CI（跨平台，D17）**：双轨 pnpm（ts-check / vitest / build）+ CMake（ctest），跑 **OS 矩阵**（windows-latest + ubuntu-latest）；工具链需专门搭建。
- **文档惯例**：`DESIGN.md`（本文，全局架构 + 阶段权威）+ **各子项目 `DESIGN.md`（下沉决策权威）** + `AGENTS.md`（协作边界）+ 纳入 `CouplingRecord` 记录机制。
- **依赖锁定**：DCinfer（含 DCIr / DCNet 模块）以 submodule / vcpkg 锁版本（D5：`suzvka/DCinfer`），落实"只复用不修改"（D13）；`DCINFER_BUILD_DCNET=OFF`（V9），引擎适配器按需启用（client：OnnxRuntime；sidecar：视本地节点引擎需求）。

## 11. 主要风险与对策（承接开题 §6，补双平面新增项）

| 风险 | 对策 |
|---|---|
| 远程节点执行失败语义与本地执行不一致 → 模糊故障 | client 完成上报携带 infer 自有错误码（contracts `errors/`），执行面映射为图级节点失败；P0 对拍专测错误路径（§9） |
| 控制通道（REST/WS）部署面明文风险（张量面已由预签名 URL 的 HTTPS 承担，2026-09-07 修正） | 部署侧前置 TLS 代理终止；详见 [security-compute-providers.md](./docs/security-compute-providers.md) |
| 任务时长差异大，单一等待 / 回收语义难兼顾 | 事件驱动统一回收（D8）；P2 增多任务在途 + shelf_life 超时清理 |
| 进程内图级语义（执行互斥）跨机失效 | 调度层约束：**有互斥关系的节点必须绑定同一客户端**（[server/DESIGN.md](./server/DESIGN.md) D9） |
| **成环 / 反馈回路跨机拆分**（DCinfer 支持成环拓扑，开题未列） | 调度层约束：**环 / 反馈回路整体绑定同一客户端**（每轮迭代跨网往返会塌语义与性能） |
| 客户端异构且随时掉线，影响在途任务 | 检视前置拒绝 + 心跳 TTL 存活（V6）+ 任务级重调度兜底 |
| **双平面 IPC 成为新故障域**（sidecar 崩溃 / 挂起） | 进程隔离 + 心跳 / 超时 + 工作流状态可恢复（`/db` 持久化）；执行面无状态可重启 |
| **多语言 monorepo 工具链复杂度** | CI 双轨（pnpm + CMake）；契约（DCIr JSON）作单一事实源解耦两栈 |

## 12. 待确认事项

> 已按归属分配：全局项留本文，子项目项见对应 DESIGN.md。

1. ~~IPC 具体协议选型~~ **已定（D16）**：HTTP over loopback TCP + JSON + 启动随机 token（[server/DESIGN.md](./server/DESIGN.md)）。
2. ~~能力声明 Schema 首版字段集与版本号规则~~ 版本号规则**已定（V2）**：每契约域整数递增；**首版字段集**待 submodule 就位看 EngineDescriptor 真身后定 → **[contracts/DESIGN.md](./contracts/DESIGN.md) §6**。
3. 远程节点错误码与图级失败映射：client 完成上报携带 infer 自有错误码（contracts `errors/`），执行面映射语义与本地执行对齐；P0 对拍实测确认（§9）。
4. ~~客户端注册是否需要鉴权~~ **已定（V3，2026-09-07）**：P1 即强制 `/auth` 机器凭证（security §3 倾向采纳）→ **[server/DESIGN.md](./server/DESIGN.md) §6 + [client/DESIGN.md](./client/DESIGN.md) §5**。
5. ~~模型产物分发策略~~ **已定（D20）**：经 `/storage` + 控制面签发预签名 URL（[server/DESIGN.md](./server/DESIGN.md)）。
6. ~~`/points` 计量接入时机与计费维度~~ 方向**已定（V13，2026-09-07）**：模型报价＝单价 × 难度钩子（内容级，市场机制约束，不建审计），P2 起启用；deposit 门禁不变 → **[server/DESIGN.md](./server/DESIGN.md) §6**（受 [security-compute-providers.md](./docs/security-compute-providers.md) 约束）。
7. ~~sidecar 生命周期~~ **已定（2026-09-07 确认）**：Next `instrumentation` 拉起 + 崩溃重启 → **[server/DESIGN.md](./server/DESIGN.md) §6**。
8. **外部 C++ 依赖双平台可移植性（D17 头号未知，全局）**：DCinfer/DCIr 须在 Windows(MSVC)+Linux(GCC/Clang) 实证 build+run（DCNet 不启用，V9）——**P0 spike**。

## 13. 落地顺序

1. **P0 奠基**：**仓库骨架（3 孙项目）+ 双轨 CI（OS 矩阵）冒烟**；`contracts/` JSON 单一事实源 + codegen（TS/C++）落地；锁双平面边界 + sidecar IPC（D16 HTTP-loopback）；**数据面最小总线闭环 + 对拍 spike**（对象存储 URI 契约 + client 执行表面验证已定，§9③；**双平台可移植性仍须实证**）；能力声明 Schema 版本化；多机集成测试骨架（确定性对拍）。
2. **P1 单跳闭环（MVP）**：`/registry` 节点注册中心（继承 ProviderRegistry + **自建 TTL 存活/注销/多能力匹配**，D4）→ 能力检视 → 整图绑定单客户端 → 任务下发（WS）→ **远程节点经对象存储总线 + 完成上报驱动 client 执行（InferGraph 单节点驱动 + ORT 适配器）** → C++ 聚合 → 回控制面；`/auth` 请求鉴权（P1 即强制，V3）+ `/ops` 管理控制台展示已登记节点。跑通"端到端正确性 + 语义一致性"两条验收。**关键路径**：client 图驱动执行（InferGraph 单节点 + ORT 适配器）与对象存储总线闭环。
3. **P2 分区 + 异步**（**已落地 2026-09-08，服务端四项**）：静态图分区（nodeGroups 分组约束 + 环 SCC 校验 + 多端点绑定，D9）；多任务在途调度 + shelf_life（签名收口）+ 任务级重调度（回收按 `(客户端,任务)` 键寻址 + 注入等待中的图节点，D8 事件驱动）；`/db` Ledger 持久化（pg write-through + 启动恢复 + reward 台账 pg 权威，D7）；`/points` 计量（完成即 deduct，模型报价：单价 × 难度钩子，D12；受 §12.6 门禁约束，deposit 兑付后置）；容错验收（掉线 / 超时 / 过载 / 重启恢复，场景测试覆盖）；client 侧（CLI V11 / 队列老化算法 / model pull）后置 P3。
4. **P3 优化**：打分调度（借鉴成熟调度器打分策略）；高效张量格式演进；自动图分区探索。

## 14. 验收主旨（承接开题 §7）

- **端到端正确性**：多机环境下，图任务从派发至聚合的结果与单机执行一致（P0 集成测试对拍）。
- **语义一致性**：远程节点在图级的行为（状态 / 错误 / 诊断）与本地节点无差别。
- **容错可预期**：掉线 / 超时 / 过载场景下系统行为明确，不产生悬挂任务与歧义结果。
