#pragma once
// ── P0 对拍 stub 模型算子 + 总线张量编码（单一语义源）────────────────────────
//
// infer-sidecar（run-local 半边本地执行）与 infer-endpoint-stub（分布式半边端点替身）
// 共用本头，防 D14「无共享 C++ core」下两 C++ 工程的 stub 语义漂移。
// 对拍只验证编排 / 总线 / 语义对齐，不验证模型质量；正式引擎 = OnnxRuntime 适配器
//（V10，P1，复用 DCinfer 引擎适配器）。不动 DCinfer 本体（D13）。
//
// stub 语义：y = x * 2 + 1（Float 标量，确定性可精确比对）。
//
// P0 总线张量编码：float32 标量裸字节（原生端序，同主机对拍闭环；正式张量格式
// 为 P3「高效张量格式演进」项，DESIGN §13）；元数据随 JSON 契约走（TensorMeta）。

#include "DCEngine/BuiltinOps.h"
#include "Tensor.hpp"

#include <cstring>
#include <memory>
#include <string>
#include <utility>

namespace infer_sidecar {

// 注册对拍算子（幂等：registerOperator 重名返回 false）。
// 同时注册 DCinfer Builtin 算子（Add/Mul/Identity）——图重建的本地算子表来源。
inline void registerParityOperators(DC::EngineRegistry& reg = DC::EngineRegistry::instance()) {
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

// Float 标量张量（P0 对拍全域唯一形态；张量编码见文件头注释）
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

}  // namespace infer_sidecar
