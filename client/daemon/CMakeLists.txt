# infer-clientd — 算力提供者常驻守护（注册/心跳 + WS 收任务 + InferGraph 单节点驱动执行 + 总线交互 + 完成上报）
# P1 daemon 核心先行（D18）：CLI 管控（V11）P2；installer 分发 P2
add_executable(infer-clientd
    src/main.cpp
    src/daemon.cpp
    src/daemon_config.cpp
    src/engine_runner.cpp
    src/task_queue.cpp
    src/http_io.cpp
    src/ws_client.cpp)
target_include_directories(infer-clientd PRIVATE src ${CONTRACTS_CPP})

# DCinfer（本地执行编排层：InferGraph 单节点驱动，D10 修订；BUILD_ENGINES=ON 时
# ORT 引擎适配器随 DCinfer::DCinfer 接入，V10）
if(TARGET DCinfer::DCinfer)
    target_link_libraries(infer-clientd PRIVATE DCinfer::DCinfer)
endif()
# Builtin 算子库（对拍 stub / 图重建算子表来源，client/daemon/src/stub_model.hpp）
if(TARGET DCEngine::Builtin)
    target_link_libraries(infer-clientd PRIVATE DCEngine::Builtin)
endif()

# 控制通道 REST/WS 客户端 + 预签名下载/上传：Poco（vcpkg poco[netssl]）；JSON：nlohmann-json
find_package(nlohmann_json CONFIG REQUIRED)
find_package(Poco CONFIG REQUIRED COMPONENTS Foundation Net Util NetSSL)
target_link_libraries(infer-clientd PRIVATE
    nlohmann_json::nlohmann_json
    Poco::Foundation
    Poco::Net
    Poco::Util
    Poco::NetSSL)

# 中文注释在 GBK 代码页宿主上防 C4819（与 server/sidecar 对齐）
if(MSVC)
    target_compile_options(infer-clientd PRIVATE /utf-8)
endif()
