// infer-client — 命令行控制（骨架占位，P0/P1 细化）
//
// 经本地 loopback HTTP + 随机 token 管控 infer-clientd（V11，与 D16 同构；DESIGN D18）：
//   install-service / uninstall    服务化（systemd / Windows Service，分平台，D17）
//   register --token <凭证>         对接 /auth client_credentials（V3 强制），绑定 accountId，上报设备指纹（security §3.2）
//   config                         能力声明（EngineRegistry 直出 Descriptor，contracts/schema/capability）
//   start / stop / restart / status / health
//   model pull|list|verify         经控制面预签名 URL 下载 + hash 校验 + 缓存（D20）
//   diag                           总线连通性自检 + dry-run 测试任务 + 本机状态（D19 场景③，只读）
//
// CLI 框架：CLI11（header-only 跨平台，见 client/vcpkg.json）。

#include <cstdio>

int main(int /*argc*/, char** /*argv*/) {
    std::fprintf(stderr,
                 "[infer-client] 骨架占位：子命令树待落地（install/register/config/start|stop|status/model/diag）\n");
    return 0;
}
