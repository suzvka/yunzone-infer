#pragma once
// ── 执行面图重建：DCIr 序列化图 JSON → InferGraph（D3 契约载体）─────────────
//
// 为什么不直接用 DCIr::GraphCompiler::compileString：其对算子 / 未注册类型仅创建
// 骨架节点（RunFn = nullptr，执行必败——GraphCompiler.h 头注释「反序列化时 RunFn
// 由上层注册」即此意，P0 勘察实证）。执行面据此在本层物化可执行节点：只消费
// DCinfer 公开面（EngineRegistry / InferGraph / Node）与 DCIr JSON 格式
//（见 DCIr/src/GraphCompiler.cpp），不动基础工程本体（D13）。
//
//   本地节点 → 算子表物化（DCinfer Builtin Add/Mul/Identity + 对拍 P0StubModel）
//   远程节点 → BusProxy：outputs-only 节点，RunFn 阻塞等待「完成上报 → 总线拉取」
//              唤醒（D8 事件驱动；P0 对拍形态）
//
// P0 限制（超界回 E_IPC_INVALID_GRAPH，随 P1 扩展）：
//   - 仅 1:1 边（broadcast/routing 不支持）
//   - 远程节点无入边（本地→远程中转上传为 P1）、单输出且为 Float 标量
//   - 图级输出绑定 ≤ 1（工作流最终输出单上传目标，V8）

#include "Graph/InferGraph.h"
#include "control-channel/task-dispatch.hpp"
#include "ipc/start-workflow-request.hpp"

#include <atomic>
#include <functional>
#include <future>
#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

namespace infer_sidecar {

// 远程节点等待态：BusProxy 与 WorkflowRun 的共享面（promise 由完成通知侧 resolve）
struct RemotePlan {
    std::string nodeId;
    std::string modelKey;
    std::string outputUri;   // 对象键（回填 TaskDispatch.outputUri；签名 URL 由控制面替换）
    std::string inputUri;    // P0 单输入对象键（TaskDispatch.inputUri 唯一来源）
    std::string outputPort;  // BusProxy 输出端口名（与图 JSON 声明一致）
    std::promise<DC::Tensor> tensor;
    std::shared_future<DC::Tensor> future = tensor.get_future();
    std::atomic<bool> dispatchEmitted{false};
};

// remotePlans：nodeId → plan（serve 模式来自 bindingPlan；run-local 传空表 = 全本地）。
// onRemoteWaiting：BusProxy 就绪开始等待时回调（工作流登记 pendingDispatch + waitingRemote）。
// 返回 false 时 err 携带原因（serve 层映射 E_IPC_INVALID_GRAPH）。
bool buildGraph(DC::InferGraph& graph,
                const nlohmann::json& graphJson,
                const std::map<std::string, std::shared_ptr<RemotePlan>>& remotePlans,
                const std::function<void(const std::string& nodeId)>& onRemoteWaiting,
                std::string& err);

}  // namespace infer_sidecar
