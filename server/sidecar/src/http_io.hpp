#pragma once
// ── 极小 loopback HTTP/1.1 收发（D16：HTTP over loopback TCP + JSON）─────────
//
// P0 执行面专用：两端同仓可控（sidecar ↔ 控制面 / 对象存储总线替身），故只实现
// Content-Length 定长报文 + Connection: close 语义，不追逐通用 HTTP 兼容面。
// TLS/HTTPS（正式 /storage 预签名 URL 直传，D20）与 WS 属 P1，随 client 侧 Poco
// 接入统一收敛（client/DESIGN D10：poco[netssl]；D17：CMake+vcpkg+POCO 单一实现栈）。
// 演进记录见 CouplingRecord [yunzone-infer] 20260907 P0 sidecar 落地条目。

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
// 防 windows 头链 min/max 宏污染（下游 Tensor/TensorData 的 std::min/std::max 调用）
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
using socket_t = SOCKET;
static constexpr socket_t kInvalidSocket = INVALID_SOCKET;
static inline void closeSocket(socket_t s) { closesocket(s); }
static inline std::string lastSocketError() { return "WSAError " + std::to_string(WSAGetLastError()); }
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using socket_t = int;
static constexpr socket_t kInvalidSocket = -1;
static inline void closeSocket(socket_t s) { ::close(s); }
static inline std::string lastSocketError() { return std::string(std::strerror(errno)); }
#endif

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace infer_sidecar::http {

// Windows 套接字库一次性启动
inline void ensureSocketInit() {
#ifdef _WIN32
    static const bool inited = [] {
        WSADATA data{};
        return WSAStartup(MAKEWORD(2, 2), &data) == 0;
    }();
    (void)inited;
#endif
}

struct Request {
    std::string method;
    std::string target;  // 已剥离 query
    std::map<std::string, std::string> headers;  // 键统一小写
    std::string body;
};

struct Response {
    int status = 200;
    std::string contentType = "application/json";
    std::string body;
};

using Handler = std::function<Response(const Request&)>;

inline const char* reasonFor(int status) {
    switch (status) {
        case 200: return "OK";
        case 201: return "Created";
        case 202: return "Accepted";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 404: return "Not Found";
        case 409: return "Conflict";
        case 500: return "Internal Server Error";
        case 502: return "Bad Gateway";
        default: return "Error";
    }
}

// 大小写不敏感头部检索（键须为小写）
inline const std::string* header(const Request& req, const std::string& lowerName) {
    const auto it = req.headers.find(lowerName);
    return it == req.headers.end() ? nullptr : &it->second;
}

inline std::string jsonEscape(const std::string& raw) {
    std::string out;
    out.reserve(raw.size() + 8);
    for (const char c : raw) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    out += "\\u00";
                    static const char* hex = "0123456789abcdef";
                    out += hex[(c >> 4) & 0xF];
                    out += hex[c & 0xF];
                } else {
                    out += c;
                }
        }
    }
    return out;
}

// ── 服务端（accept 循环线程 + 每连接一线程；loopback 低并发，P0 足够）────────
class Server {
public:
    explicit Server(Handler handler) : handler_(std::move(handler)) {}
    ~Server() { stop(); }

    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    bool start(const std::string& host, uint16_t port, std::string& err) {
        ensureSocketInit();
        const socket_t fd = ::socket(AF_INET, SOCK_STREAM, 0);
        if (fd == kInvalidSocket) {
            err = "socket(): " + lastSocketError();
            return false;
        }
        int reuse = 1;
        ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);
        if (::inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1) {
            err = "inet_pton() invalid host: " + host;
            closeSocket(fd);
            return false;
        }
        if (::bind(fd, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) != 0) {
            err = "bind() " + host + ":" + std::to_string(port) + ": " + lastSocketError();
            closeSocket(fd);
            return false;
        }
        if (::listen(fd, 16) != 0) {
            err = "listen(): " + lastSocketError();
            closeSocket(fd);
            return false;
        }
        listenFd_ = fd;
        // 回读实际绑定端口（支持 port=0 → OS 分配；控制面据此发现 sidecar 端口，
        // 对应 .env.example SIDECAR_PORT=0 语义）
        sockaddr_in bound{};
        socklen_t boundLen = sizeof(bound);
        if (::getsockname(fd, reinterpret_cast<sockaddr*>(&bound), &boundLen) == 0) {
            boundPort_ = ntohs(bound.sin_port);
        }
        running_ = true;
        acceptThread_ = std::thread([this] { acceptLoop(); });
        return true;
    }

    // 实际绑定端口（start 成功后有效；port=0 时为 OS 分配值）
    uint16_t port() const { return boundPort_; }

    void stop() {
        if (!running_.exchange(false)) return;
        if (listenFd_ != kInvalidSocket) {
            closeSocket(listenFd_);
            listenFd_ = kInvalidSocket;
        }
        if (acceptThread_.joinable()) acceptThread_.join();
    }

