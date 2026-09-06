# ipc/ — 控制面 ↔ 执行面 IPC 线格式（[server/DESIGN.md](../../../server/DESIGN.md) §4 / D16 / V7/V8）

server 控制面（TS）↔ 执行面 sidecar（C++）的本地 IPC 契约：**HTTP over loopback TCP（localhost:port）+ JSON 载荷 + 每次启动随机 token 鉴权**（D16，跨平台单一实现）。

- 载荷：DCIr 序列化图（JSON，D3）+ 绑定计划（节点 → 远程 URI 语义）+ 工作流状态
- 状态回传：**控制面轮询 `GET /status`（V7 定案，探活一体）**；最终输出经 `/storage` 预签名 URL 上传，控制面仅持元数据 + URI（V8）
- 消费方：server 控制面（发起）↔ sidecar（重建图 / 异步驱动 / 状态暴露）
- sidecar 不感知生态，控制面不 link DCinfer（[server/DESIGN.md](../../../server/DESIGN.md) §4 / D3）
