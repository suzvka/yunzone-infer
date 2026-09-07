#pragma once
// ── HTTP(S) 客户端（Poco：控制通道 REST + 数据面总线 GET/PUT）────────────────
//
// - scheme 分派：http → HTTPClientSession；https → HTTPSClientSession（poco[netssl]，
//   预签名 URL 天然 HTTPS，V8；本地 MinIO 对拍走 http）；
// - hash 校验（client/DESIGN「下载输入 + hash 校验」）：contracts TaskDispatch 暂无
//   hash 载体字段，P1 以 content-length + float32 形态校验替代，契约增补后补真校验；
// - 进程级 OpenSSL 初始化（Poco::Net::initializeSSL）由 ensureHttpInit 保证一次。

#include <string>

namespace infer_client {

/// 全局初始化（幂等）：https 支持所需（Poco NetSSL + OpenSSL）
void ensureHttpInit();

/// 总线 GET：下载张量字节（预签名 URL / 替身直链）；失败 false + err
bool httpGet(const std::string& url, std::string& out, std::string& err);

/// 总线 PUT：上传张量字节（application/octet-stream）；非 2xx 失败 + err
bool httpPut(const std::string& url, const std::string& bytes, std::string& err);

/// 控制通道 REST POST（JSON + Bearer 机器凭证）；返回 HTTP 状态码，失败 -1 + err
int httpPostJson(const std::string& url, const std::string& bearer,
                 const std::string& jsonBody, std::string& respBody, std::string& err);

}  // namespace infer_client
