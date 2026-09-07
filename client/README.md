# client/ — 算力提供者工作后端（孙项目 3，纯 C++）

> 决策权威见 [client/DESIGN.md](./DESIGN.md)：D10（纯 C++，DCinfer 本地执行编排层：InferGraph 单节点驱动）/ D18（daemon + CLI 双二进制 + installer）/ V6（心跳全量能力）/ V10（仅 ORT）/ V11（CLI↔daemon loopback HTTP）；全局架构见根 [DESIGN.md](../DESIGN.md) §3

算力提供者安装的**实际工作后端**：WS 收「执行节点」任务 → **InferGraph 单节点驱动**（DCinfer 本地执行编排层：模型→图内节点，端点=图拓扑）驱动本地引擎 → 经**对象存储总线**下载输入 / 上传输出 → 完成上报。**纯 C++**，**不消费 service-kit**。

## 双二进制（D18）

| 产物 | 目录 | 形态 | 职责 |
|---|---|---|---|
| `infer-clientd` | `daemon/` | 常驻守护 | 注册 / 心跳（模型清单+队列余量+显存水位，V6）；WS 收任务入队（V5）；**per-model 多级优先级任务队列**（§3.5，qingge-api 模式）；EngineRegistry 出队执行；输入下载 / 输出上传（对象存储总线）；完成上报（含分段耗时） |
| `infer-client` | `cli/` | 命令行控制 | 经本地 loopback HTTP + token 管控 daemon（V11）：安装/服务化、注册、能力配置、生命周期、模型管理、诊断 |

## CLI 职责域（命令行控制方式，P0/P1 细化）

- `install-service` / `uninstall`：服务化（systemd / Windows Service，分平台包装，D17）
- `register --token <机器凭证>`：对接 `/auth` client_credentials（**V3：P1 强制鉴权**）；绑定 accountId（**不收硬件指纹**，security §3.2）
- `config`：端点能力（可服务模型清单 + 每模型队列深度上限；队列余量 / 显存水位 / 分段耗时为运行时自动上报，`contracts/schema/capability`）
- `start` / `stop` / `restart` / `status` / `health`
- `model pull|list|verify`：经控制面签发的预签名 URL 下载（D20）+ hash 校验 + 本地缓存
- `diag`：总线连通性自检 + dry-run 测试任务 + 算力终端本机状态（D19 场景③，**只读**）

## 关键约束

- **无 DCNet / 无监听端**（V9）：原变体 A 监听端已退役；任务经 WS 通知 + 总线自取，client 不被出站直驱。
- **DCinfer 本地执行编排层**（V10 + D10 修订，2026-09-07）：InferGraph 单节点驱动（模型→图内节点；端点 = 图拓扑，端点封装意图见 [DESIGN.md](./DESIGN.md) §1）+ OnnxRuntime 引擎适配器（`DCINFER_BUILD_ENGINES=ON`）；执行表面已经 P0 spike 实证（`probe/`）。
- **任务队列**（qingge-api TaskPool 模式，§3.5）：per-model 多级优先级 + 过量注入满负荷 + 标记式懒惰撤销 + 配置静态深度上限 + 余量软反压；**无任务级超时**（取消 / 判死重派覆盖）；显存水位终端级上报（供后续自动拉取模型部署）。
- **信任边界**（security §1）：client 属**不信任域**；**禁自助触发 deposit**（收益 / 存入只在 server，D19）；注册鉴权（V3 强制，不收硬件指纹）+ 结果验证在控制面。
- **难度系数**（D12/V13）：按模型元数据难度钩子计算并随完成上报；市场机制约束，无审计。

## 构建与分发

CMake + vcpkg（`vcpkg.json`）；DCinfer（含 DCIr）经 `../external/` submodule（`DCINFER_BUILD_ENGINES=ON`，`DCINFER_BUILD_DCNET=OFF`）。分发经 **installer**（D18：WiX/NSIS · deb/rpm · pkg）；首版引擎运行时仅 ONNX Runtime（V10，随构建引入）。跨平台见 DESIGN D17。
