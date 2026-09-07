#include "workflow_run.hpp"

#include "Graph/GraphException.h"
#include "bus_client.hpp"
#include "stub_model.hpp"

#include <chrono>
#include <exception>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace infer_sidecar {

namespace {

std::int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

}  // namespace

std::unique_ptr<WorkflowRun> WorkflowRun::create(
    yunzone_infer::contracts::ipc::StartWorkflowRequest request, std::string& err) {
    auto run = std::unique_ptr<WorkflowRun>(new WorkflowRun());
    run->request_ = std::move(request);
    run->graph_ = std::make_unique<DC::InferGraph>();

    // 绑定计划 → RemotePlan（P0：单输入对象键必填；多输入为 P1 扩展）
    for (const auto& binding : run->request_.bindingPlan.remoteNodes) {
        auto plan = std::make_shared<RemotePlan>();
        plan->modelKey = binding.modelKey;
        plan->outputUri = binding.outputUri;
        if (!binding.inputs.has_value() || binding.inputs->empty()) {
            err = "远程节点 '" + binding.nodeId + "' 缺 inputs（P0 必填：TaskDispatch.inputUri 唯一来源）";
            return nullptr;
        }
        if (binding.inputs->size() > 1) {
            err = "远程节点 '" + binding.nodeId + "' inputs 超过 1 项（TaskDispatch.inputUri 单值，P1 扩展）";
            return nullptr;
        }
        plan->inputUri = (*binding.inputs)[0].uri;
        run->remotePlans_[binding.nodeId] = std::move(plan);
    }

    if (run->request_.finalOutputUri.has_value()) {
        run->finalUploadUrl_ = *run->request_.finalOutputUri;
        run->hasFinalUpload_ = true;
    }

    // 图重建（远程节点 → BusProxy；onRemoteWaiting 挂接工作流状态机）
    WorkflowRun* runPtr = run.get();
    std::string buildErr;
    if (!buildGraph(*run->graph_, run->request_.graph, run->remotePlans_,
                    [runPtr](const std::string& nodeId) { runPtr->onRemoteWaiting(nodeId); },
                    buildErr)) {
        err = buildErr;
        return nullptr;
    }

    // 节点级完成回调（非连接器）→ nodeStates 跟踪
    for (const auto& name : run->graph_->nodeNames()) {
        auto* node = run->graph_->node(name);
        if (!node || node->isConnector()) continue;
        node->setCompletionCallback(
            [runPtr, name](const DC::Node::TaskId&, const DC::Node::Result& result) {
                {
                    std::lock_guard lk(runPtr->mu_);
                    runPtr->nodeStates_[name] =
                        result.ok() ? yunzone_infer::contracts::ipc::NodeExecutionState::completed
                                    : yunzone_infer::contracts::ipc::NodeExecutionState::failed;
                }
                // 执行期失败出口（两层防线的动态半边，contracts/DESIGN §3）：DCinfer 的
                // ErrorTracker 只记录不终结（timeout=0 无 watchdog），本地节点失败后下游
                // 永不就绪、图将悬挂 executing——由本回调显式终结为图级 failed。
                if (!result.ok() && !runPtr->finalized_.load()) {
                    runPtr->fail(yunzone_infer::contracts::errors::ErrorCode::E_INFER_FAILED,
                                 "节点 '" + name + "' 执行失败: " + result.message);
                }
            });
    }

    // 图级任务完成回调 → 聚合回收 + 最终输出上传（V8）
    run->graph_->setTaskCompleteCallback(
        [runPtr](const DC::Node::TaskId&) { runPtr->onTaskComplete(); });

    // 初始节点状态全 pending
    for (const auto& name : run->graph_->nodeNames()) {
        auto* node = run->graph_->node(name);
        if (!node || node->isConnector()) continue;
        run->nodeStates_[name] = yunzone_infer::contracts::ipc::NodeExecutionState::pending;
    }
    return run;
}

