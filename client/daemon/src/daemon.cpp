// ── daemon 编排实现 ─────────────────────────────────────────────────────────

#include "daemon.hpp"

#include "http_io.hpp"
#include "stub_model.hpp"

#include <nlohmann/json.hpp>

#include <chrono>
#include <exception>
#include <iostream>
#include <map>

namespace infer_client {

using nlohmann::json;

namespace {

std::int64_t steadyMsSince(std::chrono::steady_clock::time_point since) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now() - since)
        .count();
}

}  // namespace

Daemon::Daemon(DaemonConfig config)
    : config_(std::move(config)),
      // 车道深度上限 = per-model 配置静态值（client/DESIGN §3.5）；
      // 成员声明顺序保证 config_ 先于 queue_ 初始化，此处引用安全
      queue_([&] {
          std::map<std::string, int> depths;
          for (const auto& m : config_.models) depths[m.modelKey] = m.maxQueueDepth;
          return depths;
      }()) {}

int Daemon::run() {
    running_.store(true);

    // ① 引擎编排层构建（D10：per-model 单节点图 + 能力直出面）
    std::string err;
    if (!engine_.build(config_.models, err)) {
        std::cerr << "[infer-clientd] engine build failed: " << err << std::endl;
        return 1;
    }

    // ② 注册（首次握手建账）
    if (!registerEndpoint(err)) {
        std::cerr << "[infer-clientd] register failed: " << err << std::endl;
        return 1;
    }

    // ③ WS 下行（V5：task.dispatch / task.revoke）
    ws_ = std::make_unique<WsClient>(
        config_.serverBaseUrl, config_.endpointId, config_.machineToken,
        [this](const std::string& payload) {
            try {
                const json msg = json::parse(payload);
                if (msg.value("type", "") == "task.dispatch") {
                    handleDispatchMessage(payload);
                } else if (msg.value("type", "") == "task.revoke") {
                    handleRevokeMessage(payload);
                }
            } catch (const json::exception& e) {
                std::cerr << "[infer-clientd] WS payload parse failed: " << e.what() << std::endl;
            }
        });
    ws_->start();

    // ④ 心跳（V6 全量能力）+ ⑤ 消费线程
    heartbeatThread_ = std::thread([this] { heartbeatLoop(); });
    consumeThread_ = std::thread([this] { consumeLoop(); });

    // 主线程等待退出（P1 无信号处理：进程 kill 即停；服务化包装 D17 属 installer 面）
    while (running_.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    ws_->stop();
    queue_.shutdown();
    if (heartbeatThread_.joinable()) heartbeatThread_.join();
    if (consumeThread_.joinable()) consumeThread_.join();
    return 0;
}

void Daemon::shutdown() { running_.store(false); }

bool Daemon::registerEndpoint(std::string& err) {
    const json body = json::parse(capabilityJson());
    const json req = json{
        {"version", 1},
        {"endpointId", config_.endpointId},
        {"capability", body},
    };
    std::string resp;
    const int status = httpPostJson(config_.serverBaseUrl + "/api/control/v1/endpoints",
                                    config_.machineToken, req.dump(), resp, err);
    if (status == 409) {
        // 已注册（daemon 重启，registry 内旧账尚存活）：沿用账目转心跳维持（V6）
        std::cout << "[infer-clientd] endpoint already registered, resuming: "
                  << config_.endpointId << std::endl;
        return true;
    }
    if (status / 100 != 2) {
        err = "register → HTTP " + std::to_string(status) + ": " + resp;
        return false;
    }
    std::cout << "[infer-clientd] registered: " << config_.endpointId << std::endl;
    return true;
}

bool Daemon::heartbeatOnce(std::string& err) {
    const json req = json::parse(capabilityJson());
    std::string resp;
    const int status =
        httpPostJson(config_.serverBaseUrl + "/api/control/v1/endpoints/" + config_.endpointId +
                         "/heartbeat",
                     config_.machineToken, req.dump(), resp, err);
    if (status / 100 != 2) {
        err = "heartbeat → HTTP " + std::to_string(status) + ": " + resp;
        return false;
    }
    return true;
}

std::string Daemon::capabilityJson() const {
    // per-model 余量（队列深度上限 - 在队）
    std::map<std::string, int> remaining;
    for (const auto& m : config_.models) {
        remaining[m.modelKey] = queue_.queueRemaining(m.modelKey);
    }
    const json capability = json{
        {"version", 1},
        {"models", engine_.capabilityModels(remaining)},
        // 显存水位（终端级）：P1 置 null（CPU/未知；自动拉取模型部署的演进消费面，D20）
        {"vramFreeBytes", nullptr},
    };
    return capability.dump();
}

void Daemon::heartbeatLoop() {
    while (running_.load()) {
        std::string err;
        if (!heartbeatOnce(err)) {
            std::cerr << "[infer-clientd] heartbeat failed: " << err << std::endl;
        }
        for (int waited = 0; running_.load() && waited < config_.heartbeatIntervalSeconds; ++waited) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    }
}

void Daemon::handleDispatchMessage(const std::string& payload) {
    const json msg = json::parse(payload);
    QueuedTask task;
    task.taskId = msg.at("taskId").get<std::string>();
    task.requestId = msg.at("requestId").get<std::string>();
    task.workflowId = msg.at("workflowId").get<std::string>();
    task.nodeId = msg.at("nodeId").get<std::string>();
    task.modelKey = msg.at("modelKey").get<std::string>();
    task.inputUri = msg.at("inputUri").get<std::string>();
    task.outputUri = msg.at("outputUri").get<std::string>();
    task.compensation = msg.value("priority", "normal") == "compensation";
    std::string err;
    if (!queue_.push(std::move(task), err)) {
        // 深度满 / 未知模型：server 反压以心跳余量为准，此处拒绝即丢（重派兜底）
        std::cerr << "[infer-clientd] task enqueue rejected: " << err << std::endl;
    }
}

void Daemon::handleRevokeMessage(const std::string& payload) {
    const json msg = json::parse(payload);
    queue_.revoke(msg.at("taskId").get<std::string>());
}

void Daemon::consumeLoop() {
    while (running_.load()) {
        QueuedTask task;
        if (!queue_.popAny(task)) break;  // shutdown

        const auto queueWaitMs = steadyMsSince(task.enqueuedAt);
        auto t0 = std::chrono::steady_clock::now();
        const auto ms = [&t0] { return steadyMsSince(t0); };

        // ① 下载输入（预签名 GET / 替身直链；P1 以 float32 形态校验替代 hash，见 http_io）
        std::string bytes;
        std::string err;
        if (!httpGet(task.inputUri, bytes, err)) {
            std::cerr << "[infer-clientd] input download failed: " << err << std::endl;
            continue;  // 不上报失败：等待 TTL 判死重派（D7）——传输侧失败无输出对象可拉
        }
        const auto downloadMs = ms();
        float input = 0.0f;
        if (!scalarFromBytes(bytes, input)) {
            std::cerr << "[infer-clientd] input is not a float32 scalar (" << bytes.size()
                      << " bytes)" << std::endl;
            continue;
        }

        // ② 执行（InferGraph 单节点驱动，D10 修订）
        t0 = std::chrono::steady_clock::now();
        float output = 0.0f;
        if (!engine_.runTask(task, input, output, err)) {
            std::cerr << "[infer-clientd] infer failed: " << err << std::endl;
            // 执行失败上报（errors 域错误码）→ sidecar 映射图级节点失败（根 DESIGN §9）
            const json report = json{
                {"version", 1},
                {"taskId", task.taskId},
                {"endpointId", config_.endpointId},
                {"requestId", task.requestId},
                {"outputUri", nullptr},
                {"errorCode", "E_INFER_FAILED"},
                {"metrics",
                 json{{"queueWaitMs", queueWaitMs}, {"downloadMs", downloadMs},
                      {"inferMs", ms()}, {"uploadMs", 0}}},
            };
            std::string resp;
            httpPostJson(config_.serverBaseUrl + "/api/control/v1/tasks/completions",
                         config_.machineToken, report.dump(), resp, err);
            continue;
        }
        const auto inferMs = ms();

        // ③ 上传输出（对象存储总线，V8）
        t0 = std::chrono::steady_clock::now();
        if (!httpPut(task.outputUri, scalarBytes(output), err)) {
            std::cerr << "[infer-clientd] output upload failed: " << err << std::endl;
            const json report = json{
                {"version", 1},
                {"taskId", task.taskId},
                {"endpointId", config_.endpointId},
                {"requestId", task.requestId},
                {"outputUri", nullptr},
                {"errorCode", "E_STORAGE_TRANSFER_FAILED"},
                {"metrics",
                 json{{"queueWaitMs", queueWaitMs}, {"downloadMs", downloadMs},
                      {"inferMs", inferMs}, {"uploadMs", ms()}}},
            };
            std::string resp;
            httpPostJson(config_.serverBaseUrl + "/api/control/v1/tasks/completions",
                         config_.machineToken, report.dump(), resp, err);
            continue;
        }
        const auto uploadMs = ms();

        // ④ 完成上报（D8 事件驱动：server 转发 sidecar 拉取唤醒）
        const json report = json{
            {"version", 1},
            {"taskId", task.taskId},
            {"endpointId", config_.endpointId},
            {"requestId", task.requestId},
            {"outputUri", task.outputUri},  // 全 URL 回传（server normalizeBusKey 提取对象键）
            {"outputMeta", json{{"shape", json::array()}, {"dtype", "float32"}}},
            {"metrics",
             json{{"queueWaitMs", queueWaitMs}, {"downloadMs", downloadMs}, {"inferMs", inferMs},
                  {"uploadMs", uploadMs}}},
        };
        std::string resp;
        const int status = httpPostJson(config_.serverBaseUrl + "/api/control/v1/tasks/completions",
                                        config_.machineToken, report.dump(), resp, err);
        if (status / 100 != 2) {
            std::cerr << "[infer-clientd] completion report failed (HTTP " << status << "): "
                      << err << std::endl;
        } else {
            std::cout << "[infer-clientd] task done: " << task.taskId
                      << " (queue=" << queueWaitMs << "ms dl=" << downloadMs
                      << "ms infer=" << inferMs << "ms ul=" << uploadMs << "ms)" << std::endl;
        }
    }
}

}  // namespace infer_client
