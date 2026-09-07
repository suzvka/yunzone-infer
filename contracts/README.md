# contracts/ — 协议契约单一事实源（孙项目 1）

> 决策权威见 [contracts/DESIGN.md](./DESIGN.md)：D15（JSON 单一事实源 + codegen）/ D6（能力 Schema，运行时同构）/ V1（codegen 工具链）/ V2（版本号规则）/ V5（控制通道形态）；D14（3 孙项目）为全局决策见根 [DESIGN.md](../DESIGN.md) §4.1。**JSON 单一事实源 + codegen** → 生成 TS 类型 + C++（nlohmann-json）结构，`server`（TS）与 `client`/`sidecar`（C++）共用，**防契约副本漂移**。

## 为什么独立成孙项目

控制通道 API / 能力声明 Schema / IPC 线格式 / 错误码跨越 **TS ↔ C++ 两栈**（server 控制面读能力做检视、client 声明能力、sidecar 按能力绑定）。若各栈手写副本必然漂移（仓库群 `CouplingRecord` 反复出现的教训）。故契约**只在此定义一次**，codegen 到两侧。

## 四个契约域（`schema/`）

| 域 | 内容 | 消费方 | 状态 |
|---|---|---|---|
| `capability/` | 能力声明 Schema（端点语义四面：模型清单 / 队列余量 / 显存水位 / 分段耗时，[contracts/DESIGN.md](./DESIGN.md) §3） | client 声明 · server 检视 · sidecar 绑定 | 首版已落地（v1；字段粒度随对接深化演进，破坏性变更走 V2 递增） |
| `control-channel/` | 控制通道 API：REST（注册 / 心跳全量能力 / 完成上报 / 状态）+ WS 单向推送（任务下发，V5/V6） | client ↔ server 控制面 | P0 |
| `ipc/` | 控制面 ↔ 执行面 IPC 线格式（DCIr JSON 图 + 绑定计划，[server/DESIGN.md](../server/DESIGN.md) §4 / D16 / V7 / V8） | server 控制面 ↔ sidecar | P0 |
| `errors/` | infer 自有错误码（控制通道 + IPC + 完成上报） | 全栈 | P0 |

## codegen

- 输入：`schema/**/*.schema.json`（JSON Schema draft-07；跨域引用用相对路径 `$ref`，如 `../errors/error-codes.schema.json`）
- 输出：`generated/ts/`（TS 类型 + `index.ts` barrel）+ `generated/cpp/`（nlohmann-json 结构 / `to_json`·`from_json` + `contracts.hpp` 总入口）
- `generated/` **不入库**（构建期生成，见根 `.gitignore`）；`server`/`client`/`sidecar` 构建前置运行 `pnpm codegen`
- **工具链（V1）**：TS 侧 `json-schema-to-typescript`（bundle 解析跨文件 `$ref`）；C++ 侧自研生成器——required→值成员，可选/可空→`std::optional`，字符串枚举→`enum class` + `toString`，`const`→`from_json` 校验，自由 object（DCIr 图 / detail）→`nlohmann::json` 原样承载；不支持构造（oneOf/allOf/内联 object 等）fail-fast
- TS 校验：`pnpm ts-check`（tsc --noEmit strict 对 generated 产物）

## 版本化与边界

- **版本号规则已定（V2）**：每个 schema 带 `version` 整数字段，每域独立递增；破坏性变更 +1 + 迁移说明。
- **张量数据面不走 JSON**（对象存储总线 URI + 元数据承载，D20/V8）；本孙项目只管控制 / 元数据契约。
- `errors/` **不含基础工程错误族**（client 完成上报经 `errors/` 映射图级失败，见根 [DESIGN.md](../DESIGN.md) §9）。
