# errors/ — infer 自有错误码（控制通道 + IPC + 完成上报）

infer 控制通道与 IPC 层的错误码单一事实源，供全栈（server TS / client C++ / sidecar C++）共用。

- 范围：注册 / 心跳 / 检视拒绝 / 任务下发 / 完成上报 / IPC / 工作流状态机的错误码
- client 完成上报携带本域错误码 → sidecar 映射为图级节点失败，语义与本地执行对齐（根 [DESIGN.md](../../../DESIGN.md) §9，P0 对拍专测错误路径）
- **不含基础工程错误族**（DCinfer / DCIr 内部错误由其契约定义；service-kit 各模块错误族由 kit 定义，server 侧透传）
