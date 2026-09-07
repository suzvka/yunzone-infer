#pragma once
// ── 对象存储总线交互（D20/V8 消费语义）───────────────────────────────────────
//
// 执行面 / 端点替身的一切张量传输均走「控制面签发 URL + HTTP GET/PUT」（D20：
// client 不持对象存储凭证；sidecar 不感知生态——URL 由控制面给到）。
// P0：本地对象存储替身（V12）直连 http URL；正式形态 = /storage 预签名 URL
//（https），随 P1 Poco 接入 TLS（http_io.hpp 头注释）。

#include "http_io.hpp"

#include <string>
#include <utility>

namespace infer_sidecar {

inline bool busGetBytes(const std::string& url, std::string& out, std::string& err) {
    const auto reply = http::request("GET", url);
    if (!reply.ok) {
        err = reply.error.empty() ? ("HTTP " + std::to_string(reply.status)) : reply.error;
        return false;
    }
    if (reply.status != 200) {
        err = "HTTP " + std::to_string(reply.status) + ": " + reply.body;
        return false;
    }
    out = reply.body;
    return true;
}

inline bool busPutBytes(const std::string& url, const std::string& bytes, std::string& err) {
    const auto reply = http::request("PUT", url, bytes,
                                     {{"content-type", "application/octet-stream"}});
    if (!reply.ok) {
        err = reply.error.empty() ? ("HTTP " + std::to_string(reply.status)) : reply.error;
        return false;
    }
    if (reply.status / 100 != 2) {
        err = "HTTP " + std::to_string(reply.status) + ": " + reply.body;
        return false;
    }
    return true;
}

}  // namespace infer_sidecar
