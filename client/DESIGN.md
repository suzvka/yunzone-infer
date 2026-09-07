# client/ — 算力提供者工作后端设计决策（孙项目 3 架构权威）

> 本文承载 **client 主导的设计决策**（原根 [DESIGN.md](../DESIGN.md) §4 的 D10 / D18 + 访谈决策 V6/V10/V11）+ **消费侧引用**（D6 能力声明 / D19③ 只读终端 / D20 总线交互，主定义在其他子项目），供 client 独立开发时自包含查阅。
> **全局约束**（D13 只复用不修改 / D14 三孙项目 / D17 整栈跨平台）与**阶段**（P0–P3）见根 [DESIGN.md](../DESIGN.md)。决策编号 D1–D20 / V1–V13 全局唯一（V 索引见根 DESIGN §4.1.1）。

## 1. 定位：纯 C++ 工作后端（不信任域，本地执行编排层）

算力提供者安装的**实际工作后端**：接收服务器下发的**单节点推理任务**，经 **DCinfer InferGraph 单节点驱动**（每可服务模型 → 图内一个引擎节点；图仅为 client **本地执行编排层**，分布式图编排仍在 server 执行面）驱动本地引擎执行，经**对象存储总线**交互张量。**纯 C++**，**不消费 service-kit**（D10）。属**不信任域**（§5）。

> **2026-09-07 架构修正**：原「DCNet 监听端（变体 A）+ 本地图执行」退役——client **不需要图编排**（单节点执行 = 引擎前向，图在 server 执行面）；DCNet 不启用（V9）；DCinfer 仅作多引擎适配器（EngineRegistry + OnnxRuntime 引擎适配器，V10）。
>
> **2026-09-07 决策访谈再修订（D10）**：client 内部改采 **InferGraph 单节点驱动**——图回归 client，但仅作**本地执行编排层**（分布式图编排仍在 server 执行面）：每可服务模型注册为图内一个引擎节点（Registry 按 modelPath 缓存实例），任务键直通图 taskId，`feedInput → submit（timeout=0，对齐「无任务级超时」）→ 完成回调`驱动上传/上报。**动机 = 端点封装意图**：未来将**一组模型包装成一个端点**——端点 = 图执行拓扑（模型清单 = 图内节点清单），端点内多模型本地连线（前处理 → 模型 → 后处理）可免总线往返。外部契约不变（单节点任务 + 完成上报）。

```
client/                       # 纯 C++（CMake + vcpkg，submodule 引 DCinfer）
├── 注册 / 心跳        REST 客户端 → 控制面控制通道；心跳全量携带（模型清单 + 队列余量 + 显存水位，V6）
├── 任务接收           WS 单向推送：「执行节点」通知入队（任务键 + 模型引用 + 输入 URI + 输出目标 + 优先级标志，V5）
├── 任务队列           per-model 多级优先级队列（qingge-api TaskPool 模式）：过量注入缓冲保持满负荷
├── 本地执行           InferGraph 单节点驱动：模型→图内节点（端点=图拓扑）+ OnnxRuntime 引擎适配器（V10）；出队执行，执行前检查撤销标记
├── 结果交互           下载输入 / 上传输出均经 /storage 预签名 URL（D20 总线）+ hash 校验 + 本地缓存
└── 完成上报           REST 上报：输出 URI + 元数据 + 难度系数 + 错误码 + 分段耗时（D8 事件驱动）
```

## 2. 决策

### D10 — 客户端栈：纯 C++（不消费 service-kit；DCinfer 本地执行编排层）

**纯 C++**：DCinfer InferGraph 单节点驱动（本地执行编排层）+ 轻量 REST/WS 客户端 + 对象存储总线交互。不消费 service-kit（纯 TS 库，且 client 属不信任域）。**无共享 C++ core**（D14→根）：与 `server/sidecar` 各自维护封装 glue；共享语义靠 [contracts/DESIGN.md](../contracts/DESIGN.md) codegen 收口。

