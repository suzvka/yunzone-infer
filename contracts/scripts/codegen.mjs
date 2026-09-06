#!/usr/bin/env node
// contracts codegen（骨架占位，P0 落地）
//
// 目标：读取 schema/**/*.json（JSON Schema），生成
//   - generated/ts/   → TS 类型（供 server 控制面 / sidecar IPC 消费）
//   - generated/cpp/  → nlohmann-json 结构 + to_json/from_json（供 client / sidecar 消费）
// generated/ 不入库（见根 .gitignore）；server/client/sidecar 构建前置运行本脚本。
//
// 工具选型待 P0 敲定（如 json-schema-to-typescript + 自研/quicktype C++ 生成器）。
// 骨架期：占位不报错（exit 0），避免阻断 workspace 构建。

console.error('[contracts] codegen 尚未实现（P0 任务）：schema/*.json → generated/{ts,cpp}');
process.exit(0);
