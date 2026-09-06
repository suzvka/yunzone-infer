# server/sidecar/ — 执行面（C++ 子进程，link DCinfer）

> 决策权威见 [server/DESIGN.md](../DESIGN.md)：D2（sidecar 子进程 + 本地 IPC）/ D3（DCIr JSON 契约）/ D16（IPC 定案，§4）/ V7（控制面轮询 /status）/ V8（数据面总线）；执行面职责见根 [DESIGN.md](../../DESIGN.md) §3

服务器双平面的 C++ 半边：**进程隔离**（C++ 崩溃 / 长阻塞不拖垮 Next），由控制面经本地 IPC 拉起并驱动（生命周期：Next `instrumentation` 拉起 + 崩溃重启，2026-09-07 定案）。

## 职责（根 [DESIGN.md](../../DESIGN.md) §3 执行面 / [server/DESIGN.md](../DESIGN.md) §1）

- **图持有 / 重建**：DCIr 反序列化 → 按绑定计划把节点标记为远程（远程节点经**对象存储 URI** 交互，V8）
- **数据驱动执行**：本地节点（聚合 / 算子）进程内执行；远程节点生成「模型引用 + 输入 URI + 输出上传目标」经控制通道 **WS 下发** client（V5）
- **聚合**：client 完成上报唤醒 + 对象存储拉取 → 回收结果汇入图执行流，直至产出最终输出（D8 事件驱动）
- **最终输出**：经 `/storage` 预签名 URL 上传；控制面仅持元数据 + URI（V8）
- **IPC 端点**：HTTP over loopback TCP + JSON + 每次启动随机 token（D16）；**控制面轮询 `GET /status`（V7，探活一体）**

## 契约

- 输入：DCIr 序列化图 JSON + 绑定计划（节点 → 远程 URI 语义），来自 `contracts/schema/ipc/`（codegen C++ 头）
- **不感知生态**（不消费 service-kit）；控制面**不 link DCinfer**（D3 解耦）
- **无 DCNet**（V9：数据面走对象存储总线，出站直驱退役）

## 构建（CMake + vcpkg，骨架期未接线）

见 `CMakeLists.txt`。依赖 DCinfer（`external/` submodule，需 `--recursive`）+ contracts codegen 的 C++ 头（`contracts/generated/cpp/`）；`BUILD_DCNET=OFF`（V9）、`BUILD_ENGINES=ON`（本地节点引擎需求，P0 spike 收紧）。`src/main.cpp` 为占位入口；P0 随 IPC 契约落地最小 sidecar。