- **DCinfer 本地执行编排层**（V10 引擎运行时不变；2026-09-07 决策访谈修订）：复用 DCinfer `InferGraph` + `EngineRegistry` + **OnnxRuntime 引擎适配器**（`DCINFER_BUILD_ENGINES=ON`）。执行形态 = **InferGraph 单节点驱动**（模型→图内节点；端点 = 图拓扑，端点封装意图见 §1 修订注）；per-model 分组互斥可用 `declareSubgraph` / `registerGroupLimit` 承载（P1 细化）。P0 spike 已实证 Node/EngineRegistry 独立表面与任务级隔离（`probe/` 12/12）——Node 直驱薄包装保留为**备选执行面**；**不动 DCinfer 本体**（D13）。`DCINFER_BUILD_DCNET=OFF`（V9）。
- **任务队列**（§3.5）：per-model 多级优先级队列（qingge-api TaskPool 模式），过量注入缓冲保持满负荷；标记式懒惰撤销；配置静态深度上限；反压余量上报。
- **能力声明直出**（D6 消费侧）：启动时 EngineRegistry 注册引擎 → 枚举 Descriptor 生成能力声明，与 server 检视端**运行时同构**，契约漂移风险归零。
- **REST/WS 客户端 + 预签名下载**：Poco（vcpkg `poco[netssl]`，REST + WS + HTTPS）；JSON：nlohmann-json；CLI 框架：CLI11（见 [vcpkg.json](./vcpkg.json)）。

### D18 — client 形态与分发：daemon + CLI 双二进制 + installer

> **P1 落地注记（2026-09-07）**：daemon 核心已落（`daemon/src/`：config / task_queue / engine_runner / http_io / ws_client / daemon 编排）——CLI 管控（V11）与 qingge-api 完整队列老化算法（alpha 平滑 / 阈值提升 / survival_count）**后置 P2**；配置来源 = `--config` JSON 文件（`daemon/config.example.json`）；模型获取 P1 = 配置内嵌引擎类型（对拍 stub 同语义副本，D14），总线 model pull P2。

| 产物 | 目录 | 形态 | 职责 |
|---|---|---|---|
| `infer-clientd` | `daemon/` | 常驻守护 | 注册 / 心跳（全量能力，V6）→ 控制通道；WS 收「执行节点」任务（V5）；InferGraph 单节点驱动执行（D10）；输入下载 / 输出上传（对象存储总线）；完成上报 |
| `infer-client` | `cli/` | 命令行控制 | 经本地 loopback HTTP + token 管控 daemon（V11）：安装/服务化、注册、能力配置、生命周期、模型管理、诊断 |

- 经 **installer** 分发（WiX/NSIS · deb/rpm · pkg）；服务化分平台包装（systemd / Windows Service，D17→根）。
- **引擎运行时**（V10）：首版仅 ONNX Runtime（vcpkg 随构建引入，随 installer 分发）；TensorRT 后置，届时是否打包 CUDA 运行时再议。

### V11 — CLI↔daemon 本地管控：loopback HTTP + 随机 token

与 server 的 D16 同构（本机 HTTP + 启动随机 token）；CLI11 命令行 → 本地 HTTP → daemon。跨平台单一实现（D17）。

### V6 — 心跳语义：全量能力随心跳

注册仅首次握手建账；此后每跳全量携带能力声明，server 每跳覆盖能力视图（最防漂移，能力变更下一跳生效）。默认心跳 30s / TTL 90s（3 次缺席判死），可配置。

## 3. 数据面交互与任务队列（对象存储总线，替代原变体 A 监听端）

### 3.1 任务流

WS 收「执行节点」通知 → **入队**（per-model 队列）→ 出队（执行前检查撤销标记）→ 下载输入（预签名 URL + hash 校验 + 本地缓存）→ **InferGraph 单节点驱动执行**（feedInput → submit → 完成回调，D10）→ 上传输出 → **完成上报**（REST：输出 URI + 形状/类型元数据 + 难度系数 + 错误码 + 分段耗时 `queue_wait`/`download`/`infer`/`upload`）→ server 执行面拉取并唤醒图节点（D8 事件驱动）。

- **无 DCNet / 无监听端**（V9）：原「变体 A Serve-a-Node 监听端」随 DCNet 退役；client 不再被出站直驱，改为 WS 通知 + 总线自取。
- **模型获取**（D20 消费侧）：`model pull` 经控制面签发的预签名 URL HTTPS GET + hash 校验 + 本地缓存，**不直连对象存储控制面**。

