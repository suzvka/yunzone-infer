#!/usr/bin/env node
// contracts codegen（V1 工具链，2026-09-07 定案）
//
// 输入：schema/**/*.schema.json（JSON Schema draft-07，单一事实源 D15）
// 输出：
//   generated/ts/   → TS 类型（供 server 控制面 / sidecar IPC 消费）
//   generated/cpp/  → nlohmann-json struct + to_json/from_json（供 client / sidecar 消费）
//
// generated/ 不入库（见根 .gitignore）；server/client/sidecar 构建前置运行 pnpm codegen。
// 生成器对不支持的 schema 构造 fail-fast（oneOf/allOf/内联 object 等），保证两侧产物语义一致。
//
// TS 侧：json-schema-to-typescript（compileFromFile，相对 $ref 基于文件目录解析）
// C++ 侧：自研生成器 —— struct + ADL to_json/from_json；required→值，其余/可空→std::optional；
//         字符串枚举→enum class + toString；const→from_json 校验；自由 object→nlohmann::json 原样承载。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile as compileToTs } from 'json-schema-to-typescript';
import $RefParser from '@apidevtools/json-schema-ref-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = path.resolve(__dirname, '..');
const SCHEMA_DIR = path.join(CONTRACTS_ROOT, 'schema');
const OUT_TS = path.join(CONTRACTS_ROOT, 'generated', 'ts');
const OUT_CPP = path.join(CONTRACTS_ROOT, 'generated', 'cpp');

// ── 通用工具 ─────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`[contracts] codegen 失败：${msg}`);
  process.exit(1);
}

function walkJsonFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(abs));
    else if (entry.isFile() && entry.name.endsWith('.schema.json')) out.push(abs);
  }
  return out;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function banner(sourceRel, lang) {
  const line = lang === 'cpp' ? '// ─────────────────────────────────────────────────────────────────────────────' : '// ─────────────────────────────────────────────────────────────────────────────';
  return [
    line,
    `// 此文件由 contracts/scripts/codegen.mjs 自动生成 — 请勿手改（D15 防副本漂移）`,
    `// 源 schema：${sourceRel}`,
    `// 工具链：V1（TS=json-schema-to-typescript / C++=自研生成器）`,
    line,
    '',
  ].join('\n');
}

// 收集 schema 文件清单：rel 以 '/' 分隔（跨平台稳定），形如 "ipc/start-workflow-request.schema.json"
function collectFiles() {
  const files = walkJsonFiles(SCHEMA_DIR).map((abs) => {
    const rel = path.relative(SCHEMA_DIR, abs).split(path.sep).join('/');
    return { abs, rel, domain: rel.split('/')[0], baseName: path.basename(rel, '.schema.json') };
  });
  if (files.length === 0) fail(`schema/ 下未找到 *.schema.json（${SCHEMA_DIR}）`);
  return files;
}

// ── TS 生成 ──────────────────────────────────────────────────────────────

async function generateTs(files) {
  rmrf(OUT_TS);
  fs.mkdirSync(OUT_TS, { recursive: true });
  const barrelEntries = [];
  for (const f of files) {
    // 先 bundle：以文件自身为基准解析相对 $ref（跨域/跨文件引用内联为 named definitions），
    // 再交 json-schema-to-typescript 生成 —— 避免 cwd 基准歧义
    const bundled = await $RefParser.bundle(f.abs);
    const ts = await compileToTs(bundled, f.baseName, {
      cwd: path.dirname(f.abs),
      bannerComment: banner(f.rel, 'ts').trimEnd(),
      style: { semi: true, singleQuote: true, bracketSpacing: false },
    });
    const outRel = f.rel.replace(/\.schema\.json$/, '.ts');
    const outAbs = path.join(OUT_TS, outRel);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, ts.endsWith('\n') ? ts : ts + '\n');
    // 权威导出名：顶层 title + definitions（bundle 内联的外部副本不进 barrel，防 TS2308 重复导出）
    const schema = JSON.parse(fs.readFileSync(f.abs, 'utf8'));
    const names = [];
    if (schema.title) names.push(schema.title);
    for (const [key, def] of Object.entries(schema.definitions ?? {})) {
      names.push(def.title ?? key);
    }
    barrelEntries.push({ rel: outRel.replace(/\.ts$/, ''), names });
    console.log(`  ts   ← ${f.rel}`);
  }
  const indexTs =
    banner('schema/**（barrel）', 'ts') +
    barrelEntries
      .filter((e) => e.names.length > 0)
      // NodeNext 下相对导入需显式 .js 扩展名（映射到同名 .ts 产物）
      // 全部产物为类型（isolatedModules 下跨工程消费需 export type）
      .map((e) => `export type { ${e.names.join(', ')} } from './${e.rel}.js';`)
      .join('\n') +
    '\n';
  fs.writeFileSync(path.join(OUT_TS, 'index.ts'), indexTs);
}

