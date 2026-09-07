#pragma once
// ── daemon 配置（P1：argv + JSON 配置文件；CLI 管控 V11 P2）──────────────────
//
// 配置来源：--config <path> JSON 文件（serverBaseUrl / machineToken / endpointId /
// 心跳间隔 / 模型清单）。机器凭证（V3）经配置注入，本地文件权限由运维侧保证
// （不信任域约束见 client/DESIGN §5：daemon 不承载 deposit 面即可）。

#include <string>
#include <vector>

namespace infer_client {

struct ModelConfig {
    std::string modelKey;      // 可服务模型清单键（/storage 产物键）
    std::string engineType;    // EngineRegistry 引擎类型（对拍：P0StubModel；V10：ORT 适配器类型）
    int maxQueueDepth = 8;     // per-model 队列深度上限（端点配置静态值，client/DESIGN §3.5）
};

struct DaemonConfig {
    std::string serverBaseUrl;              // 控制面（含端口，无尾斜杠）
    std::string machineToken;               // 机器凭证（V3，Authorization: Bearer）
    std::string endpointId;                 // 端点标识（注册幂等键）
    int heartbeatIntervalSeconds = 30;      // V6 默认 30s
    std::vector<ModelConfig> models;
};

// 解析命令行：infer-clientd --config <path>；失败返回 false 并填 err
bool loadDaemonConfig(int argc, char** argv, DaemonConfig& out, std::string& err);

}  // namespace infer_client
