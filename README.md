# yunzone-infer — 分布式推理资源池

> 状态：**P0 奠基（仓库骨架）** · 全局设计权威见 [DESIGN.md](./DESIGN.md)（子项目决策见 [server](./server/DESIGN.md) / [client](./client/DESIGN.md) / [contracts](./contracts/DESIGN.md)）· 立项见 [开题文档.md](./开题文档.md)

「服务器持有推理图、客户端持有算力」的分布式推理系统：把分散算力组织成可被统一检视、统一调度的推理资源池。以**叠加层**方式构建，**只复用不修改** DCinfer（DCNet 不启用，数据面走对象存储总线）。

## 仓库形态（多语言 monorepo · 3 孙项目 — DESIGN §10 / D14）

| 孙项目 | 栈 | 职责 |
|---|---|---|
| [`contracts/`](./contracts) | JSON Schema + codegen | 协议契约**单一事实源**（能力声明 / 控制通道 API / IPC 线格式 / 错误码）→ 生成 TS 类型 + C++ 结构（D15） |
| [`server/`](./server) | Next.js（TS）+ C++ sidecar | **控制面**（生态集成 + 调度编排 + 3 受众 UI）+ **执行面**（DCinfer 图执行 / 聚合 / 对象存储总线驱动，sidecar 子进程） |
| [`client/`](./client) | 纯 C++（CMake + vcpkg） | 算力提供者工作后端：**daemon**（注册/心跳/WS 收任务/EngineRegistry 引擎执行/总线交互）+ **CLI** 控制 + installer 分发（D18） |
| [`external/`](./external) | git submodule | [DCinfer](https://github.com/suzvka/DCinfer)（内含 DCIr / DCNet）锁版本引入（D17 依赖锁定，只复用不修改；`BUILD_DCNET=OFF`） |

## 两条通道（DESIGN §3，不可混用）

- **控制通道**（TS / REST + WS 推送，轻量 JSON）：注册 / 心跳（全量携带能力声明）/ 任务下发通知（WS）/ 完成上报 / 工作流状态。
- **数据面**（对象存储总线）：一切张量以 **URI + 元数据**寻址，经 `/storage` 预签名 URL 直传，不经服务器转发（V8；原 DCNet 直驱已退役）。

## 落地顺序（DESIGN §13）

**P0 奠基**（本骨架 + `contracts` codegen + sidecar IPC + 数据面总线闭环 + 集成对拍 spike）→ **P1 单跳闭环 MVP** → **P2 分区 + 异步** → **P3 优化**。

## 文档

- [DESIGN.md](./DESIGN.md) — 全局架构 / 全局决策（D8/D13/D14/D17）/ 决策下沉索引（D1–D20）/ 阶段（权威）
- [server/DESIGN.md](./server/DESIGN.md) · [client/DESIGN.md](./client/DESIGN.md) · [contracts/DESIGN.md](./contracts/DESIGN.md) — 各孙项目下沉决策（权威定义）
- [docs/](./docs) — 算力报酬存入模型 · 不信任算力提供者安全设计
- [AGENTS.md](./AGENTS.md) — 仓库定位与协作边界
- 意外 / 跨仓耦合记录见仓库群 `CouplingRecord/`

## 开发（骨架期，依赖尚未安装）

- **TS 侧**：`pnpm install`（workspace：`contracts`、`server`）→ `pnpm codegen`（契约生成）→ `pnpm -r build` / `pnpm -r ts-check`
- **C++ 侧**：见 [`client/README.md`](./client/README.md)、[`server/sidecar/README.md`](./server/sidecar/README.md)（CMake + vcpkg + `external/` submodule）
