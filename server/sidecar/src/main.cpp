// infer-sidecar — 执行面入口（P0 最小实现：IPC 端点 + 图重建/执行/聚合）
//
// 目标职责（DESIGN §3 执行面，2026-09-07 修正后）：
//   serve      监听 loopback TCP + 随机 token 鉴权（D16）；POST /workflows 接收
//              「DCIr 序列化图 + 绑定计划」（contracts/schema/ipc，codegen 结构）→
//              图重建（远程节点 = BusProxy）→ 数据驱动执行本地节点 → 远程节点组装
//              TaskDispatch（经 GET /workflows/{id}/status 轮询被控制面取走，V7/V5）
//              → 完成通知（POST /workflows/{id}/node-completions）唤醒 + 总线拉取
//              （D8）→ 聚合产出 PUT finalOutputUri（V8，控制面仅持元数据 + URI）。
//   run-local  P0 对拍单机半边：同图全本地执行（算子表物化），逐节点输出落盘供比对。
//
// 只复用不修改 DCinfer（D13）；BUILD_DCNET=OFF（V9）；不感知生态（不消费 service-kit）。
// 无参数运行打印用法并退出（CI 冒烟语义保持 exit 0）。

#include "Graph/GraphException.h"
#include "bus_client.hpp"
#include "graph_builder.hpp"
#include "http_io.hpp"
#include "stub_model.hpp"
#include "workflow_run.hpp"

#include <nlohmann/json.hpp>

#include <atomic>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>

#include "control-channel/task-dispatch.hpp"
#include "errors/error-codes.hpp"
#include "errors/error-envelope.hpp"
#include "ipc/node-completion-notice.hpp"
#include "ipc/start-workflow-request.hpp"
#include "ipc/workflow-status-snapshot.hpp"

using namespace yunzone_infer::contracts;
namespace http = infer_sidecar::http;  // 极小 HTTP 收发（http_io.hpp）
using infer_sidecar::WorkflowRun;     // 工作流运行时（workflow_run.hpp）

namespace {

// ── 契约化 JSON 出参 ────────────────────────────────────────────────────────

http::Response jsonReply(int status, const nlohmann::json& body) {
    return http::Response{status, "application/json", body.dump()};
}

http::Response errorReply(int status, errors::ErrorCode code, const std::string& message) {
    errors::ErrorEnvelope envelope;
    envelope.version = 1;
    envelope.ok = false;
    envelope.errorCode = code;
    envelope.message = message;
    nlohmann::json j;
    to_json(j, envelope);
    return jsonReply(status, j);
}

std::string readFileOrEmpty(const std::string& path) {
    std::ifstream ifs(path, std::ios::binary);
    if (!ifs.is_open()) return {};
    std::ostringstream oss;
    oss << ifs.rdbuf();
    return oss.str();
}

constexpr std::string_view kStatusSuffix = "/status";
constexpr std::string_view kNodeCompletionsSuffix = "/node-completions";

// ── serve 模式 ──────────────────────────────────────────────────────────────

class SidecarService {
public:
    bool run(uint16_t port, const std::string& token) {
        token_ = token;
        http::Server server([this](const http::Request& req) { return handle(req); });
        std::string err;
        if (!server.start("127.0.0.1", port, err)) {
            std::cerr << "[infer-sidecar] 启动失败: " << err << std::endl;
            return false;
        }
        // 控制面 supervisor 据此行回读实际端口（SIDECAR_PORT=0 → OS 分配）
        std::cerr << "[infer-sidecar] listening on 127.0.0.1:" << server.port()
                  << " (D16 loopback + token)" << std::endl;
        for (;;) std::this_thread::sleep_for(std::chrono::hours(1));
    }

private:
    http::Response handle(const http::Request& req) {
        // D16：每次启动随机 token；不匹配回 E_IPC_UNAUTHORIZED
        const auto* gotToken = http::header(req, "x-ipc-token");
        if (gotToken == nullptr || *gotToken != token_) {
            return errorReply(401, errors::ErrorCode::E_IPC_UNAUTHORIZED,
                              "x-ipc-token mismatch (D16)");
        }

        if (req.method == "GET" && req.target == "/status") {
            return handleLiveness();
        }
        if (req.method == "POST" && req.target == "/workflows") {
            return handleStartWorkflow(req.body);
        }
        if (req.method == "GET" && req.target.rfind("/workflows/", 0) == 0 &&
            req.target.size() > kStatusSuffix.size() &&
            req.target.substr(req.target.size() - kStatusSuffix.size()) == kStatusSuffix) {
            return handleStatus(req.target);
        }
        if (req.method == "POST" && req.target.rfind("/workflows/", 0) == 0 &&
            req.target.find(kNodeCompletionsSuffix) != std::string::npos) {
            return handleNodeCompletion(req.target, req.body);
        }
        return errorReply(404, errors::ErrorCode::E_INTERNAL,
                          "no such IPC endpoint: " + req.method + " " + req.target);
    }

