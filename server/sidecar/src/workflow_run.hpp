#pragma once
// ── 工作流运行实例（serve 模式）──────────────────────────────────────────────
//
// 图重建 + 数据驱动执行 + 远程节点总线回收（D8）+ 聚合最终输出上传（V8）。
// 生命周期：进程内常驻（P0 不做 GC，BusProxy/回调捕获 this 的稳定性由此保证；
// P1 随工作流状态机 /db Ledger 持久化一并收敛）。
//
// 状态流：starting → waitingRemote（pendingDispatch 就绪，V7 轮询取走）
//       → executing（远程输出拉取完毕，本地聚合运行）→ completed / failed。
// 失败映射（根 DESIGN §9）：完成通知 errorCode → 图级节点失败，语义与本地执行对齐。

#include "graph_builder.hpp"
#include "ipc/node-completion-notice.hpp"
#include "ipc/start-workflow-request.hpp"
#include "ipc/workflow-status-snapshot.hpp"

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

namespace infer_sidecar {

class WorkflowRun {
public:
    // 工厂：图重建失败时返回 nullptr 并填 err（serve 层映射 E_IPC_INVALID_GRAPH）
    static std::unique_ptr<WorkflowRun> create(
        yunzone_infer::contracts::ipc::StartWorkflowRequest request, std::string& err);

    // 提交图执行（BusProxy 无输入 → 立即触发 onRemoteWaiting → waitingRemote）
    void start();

    yunzone_infer::contracts::ipc::WorkflowStatusSnapshot snapshot() const;

    // 完成通知入站（D8 唤醒）。accepted=false 表示迟到重复通知（幂等忽略）；
    // 未知节点返回 false 且填 err。
    bool completeNode(const yunzone_infer::contracts::ipc::NodeCompletionNotice& notice,
                      bool& accepted, std::string& err);

    const std::string& workflowId() const { return request_.workflowId; }

private:
    WorkflowRun() = default;

    void onRemoteWaiting(const std::string& nodeId);
    void onTaskComplete();
    void fail(yunzone_infer::contracts::errors::ErrorCode code, const std::string& message);
    void markExecuting();

    yunzone_infer::contracts::ipc::StartWorkflowRequest request_;
    std::unique_ptr<DC::InferGraph> graph_;
    std::map<std::string, std::shared_ptr<RemotePlan>> remotePlans_;
    std::string finalUploadUrl_;   // 控制面签发的最终输出上传 URL（P0 替身直连；正式预签名 PUT）
    bool hasFinalUpload_ = false;

    mutable std::mutex mu_;
    yunzone_infer::contracts::ipc::GraphExecutionStatus status_ =
        yunzone_infer::contracts::ipc::GraphExecutionStatus::starting;
    std::optional<yunzone_infer::contracts::errors::ErrorCode> errorCode_;
    std::optional<std::string> finalOutputUri_;
    std::map<std::string, yunzone_infer::contracts::ipc::NodeExecutionState> nodeStates_;
    std::map<std::string, yunzone_infer::contracts::control_channel::TaskDispatch> pending_;
    std::atomic<bool> finalized_{false};
};

}  // namespace infer_sidecar