// ── C++ 生成器（V1 自研）─────────────────────────────────────────────────

const CPP_KEYWORDS = new Set([
  'alignas', 'alignof', 'and', 'asm', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class',
  'co_await', 'co_return', 'co_yield', 'const', 'const_cast', 'constexpr', 'continue', 'decltype',
  'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum', 'explicit', 'export',
  'extern', 'false', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable',
  'namespace', 'new', 'noexcept', 'not', 'nullptr', 'operator', 'or', 'private', 'protected',
  'public', 'register', 'reinterpret_cast', 'requires', 'return', 'short', 'signed', 'sizeof',
  'static', 'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local',
  'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using', 'virtual',
  'void', 'volatile', 'wchar_t', 'while', 'xor',
]);

function cppSafeIdent(name) {
  return CPP_KEYWORDS.has(name) ? name + '_' : name;
}

function pascalCase(s) {
  return s.replace(/(^|[-_.\s]+)([a-zA-Z0-9])/g, (_, __, c) => c.toUpperCase());
}

function cppDomain(domain) {
  return 'yunzone_infer::contracts::' + domain.replaceAll('-', '_');
}

// $ref 解析 → { fileRel, node, name }；支持 '#/definitions/X' 与 '相对路径(.schema.json)(#/definitions/X)?'
function resolveRef(ref, fromRel, byPath) {
  if (ref.startsWith('#/')) {
    const seg = ref.split('/');
    if (seg[1] !== 'definitions') fail(`${fromRel}：不支持的内引用形式 ${ref}（仅支持 #/definitions/X）`);
    const node = byPath.get(fromRel)?.schema?.definitions?.[seg[2]];
    if (!node) fail(`${fromRel}：$ref 目标不存在 ${ref}`);
    return { fileRel: fromRel, node, name: node.title ?? seg[2] };
  }
  const [fileRef, frag] = ref.split('#');
  const targetRel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), fileRef));
  const target = byPath.get(targetRel);
  if (!target) fail(`${fromRel}：$ref 目标文件不在 schema/ 内或不存在：${ref}`);
  if (!frag) {
    if (!target.schema.title) fail(`${targetRel}：被引用文件缺顶层 title`);
    return { fileRel: targetRel, node: target.schema, name: target.schema.title };
  }
  const seg = frag.split('/');
  if (seg[1] !== 'definitions') fail(`${fromRel}：不支持的外部引用 fragment ${ref}`);
  const node = target.schema.definitions?.[seg[2]];
  if (!node) fail(`${fromRel}：$ref 目标不存在 ${ref}`);
  return { fileRel: targetRel, node, name: node.title ?? seg[2] };
}

function isNullable(schema) {
  return Array.isArray(schema.type) && schema.type.includes('null');
}

// 类型声明收集：顶层 + definitions 中所有 object-with-title（struct）与 string-enum（enum class）
function collectCppTypes(fileRel, schema, ctx) {
  if (schema.type === 'object') {
    if (!schema.title) fail(`${fileRel}：顶层 object 缺 title`);
    ctx.structs.set(schema.title, { name: schema.title, schema, desc: schema.description });
  } else if (schema.type === 'string' && Array.isArray(schema.enum)) {
    ctx.enums.set(schema.title, { name: schema.title, values: schema.enum, desc: schema.description });
  } else {
    fail(`${fileRel}：不支持的顶层 schema 形态（type=${schema.type}）`);
  }
  for (const [key, def] of Object.entries(schema.definitions ?? {})) {
    const name = def.title ?? key;
    if (def.type === 'object') {
      if (def.title && def.title !== key) fail(`${fileRel}：definitions.${key} 的 title(${def.title}) 与键名不一致`);
      ctx.structs.set(name, { name, schema: def, desc: def.description });
    } else if (def.type === 'string' && Array.isArray(def.enum)) {
      ctx.enums.set(name, { name, values: def.enum, desc: def.description });
    } else {
      fail(`${fileRel}：不支持的 definitions.${key} 形态（type=${def.type}）`);
    }
  }
}

