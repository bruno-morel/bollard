import type { LanguageId, PackageManagerId } from "./types.js"

export function deriveSourcePatterns(lang: LanguageId): string[] {
  switch (lang) {
    case "typescript":
      return [
        "**/*.ts",
        "**/*.tsx",
        "!**/*.test.ts",
        "!**/*.spec.ts",
        "!**/node_modules/**",
        "!**/dist/**",
      ]
    case "javascript":
      return [
        "**/*.js",
        "**/*.jsx",
        "!**/*.test.js",
        "!**/*.spec.js",
        "!**/node_modules/**",
        "!**/dist/**",
      ]
    case "python":
      return ["**/*.py", "!**/test_*.py", "!**/*_test.py", "!**/__pycache__/**"]
    case "go":
      return ["**/*.go", "!**/*_test.go"]
    case "rust":
      return ["**/*.rs", "!**/target/**"]
    case "java":
    case "kotlin":
      return ["**/*.java", "**/*.kt", "!**/test/**", "!**/build/**"]
    case "ruby":
      return ["**/*.rb", "!**/spec/**", "!**/test/**"]
    case "csharp":
      return ["**/*.cs", "!**/bin/**", "!**/obj/**", "!**/*Test*.cs"]
    case "elixir":
      return ["**/*.ex", "**/*.exs", "!**/test/**", "!**/_build/**"]
    default:
      return ["**/*"]
  }
}

export function deriveTestPatterns(lang: LanguageId): string[] {
  switch (lang) {
    case "typescript":
      return ["**/*.test.ts", "**/*.spec.ts"]
    case "javascript":
      return ["**/*.test.js", "**/*.spec.js"]
    case "python":
      return ["**/test_*.py", "**/*_test.py"]
    case "go":
      return ["**/*_test.go"]
    case "rust":
      return ["**/*.rs"]
    case "java":
    case "kotlin":
      return ["**/test/**/*.java", "**/test/**/*.kt"]
    case "ruby":
      return ["**/spec/**/*_spec.rb", "**/test/**/*_test.rb"]
    case "csharp":
      return ["**/*Test*.cs", "**/*Tests*.cs"]
    case "elixir":
      return ["**/test/**/*_test.exs"]
    default:
      return []
  }
}

export function deriveIgnorePatterns(lang: LanguageId): string[] {
  switch (lang) {
    case "typescript":
    case "javascript":
      return ["node_modules", "dist", ".tsbuildinfo", "coverage"]
    case "python":
      return ["__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", "*.egg-info"]
    case "go":
      return ["vendor"]
    case "rust":
      return ["target"]
    case "java":
    case "kotlin":
      return ["build", ".gradle", "target"]
    case "ruby":
      return [".bundle", "vendor"]
    case "csharp":
      return ["bin", "obj", "packages"]
    case "elixir":
      return ["_build", "deps"]
    default:
      return []
  }
}

export function deriveAllowedCommands(
  lang: LanguageId,
  pkgMgr?: PackageManagerId,
  tools?: string[],
): string[] {
  const base = ["git", "cat", "head", "tail", "wc", "diff"]
  const extra = tools ?? []

  switch (lang) {
    case "typescript":
    case "javascript": {
      const pkg = pkgMgr ?? "pnpm"
      return [pkg, "npx", "node", "tsc", ...extra, ...base]
    }
    case "python": {
      const pkg = pkgMgr ?? "pip"
      return ["python", "python3", pkg, "pytest", ...extra, ...base]
    }
    case "go":
      return ["go", ...extra, ...base]
    case "rust":
      return ["cargo", "rustc", ...extra, ...base]
    case "java":
    case "kotlin":
      return [pkgMgr ?? "gradle", ...extra, ...base]
    case "ruby":
      return ["ruby", "bundle", ...extra, ...base]
    case "csharp":
      return ["dotnet", ...extra, ...base]
    case "elixir":
      return ["mix", "elixir", ...extra, ...base]
    default:
      return [...extra, ...base]
  }
}
