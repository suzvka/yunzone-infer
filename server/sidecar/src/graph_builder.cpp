#include "graph_builder.hpp"

#include "Graph/GraphException.h"
#include "stub_model.hpp"

#include <exception>
#include <iostream>
#include <mutex>

namespace infer_sidecar {

namespace {

// 本地算子表初始化（进程级一次；run-local 与 serve 共用）
void ensureOperators() {
    static std::once_flag flag;
    std::call_once(flag, [] { registerParityOperators(); });
}

// P0 端口形态校验：Float 标量（tensorType=Float / typeSize=4 / shape 空或 [1]）
bool parseFloatScalarPort(const nlohmann::json& port, std::string& err) {
    const std::string tensorType = port.value("tensorType", "");
    const long long typeSize = port.value("typeSize", 0LL);
    bool scalarShape = true;
    if (port.contains("shape") && port["shape"].is_array()) {
        for (const auto& dim : port["shape"]) {
            if (dim.is_number_integer() && dim.get<long long>() > 1) scalarShape = false;
        }
    }
    if (tensorType != "Float" || typeSize != static_cast<long long>(sizeof(float)) || !scalarShape) {
        err = "P0 仅支持 Float 标量端口（tensorType=Float / typeSize=4 / shape=[]），got tensorType=" +
              tensorType;
        return false;
    }
    return true;
}

}  // namespace

bool buildGraph(DC::InferGraph& graph,
                const nlohmann::json& graphJson,
                const std::map<std::string, std::shared_ptr<RemotePlan>>& remotePlans,
                const std::function<void(const std::string& nodeId)>& onRemoteWaiting,
                std::string& err) {
    ensureOperators();
    auto& reg = DC::EngineRegistry::instance();

    if (!graphJson.contains("nodes") || !graphJson["nodes"].is_array()) {
        err = "graph.nodes 缺失或非数组（DCIr 格式）";
        return false;
    }

    try {
        // ── 节点物化 ────────────────────────────────────────────────────────
        for (const auto& j : graphJson["nodes"]) {
            const std::string name = j.at("name").get<std::string>();
            const std::string type = j.at("type").get<std::string>();

            const auto remoteIt = remotePlans.find(name);
            if (remoteIt != remotePlans.end()) {
                // 远程节点 → BusProxy（outputs-only；等待完成上报 + 总线拉取，D8）
                auto& plan = *remoteIt->second;
                plan.nodeId = name;
                if (!j.contains("outputs") || !j["outputs"].is_array() || j["outputs"].empty()) {
                    err = "远程节点 '" + name + "' 缺少输出端口声明";
                    return false;
                }
                if (!parseFloatScalarPort(j["outputs"][0], err)) {
                    err = "远程节点 '" + name + "'：" + err;
                    return false;
                }
                plan.outputPort = j["outputs"][0].at("name").get<std::string>();

                DC::Node::Schema schema;
                schema.outputs = {DC::Node::Port::out<float>(plan.outputPort)};
                RemotePlan* planPtr = &plan;
                auto node = reg.createNode(
                    name, std::move(schema),
                    [planPtr, onRemoteWaiting](DC::Node::RunContext& ctx) -> DC::Node::Result {
                        // ① 首次进入：登记 pendingDispatch + waitingRemote（V5 取走通道）
                        if (!planPtr->dispatchEmitted.exchange(true)) {
                            onRemoteWaiting(planPtr->nodeId);
                        }
                        // ② 阻塞等待完成上报唤醒（D8 事件驱动；占用 operator 池一线程，
                        //    P0 对拍单远程节点形态可接受）
                        try {
                            DC::Tensor t = planPtr->future.get();
                            auto copy = std::make_unique<DC::Tensor>(std::move(t));
                            ctx.output(planPtr->outputPort, DC::Value(std::move(copy)));
                            return ctx.success();
                        } catch (const std::exception& e) {
                            return ctx.failure(DC::Node::Status::ExecutionFailed,
                                               "remote node '" + planPtr->nodeId +
                                                   "' 输出拉取失败: " + e.what());
                        }
                    });
                if (!node) {
                    err = "BusProxy 节点创建失败: " + name;
                    return false;
                }
                graph.addNode(std::move(node));
                continue;
            }

            // 本地节点 → 算子表物化（schema 以注册表为权威——运行时同构，D6）
            auto node = reg.createOperator(type, name);
            if (!node) {
                err = "未知本地节点类型 '" + type + "'（P0 算子表：Add/Mul/Identity/P0StubModel）";
                return false;
            }
            graph.addNode(std::move(node));
        }

        // ── 边（P0：仅 1:1；wire 自动插入 N=1 导线连接器）──────────────────
        if (graphJson.contains("edges")) {
            for (const auto& e : graphJson["edges"]) {
                const std::string src = e.at("srcNode").get<std::string>();
                const std::string srcPort = e.at("srcPort").get<std::string>();
                const std::string dst = e.at("dstNode").get<std::string>();
                const std::string dstPort = e.at("dstPort").get<std::string>();
                if (e.contains("mode") && !e["mode"].get<std::string>().empty()) {
                    err = "P0 仅支持 1:1 边（broadcast/routing 为 P1）: " + src + "." + srcPort;
                    return false;
                }
                if (remotePlans.count(dst)) {
                    err = "P0 不支持入边到远程节点（本地→远程中转上传为 P1）: " + src + " → " + dst;
                    return false;
                }
                try {
                    graph.wire(src, srcPort, dst, dstPort);
                } catch (const DC::GraphException& ex) {
                    err = "接线失败 " + src + "." + srcPort + " → " + dst + "." + dstPort + ": " +
                          ex.what();
                    return false;
                }
            }
        }

        // ── 图级输入绑定：远程节点跳过（其输入在总线，端点自取——D20）────────
        if (graphJson.contains("inputBindings")) {
            for (const auto& b : graphJson["inputBindings"]) {
                const std::string nodeName = b.at("nodeName").get<std::string>();
                if (remotePlans.count(nodeName)) continue;
                graph.bindInput(nodeName, b.at("portName").get<std::string>());
            }
        }

        // ── 图级输出绑定（OutputZone 聚合声明）──────────────────────────────
        if (graphJson.contains("outputBindings")) {
            for (const auto& b : graphJson["outputBindings"]) {
                graph.bindOutput(b.at("nodeName").get<std::string>(),
                                 b.at("portName").get<std::string>());
            }
        }
    } catch (const DC::GraphException& ex) {
        err = std::string("图重建失败: ") + ex.what();
        return false;
    } catch (const nlohmann::json::exception& ex) {
        err = std::string("DCIr JSON 解析失败: ") + ex.what();
        return false;
    } catch (const std::exception& ex) {
        err = std::string("图重建异常: ") + ex.what();
        return false;
    }
    return true;
}

}  // namespace infer_sidecar