void WorkflowRun::start() {
    const DC::Node::TaskId taskId = request_.workflowId;

    // ① 图级输入取值（workflowInputs，URL 语义）：指向本地节点的输入在提交前拉取注入。
    //    DCIr 只声明 inputBindings 不携带值；缺失的输入将令下游节点永不就绪（TaskBuffer
    //    以任务记录存在为就绪前提，且必选端口必须有值）。
    for (const auto& input : request_.workflowInputs.value_or(std::vector<yunzone_infer::contracts::ipc::GraphInput>{})) {
        auto* node = graph_->node(input.node);
        if (!node) {
            fail(yunzone_infer::contracts::errors::ErrorCode::E_IPC_INVALID_GRAPH,
                 "workflowInput 指向未知节点 '" + input.node + "'");
            return;
        }
        std::string bytes;
        std::string fetchErr;
        if (!busGetBytes(input.uri, bytes, fetchErr)) {
            fail(yunzone_infer::contracts::errors::ErrorCode::E_STORAGE_TRANSFER_FAILED,
                 "workflow input fetch failed: " + fetchErr);
            return;
        }
        float value = 0.0f;
        if (!scalarFromBytes(bytes, value)) {
            fail(yunzone_infer::contracts::errors::ErrorCode::E_OUTPUT_VALIDATION_FAILED,
                 "workflow input is not a float32 scalar");
            return;
        }
        try {
            graph_->feedInput(taskId, input.node, input.port, scalarTensor(value));
        } catch (const std::exception& e) {
            fail(yunzone_infer::contracts::errors::ErrorCode::E_IPC_INVALID_GRAPH,
                 std::string("workflow input 注入失败: ") + e.what());
            return;
        }
    }

    // ② 零输入 BusProxy 建任务记录（TaskBuffer::isReady 以任务存在为前提，
    //    否则 submit 的就绪扫描永远看不到它们）；RunFn 立即执行 → 登记 dispatch → 阻塞等待
    for (const auto& [nodeId, plan] : remotePlans_) {
        auto* node = graph_->node(plan->nodeId);
        if (!node) continue;
        // Value 为 move-only：空 map 逐个 move 传入（setInput 按值接管）
        std::unordered_map<std::string, DC::Node::TaskData> kick{};
        try {
            node->setInput(taskId, std::move(kick));
        } catch (const std::exception& e) {
            fail(yunzone_infer::contracts::errors::ErrorCode::E_INTERNAL,
                 std::string("BusProxy 任务记录创建失败: ") + e.what());
            return;
        }
    }

    // ③ 提交：引擎扫描就绪节点（BusProxy）→ waitingRemote → 控制面轮询取走派发（V7/V5）
    std::vector<DC::OutputDeclaration> declarations;
    for (const auto& b : graph_->outputBindings()) {
        declarations.push_back({b.nodeName, b.portName, 1});
    }
    graph_->submit(taskId, std::move(declarations),
                   std::chrono::milliseconds(0));  // timeout=0：无任务级超时（D7）
}

yunzone_infer::contracts::ipc::WorkflowStatusSnapshot WorkflowRun::snapshot() const {
    std::lock_guard lk(mu_);
    using yunzone_infer::contracts::control_channel::TaskDispatch;
    using yunzone_infer::contracts::ipc::NodeState;
    yunzone_infer::contracts::ipc::WorkflowStatusSnapshot s;
    s.version = 1;
    s.workflowId = request_.workflowId;
    s.status = status_;
    // 可选字段（schema 非必需 → codegen 生成 optional<vector>)：统一构造后整体赋值
    std::vector<NodeState> nodeStates;
    nodeStates.reserve(nodeStates_.size());
    for (const auto& [id, state] : nodeStates_) {
        nodeStates.push_back({id, state, std::nullopt});
    }
    s.nodeStates = std::move(nodeStates);
    std::vector<TaskDispatch> pending;
    pending.reserve(pending_.size());
    for (const auto& [id, dispatch] : pending_) {
        pending.push_back(dispatch);
    }
    s.pendingDispatches = std::move(pending);
    s.finalOutputUri = finalOutputUri_;
    s.errorCode = errorCode_;
    return s;
}

void WorkflowRun::onRemoteWaiting(const std::string& nodeId) {
    std::lock_guard lk(mu_);
    if (status_ == yunzone_infer::contracts::ipc::GraphExecutionStatus::starting) {
        status_ = yunzone_infer::contracts::ipc::GraphExecutionStatus::waitingRemote;
    }
    const auto& plan = *remotePlans_.at(nodeId);
    nodeStates_[nodeId] = yunzone_infer::contracts::ipc::NodeExecutionState::running;

    // TaskDispatch 组装（契约形态）：inputUri/outputUri 此刻为对象键，
    // 控制面取走后替换为签名 URL 再下发（pendingDispatches 契约描述）。
    // requestId 占位 = taskId：sidecar 不感知端点（绑定在控制面），控制面取走时
    // 覆盖为 hash(endpointId, taskId)（契约语义），requestId 幂等账本在控制面。
    yunzone_infer::contracts::control_channel::TaskDispatch d;
    d.version = 1;
    d.type = "task.dispatch";
    d.taskId = request_.workflowId + ":" + nodeId;
    d.requestId = d.taskId;
    d.workflowId = request_.workflowId;
    d.nodeId = nodeId;
    d.modelKey = plan.modelKey;
    d.inputUri = plan.inputUri;
    d.outputUri = plan.outputUri;
    d.priority = yunzone_infer::contracts::control_channel::TaskDispatchPriority::normal;
    d.dispatchedAtMs = nowMs();
    pending_[nodeId] = std::move(d);
}

