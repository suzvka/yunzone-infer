# infer-client — 命令行控制（经本地 loopback HTTP + token 管控 infer-clientd，V11；不 link DCinfer）
add_executable(infer-client src/main.cpp)
target_include_directories(infer-client PRIVATE src ${CONTRACTS_CPP})

# CLI 框架：CLI11（header-only 跨平台，vcpkg cli11）；本地管控：loopback HTTP（与 D16 同构）
# 骨架期从简，P0/P1 接线 find_package(CLI11 ...) / find_package(Poco ...)
