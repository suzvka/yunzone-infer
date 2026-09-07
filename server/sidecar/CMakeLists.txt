# server/sidecar — 执行面 C++ 子进程（link DCinfer；数据面对象存储总线，V8/V9）
# P0 最小实现已落地：IPC 端点（D16）+ 图重建（DCIr JSON → InferGraph）+ BusProxy
# 总线回收（D8）+ 聚合上传（V8）；run-local 为对拍单机半边，infer-endpoint-stub 为
# 对拍端点替身（P1 由真 client daemon 替代，D18）。
cmake_minimum_required(VERSION 3.20)
project(infer_sidecar CXX)

# 顶层启用 ctest：否则子目录（build/dcinfer）的 add_test 不进入根 CTestTestfile 链，
# ctest 从构建根找不到任何测试（DCinfer 根的 enable_testing 只作用于其子树）
enable_testing()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 基础工程（external/ submodule，suzvka/DCinfer；只复用不修改，DESIGN D13/D17）
# DCINFER_BUILD_DCNET=OFF（V9：数据面走对象存储总线）；DCINFER_BUILD_ENGINES=ON（本地节点执行视引擎需求）；
# BUILD_ENGINE_BUILTIN=ON：本地算子表（Add/Mul/Identity）物化需要 Builtin 算子库（DCEngine::Builtin），
# 引擎子开关保留原名（上游迁移 DCINFER_BUILD_* 时仅顶层选项入命名空间）；
# DCINFER_BUILD_TESTS=ON：DCinfer 自带测试随消费语境构建并纳入 ctest 回归（上游 a59185f 起
# 子工程消费时测试/示例默认关，须显式开启）；示例不再显式关闭（子工程默认即 OFF）。
set(DCINFER_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../external/DCinfer)
if(EXISTS ${DCINFER_ROOT}/CMakeLists.txt)
    set(DCINFER_BUILD_ENGINES ON CACHE BOOL "" FORCE)
    set(BUILD_ENGINE_BUILTIN ON CACHE BOOL "" FORCE)
    set(DCINFER_BUILD_DCNET OFF CACHE BOOL "" FORCE)
    set(DCINFER_BUILD_TESTS ON CACHE BOOL "" FORCE)
    add_subdirectory(${DCINFER_ROOT} ${CMAKE_BINARY_DIR}/dcinfer)
else()
    message(WARNING "external/DCinfer 未就位（git submodule update --init --recursive）；sidecar 以占位形态构建")
endif()

add_executable(infer-sidecar
    src/main.cpp
    src/graph_builder.cpp
    src/workflow_run.cpp)
# 对拍端点替身（与 sidecar 共享 stub_model.hpp 算子语义，单一语义源）
add_executable(infer-endpoint-stub src/endpoint_stub.cpp)
# 中文注释在 GBK 代码页宿主上防 C4819（源文件统一按 UTF-8 读，与 DCinfer 根 CMakeLists 对其目标的做法对齐）
if(MSVC)
    target_compile_options(infer-sidecar PRIVATE /utf-8)
    target_compile_options(infer-endpoint-stub PRIVATE /utf-8)
endif()
target_include_directories(infer-sidecar PRIVATE
    src
    ${CMAKE_CURRENT_SOURCE_DIR}/../../contracts/generated/cpp)  # contracts codegen C++ 头（IPC 线格式，D15）
target_include_directories(infer-endpoint-stub PRIVATE
    src
    ${CMAKE_CURRENT_SOURCE_DIR}/../../contracts/generated/cpp)

# DCinfer 就位后接线（骨架期 external 缺失时跳过）；DCNet 不启用（V9）
# nlohmann：contracts codegen C++ 头（D15）依赖 <nlohmann/json.hpp>；DCinfer 核心零依赖
# 不携带其 include 面，须显式引入（vcpkg manifest 已含 nlohmann-json）
find_package(nlohmann_json CONFIG REQUIRED)
if(TARGET DCinfer::DCinfer)
    target_link_libraries(infer-sidecar PRIVATE DCinfer::DCinfer nlohmann_json::nlohmann_json)
    target_link_libraries(infer-endpoint-stub PRIVATE DCinfer::DCinfer nlohmann_json::nlohmann_json)
endif()
if(TARGET DCEngine::Builtin)
    target_link_libraries(infer-sidecar PRIVATE DCEngine::Builtin)
    target_link_libraries(infer-endpoint-stub PRIVATE DCEngine::Builtin)
endif()
# http_io.hpp（winsock2）：MSVC 需显式链 ws2_32；POSIX 端 socket 在 libc
if(WIN32)
    target_link_libraries(infer-sidecar PRIVATE ws2_32)
    target_link_libraries(infer-endpoint-stub PRIVATE ws2_32)
endif()

# 冒烟：无参数运行打印用法（exit 0）；对拍 e2e 见 ../tests/parity-bus-spike.test.ts
#（由仓库根 vitest 驱动 serve + endpoint-stub + 总线替身 + run-local 全闭环）
