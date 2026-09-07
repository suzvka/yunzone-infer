#pragma once
// ── 本地执行编排层（D10 修订：InferGraph 单节点驱动）─────────────────────────
//
// 每可服务模型 → 一张单节点 InferGraph（模型 = 图内一个引擎节点；端点 = 模型图
// 集合）。P1 简化决策：D10 修订的「端点内多模型本地连线（前处理→模型→后处理）」
// 演进为单模型独立图（任务直通目标节点，outputBindings 绑该节点输出）——
// 「单节点驱动」语义不变，多节点连线待端点封装意图落地（client/DESIGN §1）。
//
// 任务驱动（对齐 sidecar submit 形态，timeout=0 无任务级超时，D7）：
//   feedInput(taskId, node, port, tensor) → submit(taskId, declarations, 0ms)
//   → 节点完成回调（Result 捕获）→ getOutputTensor → clearTask（Node 级任务态回收，
//   probe 实证面）。
//
// 能力声明直出（D6 运行时同构）：图构建后 node->schema() 端口名直出 io；P1 口径
// 为 Float 标量（tensorType=Float / typeSize=4 / shape=[]，与 sidecar 检视口径
// parseFloatScalarPort 一致），真实 shape 直出待 V10 ORT 适配器就绪后收口。

#include "daemon_config.hpp"
#include "task_queue.hpp"

#include "Graph/InferGraph.h"

#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace infer_client {

class EngineRunner {
public:
    /// 注册算子表 + 逐模型建图；失败 false + err（引擎类型未注册等）
    bool build(const std::vector<ModelConfig>& models, std::string& err);

    /// capability.models[] JSON（modelKey + queueRemaining + io 直出；vramFreeBytes 上层补）
    /// 注：直接产出 nlohmann json（心跳/注册请求体复用）
    nlohmann::json capabilityModels(const std::map<std::string, int>& queueRemaining) const;

    /// 是否持有该模型图
    bool hasModel(const std::string& modelKey) const;

    /// 执行单任务（同步）：Float 标量输入 → 引擎前向 → Float 标量输出
    /// 失败 false + err（映射完成上报 errorCode=E_INFER_FAILED，语义由 sidecar 消费为图级失败）
    bool runTask(const QueuedTask& task, float inputValue, float& outputValue, std::string& err);

private:
    struct ModelGraph {
        std::string modelKey;
        std::string engineType;
        std::string nodeName;
        std::string inputPort;
        std::string outputPort;
        std::unique_ptr<DC::InferGraph> graph;
        DC::Node* node = nullptr;
    };

    ModelGraph* find(const std::string& modelKey);
    const ModelGraph* find(const std::string& modelKey) const;

    std::vector<std::unique_ptr<ModelGraph>> graphs_;
};

}  // namespace infer_client