// C++ 类型表达式解析；副作用：注册内联 enum（<Parent><Field>）、登记跨文件依赖
function cppTypeExpr(schema, ctx, fieldName, parentName) {
  if (schema.$ref) {
    const r = resolveRef(schema.$ref, ctx.fileRel, ctx.byPath);
    if (r.fileRel !== ctx.fileRel) {
      ctx.deps.add(r.fileRel);
      const depDomain = r.fileRel.split('/')[0];
      const targetNs = cppDomain(depDomain);
      const base = ctx.fileRel.split('/')[0] === depDomain ? r.name : `${targetNs}::${r.name}`;
      return isNullable(schema) ? `std::optional<${base}>` : base;
    }
    return isNullable(schema) ? `std::optional<${r.name}>` : r.name;
  }
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t) => t !== 'null');
    if (nonNull.length !== 1) fail(`${ctx.fileRel}：字段 ${fieldName} 的 type 多值非空分支不支持`);
    const inner = cppTypeExpr({ ...schema, type: nonNull[0] }, ctx, fieldName, parentName);
    return `std::optional<${inner}>`;
  }
  if (schema.const !== undefined && !schema.type) {
    // const-only 字段（如 WS 判别标签 type: const "task.dispatch"）：按常量值推断类型，from_json 另行校验
    if (typeof schema.const === 'string') return 'std::string';
    if (typeof schema.const === 'number') return Number.isInteger(schema.const) ? 'std::int64_t' : 'double';
    if (typeof schema.const === 'boolean') return 'bool';
    fail(`${ctx.fileRel}：字段 ${fieldName} 的 const 类型不支持（${typeof schema.const}）`);
  }
  if (schema.enum) {
    if (!schema.enum.every((v) => typeof v === 'string')) fail(`${ctx.fileRel}：字段 ${fieldName} 的内联 enum 仅支持字符串`);
    const name = `${parentName}${pascalCase(fieldName)}`;
    ctx.enums.set(name, { name, values: schema.enum, desc: schema.description });
    return name;
  }
  switch (schema.type) {
    case 'string': return 'std::string';
    case 'integer': return 'std::int64_t';
    case 'number': return 'double';
    case 'boolean': return 'bool';
    case 'array': return `std::vector<${cppTypeExpr(schema.items, ctx, fieldName, parentName)}>`;
    case 'object':
      // 自由 object（如 DCIr 图原样承载 / detail）：nlohmann::json 透传
      if (schema.additionalProperties === false || schema.properties) {
        fail(`${ctx.fileRel}：字段 ${fieldName} 的内联 object（带 properties）必须提升到 definitions`);
      }
      return 'nlohmann::json';
    default:
      fail(`${ctx.fileRel}：字段 ${fieldName} 的 type=${schema.type} 不支持`);
  }
}

function cppComment(desc, indent) {
  if (!desc) return [];
  return desc.split('\n').map((l) => `${indent}/// ${l.trim()}`.trimEnd());
}

function emitEnum({ name, values, desc }) {
  const lines = [];
  lines.push(...cppComment(desc, ''));
  lines.push(`enum class ${name} {`);
  for (const v of values) lines.push(`    ${cppSafeIdent(v)},`);
  lines.push('};');
  lines.push('');
  lines.push(...cppComment(desc, ''));
  lines.push(`inline const char* toString(${name} v) noexcept {`);
  lines.push('    switch (v) {');
  for (const v of values) lines.push(`        case ${name}::${cppSafeIdent(v)}: return "${v}";`);
  lines.push('    }');
  lines.push('    return nullptr;');
  lines.push('}');
  lines.push('');
  lines.push('inline void to_json(nlohmann::json& j, const ' + name + '& v) { j = std::string(toString(v)); }');
  lines.push('');
  lines.push('inline void from_json(const nlohmann::json& j, ' + name + '& v) {');
  lines.push('    const auto s = j.get<std::string>();');
  for (const v of values) {
    lines.push(`    if (s == "${v}") { v = ${name}::${cppSafeIdent(v)}; return; }`);
  }
  lines.push(`    throw nlohmann::json::other_error::create(501, "unknown ${name} value: " + s, nullptr);`);
  lines.push('}');
  return lines;
}

