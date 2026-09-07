// ── per-model 任务队列实现 ──────────────────────────────────────────────────

#include "task_queue.hpp"

namespace infer_client {

TaskQueue::TaskQueue(const std::map<std::string, int>& depthLimits) {
    for (const auto& [modelKey, depth] : depthLimits) {
        lanes_[modelKey].depthLimit = depth;
    }
}

TaskQueue::Lane* TaskQueue::findLane(const std::string& modelKey) {
    const auto it = lanes_.find(modelKey);
    return it == lanes_.end() ? nullptr : &it->second;
}

const TaskQueue::Lane* TaskQueue::findLane(const std::string& modelKey) const {
    const auto it = lanes_.find(modelKey);
    return it == lanes_.end() ? nullptr : &it->second;
}

bool TaskQueue::push(QueuedTask task, std::string& err) {
    std::lock_guard lk(mu_);
    Lane* lane = findLane(task.modelKey);
    if (!lane) {
        err = "未配置的模型车道: " + task.modelKey;
        return false;
    }
    const int queued = static_cast<int>(lane->normal.size() + lane->compensation.size());
    if (queued >= lane->depthLimit) {
        err = "模型 " + task.modelKey + " 队列深度已满（" + std::to_string(lane->depthLimit) + "）";
        return false;
    }
    task.enqueuedAt = std::chrono::steady_clock::now();
    if (task.compensation) {
        lane->compensation.push_back(std::move(task));
    } else {
        lane->normal.push_back(std::move(task));
    }
    cv_.notify_one();
    return true;
}

bool TaskQueue::popAny(QueuedTask& out) {
    std::unique_lock lk(mu_);
    cv_.wait(lk, [this] {
        if (shuttingDown_) return true;
        for (auto& [key, lane] : lanes_) {
            if (!lane.normal.empty() || !lane.compensation.empty()) return true;
        }
        return false;
    });
    if (shuttingDown_) return false;

    // compensation 优先（补偿重派升队）；normal FIFO；两档都扫（撤销懒惰跳空后继续）
    for (auto& [key, lane] : lanes_) {
        for (std::deque<QueuedTask>* queue : {&lane.compensation, &lane.normal}) {
            while (!queue->empty()) {
                QueuedTask task = std::move(queue->front());
                queue->pop_front();
                if (lane.revoked.count(task.taskId)) {
                    // 标记式懒惰撤销：跳过取下一个（不中断执行中任务，D7）
                    lane.revoked.erase(task.taskId);
                    continue;
                }
                out = std::move(task);
                return true;
            }
        }
    }
    return false;
}

void TaskQueue::revoke(const std::string& taskId) {
    std::lock_guard lk(mu_);
    for (auto& [key, lane] : lanes_) {
        // 撤销标记记到所有车道：taskId 全局唯一，出队时命中即跳过
        lane.revoked.insert(taskId);
    }
}

int TaskQueue::queueRemaining(const std::string& modelKey) const {
    std::lock_guard lk(mu_);
    const Lane* lane = findLane(modelKey);
    if (!lane) return 0;
    const int queued = static_cast<int>(lane->normal.size() + lane->compensation.size());
    return lane->depthLimit > queued ? lane->depthLimit - queued : 0;
}

void TaskQueue::shutdown() {
    std::lock_guard lk(mu_);
    shuttingDown_ = true;
    cv_.notify_all();
}

}  // namespace infer_client
