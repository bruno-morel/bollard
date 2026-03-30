import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["packages/*/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.adversarial.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
})
