import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/** Vitest project for contract tests under `.bollard/tests/` (see `runTests` in dynamic.ts). */
const repoRoot = dirname(fileURLToPath(import.meta.url))
const bollardPackages = [
  "engine",
  "llm",
  "cli",
  "agents",
  "verify",
  "blueprints",
  "detect",
  "mcp",
] as const
const bollardAliases = Object.fromEntries(
  bollardPackages.map((p) => [`@bollard/${p}`, resolve(repoRoot, `packages/${p}`)]),
)

export default defineConfig({
  resolve: {
    alias: bollardAliases,
  },
  test: {
    globals: false,
    environment: "node",
    include: [".bollard/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
})
