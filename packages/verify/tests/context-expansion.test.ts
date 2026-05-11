import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { expandAffectedFiles } from "../src/context-expansion.js"

const here = dirname(fileURLToPath(import.meta.url))

function scope(enabled: boolean) {
  return {
    enabled,
    integration: "independent" as const,
    lifecycle: "ephemeral" as const,
    concerns: {
      correctness: "high" as const,
      security: "medium" as const,
      performance: "low" as const,
      resilience: "off" as const,
    },
  }
}

function profile(language: LanguageId): ToolchainProfile {
  return {
    language,
    checks: {},
    sourcePatterns: ["**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: [],
    adversarial: {
      boundary: scope(true),
      contract: scope(false),
      behavioral: scope(false),
    },
  }
}

const tsProfile = profile("typescript")

describe("expandAffectedFiles passthrough", () => {
  const langs: LanguageId[] = ["python", "go", "rust", "unknown"]
  for (const lang of langs) {
    it(`passthrough for ${lang}`, async () => {
      const r = await expandAffectedFiles("/tmp", ["a.ts", "b.ts", "c.ts"], profile(lang), 2)
      expect(r.source).toBe("passthrough")
      expect(r.files).toEqual(["a.ts", "b.ts"])
      expect(r.fanInScores).toEqual({})
    })
  }
})

describe("expandAffectedFiles TypeScript graph", () => {
  it("linear chain A → B → C", async () => {
    const root = join(here, "fixtures", "context-expansion", "linear")
    const r = await expandAffectedFiles(root, ["src/a.ts"], tsProfile, 10)
    expect(r.source).toBe("import-graph")
    expect(r.files.slice(0, 3)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
  })

  it("diamond: shared D has higher fan-in than B or C", async () => {
    const root = join(here, "fixtures", "context-expansion", "diamond")
    const r = await expandAffectedFiles(root, ["src/a.ts"], tsProfile, 10)
    expect(r.source).toBe("import-graph")
    expect(r.files[0]).toBe("src/a.ts")
    expect(r.files[1]).toBe("src/d.ts")
    expect(new Set(r.files)).toEqual(new Set(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]))
  })

  it("respects maxFiles cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "ce-cap-"))
    for (let i = 0; i < 9; i++) {
      const body =
        i < 8
          ? `import "./f${i + 1}.js"\nexport const x${i} = ${i}\n`
          : `export const x${i} = ${i}\n`
      await writeFile(join(root, `f${i}.ts`), body)
    }
    const r = await expandAffectedFiles(root, ["f0.ts"], tsProfile, 3)
    expect(r.files).toHaveLength(3)
    expect(r.files[0]).toBe("f0.ts")
  })

  it("affectedModify paths always come first even when fan-in favors another file", async () => {
    const root = join(here, "fixtures", "context-expansion", "diamond")
    const r = await expandAffectedFiles(root, ["src/d.ts", "src/a.ts"], tsProfile, 2)
    expect(r.files[0]).toBe("src/d.ts")
    expect(r.files[1]).toBe("src/a.ts")
  })

  it("bad tsconfig does not prevent import-graph expansion", async () => {
    const root = join(here, "fixtures", "context-expansion", "bad-tsconfig")
    const r = await expandAffectedFiles(root, ["src/a.ts"], tsProfile, 10)
    expect(r.source).toBe("import-graph")
    expect(r.files).toContain("src/b.ts")
  })

  it("cyclic imports terminate", async () => {
    const root = join(here, "fixtures", "context-expansion", "cyclic")
    const r = await expandAffectedFiles(root, ["src/a.ts"], tsProfile, 10)
    expect(r.source).toBe("import-graph")
    expect(new Set(r.files)).toEqual(new Set(["src/a.ts", "src/b.ts"]))
  })

  it("resolves workspace package @fixture/a from @fixture/b entry", async () => {
    const root = join(here, "fixtures", "context-expansion", "workspace")
    const r = await expandAffectedFiles(root, ["packages/pkg-b/src/entry.ts"], tsProfile, 10)
    expect(r.source).toBe("import-graph")
    expect(r.files).toContain("packages/pkg-a/src/index.ts")
    expect(r.files[0]).toBe("packages/pkg-b/src/entry.ts")
  })

  it("skips bare external specifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "ce-ext-"))
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(
      join(root, "src", "m.ts"),
      ['import "react"', 'import { x } from "./x.js"', "export const u = 1"].join("\n"),
    )
    await writeFile(join(root, "src", "x.ts"), "export const x = 1\n")
    const r = await expandAffectedFiles(root, ["src/m.ts"], tsProfile, 10)
    expect(r.source).toBe("import-graph")
    expect(r.files).toContain("src/x.ts")
    expect(r.files.every((f) => !f.includes("node_modules"))).toBe(true)
  })
})