private:
    void acceptLoop() {
        while (running_) {
            const socket_t conn = ::accept(listenFd_, nullptr, nullptr);
            if (conn == kInvalidSocket) {
                if (!running_) return;  // stop() 已关闭监听 fd
                continue;
            }
            std::thread([this, conn] { serveConnection(conn); }).detach();
        }
    }

    void serveConnection(const socket_t conn) {
        Request req;
        Response res;
        if (!readRequest(conn, req)) {
            res = Response{400, "application/json",
                           "{\"version\":1,\"ok\":false,\"errorCode\":\"E_INTERNAL\","
                           "\"message\":\"malformed HTTP request\"}"};
        } else {
            res = safeHandle(req);
        }
        const std::string wire = "HTTP/1.1 " + std::to_string(res.status) + " " + reasonFor(res.status) +
                                 "\r\nContent-Type: " + res.contentType +
                                 "\r\nContent-Length: " + std::to_string(res.body.size()) +
                                 "\r\nConnection: close\r\n\r\n" + res.body;
        sendAll(conn, wire.data(), wire.size());
        closeSocket(conn);
    }

    Response safeHandle(const Request& req) {
        try {
            return handler_(req);
        } catch (const std::exception& e) {
            return Response{500, "application/json",
                            "{\"version\":1,\"ok\":false,\"errorCode\":\"E_INTERNAL\",\"message\":\"" +
                                jsonEscape(e.what()) + "\"}"};
        }
    }

    void sendAll(const socket_t conn, const char* data, size_t len) const {
        size_t sent = 0;
        while (sent < len) {
            const int n = static_cast<int>(
                ::send(conn, data + sent, static_cast<int>(len - sent), 0));
            if (n <= 0) return;
            sent += static_cast<size_t>(n);
        }
    }

    // 读到 \r\n\r\n 定界头部，再按 Content-Length 补齐 body（P0 上限 64 MB）
    bool readRequest(const socket_t conn, Request& req) const {
        constexpr size_t kMaxHeaderBytes = 64 * 1024;
        constexpr size_t kMaxBodyBytes = 64ull * 1024 * 1024;
        std::string buf;
        char chunk[8192];
        size_t headerEnd = std::string::npos;
        while (buf.size() < kMaxHeaderBytes) {
            const int n = ::recv(conn, chunk, sizeof(chunk), 0);
            if (n <= 0) return false;
            buf.append(chunk, static_cast<size_t>(n));
            headerEnd = buf.find("\r\n\r\n");
            if (headerEnd != std::string::npos) break;
        }
        if (headerEnd == std::string::npos) return false;

        // 请求行：METHOD SP TARGET SP VERSION
        const size_t lineEnd = buf.find("\r\n");
        const std::string requestLine = buf.substr(0, lineEnd);
        const size_t sp1 = requestLine.find(' ');
        const size_t sp2 = requestLine.find(' ', sp1 + 1);
        if (sp1 == std::string::npos || sp2 == std::string::npos) return false;
        req.method = requestLine.substr(0, sp1);
        req.target = requestLine.substr(sp1 + 1, sp2 - sp1 - 1);
        const size_t query = req.target.find('?');
        if (query != std::string::npos) req.target.resize(query);

        // 头部（键小写化）
        size_t pos = lineEnd + 2;
        size_t contentLength = 0;
        while (pos < headerEnd) {
            const size_t eol = buf.find("\r\n", pos);
            if (eol == std::string::npos || eol > headerEnd) break;
            const std::string line = buf.substr(pos, eol - pos);
            pos = eol + 2;
            const size_t colon = line.find(':');
            if (colon == std::string::npos) continue;
            std::string key = line.substr(0, colon);
            std::string value = line.substr(colon + 1);
            for (auto& c : key) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) value.erase(0, 1);
            req.headers[key] = value;
            if (key == "content-length") {
                contentLength = static_cast<size_t>(std::strtoull(value.c_str(), nullptr, 10));
            }
        }
        if (contentLength > kMaxBodyBytes) return false;

        // body 补齐
        std::string body = buf.substr(headerEnd + 4);
        while (body.size() < contentLength) {
            const int n = ::recv(conn, chunk, sizeof(chunk), 0);
            if (n <= 0) return false;
            body.append(chunk, static_cast<size_t>(n));
        }
        req.body = std::move(body);
        return !req.method.empty() && !req.target.empty();
    }

    Handler handler_;
    socket_t listenFd_ = kInvalidSocket;
    uint16_t boundPort_ = 0;
    std::atomic<bool> running_{false};
    std::thread acceptThread_;
};

