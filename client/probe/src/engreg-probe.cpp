// engreg-probe — P0 spike：EngineRegistry / Node 脱离图上下文的独立调用表面验证
//
// 问题（client/DESIGN.md D10 / P0 spike 项）：DCinfer 的执行表面不经 InferGraph /
// ExecutionEngine / SignalStore 能否直接驱动？（为 client 执行形态选型提供两面证据）
//
// 方法：registerBuiltinOperators → EngineRegistry::createOperator("Add") → 手动
// setInput → isReady → tryExecute → getOutputTensor → clearTask，跑两个任务验证任务级隔离。
//
// 判定：sum = a + b 且全程无图对象参与 ⇒ Node/EngineRegistry 独立表面成立（不动 DCinfer 本体，D13）；
//       2026-09-07 决策访谈：client 执行形态采纳 **InferGraph 单节点驱动**（端点=图拓扑，D10 修订）；
//       本探针保留为执行表面与任务级隔离语义的实证——Node 流水线正是图驱动 submit 的底层路径。
//
// 本探针为 spike 产物，不并入 daemon/cli 构建树（独立 CMakeLists）；
// 结论沉淀 CouplingRecord；P1 client 以 InferGraph 单节点驱动为执行基准（D10 修订），薄包装为备选面。

#include "Graph/EngineRegistry.h"
#include "DCEngine/BuiltinOps.h"
#include "Tensor.hpp"

#include <cstdio>
#include <string>

using namespace DC;

static int g_failures = 0;

static void check(bool cond, const std::string& what) {
    std::fprintf(stderr, "[probe] %s: %s\n", cond ? "ok  " : "FAIL", what.c_str());
    if (!cond) ++g_failures;
}

int main() {
    // 1) 全局注册表脱离任何图对象即可访问与注册
    auto& reg = EngineRegistry::instance();
    Builtin::registerBuiltinOperators(reg);
    check(reg.hasEngine("Add"), "registerOperator 与引擎同表可检索（engineTypes 含算子，实现事实）");
    check(true, "engineTypes() 可调用（当前注册引擎数：" + std::to_string(reg.engineTypes().size()) + "）");

    // 2) 从注册表创建节点（无需任何图上下文）
    auto node = reg.createOperator("Add", "probe_add");
    check(node != nullptr, "createOperator(\"Add\") 返回节点");
    if (!node)
        return 1;

    // 3) Schema 直读 —— client 能力声明 / 端口检视的消费面
    const auto& schema = node->schema();
    check(schema.inputs.size() == 2 && schema.outputs.size() == 1,
          "Schema 直读：inputs=2 outputs=1");
    check(schema.findInput("a") != nullptr && schema.findOutput("sum") != nullptr,
          "端口按名检索：a / sum");

    // 4) 手动驱动一次前向：setInput → isReady → tryExecute → getOutputTensor
    {
        Tensor a(Tensor::TensorType::Float, sizeof(float));
        a = 2.0f;
        Tensor b(Tensor::TensorType::Float, sizeof(float));
        b = 3.0f;
        const std::string task = "t1";
        node->setInput(task, "a", a);
        node->setInput(task, "b", b);
        check(node->isReady(task), "setInput 后 isReady");

        Node::Result r{};
        bool threw = false;
        try {
            r = node->tryExecute(task);
        } catch (const std::exception& e) {
            threw = true;
            std::fprintf(stderr, "[probe] tryExecute 抛出: %s\n", e.what());
        }
        check(!threw && r.ok(), "tryExecute 同步完成（无图对象参与）: " + r.message);
        check(node->hasOutput(task, "sum"), "产出 sum");
        if (node->hasOutput(task, "sum")) {
            const float sum = node->getOutputTensor(task, "sum").item<float>();
            check(sum == 5.0f, "前向结果 sum == 5.0f（实际 " + std::to_string(sum) + "）");
        }
        node->clearTask(task);
        check(!node->hasTask(task), "clearTask 后任务状态回收");
    }

    // 5) 同一节点跑第二个任务 —— 任务级隔离（client 任务队列逐任务驱动的前提）
    {
        Tensor a(Tensor::TensorType::Float, sizeof(float));
        a = 10.0f;
        Tensor b(Tensor::TensorType::Float, sizeof(float));
        b = -1.5f;
        const std::string task = "t2";
        node->setInput(task, "a", a);
        node->setInput(task, "b", b);
        Node::Result r = node->tryExecute(task);
        check(r.ok() && node->getOutputTensor(task, "sum").item<float>() == 8.5f,
              "任务 t2 独立于 t1（sum == 8.5f）");
        node->clearTask(task);
    }

    // 6) 实例管理面（client 模型生命周期管理的前提）
    {
        reg.releaseAllEngines();
        check(true, "releaseAllEngines() 可调用");
    }

    if (g_failures == 0) {
        std::fprintf(stderr, "[probe] === PASS：EngineRegistry/Node 独立调用表面成立 ===\n");
        return 0;
    }
    std::fprintf(stderr, "[probe] === FAILED：%d 项未过 ===\n", g_failures);
    return 1;
}
