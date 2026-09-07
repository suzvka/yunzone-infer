// ── daemon 配置实现（JSON 配置文件解析）────────────────────────────────────

#include "daemon_config.hpp"

#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>

namespace infer_client {

using nlohmann::json;

bool loadDaemonConfig(int argc, char** argv, DaemonConfig& out, std::string& err) {
    std::string configPath;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc) {
            configPath = argv[++i];
        }
    }
    if (configPath.empty()) {
        err = "用法: infer-clientd --config <daemon.json>";
        return false;
    }

    std::ifstream file(configPath);
    if (!file) {
        err = "配置文件打开失败: " + configPath;
        return false;
    }
    json j;
    try {
        file >> j;
    } catch (const json::exception& e) {
        err = std::string("配置 JSON 解析失败: ") + e.what();
        return false;
    }

    try {
        out.serverBaseUrl = j.at("serverBaseUrl").get<std::string>();
        while (!out.serverBaseUrl.empty() && out.serverBaseUrl.back() == '/') {
            out.serverBaseUrl.pop_back();
        }
        out.machineToken = j.at("machineToken").get<std::string>();
        out.endpointId = j.at("endpointId").get<std::string>();
        if (j.contains("heartbeatIntervalSeconds")) {
            out.heartbeatIntervalSeconds = j.at("heartbeatIntervalSeconds").get<int>();
        }
        for (const auto& m : j.at("models")) {
            ModelConfig mc;
            mc.modelKey = m.at("modelKey").get<std::string>();
            mc.engineType = m.at("engineType").get<std::string>();
            if (m.contains("maxQueueDepth")) mc.maxQueueDepth = m.at("maxQueueDepth").get<int>();
            out.models.push_back(std::move(mc));
        }
    } catch (const json::exception& e) {
        err = std::string("配置字段缺失或非法: ") + e.what();
        return false;
    }

    if (out.serverBaseUrl.empty() || out.machineToken.empty() || out.endpointId.empty() ||
        out.models.empty()) {
        err = "配置不完整：serverBaseUrl / machineToken / endpointId / models 均必填";
        return false;
    }
    return true;
}

}  // namespace infer_client
