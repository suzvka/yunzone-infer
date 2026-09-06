// infer-clientd — 算力提供者常驻守护（骨架占位，P1 落地）
//
// 目标职责（DESIGN §3 client，2026-09-07 修正后）：
//   注册 / 心跳 → 控制面控制通道（REST，心跳全量携带能力声明，V6）
//   WS 单向推送收「执行节点」任务：模型引用 + 输入 URI + 输出上传目标 + 任务键（V5）
//   本地执行：DCinfer EngineRegistry + OnnxRuntime 引擎适配器（V10，仅引擎适配层不做图执行）
//   结果交互：输入下载 / 输出上传经 /storage 预签名 URL（对象存储总线，V8）+ hash 校验 + 缓存
//   完成上报：输出 URI + 形状/类型元数据 + 难度系数 + 错误码（D8 事件驱动）
//
// 纯 C++，不消费 service-kit（D10）；无 DCNet / 无监听端（V9）；
// 属不信任域，禁自助触发 deposit（D19）；单模型互斥串行 → 单 engineType+模型 并发=1。

#include <cstdio>

int main(int /*argc*/, char** /*argv*/) {
    std::fprintf(stderr,
                 "[infer-clientd] 骨架占位：注册/心跳 + WS 收任务 + EngineRegistry 执行 + 总线交互 待 P1 落地\n");
    return 0;
}
