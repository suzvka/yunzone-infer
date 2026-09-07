// ── HTTP(S) 客户端实现（Poco Net / NetSSL）──────────────────────────────────

#include "http_io.hpp"

#include <Poco/Net/HTTPClientSession.h>
#include <Poco/Net/HTTPRequest.h>
#include <Poco/Net/HTTPResponse.h>
#include <Poco/Net/HTTPSession.h>
#include <Poco/Net/HTTPSClientSession.h>
#include <Poco/Net/NetSSL.h>
#include <Poco/Net/SSLManager.h>
#include <Poco/StreamCopier.h>
#include <Poco/URI.h>

#include <chrono>
#include <iostream>
#include <mutex>
#include <sstream>

namespace infer_client {

namespace {

std::once_flag g_sslInit;

// receiveResponse 属 HTTPClientSession（HTTPSClientSession 继承自它），非基类 HTTPSession——模板分派
template <typename SessionT>
void receiveBody(Poco::Net::HTTPResponse& resp, SessionT& session, std::string& out) {
    std::istream& body = session.receiveResponse(resp);
    std::ostringstream ss;
    Poco::StreamCopier::copyStream(body, ss);
    out = ss.str();
}

}  // namespace

void ensureHttpInit() {
    std::call_once(g_sslInit, [] {
        try {
            Poco::Net::initializeSSL();
        } catch (...) {
            // https 不可用时 http 面照常工作（本地对拍形态）
        }
    });
}

bool httpGet(const std::string& url, std::string& out, std::string& err) {
    ensureHttpInit();
    try {
        Poco::URI uri(url);
        Poco::Net::HTTPResponse resp;
        if (uri.getScheme() == "https") {
            Poco::Net::HTTPSClientSession session(uri.getHost(), uri.getPort());
            Poco::Net::HTTPRequest req(Poco::Net::HTTPRequest::HTTP_GET, uri.getPathAndQuery(),
                                       Poco::Net::HTTPMessage::HTTP_1_1);
            session.setTimeout(Poco::Timespan(60, 0));
            session.sendRequest(req);
            receiveBody(resp, session, out);
        } else {
            Poco::Net::HTTPClientSession session(uri.getHost(), uri.getPort());
            Poco::Net::HTTPRequest req(Poco::Net::HTTPRequest::HTTP_GET, uri.getPathAndQuery(),
                                       Poco::Net::HTTPMessage::HTTP_1_1);
            session.setTimeout(Poco::Timespan(60, 0));
            session.sendRequest(req);
            receiveBody(resp, session, out);
        }
        if (resp.getStatus() / 100 != 2) {
            err = "GET " + url + " → " + std::to_string(resp.getStatus());
            return false;
        }
        return true;
    } catch (const std::exception& e) {
        err = std::string("GET ") + url + " failed: " + e.what();
        return false;
    }
}

bool httpPut(const std::string& url, const std::string& bytes, std::string& err) {
    ensureHttpInit();
    try {
        Poco::URI uri(url);
        Poco::Net::HTTPResponse resp;
        std::string respBody;  // PUT 响应体丢弃（对象存储回 201/200）
        if (uri.getScheme() == "https") {
            Poco::Net::HTTPSClientSession session(uri.getHost(), uri.getPort());
            Poco::Net::HTTPRequest req(Poco::Net::HTTPRequest::HTTP_PUT, uri.getPathAndQuery(),
                                       Poco::Net::HTTPMessage::HTTP_1_1);
            req.setContentType("application/octet-stream");
            req.setContentLength(bytes.size());
            session.setTimeout(Poco::Timespan(60, 0));
            std::ostream& body = session.sendRequest(req);
            body.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
            receiveBody(resp, session, respBody);
        } else {
            Poco::Net::HTTPClientSession session(uri.getHost(), uri.getPort());
            Poco::Net::HTTPRequest req(Poco::Net::HTTPRequest::HTTP_PUT, uri.getPathAndQuery(),
                                       Poco::Net::HTTPMessage::HTTP_1_1);
            req.setContentType("application/octet-stream");
            req.setContentLength(bytes.size());
            session.setTimeout(Poco::Timespan(60, 0));
            std::ostream& body = session.sendRequest(req);
            body.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
            receiveBody(resp, session, respBody);
        }
        if (resp.getStatus() / 100 != 2) {
            err = "PUT " + url + " → " + std::to_string(resp.getStatus());
            return false;
        }
        return true;
    } catch (const std::exception& e) {
        err = std::string("PUT ") + url + " failed: " + e.what();
        return false;
    }
}

int httpPostJson(const std::string& url, const std::string& bearer,
                 const std::string& jsonBody, std::string& respBody, std::string& err) {
    ensureHttpInit();
    try {
        Poco::URI uri(url);
        Poco::Net::HTTPRequest req(Poco::Net::HTTPRequest::HTTP_POST, uri.getPathAndQuery(),
                                   Poco::Net::HTTPMessage::HTTP_1_1);
        req.setContentType("application/json");
        req.setContentLength(jsonBody.size());
        if (!bearer.empty()) {
            req.set("Authorization", "Bearer " + bearer);
        }
        Poco::Net::HTTPResponse resp;
        if (uri.getScheme() == "https") {
            Poco::Net::HTTPSClientSession session(uri.getHost(), uri.getPort());
            session.setTimeout(Poco::Timespan(30, 0));
            std::ostream& body = session.sendRequest(req);
            body.write(jsonBody.data(), static_cast<std::streamsize>(jsonBody.size()));
            receiveBody(resp, session, respBody);
        } else {
            Poco::Net::HTTPClientSession session(uri.getHost(), uri.getPort());
            session.setTimeout(Poco::Timespan(30, 0));
            std::ostream& body = session.sendRequest(req);
            body.write(jsonBody.data(), static_cast<std::streamsize>(jsonBody.size()));
            receiveBody(resp, session, respBody);
        }
        return resp.getStatus();
    } catch (const std::exception& e) {
        err = std::string("POST ") + url + " failed: " + e.what();
        return -1;
    }
}

}  // namespace infer_client
