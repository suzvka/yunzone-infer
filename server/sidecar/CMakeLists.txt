# server/sidecar — 执行面 C++ 子进程（link DCinfer；数据面对象存储总线，V8/V9）
# 骨架占位：P0 随 IPC 契约落地最小可运行 sidecar。
cmake_minimum_required(VERSION 3.20)
project(infer_sidecar CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 基础工程（external/ submodule，suzvka/DCinfer；只复用不修改，DESIGN D13/D17）
# BUILD_DCNET=OFF（V9：数据面走对象存储总线）；BUILD_ENGINES=ON（本地节点执行视引擎需求，P0 spike 收紧）
set(DCINFER_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../external/DCinfer)
if(EXISTS ${DCINFER_ROOT}/CMakeLists.txt)
    set(BUILD_ENGINES ON CACHE BOOL "" FORCE)
    set(BUILD_DCNET OFF CACHE BOOL "" FORCE)
    add_subdirectory(${DCINFER_ROOT} ${CMAKE_BINARY_DIR}/dcinfer)
else()
    message(WARNING "external/DCinfer 未就位（git submodule update --init --recursive）；sidecar 以占位形态构建")
endif()

add_executable(infer-sidecar src/main.cpp)
target_include_directories(infer-sidecar PRIVATE
    src
    ${CMAKE_CURRENT_SOURCE_DIR}/../../contracts/generated/cpp)  # contracts codegen C++ 头（IPC 线格式，D15）

# DCinfer 就位后接线（骨架期 external 缺失时跳过）；DCNet 不启用（V9）
if(TARGET DCinfer::DCinfer)
    target_link_libraries(infer-sidecar PRIVATE DCinfer::DCinfer)
endif()

# 追加源文件时改用 glob：
# file(GLOB_RECURSE SIDECAR_SRC CONFIGURE_DEPENDS src/*.cpp)
# target_sources(infer-sidecar PRIVATE ${SIDECAR_SRC})
