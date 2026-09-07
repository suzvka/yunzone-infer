#pragma once
// ── WS 下行客户端（V5：控制通道单向推送；Poco WebSocket + 重连退避）──────────
//
// 连接：{server}/api/control/v1/ws?endpointId={id}，Authorization: Bearer 机器凭证
//（server 端 ws-gateway 连接鉴权，V3）。断线自动重连（指数退避封顶 30s）；
// 收到 task.dispatch / task.revoke（contracts control-channel 域 type 判别）交回调。
// P1 本地对拍 ws:// 明文（部署面 TLS 由前置代理承担，server/DESIGN §11）。

#include <atomic>
#include <functional>
#include <string>
#include <thread>

namespace infer_client {

class WsClient {
public:
    using MessageHandler = std::function<void(const std::string& payload)>;

    WsClient(std::string serverBaseUrl, std::string endpointId, std::string bearer,
             MessageHandler onMessage);
    ~WsClient();

    /// 启动接收循环（后台线程；断线重连）。重复调用无副作用。
    void start();

    /// 停止（关闭连接 + join 线程）
    void stop();

    bool connected() const { return connected_.load(); }

private:
    void loop();

    std::string serverBaseUrl_;
    std::string endpointId_;
    std::string bearer_;
    MessageHandler onMessage_;
    std::thread worker_;
    std::atomic<bool> running_{false};
    std::atomic<bool> connected_{false};
};

}  // namespace infer_client
