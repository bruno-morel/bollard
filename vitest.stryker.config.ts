import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["packages/*/tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.adversarial.test.ts",
      "packages/verify/tests/static.test.ts",
      "packages/verify/tests/dynamic.test.ts",
      "packages/verify/tests/extractor-helpers.test.ts",
    ],
  },
})
