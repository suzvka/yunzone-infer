# 仓库定位（最先读，优先于一切结构推断）

本仓库是 **yunzone-infer 分布式推理资源池**，项目组**首个多语言 monorepo**：

- **3 孙项目**（DESIGN §10 / D14）：`contracts/`（JSON 契约单一事实源 + codegen）、`server/`（Next.js TS 控制面 + C++ 执行面 sidecar）、`client/`（纯 C++ daemon + CLI）。`external/` 以 submodule 锁版本引入 [DCinfer](https://github.com/suzvka/DCinfer)（内含 DCIr / DCNet；**DCNet 不启用，V9**）。**各孙项目决策权威见其 `DESIGN.md`**（`contracts/DESIGN.md` · `server/DESIGN.md` · `client/DESIGN.md`）。
- **叠加层定位**：**只复用不修改** DCinfer / DCIr（D13 / D17）；通用性新需求（如 DCNet 直连低延迟）以提案形式反馈基础工程路线图，**不私自分叉**。
- **服务器强制双平面**（D1，不可让）：service-kit 是纯 TS 库 → 控制面必须 TS/Next；服务器是「推理图唯一持有者 + 结果聚合者」（DCinfer 数据驱动执行）→ 执行面必须 C++ DCinfer sidecar（本地 IPC，D2/D16）。

# 边界与约定

- **契约单一事实源**（D15）：能力声明 Schema / 控制通道 API / IPC 线格式 / 错误码只在 `contracts/`（JSON）定义，codegen 出 TS 类型 + C++（nlohmann-json）结构；**两侧不得手写副本**（防漂移）。张量数据面走对象存储总线（URI + 元数据契约，V8），**不进 JSON 载荷**。
- **无共享 C++ core**（D14）：`server/sidecar` 与 `client` 各自维护封装 glue（引擎适配 / 总线交互）；共享语义靠 `contracts/` codegen 收口。
- **两条通道不可混用**（DESIGN §3，2026-09-07 修正后形态）：控制通道（TS / REST + WS，JSON）vs **数据面（对象存储总线，张量以 URI + 元数据寻址）**；原 DCNet 直驱已退役。
- **client 纯 C++ 不消费 service-kit**（D10）：模型拉取经控制面签发的**预签名 URL**（D20），不直连对象存储。
- **信任约束**（D19）：provider 收益 / 存入(deposit) UI 只能在 `server`（信任域），**不可落 `client`**（不信任域，禁自助触发 deposit）；算力终端(C++ ③)限本机只读状态。
- **文档惯例**：`DESIGN.md` 为**全局架构 + 阶段权威**；决策 D1–D20 编号全局唯一、**权威定义已下沉**——全局决策（D8/D13/D14/D17）在根 `DESIGN.md` §4.1，其余在各子项目 `DESIGN.md`（`server`/`client`/`contracts`），下沉索引见根 `DESIGN.md` §4.2；改动中发现意外 / 跨仓耦合，记入仓库群 `CouplingRecord/`（命名 `[yunzone-infer] yyyyMMdd-HHmmss 描述`）。

<!-- Next.js 集成注意（server/ 控制面）：本仓库群 Next 版本可能与既有认知不同（house 版 16.x），
     编写 server/ 代码前先读 node_modules/next/dist/docs/ 相关指南，遵循弃用提示。 -->
