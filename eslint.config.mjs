import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Large runtime artifacts and operator notes that are not lint targets:
    ".claude/**",
    ".omc/**",
    "data/**",
    "docs/**",
    "reports/**",
    "prisma/dev.db",
  ]),
]);

export default eslintConfig;