bool WorkflowRun::completeNode(
    const yunzone_infer::contracts::ipc::NodeCompletionNotice& notice, bool& accepted,
    std::string& err) {
    std::shared_ptr<RemotePlan> plan;
    {
        std::lock_guard lk(mu_);
        const auto it = remotePlans_.find(notice.nodeId);
        if (it == remotePlans_.end()) {
            err = "node '" + notice.nodeId + "' 不是远程节点或不存在";
            return false;
        }
        plan = it->second;
        if (finalized_.load()) {
            accepted = false;  // 迟到的重复通知：幂等忽略
            return true;
        }
    }

    // 失败通知 → 图级节点失败（根 DESIGN §9：错误码映射，语义与本地执行对齐）
    if (notice.errorCode.has_value()) {
        std::lock_guard lk(mu_);
        nodeStates_[notice.nodeId] = yunzone_infer::contracts::ipc::NodeExecutionState::failed;
        errorCode_ = notice.errorCode;
        status_ = yunzone_infer::contracts::ipc::GraphExecutionStatus::failed;
        finalized_.store(true);
        plan->tensor.set_exception(std::make_exception_ptr(std::runtime_error(
            std::string("endpoint failure: ") +
            yunzone_infer::contracts::errors::toString(*notice.errorCode))));
        accepted = true;
        return true;
    }

    // outputUri 为 nullable optional（字段缺失 / null 皆视为失败通知）
    const bool hasUrl = notice.outputUri.has_value() && notice.outputUri->has_value();
    const std::string url = hasUrl ? **notice.outputUri : std::string();
    if (!hasUrl) {
        std::lock_guard lk(mu_);
        fail(yunzone_infer::contracts::errors::ErrorCode::E_INFER_FAILED,
             "completion notice without outputUri");
        plan->tensor.set_exception(
            std::make_exception_ptr(std::runtime_error("completion notice without outputUri")));
        accepted = true;
        return true;
    }

    // 拉取线程：GET 总线对象 → 唤醒 BusProxy（D8：执行面拉取并唤醒等待中的图节点）
    WorkflowRun* runPtr = this;
    std::thread([runPtr, plan, url] {
        std::string bytes;
        std::string fetchErr;
        if (!busGetBytes(url, bytes, fetchErr)) {
            runPtr->fail(yunzone_infer::contracts::errors::ErrorCode::E_STORAGE_TRANSFER_FAILED,
                         "remote output fetch failed: " + fetchErr);
            plan->tensor.set_exception(std::make_exception_ptr(std::runtime_error(fetchErr)));
            return;
        }
        float value = 0.0f;
        if (!scalarFromBytes(bytes, value)) {
            runPtr->fail(yunzone_infer::contracts::errors::ErrorCode::E_OUTPUT_VALIDATION_FAILED,
                         "remote output is not a float32 scalar (" + std::to_string(bytes.size()) +
                             " bytes)");
            plan->tensor.set_exception(
                std::make_exception_ptr(std::runtime_error("remote output is not a float32 scalar")));
            return;
        }
        runPtr->markExecuting();
        plan->tensor.set_value(scalarTensor(value));
    }).detach();

    accepted = true;
    return true;
}

void WorkflowRun::onTaskComplete() {
    if (finalized_.load()) return;  // failed 路径的 terminate 同样可能触发回调

    // P0：单输出绑定（最终输出单上传目标，V8）
    DC::Node::TaskId taskId = request_.workflowId;
    std::string nodeName;
    std::string portName;
    {
        const auto& bindings = graph_->outputBindings();
        if (bindings.size() != 1) {
            fail(yunzone_infer::contracts::errors::ErrorCode::E_INTERNAL,
                 "P0 限单输出绑定，got " + std::to_string(bindings.size()));
            return;
        }
        nodeName = bindings[0].nodeName;
        portName = bindings[0].portName;
    }
    DC::Tensor out;
    try {
        out = graph_->getOutputTensor(taskId, nodeName, portName);
    } catch (const std::exception& e) {
        fail(yunzone_infer::contracts::errors::ErrorCode::E_INTERNAL,
             std::string("聚合输出缺失: ") + e.what());
        return;
    }

    if (!hasFinalUpload_) {
        // 无上传目标（契约可选字段缺省）：仅置完成，最终输出留在执行面
        std::lock_guard lk(mu_);
        status_ = yunzone_infer::contracts::ipc::GraphExecutionStatus::completed;
        finalized_.store(true);
        return;
    }

    const float value = out.item<float>();
    std::string putErr;
    if (!busPutBytes(finalUploadUrl_, scalarBytes(value), putErr)) {
        fail(yunzone_infer::contracts::errors::ErrorCode::E_STORAGE_TRANSFER_FAILED,
             "final output upload failed: " + putErr);
        return;
    }
    std::lock_guard lk(mu_);
    status_ = yunzone_infer::contracts::ipc::GraphExecutionStatus::completed;
    finalOutputUri_ = finalUploadUrl_;  // 控制面仅持元数据 + URI（V8）
    finalized_.store(true);
}

void WorkflowRun::fail(yunzone_infer::contracts::errors::ErrorCode code, const std::string& message) {
    std::lock_guard lk(mu_);
    if (finalized_.load()) return;
    errorCode_ = code;
    status_ = yunzone_infer::contracts::ipc::GraphExecutionStatus::failed;
    finalized_.store(true);
    std::cerr << "[infer-sidecar] workflow '" << request_.workflowId << "' failed: " << message
              << std::endl;
}

void WorkflowRun::markExecuting() {
    std::lock_guard lk(mu_);
    if (status_ == yunzone_infer::contracts::ipc::GraphExecutionStatus::waitingRemote) {
        status_ = yunzone_infer::contracts::ipc::GraphExecutionStatus::executing;
    }
}

}  // namespace infer_sidecar
