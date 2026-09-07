# server/sidecar/ — 执行面（C++ 子进程，link DCinfer）

> 决策权威见 [server/DESIGN.md](../DESIGN.md)：D2（sidecar 子进程 + 本地 IPC）/ D3（DCIr JSON 契约）/ D16（IPC 定案，§4）/ V7（控制面轮询 /status）/ V8（数据面总线）；执行面职责见根 [DESIGN.md](../../DESIGN.md) §3

服务器双平面的 C++ 半边：**进程隔离**（C++ 崩溃 / 长阻塞不拖垮 Next），由控制面经本地 IPC 拉起并驱动（生命周期：Next `instrumentation` 拉起 + 崩溃重启，2026-09-07 定案）。

## 职责（根 [DESIGN.md](../../DESIGN.md) §3 执行面 / [server/DESIGN.md](../DESIGN.md) §1）——P0 已落地

- **图持有 / 重建**：DCIr JSON → InferGraph（`graph_builder.cpp`；远程节点物化为 **BusProxy**：outputs-only 节点，RunFn 阻塞等待完成上报 + 总线拉取唤醒，D8）
- **数据驱动执行**：本地节点（算子 / 聚合）进程内执行（DCinfer Builtin 算子表）；远程节点组装 TaskDispatch（对象键语义）入 pendingDispatches，经 `GET /workflows/{id}/status` 轮询被控制面取走（V7/V5）
- **聚合**：控制面转发完成通知（`POST /workflows/{id}/node-completions`）→ 拉取输出（签名 URL）→ 唤醒 BusProxy → 数据驱动传播 → 任务完成回调 → PUT finalOutputUri（V8）
- **IPC 端点**：HTTP over loopback TCP + JSON + 启动 token（D16，`http_io.hpp` 极小实现；两端同仓可控，Poco 收敛随 client P1）；`GET /status` 聚合探活（V7，端口支持 0 = OS 分配回读）
- **不感知生态**（不消费 service-kit）；控制面**不 link DCinfer**（D3）；**无 DCNet**（V9）

## 源码结构

| 文件 | 职责 |
|---|---|
| `src/main.cpp` | 入口：`serve`（IPC 端点 + 路由）/ `run-local`（对拍单机半边：同图全本地执行逐节点落盘） |
| `src/graph_builder.*` | DCIr JSON → InferGraph（本地节点算子表物化 / 远程节点 BusProxy；P0 限制：仅 1:1 边、远程节点无入边、Float 标量端口） |
| `src/workflow_run.*` | 工作流运行时（状态机 + pendingDispatch 组装 + D8 唤醒 + 聚合上传 + 错误码映射） |
| `src/http_io.hpp` | 极小 loopback HTTP 收发（Content-Length + Connection: close；NOMINMAX） |
| `src/bus_client.hpp` | 总线 GET/PUT（签名 URL，D20 消费语义） |
| `src/stub_model.hpp` | 对拍 stub 算子 `P0StubModel`（y=x*2+1，单一语义源）+ float32 标量编解码 |
| `src/endpoint_stub.cpp` | `infer-endpoint-stub` 对拍端点替身（下载→前向→上传→结果 JSON；P1 由真 client daemon 替代，D18） |

## 构建（CMake + vcpkg）

见 `CMakeLists.txt`。依赖 DCinfer（`external/` submodule，需 `--recursive`；`BUILD_ENGINE_BUILTIN=ON`）+ contracts codegen 的 C++ 头（`pnpm codegen` 先行）+ vcpkg `nlohmann-json/zlib/minizip`。
