// infer-sidecar 执行面入口（骨架占位，P0 落地）
//
// 目标职责（DESIGN §3 执行面，2026-09-07 修正后）：
//   监听 loopback TCP + 随机 token 鉴权（D16）；控制面轮询 GET /status（V7）
//   → 接收控制面「DCIr 序列化图 JSON + 绑定计划」（contracts/schema/ipc）
//   → DCIr 反序列化重建图，按绑定计划把节点标记为远程（远程节点经对象存储 URI 交互，V8）
//   → 数据驱动执行：本地节点进程内；远程节点生成「模型引用 + 输入 URI」经 WS 下发 client（V5）
//   → 完成上报唤醒 + 对象存储拉取 → 聚合回收结果汇入图执行流（D8 事件驱动）
//   → 最终输出经 /storage 预签名 URL 上传，回传控制面仅元数据 + URI（V8）
//
// 只复用不修改 DCinfer（D13）；BUILD_DCNET=OFF（V9）；不感知生态（不消费 service-kit）。

#include <cstdio>

int main(int /*argc*/, char** /*argv*/) {
    std::fprintf(stderr, "[infer-sidecar] 骨架占位：IPC 端点 + 图重建/执行/聚合 待 P0 落地\n");
    return 0;
}