// ── 客户端（仅 http://；P0 本地替身/loopback）──────────────────────────────
struct Reply {
    bool ok = false;    // 传输层成功（连接建立 + 完整收到响应）
    int status = 0;
    std::string body;
    std::string error;  // 传输层失败原因（ok=false 时有效）
};

inline Reply request(const std::string& method, const std::string& url,
                     const std::string& body = {},
                     const std::vector<std::pair<std::string, std::string>>& headers = {}) {
    ensureSocketInit();
    Reply reply;
    if (url.rfind("http://", 0) != 0) {
        reply.error = "P0 http 客户端仅支持 http:// URL（https 预签名直传随 P1 Poco 接入）: " + url;
        return reply;
    }
    // 解析 host:port/path
    const std::string rest = url.substr(7);
    const size_t slash = rest.find('/');
    const std::string hostPort = slash == std::string::npos ? rest : rest.substr(0, slash);
    const std::string path = slash == std::string::npos ? "/" : rest.substr(slash);
    const size_t colon = hostPort.find(':');
    if (hostPort.empty()) {
        reply.error = "invalid URL: " + url;
        return reply;
    }
    const std::string host = colon == std::string::npos ? hostPort : hostPort.substr(0, colon);
    const uint16_t port = colon == std::string::npos
                              ? 80
                              : static_cast<uint16_t>(std::strtoul(hostPort.substr(colon + 1).c_str(), nullptr, 10));

    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* result = nullptr;
    if (::getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &result) != 0 || result == nullptr) {
        reply.error = "getaddrinfo() failed: " + host;
        return reply;
    }
    const socket_t fd = ::socket(result->ai_family, result->ai_socktype, result->ai_protocol);
    if (fd == kInvalidSocket) {
        ::freeaddrinfo(result);
        reply.error = "socket(): " + lastSocketError();
        return reply;
    }
    if (::connect(fd, result->ai_addr, static_cast<int>(result->ai_addrlen)) != 0) {
        ::freeaddrinfo(result);
        closeSocket(fd);
        reply.error = "connect() " + hostPort + ": " + lastSocketError();
        return reply;
    }
    ::freeaddrinfo(result);

    std::string wire = method + " " + path + " HTTP/1.1\r\nHost: " + hostPort +
                       "\r\nContent-Length: " + std::to_string(body.size()) +
                       "\r\nConnection: close\r\n";
    for (const auto& [k, v] : headers) wire += k + ": " + v + "\r\n";
    wire += "\r\n" + body;
    size_t sent = 0;
    while (sent < wire.size()) {
        const int n = static_cast<int>(::send(fd, wire.data() + sent, static_cast<int>(wire.size() - sent), 0));
        if (n <= 0) {
            closeSocket(fd);
            reply.error = "send(): " + lastSocketError();
            return reply;
        }
        sent += static_cast<size_t>(n);
    }

    // 读到对端关闭（Connection: close）
    std::string raw;
    char chunk[8192];
    while (true) {
        const int n = ::recv(fd, chunk, sizeof(chunk), 0);
        if (n <= 0) break;
        raw.append(chunk, static_cast<size_t>(n));
    }
    closeSocket(fd);

    const size_t headEnd = raw.find("\r\n\r\n");
    if (raw.rfind("HTTP/1.", 0) != 0 || headEnd == std::string::npos) {
        reply.error = "malformed HTTP response";
        return reply;
    }
    const size_t sp1 = raw.find(' ');
    reply.status = std::atoi(raw.c_str() + sp1 + 1);
    reply.body = raw.substr(headEnd + 4);
    reply.ok = true;
    return reply;
}

}  // namespace infer_sidecar::http
