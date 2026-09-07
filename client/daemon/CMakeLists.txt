# infer-clientd — 算力提供者常驻守护（注册/心跳 + WS 收任务 + InferGraph 单节点驱动执行 + 总线交互 + 完成上报）
add_executable(infer-clientd src/main.cpp)
target_include_directories(infer-clientd PRIVATE src ${CONTRACTS_CPP})

# DCinfer（本地执行编排层：InferGraph 单节点驱动 + OnnxRuntime 适配器，V10/D10 修订）就位后接线
if(TARGET DCinfer::DCinfer)
    target_link_libraries(infer-clientd PRIVATE DCinfer::DCinfer)
endif()

# 控制通道 REST/WS 客户端 + 预签名下载：Poco（vcpkg poco[netssl]）；JSON：nlohmann-json
# 骨架期从简，P1 接线 find_package(Poco ...) / find_package(nlohmann_json ...)

# 追加源文件时改用 glob：
# file(GLOB_RECURSE CLIENTD_SRC CONFIGURE_DEPENDS src/*.cpp)
# target_sources(infer-clientd PRIVATE ${CLIENTD_SRC})
