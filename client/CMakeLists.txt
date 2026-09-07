# client — 算力提供者工作后端（纯 C++：daemon + CLI，DESIGN D10/D18）
cmake_minimum_required(VERSION 3.20)
project(infer_client CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 基础工程（../external/ submodule，suzvka/DCinfer；只复用不修改，DESIGN D13/D17）
# client 用途＝本地执行编排层（V10 + D10 修订：InferGraph 单节点驱动）：BUILD_ENGINES=ON 启用 OnnxRuntime 引擎适配器；BUILD_DCNET=OFF（V9）
set(DCINFER_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../external/DCinfer)
if(EXISTS ${DCINFER_ROOT}/CMakeLists.txt)
    set(BUILD_ENGINES ON CACHE BOOL "" FORCE)
    set(BUILD_DCNET OFF CACHE BOOL "" FORCE)
    add_subdirectory(${DCINFER_ROOT} ${CMAKE_BINARY_DIR}/dcinfer)
else()
    message(WARNING "external/DCinfer 未就位（git submodule update --init --recursive）；client 以占位形态构建")
endif()

# contracts codegen 的 C++ 头（能力声明 / 控制通道，D15）——子目录继承此变量
set(CONTRACTS_CPP ${CMAKE_CURRENT_SOURCE_DIR}/../contracts/generated/cpp)

add_subdirectory(daemon)   # infer-clientd（常驻守护）
add_subdirectory(cli)      # infer-client（命令行控制）
