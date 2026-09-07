# client/probe — P0 spike 探针（EngineRegistry 独立调用表面验证）
#
# 独立构建树，不并入 client 顶层（daemon/cli 构建不受影响）：
#   cmake -S client/probe -B client/probe/build && cmake --build client/probe/build --config Release
# 零外部依赖（DCinfer 核心 + Builtin 算子均无 vcpkg 需求；BUILD_IR=OFF 免去 DCIr 的
# nlohmann/zlib/minizip），spike 期不接 vcpkg 工具链。
cmake_minimum_required(VERSION 3.20)
project(engreg_probe CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(DCINFER_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../external/DCinfer)
if(EXISTS ${DCINFER_ROOT}/CMakeLists.txt)
    set(BUILD_ENGINES ON CACHE BOOL "" FORCE)
    set(BUILD_ENGINE_BUILTIN ON CACHE BOOL "" FORCE)
    set(BUILD_ENGINE_ONNXRUNTIME OFF CACHE BOOL "" FORCE)
    set(BUILD_DCNET OFF CACHE BOOL "" FORCE)
    set(BUILD_IR OFF CACHE BOOL "" FORCE)
    set(BUILD_TESTS OFF CACHE BOOL "" FORCE)  # spike 最小构建（上游 27e9c7d 修复后消费语境亦可开，按需）
    set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    add_subdirectory(${DCINFER_ROOT} ${CMAKE_BINARY_DIR}/dcinfer)
else()
    message(FATAL_ERROR "external/DCinfer 未就位（git submodule update --init --recursive）")
endif()

add_executable(engreg-probe src/engreg-probe.cpp)
if(MSVC)
    target_compile_options(engreg-probe PRIVATE /utf-8)
endif()
target_link_libraries(engreg-probe PRIVATE
    DCEngine::Builtin
    DCinfer::DCinfer)
