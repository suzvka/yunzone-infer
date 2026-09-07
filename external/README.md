# external/ — 基础工程 submodule（锁版本引入）

DCinfer 以 **git submodule** 引入此处（D5：`https://github.com/suzvka/DCinfer`，MIT），落实 DESIGN D17「依赖锁定、只复用不修改」。DCinfer 仓库内含多模块，单一 submodule 即可：

| 模块 | 用途 | 消费方 |
|---|---|---|
| `DCinfer/` | C++20 推理图编排运行时（图持有 / 执行 / 聚合、EngineRegistry 插件式引擎、端口 Schema 校验、零依赖核心） | `server/sidecar`、`client` |
| `DCIr/` | 推理图序列化 / 反序列化 + 模型打包 | 同上（DCIr JSON = 控制面 ↔ 执行面契约载体，D3） |
| `DCNet/` | 张量网络传输框架 | **不启用（V9，2026-09-07）**：数据面走对象存储总线（根 DESIGN §9），`DCINFER_BUILD_DCNET=OFF`；P3 直连需求经 D13 提案机制反馈 |
| 引擎适配器 | Builtin / OnnxRuntime / OpenAI（`DCINFER_BUILD_ENGINES` 开关，子工程消费默认 OFF） | `client`（OnnxRuntime，V10）、`server/sidecar`（视本地节点引擎需求） |

## 初始化（依赖安装步骤，骨架期未执行）

```bash
# 仓库自身含 submodule，必须 --recursive
git submodule add https://github.com/suzvka/DCinfer external/DCinfer
git submodule update --init --recursive
```

C++ 构建经 vcpkg（见 `client/vcpkg.json`）；开关：`DCINFER_BUILD_ENGINES=ON`（client 用 OnnxRuntime 适配器）/ `DCINFER_BUILD_DCNET=OFF`（V9）；上游 a59185f 起顶层选项迁至 `DCINFER_BUILD_*` 命名空间（旧 `BUILD_*` 名兼容映射），子工程消费时测试/示例默认关。仅需要核心源码可用 git sparse-checkout（`DCinfer DCIr cmake vcpkg.json CMakeLists.txt`）。

## 版本锁定

- submodule 指向确定 commit（tag / commit hash），CI 与本地一致（D17）。
- 数据面对象存储总线在 `/storage`（service-kit）之上构建（根 [DESIGN.md](../DESIGN.md) §9）：**只复用不修改**本体、不私建分叉（D13）。