// 生成一个 struct 的声明 + ADL to_json/from_json（成员名 = JSON 键）
function emitStruct({ name, schema, desc }, ctx) {
  const required = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties ?? {});
  if (schema.additionalProperties !== false && props.length > 0) {
    fail(`${ctx.fileRel}：struct ${name} 未声明 additionalProperties: false（防漂移，要求显式封闭）`);
  }
  const fieldTypes = new Map();
  const lines = [];
  lines.push(...cppComment(desc, ''));
  lines.push(`struct ${name} {`);
  for (const [k, ps] of props) {
    const t = cppTypeExpr(ps, ctx, k, name);
    const isReq = required.has(k);
    fieldTypes.set(k, { t, isReq, isNull: isNullable(ps), ps });
    lines.push(...cppComment(ps.description, '    '));
    lines.push(`    ${isReq && !isNullable(ps) ? t : 'std::optional<' + t + '>'} ${cppSafeIdent(k)};`);
  }
  lines.push('};');
  lines.push('');
  // to_json
  lines.push('inline void to_json(nlohmann::json& j, const ' + name + '& v) {');
  lines.push('    j = nlohmann::json::object();');
  for (const [k, ft] of fieldTypes) {
    const key = `"${k}"`;
    if (ft.isReq && !ft.isNull) {
      lines.push(`    j[${key}] = v.${cppSafeIdent(k)};`);
    } else if (ft.isReq && ft.isNull) {
      lines.push(`    if (v.${cppSafeIdent(k)}.has_value()) j[${key}] = *v.${cppSafeIdent(k)};`);
      lines.push(`    else j[${key}] = nullptr;`);
    } else {
      lines.push(`    if (v.${cppSafeIdent(k)}.has_value()) j[${key}] = *v.${cppSafeIdent(k)};`);
    }
  }
  lines.push('}');
  lines.push('');
  // from_json
  lines.push('inline void from_json(const nlohmann::json& j, ' + name + '& v) {');
  for (const [k, ft] of fieldTypes) {
    const key = `"${k}"`;
    const ident = cppSafeIdent(k);
    const constVal = ft.ps.const;
    if (ft.isReq && !ft.isNull) {
      if (constVal !== undefined) {
        // 字符串 const 不带引号嵌入消息（避免截断 C++ 字面量）；nlohmann 3.12+ 异常构造函数私有，经静态 create 构造
        const constDisplay = typeof constVal === 'string' ? constVal : String(constVal);
        lines.push(`    if (j.at(${key}) != ${JSON.stringify(constVal)}) {`);
        lines.push(`        throw nlohmann::json::other_error::create(501, "invalid value for ${name}.${k} (const ${constDisplay})", nullptr);`);
        lines.push('    }');
      }
      lines.push(`    v.${ident} = j.at(${key}).get<${ft.t}>();`);
    } else if (ft.isReq && ft.isNull) {
      lines.push(`    {`);
      lines.push(`        const auto& _j = j.at(${key});`);
      lines.push(`        if (!_j.is_null()) v.${ident} = _j.get<${ft.t}>();`);
      lines.push(`    }`);
    } else {
      lines.push(`    if (auto _f = j.find(${key}); _f != j.end() && !_f->is_null()) {`);
      lines.push(`        v.${ident} = _f->get<${ft.t}>();`);
      lines.push(`    }`);
    }
  }
  lines.push('}');
  return lines;
}

// 同文件内类型拓扑排序（被依赖者先 emit；检测循环）
function orderTypes(ctx) {
  const emitted = new Set();
  const ordered = [];
  const inProgress = new Set();

  function refsOf(typeDef) {
    const found = new Set();
    const walk = (node, seen) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (node.$ref) {
        const r = resolveRef(node.$ref, ctx.fileRel, ctx.byPath);
        if (r.fileRel === ctx.fileRel) found.add(r.name);
        return;
      }
      for (const child of Object.values(node.properties ?? {})) walk(child, seen);
      if (node.items) walk(node.items, seen);
    };
    walk(typeDef.schema, new Set());
    return [...found];
  }

  function visit(name) {
    if (emitted.has(name)) return;
    if (inProgress.has(name)) fail(`${ctx.fileRel}：类型循环依赖（${name}）——按值嵌套无法编译`);
    inProgress.add(name);
    const td = ctx.structs.get(name);
    if (td) {
      for (const dep of refsOf(td)) visit(dep);
      ordered.push({ kind: 'struct', def: td });
    } else if (ctx.enums.has(name)) {
      ordered.push({ kind: 'enum', def: ctx.enums.get(name) });
    }
    inProgress.delete(name);
    emitted.add(name);
  }

  for (const name of ctx.enums.keys()) visit(name);
  for (const name of ctx.structs.keys()) visit(name);
  return ordered;
}

