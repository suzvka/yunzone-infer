#pragma once
// ── per-model 任务队列（qingge-api TaskPool 模式 P1 简化版，client/DESIGN §3.5）──
//
// - 结构：per-model 车道 × 两档优先级子队列（normal / compensation——失败重派任务
//   升入优先子队列：已排过队，失败是端点的问题，不由任务负责）；
// - 撤销 = 标记式懒惰撤销（server 下发 task.revoke 打标记，出队前检查跳过；
//   无任务级超时，D7）；
// - 深度上限 = per-model 配置静态值；满时 push 拒绝（server 反压以心跳余量为准）；
// - 过量注入 + 队列缓冲保持满负荷（server 侧语义），元素为轻量任务元数据
//   （张量在对象存储，出队才下载，V8）。
//
// P1 简化（P2 收口）：qingge-api 完整老化算法（alpha 平滑 / 阈值提升 /
// survival_count 防饥饿）未落——两档 FIFO 在对拍任务量下语义等价。

#include <chrono>
#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <string>

namespace infer_client {

struct QueuedTask {
    std::string taskId;
    std::string requestId;
    std::string workflowId;
    std::string nodeId;
    std::string modelKey;
    std::string inputUri;   // 输入下载目标（预签名 GET URL / 替身直链，D20）
    std::string outputUri;  // 输出上传目标（预签名 PUT URL）
    bool compensation = false;                 // priority=compensation（重派补偿）
    std::chrono::steady_clock::time_point enqueuedAt{};  // queue_wait 分段耗时起点
};

class TaskQueue {
public:
    explicit TaskQueue(const std::map<std::string, int>& depthLimits);

    /// 入队（未知 modelKey 或深度满 → false，err 归因）
    bool push(QueuedTask task, std::string& err);

    /// 阻塞出队任一车道（compensation 优先；已撤销任务懒惰跳过）；shutdown 后返回 false
    bool popAny(QueuedTask& out);

    /// 标记式撤销（task.revoke 下发消费）
    void revoke(const std::string& taskId);

    /// 余量（任务数）：深度上限 - 在队数（心跳全量能力上报，V6）
    int queueRemaining(const std::string& modelKey) const;

    /// 唤醒全部阻塞 popAny（进程退出）
    void shutdown();

private:
    struct Lane {
        std::deque<QueuedTask> normal;
        std::deque<QueuedTask> compensation;
        std::set<std::string> revoked;
        int depthLimit = 8;
    };

    Lane* findLane(const std::string& modelKey);
    const Lane* findLane(const std::string& modelKey) const;

    mutable std::mutex mu_;
    std::condition_variable cv_;
    bool shuttingDown_ = false;
    std::map<std::string, Lane> lanes_;
};

}  // namespace infer_client
