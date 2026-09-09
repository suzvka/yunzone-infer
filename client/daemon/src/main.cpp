// infer-clientd — 算力提供者常驻守护（D18；P1 daemon 核心先行，CLI 管控 V11 P2）
//
// 职责（client/DESIGN.md §1，2026-09-07 修正后形态）：
//   注册 / 心跳 → 控制面控制通道（REST，心跳全量携带能力声明，V6）
//   WS 单向推送收「执行节点」任务：模型引用 + 输入 URI + 输出上传目标 + 任务键（V5）
//   本地执行：InferGraph 单节点驱动（模型→图内节点，端点=图拓扑，D10 修订）
//   结果交互：输入下载 / 输出上传经预签名 URL（对象存储总线，V8）+ hash 校验（P1 形态校验）
//   完成上报：输出 URI + 形状/类型元数据 + 错误码 + 分段耗时（D8 事件驱动）
//
// 纯 C++，不消费 service-kit（D10）；无 DCNet / 无监听端（V9）；
// 属不信任域，禁自助发放报酬（D19；计量面已上移平台，2026-09-09）。
//
// 用法：infer-clientd --config <daemon.json>（示例见 ../config.example.json）

#include "daemon.hpp"
#include "daemon_config.hpp"
#include "http_io.hpp"

#include <iostream>

int main(int argc, char** argv) {
    infer_client::ensureHttpInit();

    infer_client::DaemonConfig config;
    std::string err;
    if (!infer_client::loadDaemonConfig(argc, argv, config, err)) {
        std::cerr << "[infer-clientd] " << err << std::endl;
        return 2;
    }

    std::cout << "[infer-clientd] starting: endpoint=" << config.endpointId
              << " server=" << config.serverBaseUrl << " models=" << config.models.size()
              << std::endl;

    infer_client::Daemon daemon(std::move(config));
    return daemon.run();
}
