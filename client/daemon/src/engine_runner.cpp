// ── 本地执行编排层实现（InferGraph 单节点驱动，D10 修订）────────────────────

#include "engine_runner.hpp"

#include "stub_model.hpp"

#include "Graph/GraphException.h"
#include "Node/Node.h"
#include "Tensor/TensorMeta.h"

#include <future>
#include <mutex>
#include <nlohmann/json.hpp>
#include <utility>

namespace infer_client {

using nlohmann::json;

bool EngineRunner::build(const std::vector<ModelConfig>& models, std::string& err) {
    registerClientOperators();
    auto& reg = DC::EngineRegistry::instance();

    for (const auto& m : models) {
        auto mg = std::make_unique<ModelGraph>();
        mg->modelKey = m.modelKey;
        mg->engineType = m.engineType;
        mg->nodeName = "model:" + m.modelKey;

        auto node = reg.createOperator(m.engineType, mg->nodeName);
        if (!node) {
            err = "未知引擎类型 '" + m.engineType + "'（模型 " + m.modelKey + "）";
            return false;
        }

        // Schema 直出端口（D6 运行时同构：声明即执行面，漂移归零）
        const auto& schema = node->schema();
        if (schema.inputs.empty() || schema.outputs.empty()) {
            err = "引擎 '" + m.engineType + "' Schema 无输入/输出端口（模型 " + m.modelKey + "）";
            return false;
        }
        mg->inputPort = schema.inputs.front().name;
        mg->outputPort = schema.outputs.front().name;

        // 单节点图 + 图级绑定（任务直通该节点；V10 ORT 适配器同路径）
        mg->graph = std::make_unique<DC::InferGraph>();
        mg->graph->addNode(std::move(node));
        try {
            mg->graph->bindInput(mg->nodeName, mg->inputPort);
            mg->graph->bindOutput(mg->nodeName, mg->outputPort);
        } catch (const DC::GraphException& ex) {
            err = "模型 " + m.modelKey + " 图绑定失败: " + ex.what();
            return false;
        }
        mg->node = mg->graph->node(mg->nodeName);
        if (!mg->node) {
            err = "模型 " + m.modelKey + " 节点物化失败";
            return false;
        }
        graphs_.push_back(std::move(mg));
    }
    return true;
}

nlohmann::json EngineRunner::capabilityModels(const std::map<std::string, int>& queueRemaining) const {
    // capability 域 ModelQueueEntry[]：io = Schema 端口直出（P1 Float 标量口径见头注释）
    // 注：NodePort 为 DC 顶层类型（Node.h「提取为顶层类型的 Node 嵌套类型」）
    json models = json::array();
    for (const auto& mg : graphs_) {
        const auto& schema = mg->node->schema();
        auto portJson = [](const DC::NodePort& p) {
            return json{
                {"name", p.name},
                {"tensorType", DC::TensorMeta::typeToString(p.type)},
                {"typeSize", p.typeSize},
                {"shape", p.shape},
                {"required", p.required},
            };
        };
        json inputs = json::array();
        for (const auto& p : schema.inputs) inputs.push_back(portJson(p));
        json outputs = json::array();
        for (const auto& p : schema.outputs) outputs.push_back(portJson(p));

        int remaining = 0;
        if (const auto it = queueRemaining.find(mg->modelKey); it != queueRemaining.end()) {
            remaining = it->second;
        }
        models.push_back(json{
            {"modelKey", mg->modelKey},
            {"queueRemaining", remaining},
            {"io", json{{"inputs", inputs}, {"outputs", outputs}}},
        });
    }
    return models;
}

bool EngineRunner::hasModel(const std::string& modelKey) const {
    return find(modelKey) != nullptr;
}

EngineRunner::ModelGraph* EngineRunner::find(const std::string& modelKey) {
    for (auto& mg : graphs_) {
        if (mg->modelKey == modelKey) return mg.get();
    }
    return nullptr;
}

const EngineRunner::ModelGraph* EngineRunner::find(const std::string& modelKey) const {
    for (const auto& mg : graphs_) {
        if (mg->modelKey == modelKey) return mg.get();
    }
    return nullptr;
}

bool EngineRunner::runTask(const QueuedTask& task, float inputValue, float& outputValue,
                           std::string& err) {
    ModelGraph* mg = find(task.modelKey);
    if (!mg) {
        err = "未持有模型图: " + task.modelKey;
        return false;
    }

    // 节点完成回调 → Result 捕获 + promise 唤醒（submit 异步，timeout=0 无任务级超时 D7）
    std::promise<void> done;
    auto future = done.get_future();
    bool execOk = false;
    std::string execMsg;
    std::mutex cbMu;
    mg->node->setCompletionCallback(
        [&done, &execOk, &execMsg, &cbMu](const DC::Node::TaskId&, const DC::Node::Result& result) {
            std::lock_guard lk(cbMu);
            execOk = result.ok();
            execMsg = result.message;
            done.set_value();
        });

    const DC::Node::TaskId taskId = task.taskId;
    try {
        mg->graph->feedInput(taskId, mg->nodeName, mg->inputPort, scalarTensor(inputValue));
        std::vector<DC::OutputDeclaration> declarations;
        for (const auto& b : mg->graph->outputBindings()) {
            declarations.push_back({b.nodeName, b.portName, 1});
        }
        mg->graph->submit(taskId, std::move(declarations), std::chrono::milliseconds(0));
    } catch (const std::exception& e) {
        err = std::string("任务提交失败: ") + e.what();
        return false;
    }

    future.wait();
    {
        std::lock_guard lk(cbMu);
        if (!execOk) {
            err = "引擎执行失败: " + execMsg;
            return false;
        }
    }

    try {
        outputValue = mg->graph->getOutputTensor(taskId, mg->nodeName, mg->outputPort).item<float>();
    } catch (const std::exception& e) {
        err = std::string("输出读取失败: ") + e.what();
        return false;
    }
    // Node 级任务态回收（任务键 = server taskId 全局唯一；probe 实证面）
    mg->node->clearTask(taskId);
    return true;
}

}  // namespace infer_client