function relativeInclude(fromCppRel, toCppRel) {
  const fromDir = path.posix.dirname(fromCppRel);
  let rel = path.posix.relative(fromDir, toCppRel);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

function generateCpp(files) {
  rmrf(OUT_CPP);
  fs.mkdirSync(OUT_CPP, { recursive: true });
  const byPath = new Map(files.map((f) => [f.rel, { schema: JSON.parse(fs.readFileSync(f.abs, 'utf8')), ...f }]));
  const emittedCppRel = new Map(); // fileRel → generated cpp rel（"<domain>/<base>.hpp"）

  for (const [rel, file] of byPath) {
    const ctx = { fileRel: rel, byPath, deps: new Set(), structs: new Map(), enums: new Map() };
    collectCppTypes(rel, file.schema, ctx);
    if (ctx.structs.size + ctx.enums.size === 0) fail(`${rel}：无可生成类型`);

    // 预扫描 struct 字段：先注册内联 enum（<Parent><Field>）与跨文件依赖，保证拓扑排序时 enum 集完整
    for (const td of ctx.structs.values()) {
      for (const [k, ps] of Object.entries(td.schema.properties ?? {})) {
        cppTypeExpr(ps, ctx, k, td.name);
      }
    }

    const ordered = orderTypes(ctx);
    const body = [];
    for (const item of ordered) {
      body.push(...(item.kind === 'enum' ? emitEnum(item.def) : emitStruct(item.def, ctx)));
      body.push('');
    }

    // include：跨文件依赖（相对路径）+ 标准头
    const depIncludes = [...ctx.deps].sort().map((depRel) => {
      const dep = byPath.get(depRel);
      if (!emittedCppRel.has(depRel)) {
        const cppRel = `${dep.domain}/${dep.baseName}.hpp`;
        emittedCppRel.set(depRel, cppRel);
      }
      return `#include "${relativeInclude(`${file.domain}/${file.baseName}.hpp`, emittedCppRel.get(depRel))}"`;
    });
    emittedCppRel.set(rel, `${file.domain}/${file.baseName}.hpp`);

    const header = [
      banner(rel, 'cpp'),
      '#pragma once',
      '',
      '#include <cstdint>',
      '#include <optional>',
      '#include <string>',
      '#include <vector>',
      '',
      '#include <nlohmann/json.hpp>',
      '',
      ...(depIncludes.length ? [...depIncludes, ''] : []),
      `namespace ${cppDomain(file.domain)} {`,
      '',
      ...body,
      `}  // namespace ${cppDomain(file.domain)}`,
      '',
    ].join('\n');

    const outAbs = path.join(OUT_CPP, file.domain, `${file.baseName}.hpp`);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, header);
    console.log(`  cpp  ← ${rel}`);
  }

  // 总入口头（include 全部）
  const allIncludes = files
    .map((f) => `#include "${relativeInclude('contracts.hpp', `${f.domain}/${f.baseName}.hpp`)}"`)
    .join('\n');
  const agg = [banner('schema/**（总入口）', 'cpp'), '#pragma once', '', allIncludes, ''].join('\n');
  fs.writeFileSync(path.join(OUT_CPP, 'contracts.hpp'), agg);
}

// ── 主流程 ───────────────────────────────────────────────────────────────

async function main() {
  const files = collectFiles();
  console.log(`[contracts] 发现 ${files.length} 个 schema：`);
  console.log('[contracts] 生成 TS 类型 → generated/ts/');
  await generateTs(files);
  console.log('[contracts] 生成 C++ 结构 → generated/cpp/');
  generateCpp(files);
  console.log(`[contracts] 完成：${files.length} schema → TS + C++ 产物`);
}

main().catch((err) => fail(err?.stack ?? String(err)));