### 3.5 任务队列与满负荷（qingge-api TaskPool 模式，2026-09-07 定案）

- **过量注入 + 队列缓冲**：server 向端点注入过量任务，队列恒非空使执行器满负荷，网络延迟气泡被队列吸收；**队列元素为轻量任务元数据**（张量在对象存储，出队才下载）。
- **队列结构**：per-model 队列 × 内部**多级优先级子队列** + 权重老化防饥饿 + 插队标志（qingge-api TaskPool：alpha 平滑 / 阈值提升 / survival_count）。
- **优先级来源 = 重试补偿**：常规任务入普通子队列；**执行失败回收重派的任务升入优先子队列**（已排过队，失败是端点的问题，不由任务负责）；消费者付费档位 P2 再议。
- **撤销 = 标记式懒惰撤销**：server 下发「不再执行」标记，端点出队执行前检查，已标记则跳过取下一个；**无任务级超时**——用户等不及走取消，端点掉线走 TTL 判死 + server 侧重派（重签 URL，requestId 幂等先到先得）。
- **深度上限 = 配置静态值**：每模型 max 队列深度由端点配置文件设定；**反压 = 余量软控制**——余量（任务数）随心跳/完成上报，server 注入前查余量，满则暂缓推送。
- **显存水位**（终端级）：上报当前可用显存，**不参与队列深度计算**；后续用于「自动拉取服务器需要的模型并部署」（D20 自动化演进）。

## 4. 消费侧引用（主导定义在其他子项目）

- **D6 能力声明的产生**（主定义 [contracts/DESIGN.md](../contracts/DESIGN.md)）：端点语义四面——模型清单 / 队列余量 / 显存水位 / 分段耗时指标；模型清单 = 端点图内节点清单（D10 端点封装意图）；遵守 `schema/capability/` 版本化契约（V2 整数递增）。
- **D19③ 算力终端只读**（主定义 [server/DESIGN.md](../server/DESIGN.md)）：场景③「算力终端(C++)看本机」在 client CLI/TUI，**限本机只读状态**；provider 收益 / 存入(deposit) UI **不可落 client**（不信任域，见 §5）。
- **D20 总线交互消费侧**（主定义 [server/DESIGN.md](../server/DESIGN.md)）：输入 / 输出 / 模型均经预签名 URL，client 不持对象存储凭证。
- **D7 结果回收回推侧**（主定义 [server/DESIGN.md](../server/DESIGN.md)）：`(客户端, 任务)` 键经完成上报携带。

## 5. 信任边界与并发约束

- **不信任域**（[security-compute-providers.md](../docs/security-compute-providers.md) §1）：client 属第三方、可能恶意。**禁自助触发 deposit**（收益 / 存入只在 server 信任域，D19）；注册鉴权 + 结果验证在控制面。
- **注册鉴权**（V3 已定强制）：`register --token <机器凭证>` 对接 `/auth` client_credentials，绑定 accountId；**不收集硬件指纹**（2026-09-07 裁决：端点语义不描述终端配置，Sybil 防御走账号维度，security §3.2）。
- **难度系数**（D12/V13）：client 执行时按模型元数据中的难度钩子计算并随完成上报——内容级自报值，信任市场机制 + 直营模型精算（V13，不建抽样审计）。
- **任务队列自治**（原「并发=1」退役，2026-09-07）：队列结构 / 优先级 / 撤销 / 上限见 §3.5；能力声明上报队列余量与显存水位（[contracts/DESIGN.md](../contracts/DESIGN.md) §3）。

## 6. 交叉引用

- 全局架构 / 阶段 / 全局决策（D8/D13/D14/D17）+ V 决策索引（V1–V13）：根 [DESIGN.md](../DESIGN.md)
- 能力 Schema / 契约形态（D6/D15/V1/V2/V5）：[contracts/DESIGN.md](../contracts/DESIGN.md)
- server 侧（D1/D7/D19/D20 主定义）：[server/DESIGN.md](../server/DESIGN.md)
- 构建与分发（CMake + vcpkg + installer）：[README.md](./README.md) · [vcpkg.json](./vcpkg.json)
- 数据面（对象存储总线）设计：根 [DESIGN.md](../DESIGN.md) §9
