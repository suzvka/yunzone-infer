/**
 * server vitest 配置：tsconfig paths 的 "@" 别名运行时映射
 * （route handler 等源码用 "@/lib/..." 导入，vitest 默认不读 tsconfig paths）
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
    },
  },
});
