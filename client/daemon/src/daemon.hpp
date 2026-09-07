#pragma once
// ── daemon 编排（D18：注册/心跳 → WS 收任务 → 队列 → 执行 → 上报）────────────
//
// 线程模型（P1 对拍形态）：
//   主线程 = run() 阻塞（等待 shutdown）；
//   WS 线程 = WsClient 接收循环（断线重连）；
//   心跳线程 = 周期全量能力上报（V6：模型清单 + 队列余量 + 显存水位）；
//   消费线程 = 队列阻塞出队 → 下载 → 执行 → 上传 → 完成上报（分段耗时）。
// 多模型并发消费为 P2（per-model worker；P1 单消费线程保持「并发=1」串行语义）。

#include "daemon_config.hpp"
#include "engine_runner.hpp"
#include "task_queue.hpp"
#include "ws_client.hpp"

#include <atomic>
#include <memory>
#include <string>
#include <thread>

namespace infer_client {

class Daemon {
public:
    explicit Daemon(DaemonConfig config);

    /// 阻塞运行（注册 → WS → 心跳 → 消费）；返回退出码（0 = 正常退出）
    int run();

    /// 请求退出（信号处理或测试注入）
    void shutdown();

private:
    /// 注册（首次握手建账，V3/V6；409 = 已注册沿用——daemon 重启恢复语义，注释见实现）
    bool registerEndpoint(std::string& err);

    /// 单次心跳（全量能力：模型清单 + queueRemaining + 显存水位，V6）
    bool heartbeatOnce(std::string& err);

    /// 能力声明 JSON（capability 域 EndpointCapability）
    std::string capabilityJson() const;

    void heartbeatLoop();
    void consumeLoop();
    void handleDispatchMessage(const std::string& payload);
    void handleRevokeMessage(const std::string& payload);

    DaemonConfig config_;
    EngineRunner engine_;
    TaskQueue queue_;
    std::unique_ptr<WsClient> ws_;
    std::thread heartbeatThread_;
    std::thread consumeThread_;
    std::atomic<bool> running_{false};
};

}  // namespace infer_client