    // GET /status：V7 探活聚合（P0 IPC 内部面：workflowId + 状态列表；未入 contracts，
    // 正式 /storage·WS 面落地时一并收口）
    http::Response handleLiveness() const {
        nlohmann::json workflows = nlohmann::json::array();
        {
            std::lock_guard lk(runsMu_);
            for (const auto& [id, run] : runs_) {
                workflows.push_back({{"workflowId", id},
                                     {"status",
                                      ipc::toString(run->snapshot().status)}});
            }
        }
        return jsonReply(200, {{"version", 1}, {"ok", true}, {"workflows", workflows}});
    }

    http::Response handleStartWorkflow(const std::string& body) {
        ipc::StartWorkflowRequest request;
        try {
            auto parsed = nlohmann::json::parse(body);
            from_json(parsed, request);
        } catch (const nlohmann::json::exception& e) {
            return errorReply(400, errors::ErrorCode::E_INTERNAL,
                              std::string("malformed StartWorkflowRequest: ") + e.what());
        }

        std::unique_ptr<WorkflowRun> run;
        {
            std::lock_guard lk(runsMu_);
            if (runs_.count(request.workflowId)) {
                return errorReply(409, errors::ErrorCode::E_INTERNAL,
                                  "workflow '" + request.workflowId + "' already exists");
            }
            std::string buildErr;
            run = WorkflowRun::create(std::move(request), buildErr);
            if (!run) {
                return errorReply(400, errors::ErrorCode::E_IPC_INVALID_GRAPH, buildErr);
            }
            WorkflowRun* started = run.get();
            runs_[started->workflowId()] = std::move(run);
            started->start();  // 在册后启动：避免提交与快照的注册窗口竞争
        }
        return jsonReply(201, {{"version", 1}, {"ok", true}});
    }

    http::Response handleStatus(const std::string& target) const {
        // /workflows/{id}/status
        const std::string prefix = "/workflows/";
        const size_t start = prefix.size();
        const size_t end = target.rfind("/status");
        const std::string workflowId = target.substr(start, end - start);
        std::lock_guard lk(runsMu_);
        const auto it = runs_.find(workflowId);
        if (it == runs_.end()) {
            return errorReply(404, errors::ErrorCode::E_IPC_WORKFLOW_UNKNOWN,
                              "sidecar has no workflow '" + workflowId + "'");
        }
        nlohmann::json j;
        to_json(j, it->second->snapshot());
        return jsonReply(200, j);
    }

    http::Response handleNodeCompletion(const std::string& target, const std::string& body) {
        const std::string prefix = "/workflows/";
        const size_t start = prefix.size();
        const size_t end = target.find("/node-completions");
        const std::string workflowId = target.substr(start, end - start);

        ipc::NodeCompletionNotice notice;
        try {
            auto parsed = nlohmann::json::parse(body);
            from_json(parsed, notice);
        } catch (const nlohmann::json::exception& e) {
            return errorReply(400, errors::ErrorCode::E_INTERNAL,
                              std::string("malformed NodeCompletionNotice: ") + e.what());
        }
        if (notice.workflowId != workflowId) {
            return errorReply(400, errors::ErrorCode::E_IPC_WORKFLOW_UNKNOWN,
                              "notice.workflowId mismatch: " + notice.workflowId + " != " + workflowId);
        }

        std::lock_guard lk(runsMu_);
        const auto it = runs_.find(workflowId);
        if (it == runs_.end()) {
            return errorReply(404, errors::ErrorCode::E_IPC_WORKFLOW_UNKNOWN,
                              "sidecar has no workflow '" + workflowId + "'");
        }
        bool accepted = false;
        std::string err;
        if (!it->second->completeNode(notice, accepted, err)) {
            return errorReply(400, errors::ErrorCode::E_INTERNAL, err);
        }
        return jsonReply(202, {{"version", 1}, {"ok", true}, {"accepted", accepted}});
    }

