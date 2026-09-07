#pragma once
// ── client 对拍 stub 算子 + 总线张量编码 ────────────────────────────────────
//
// P1 client daemon（D10 修订：InferGraph 单节点驱动）的对拍执行面：
// P0StubModel 语义 y = x * 2 + 1，与 server/sidecar/src/stub_model.hpp 对拍语义
// 一致——但两 C++ 工程各自维护副本（D14「无共享 C++ core」，语义一致性由
// contracts 检视 + 对拍比对保证，不共享代码）。
//
// P1 张量编码：float32 标量裸字节（原生端序，同主机对拍闭环；正式张量格式为
// P3「高效张量格式演进」项，DESIGN §13）；元数据随 JSON 契约走（TensorMeta）。
// 正式引擎 = OnnxRuntime 适配器（V10，DCinfer BUILD_ENGINES=ON）。

#include "DCEngine/BuiltinOps.h"
#include "Graph/EngineRegistry.h"
#include "Tensor.hpp"

#include <cstring>
#include <memory>
#include <string>
#include <utility>

namespace infer_client {

// 注册 client 算子表（幂等；对拍图本地节点 + 远程引擎类型来源）
inline void registerClientOperators(DC::EngineRegistry& reg = DC::EngineRegistry::instance()) {
    DC::Builtin::registerBuiltinOperators(reg);

    DC::Node::Schema s;
    s.inputs = {DC::Node::Port::in<float>("x")};
    s.outputs = {DC::Node::Port::out<float>("y")};
    reg.registerOperator(
        "P0StubModel", std::move(s), [](DC::Node::RunContext& ctx) -> DC::Node::Result {
            const auto& xv = ctx.peek("x");
            const auto* x = xv.as<DC::Tensor>();
            if (!x) {
                return ctx.failure(DC::Node::Status::InvalidInput,
                                   "P0StubModel: input must be DC::Tensor");
            }
            const float y = x->item<float>() * 2.0f + 1.0f;
            auto t = std::make_unique<DC::Tensor>(DC::Tensor::TensorType::Float, sizeof(float));
            *t = y;
            ctx.output("y", DC::Value(std::move(t)));
            return ctx.success();
        });
}

// Float 标量张量（P1 对拍全域唯一形态）
inline DC::Tensor scalarTensor(float v) {
    DC::Tensor t(DC::Tensor::TensorType::Float, sizeof(float));
    t = v;
    return t;
}

inline std::string scalarBytes(float v) {
    std::string bytes(sizeof(float), '\0');
    std::memcpy(bytes.data(), &v, sizeof(float));
    return bytes;
}

inline bool scalarFromBytes(const std::string& bytes, float& out) {
    if (bytes.size() != sizeof(float)) return false;
    std::memcpy(&out, bytes.data(), sizeof(float));
    return true;
}

}  // namespace infer_client
