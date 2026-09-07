// ── WS 下行客户端实现（Poco WebSocket）─────────────────────────────────────

#include "ws_client.hpp"

#include "http_io.hpp"

#include <Poco/Net/HTTPClientSession.h>
#include <Poco/Net/HTTPRequest.h>
#include <Poco/Net/HTTPResponse.h>
#include <Poco/Net/WebSocket.h>
#include <Poco/URI.h>

#include <chrono>
#include <cstring>
#include <iostream>
#include <thread>

namespace infer_client {

namespace {
constexpr const char* kWsPath = "/api/control/v1/ws";
constexpr int kMaxBackoffSeconds = 30;
}  // namespace

WsClient::WsClient(std::string serverBaseUrl, std::string endpointId, std::string bearer,
                   MessageHandler onMessage)
    : serverBaseUrl_(std::move(serverBaseUrl)),
      endpointId_(std::move(endpointId)),
      bearer_(std::move(bearer)),
      onMessage_(std::move(onMessage)) {
    while (!serverBaseUrl_.empty() && serverBaseUrl_.back() == '/') serverBaseUrl_.pop_back();
}

WsClient::~WsClient() { stop(); }

void WsClient::start() {
    if (running_.load()) return;
    running_.store(true);
    worker_ = std::thread([this] { loop(); });
}

void WsClient::stop() {
    running_.store(false);
    if (worker_.joinable()) worker_.join();
    connected_.store(false);
}

void WsClient::loop() {
    int backoffSeconds = 1;
    while (running_.load()) {
        try {
            // ws:// 或 wss:// 均按 host/port 明文握手（wss 部署面走 TLS 代理前置，P1 注释）
            const std::string wsUrl = serverBaseUrl_ + kWsPath + "?endpointId=" + endpointId_;
            Poco::URI uri(wsUrl);
            Poco::Net::HTTPClientSession session(uri.getHost(), uri.getPort());
            Poco::Net::HTTPRequest req(Poco::Net::HTTPRequest::HTTP_GET, uri.getPathAndQuery(),
                                       Poco::Net::HTTPMessage::HTTP_1_1);
            if (!bearer_.empty()) {
                req.set("Authorization", "Bearer " + bearer_);
            }
            Poco::Net::HTTPResponse resp;
            Poco::Net::WebSocket ws(session, req, resp);

            connected_.store(true);
            backoffSeconds = 1;
            std::cout << "[infer-clientd] WS connected: " + serverBaseUrl_ + kWsPath << std::endl;

            char buffer[8192];
            int flags = 0;
            while (running_.load()) {
                const int n = ws.receiveFrame(buffer, sizeof(buffer), flags);
                if (n <= 0) break;  // 对端关闭 / 错误 → 重连
                if ((flags & Poco::Net::WebSocket::FRAME_OP_BITMASK) ==
                    Poco::Net::WebSocket::FRAME_OP_CLOSE) {
                    break;
                }
                if (onMessage_) {
                    onMessage_(std::string(buffer, static_cast<size_t>(n)));
                }
            }
            connected_.store(false);
        } catch (const std::exception& e) {
            connected_.store(false);
            std::cerr << "[infer-clientd] WS error: " << e.what()
                      << "（" << backoffSeconds << "s 后重连）" << std::endl;
        }
        // 指数退避重连（1s → 30s 封顶；期间 running_ 置 false 立即退出）
        for (int waited = 0; running_.load() && waited < backoffSeconds; ++waited) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
        backoffSeconds = backoffSeconds < kMaxBackoffSeconds ? backoffSeconds * 2 : kMaxBackoffSeconds;
    }
}

}  // namespace infer_client