    mutable std::mutex runsMu_;
    std::map<std::string, std::unique_ptr<WorkflowRun>> runs_;
    std::string token_;
};

int runServe(int argc, char** argv) {
    uint16_t port = 43110;
    std::string token;
    for (int i = 2; i + 1 < argc; i += 2) {
        const std::string key = argv[i];
        const std::string value = argv[i + 1];
        if (key == "--port") {
            port = static_cast<uint16_t>(std::strtoul(value.c_str(), nullptr, 10));
        } else if (key == "--token") {
            token = value;
        }
    }
    if (token.empty()) {
        // D16：每次启动随机 token（测试/本地缺省注入 env SIDECAR_TOKEN 或随机）
        const char* envToken = std::getenv("SIDECAR_TOKEN");
        if (envToken != nullptr) {
            token = envToken;
        } else {
            std::srand(static_cast<unsigned>(std::time(nullptr)));
            for (int i = 0; i < 32; ++i) token += "0123456789abcdef"[std::rand() % 16];
        }
    }
    SidecarService service;
    return service.run(port, token) ? 0 : 2;
}

// ── run-local 模式（P0 对拍单机半边）───────────────────────────────────────

int runLocal(int argc, char** argv) {
    std::string graphPath;
    std::string feedPath;
    std::string outPath;
    for (int i = 2; i + 1 < argc; i += 2) {
        const std::string key = argv[i];
        const std::string value = argv[i + 1];
        if (key == "--graph") graphPath = value;
        else if (key == "--feed") feedPath = value;
        else if (key == "--out") outPath = value;
    }
    if (graphPath.empty() || outPath.empty()) {
        std::cerr << "run-local 需要 --graph <dcir.json> --out <results.json> [--feed feed.json]"
                  << std::endl;
        return 2;
    }

    const std::string graphText = readFileOrEmpty(graphPath);
    if (graphText.empty()) {
        std::cerr << "无法读取图文件: " << graphPath << std::endl;
        return 2;
    }
    nlohmann::json graphJson;
    try {
        graphJson = nlohmann::json::parse(graphText);
    } catch (const nlohmann::json::exception& e) {
        std::cerr << "图 JSON 解析失败: " << e.what() << std::endl;
        return 2;
    }

    auto graph = std::make_unique<DC::InferGraph>();
    static const std::map<std::string, std::shared_ptr<infer_sidecar::RemotePlan>> kNoRemote;
    std::string buildErr;
    if (!infer_sidecar::buildGraph(*graph, graphJson, kNoRemote, {}, buildErr)) {
        std::cerr << "图重建失败: " << buildErr << std::endl;
        return 2;
    }

    const DC::Node::TaskId taskId = "local";
    // 图级输入注入（feed.json：{"node.port": number}，Float 标量）
    if (!feedPath.empty()) {
        const std::string feedText = readFileOrEmpty(feedPath);
        nlohmann::json feed;
        try {
            feed = nlohmann::json::parse(feedText.empty() ? "{}" : feedText);
        } catch (const nlohmann::json::exception& e) {
            std::cerr << "feed JSON 解析失败: " << e.what() << std::endl;
            return 2;
        }
        for (const auto& b : graph->inputBindings()) {
            const std::string key = b.nodeName + "." + b.portName;
            if (!feed.contains(key)) {
                std::cerr << "feed 缺少图级输入: " << key << std::endl;
                return 2;
            }
            graph->feedInput(taskId, b.nodeName, b.portName,
                             infer_sidecar::scalarTensor(feed[key].get<float>()));
        }
    }

    // 逐节点输出快照（对拍逐节点比对载体）：在完成回调里 peekOutput 非消费式取值 ——
    // 任务完成后的传播阶段会搬空节点缓冲（OutputZone 搬运 + 边搬运），事后收集为空
    std::mutex outMu;
    std::map<std::string, std::map<std::string, float>> nodeOutputs;
    for (const auto& name : graph->nodeNames()) {
        auto* node = graph->node(name);
        if (!node || node->isConnector()) continue;
        node->setCompletionCallback(
            [&outMu, &nodeOutputs, node, &taskId, name](const DC::Node::TaskId&,
                                                        const DC::Node::Result& result) {
                if (!result.ok()) return;
                std::lock_guard lk(outMu);
                for (const auto& port : node->schema().outputs) {
                    const auto& v = node->peekOutput(taskId, port.name);
                    if (!v) continue;
                    const auto* t = v.as<DC::Tensor>();
                    if (t) nodeOutputs[name][port.name] = t->item<float>();
                }
            });
    }

    std::vector<DC::OutputDeclaration> declarations;
    for (const auto& b : graph->outputBindings()) {
        declarations.push_back({b.nodeName, b.portName, 1});
    }
    graph->submit(taskId, std::move(declarations), std::chrono::milliseconds(0));
    if (!graph->wait(taskId, std::chrono::milliseconds(120000))) {
        std::cerr << "图执行超时或失败（taskErrors=" << graph->taskErrors(taskId).size()
                  << " 条）" << std::endl;
        for (const auto& e : graph->taskErrors(taskId)) {
            std::cerr << "  - " << e.nodeName << ": " << e.message << std::endl;
        }
        return 2;
    }

    nlohmann::json outNodes = nlohmann::json::object();
    {
        std::lock_guard lk(outMu);
        for (const auto& [name, ports] : nodeOutputs) {
            for (const auto& [port, value] : ports) {
                outNodes[name][port] = value;
            }
        }
    }
    std::ofstream ofs(outPath, std::ios::binary);
    if (!ofs.is_open()) {
        std::cerr << "无法写出结果文件: " << outPath << std::endl;
        return 2;
    }
    ofs << nlohmann::json{{"nodes", outNodes}}.dump(2);
    return 0;
}

void printUsage() {
    std::cerr
        << "infer-sidecar — yunzone-infer 执行面（DESIGN §3 / D2/D16）\n"
        << "用法:\n"
        << "  infer-sidecar serve --port <n> --token <hex>      # IPC 执行面（D16）\n"
        << "  infer-sidecar run-local --graph <dcir.json> --feed <f.json> --out <r.json>\n"
        << "                                                    # P0 对拍单机半边\n"
        << "无参数运行打印本说明（骨架冒烟语义）。\n";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        printUsage();
        return 0;
    }
    const std::string mode = argv[1];
    if (mode == "serve") return runServe(argc, argv);
    if (mode == "run-local") return runLocal(argc, argv);
    printUsage();
    return argc == 1 ? 0 : 2;
}
