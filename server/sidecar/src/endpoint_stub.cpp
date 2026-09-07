// infer-endpoint-stub — P0 对拍替身执行器（stub endpoint）
//
// 对拍角色：模拟真 client daemon 的执行半边（D18 为 P1 落地）——下载输入（总线
// GET）→ P0StubModel 引擎前向（DCinfer Node 流水线驱动，与 sidecar 同源算子
// stub_model.hpp，防语义漂移）→ 上传输出（总线 PUT）→ stdout 打印任务结果 JSON
//（对拍设施自述面，非契约面；对拍 harness 据此组装 CompletionReport）。
// P1 由真 client daemon 替代：WS 收派发（V5）+ 完成上报走控制通道（D8）。
//
// 用法:
//   infer-endpoint-stub --task <taskId> --model-key <key> --input <url> --output <url>
// stdout（成功）: {"version":1,"taskId":...,"modelKey":...,"outputUri":...,
//                  "outputMeta":{"shape":[],"dtype":"float32"},
//                  "metrics":{"queueWaitMs":0,"downloadMs":..,"inferMs":..,"uploadMs":..}}

#include "Tensor.hpp"
#include "bus_client.hpp"
#include "http_io.hpp"
#include "stub_model.hpp"

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>

namespace {

std::int64_t elapsedMsSince(const std::chrono::steady_clock::time_point& t0) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now() - t0)
        .count();
}

}  // namespace

int main(int argc, char** argv) {
    std::string taskId;
    std::string modelKey;
    std::string inputUrl;
    std::string outputUrl;
    for (int i = 1; i + 1 < argc; i += 2) {
        const std::string key = argv[i];
        const std::string value = argv[i + 1];
        if (key == "--task") taskId = value;
        else if (key == "--model-key") modelKey = value;
        else if (key == "--input") inputUrl = value;
        else if (key == "--output") outputUrl = value;
    }
    if (taskId.empty() || inputUrl.empty() || outputUrl.empty()) {
        std::cerr << "用法: infer-endpoint-stub --task <id> --model-key <key> "
                     "--input <url> --output <url>" << std::endl;
        return 2;
    }

    // ① 下载输入（qingge-api 分段审计：download）
    const auto t0 = std::chrono::steady_clock::now();
    std::string inputBytes;
    std::string err;
    if (!infer_sidecar::busGetBytes(inputUrl, inputBytes, err)) {
        std::cerr << "[endpoint-stub] 输入下载失败: " << err << std::endl;
        return 2;
    }
    const auto downloadMs = elapsedMsSince(t0);

    // ② 引擎前向（DCinfer Node 流水线驱动；出队即执行，queue_wait 记 0）
    float x = 0.0f;
    if (!infer_sidecar::scalarFromBytes(inputBytes, x)) {
        std::cerr << "[endpoint-stub] 输入非 float32 标量（" << inputBytes.size()
                  << " bytes）" << std::endl;
        return 2;
    }
    infer_sidecar::registerParityOperators();
    auto& reg = DC::EngineRegistry::instance();
    auto node = reg.createOperator("P0StubModel", "stub-" + taskId);
    if (!node) {
        std::cerr << "[endpoint-stub] P0StubModel 算子创建失败" << std::endl;
        return 2;
    }
    const DC::Node::TaskId task = taskId;
    const auto t1 = std::chrono::steady_clock::now();
    node->setInput(task, "x", infer_sidecar::scalarTensor(x));
    DC::Node::Result r{};
    try {
        r = node->tryExecute(task);
    } catch (const std::exception& e) {
        std::cerr << "[endpoint-stub] tryExecute 抛出: " << e.what() << std::endl;
        return 2;
    }
    if (!r.ok()) {
        std::cerr << "[endpoint-stub] 引擎前向失败: " << r.message << std::endl;
        node->clearTask(task);
        return 2;
    }
    const float y = node->getOutputTensor(task, "y").item<float>();
    node->clearTask(task);
    const auto inferMs = elapsedMsSince(t1);

    // ③ 上传输出（qingge-api 分段审计：upload）
    const auto t2 = std::chrono::steady_clock::now();
    if (!infer_sidecar::busPutBytes(outputUrl, infer_sidecar::scalarBytes(y), err)) {
        std::cerr << "[endpoint-stub] 输出上传失败: " << err << std::endl;
        return 2;
    }
    const auto uploadMs = elapsedMsSince(t2);

    // ④ 任务结果 JSON（对拍 harness 组装 CompletionReport 的输入）
    nlohmann::json result = {
        {"version", 1},
        {"taskId", taskId},
        {"modelKey", modelKey},
        {"outputUri", outputUrl},
        {"outputMeta", {{"shape", nlohmann::json::array()}, {"dtype", "float32"}}},
        {"metrics",
         {{"queueWaitMs", 0}, {"downloadMs", downloadMs}, {"inferMs", inferMs},
          {"uploadMs", uploadMs}}},
    };
    std::cout << result.dump() << std::endl;
    return 0;
}
