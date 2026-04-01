import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { LLMProvider, LLMResponse } from "@bollard/llm/src/types.js"
import { describe, expect, it } from "vitest"
import {
  type ExtractionResult,
  LlmFallbackExtractor,
  TsCompilerExtractor,
  extractPrivateIdentifiers,
  extractSignatures,
  extractSignaturesFromFiles,
  extractTypeDefinitions,
  getExtractor,
  resolveReferencedTypes,
} from "../src/type-extractor.js"

function createMockProvider(responseText: string): LLMProvider {
  return {
    name: "mock",
    chat: async () => ({
      content: [{ type: "text" as const, text: responseText }],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 100, outputTokens: 200 },
      costUsd: 0.001,
    }),
  }
}

function createErrorProvider(): LLMProvider {
  return {
    name: "error-mock",
    chat: async () => {
      throw new Error("LLM unavailable")
    },
  }
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGES_DIR = resolve(THIS_DIR, "../..")

async function readSource(pkgPath: string): Promise<string> {
  return readFile(resolve(PACKAGES_DIR, pkgPath), "utf-8")
}

describe("extractSignatures", () => {
  it("extracts class signatures from errors.ts without implementation bodies", async () => {
    const source = await readSource("engine/src/errors.ts")
    const result = extractSignatures("engine/src/errors.ts", source)

    expect(result.signatures).toContain("export class BollardError")
    expect(result.signatures).toContain("constructor(")
    expect(result.signatures).toContain("{ ... }")

    expect(result.signatures).not.toContain("Object.setPrototypeOf")
    expect(result.signatures).not.toContain('this.name = "BollardError"')
  })

  it("strips private class members from cost-tracker.ts", async () => {
    const source = await readSource("engine/src/cost-tracker.ts")
    const result = extractSignatures("engine/src/cost-tracker.ts", source)

    expect(result.signatures).toContain("add(costUsd: number)")
    expect(result.signatures).toContain("total()")
    expect(result.signatures).toContain("exceeded()")
    expect(result.signatures).toContain("remaining()")

    expect(result.signatures).not.toContain("_total")
    expect(result.signatures).not.toContain("_limit")
  })

  it("preserves interfaces in full from llm/types.ts", async () => {
    const source = await readSource("llm/src/types.ts")
    const result = extractSignatures("llm/src/types.ts", source)

    expect(result.types).toContain("export interface LLMProvider")
    expect(result.types).toContain("export interface LLMRequest")
    expect(result.types).toContain("export interface LLMResponse")
    expect(result.types).toContain("chat(request: LLMRequest)")
  })

  it("preserves import statements", async () => {
    const source = await readSource("engine/src/cost-tracker.ts")
    const result = extractSignatures("engine/src/cost-tracker.ts", source)

    expect(result.imports).toContain("import")
    expect(result.imports).toContain("BollardError")
  })

  it("preserves type aliases in full", async () => {
    const source = await readSource("engine/src/errors.ts")
    const result = extractSignatures("engine/src/errors.ts", source)

    expect(result.types).toContain("export type BollardErrorCode")
    expect(result.types).toContain("LLM_TIMEOUT")
    expect(result.types).toContain("NODE_EXECUTION_FAILED")
  })

  it("extracts typed const declarations without initializer values", async () => {
    const source = await readSource("agents/src/tools/index.ts")
    const result = extractSignatures("agents/src/tools/index.ts", source)

    expect(result.signatures).toContain("ALL_TOOLS")
    expect(result.signatures).toContain("AgentTool[]")
    expect(result.signatures).toContain("READ_ONLY_TOOLS")

    expect(result.signatures).not.toContain("readFileTool")
    expect(result.signatures).not.toContain("writeFileTool")
  })

  it("strips non-exported items", async () => {
    const source = await readSource("engine/src/errors.ts")
    const result = extractSignatures("engine/src/errors.ts", source)

    expect(result.signatures).not.toContain("RETRYABLE_CODES")
    expect(result.types).not.toContain("BollardErrorOptions")
  })

  it("extracts runner.ts signatures without implementation logic", async () => {
    const source = await readSource("engine/src/runner.ts")
    const result = extractSignatures("engine/src/runner.ts", source)

    expect(result.signatures).toContain("runBlueprint")
    expect(result.signatures).toContain("{ ... }")

    expect(result.signatures).not.toContain("ctx.costTracker")
    expect(result.signatures).not.toContain("checkPostconditions")
    expect(result.signatures).not.toContain("executeNode")
  })

  it("does not leak implementation keywords in cost-tracker output", async () => {
    const source = await readSource("engine/src/cost-tracker.ts")
    const result = extractSignatures("engine/src/cost-tracker.ts", source)

    const combined = `${result.imports}\n${result.types}\n${result.signatures}`

    expect(combined).not.toContain("Math.max")
    expect(combined).not.toContain("this._total")
    expect(combined).not.toContain("this._limit")
  })
})

describe("extractPrivateIdentifiers", () => {
  it("returns private class fields from cost-tracker.ts", async () => {
    const source = await readSource("engine/src/cost-tracker.ts")
    const result = extractPrivateIdentifiers("engine/src/cost-tracker.ts", source)

    expect(result).toContain("_total")
    expect(result).toContain("_limit")

    expect(result).not.toContain("add")
    expect(result).not.toContain("total")
    expect(result).not.toContain("exceeded")
    expect(result).not.toContain("remaining")
  })

  it("returns non-exported variables from errors.ts", async () => {
    const source = await readSource("engine/src/errors.ts")
    const result = extractPrivateIdentifiers("engine/src/errors.ts", source)

    expect(result).toContain("RETRYABLE_CODES")
  })

  it("filters noise identifiers and single-char names", () => {
    const source = `
function helper(i: number, ctx: Context): void {
  const x = i + 1
}
export function publicFn(): void { }
`
    const result = extractPrivateIdentifiers("test.ts", source)

    expect(result).toContain("helper")
    expect(result).not.toContain("i")
    expect(result).not.toContain("x")
    expect(result).not.toContain("ctx")
    expect(result).not.toContain("publicFn")
  })
})

describe("extractTypeDefinitions", () => {
  it("extracts exported interfaces", async () => {
    const source = await readSource("detect/src/types.ts")
    const defs = extractTypeDefinitions("detect/src/types.ts", source)

    const iface = defs.find((d) => d.name === "ToolchainProfile")
    expect(iface).toBeDefined()
    expect(iface?.kind).toBe("interface")
    expect(iface?.definition).toContain("language: LanguageId")
    expect(iface?.definition).toContain("checks:")
  })

  it("extracts exported type aliases", async () => {
    const source = await readSource("engine/src/errors.ts")
    const defs = extractTypeDefinitions("engine/src/errors.ts", source)

    const typeAlias = defs.find((d) => d.name === "BollardErrorCode")
    expect(typeAlias).toBeDefined()
    expect(typeAlias?.kind).toBe("type")
    expect(typeAlias?.definition).toContain("LLM_TIMEOUT")
  })

  it("extracts exported const with type annotations", async () => {
    const source = await readSource("agents/src/tools/index.ts")
    const defs = extractTypeDefinitions("agents/src/tools/index.ts", source)

    const allTools = defs.find((d) => d.name === "ALL_TOOLS")
    expect(allTools).toBeDefined()
    expect(allTools?.kind).toBe("const")
    expect(allTools?.definition).toContain("AgentTool[]")
  })

  it("does not include non-exported types", async () => {
    const source = await readSource("engine/src/errors.ts")
    const defs = extractTypeDefinitions("engine/src/errors.ts", source)

    const names = defs.map((d) => d.name)
    expect(names).not.toContain("BollardErrorOptions")
  })
})

describe("resolveReferencedTypes", () => {
  it("resolves types referenced in function signatures", () => {
    const signatures = [
      {
        filePath: "test.ts",
        signatures: "export function detect(cwd: string): Promise<ToolchainProfile> { ... }",
        types: "",
        imports: "",
      },
    ]

    const allTypes = [
      {
        name: "ToolchainProfile",
        kind: "interface" as const,
        definition: "export interface ToolchainProfile { language: LanguageId }",
        filePath: "types.ts",
      },
      {
        name: "UnrelatedType",
        kind: "interface" as const,
        definition: "export interface UnrelatedType { x: number }",
        filePath: "other.ts",
      },
    ]

    const resolved = resolveReferencedTypes(signatures, allTypes)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.name).toBe("ToolchainProfile")
  })

  it("deduplicates resolved types", () => {
    const signatures = [
      {
        filePath: "a.ts",
        signatures: "export function a(p: MyType): MyType { ... }",
        types: "",
        imports: "",
      },
      {
        filePath: "b.ts",
        signatures: "export function b(p: MyType): void { ... }",
        types: "",
        imports: "",
      },
    ]

    const allTypes = [
      {
        name: "MyType",
        kind: "interface" as const,
        definition: "export interface MyType { x: number }",
        filePath: "types.ts",
      },
    ]

    const resolved = resolveReferencedTypes(signatures, allTypes)
    expect(resolved).toHaveLength(1)
  })
})

describe("extractSignaturesFromFiles returns ExtractionResult", () => {
  it("returns both signatures and types", async () => {
    const files = [resolve(PACKAGES_DIR, "detect/src/types.ts")]
    const result = await extractSignaturesFromFiles(files)

    expect(result.signatures).toHaveLength(1)
    expect(result.signatures[0]?.filePath).toBe(files[0])
    expect(result.types.length).toBeGreaterThan(0)
    expect(result.types.some((t) => t.name === "ToolchainProfile")).toBe(true)
  })
})

describe("SignatureExtractor implementations", () => {
  it("TsCompilerExtractor wraps extractSignaturesFromFiles", async () => {
    const extractor = new TsCompilerExtractor()
    const files = [resolve(PACKAGES_DIR, "engine/src/errors.ts")]
    const result = await extractor.extract(files)

    expect(result.signatures).toHaveLength(1)
    expect(result.signatures[0]?.signatures).toContain("BollardError")
    expect(result.types.length).toBeGreaterThan(0)
  })

  it("getExtractor returns TsCompilerExtractor for typescript", () => {
    const extractor = getExtractor("typescript")
    expect(extractor).toBeInstanceOf(TsCompilerExtractor)
  })

  it("getExtractor returns LlmFallbackExtractor for non-typescript", () => {
    expect(getExtractor("python")).toBeInstanceOf(LlmFallbackExtractor)
    expect(getExtractor("go")).toBeInstanceOf(LlmFallbackExtractor)
    expect(getExtractor("rust")).toBeInstanceOf(LlmFallbackExtractor)
  })

  it("getExtractor with provider returns LlmFallbackExtractor for python", () => {
    const provider = createMockProvider("{}")
    const extractor = getExtractor("python", provider, "test-model")
    expect(extractor).toBeInstanceOf(LlmFallbackExtractor)
  })

  it("getExtractor without provider returns noop LlmFallbackExtractor", () => {
    const extractor = getExtractor("python")
    expect(extractor).toBeInstanceOf(LlmFallbackExtractor)
  })
})

describe("LlmFallbackExtractor", () => {
  const VALID_JSON = JSON.stringify({
    signatures: [
      {
        filePath: "src/auth.py",
        signatures: "def login(user: str, password: str) -> Token: ...",
        types: "class Token:\n    value: str\n    expires_at: int",
        imports: "from dataclasses import dataclass",
      },
    ],
    types: [
      {
        name: "Token",
        kind: "interface",
        definition: "class Token:\n    value: str\n    expires_at: int",
        filePath: "src/auth.py",
      },
    ],
  })

  it("parses structured JSON from MockProvider into ExtractionResult", async () => {
    const provider = createMockProvider(VALID_JSON)
    const extractor = new LlmFallbackExtractor(provider, "test-model")
    const result = await extractor.extract([resolve(PACKAGES_DIR, "engine/src/errors.ts")])

    expect(result.signatures).toHaveLength(1)
    expect(result.signatures[0]?.filePath).toBe("src/auth.py")
    expect(result.signatures[0]?.signatures).toContain("login")
    expect(result.types).toHaveLength(1)
    expect(result.types[0]?.name).toBe("Token")
    expect(result.types[0]?.kind).toBe("interface")
  })

  it("returns empty result when provider returns garbage", async () => {
    const provider = createMockProvider("this is not json at all!!!")
    const extractor = new LlmFallbackExtractor(provider, "test-model")
    const result = await extractor.extract([resolve(PACKAGES_DIR, "engine/src/errors.ts")])

    expect(result.signatures).toHaveLength(0)
    expect(result.types).toHaveLength(0)
  })

  it("returns empty result when provider returns empty content", async () => {
    const provider = createMockProvider("")
    const extractor = new LlmFallbackExtractor(provider, "test-model")
    const result = await extractor.extract([resolve(PACKAGES_DIR, "engine/src/errors.ts")])

    expect(result.signatures).toHaveLength(0)
    expect(result.types).toHaveLength(0)
  })

  it("returns empty result when provider throws", async () => {
    const provider = createErrorProvider()
    const extractor = new LlmFallbackExtractor(provider, "test-model")
    const result = await extractor.extract([resolve(PACKAGES_DIR, "engine/src/errors.ts")])

    expect(result.signatures).toHaveLength(0)
    expect(result.types).toHaveLength(0)
  })

  it("returns empty result for empty file list", async () => {
    const provider = createMockProvider(VALID_JSON)
    const extractor = new LlmFallbackExtractor(provider, "test-model")
    const result = await extractor.extract([])

    expect(result.signatures).toHaveLength(0)
    expect(result.types).toHaveLength(0)
  })

  it("filters out types with invalid kind", async () => {
    const json = JSON.stringify({
      signatures: [],
      types: [
        { name: "Good", kind: "interface", definition: "interface Good {}", filePath: "a.py" },
        { name: "Bad", kind: "unknown-kind", definition: "???", filePath: "b.py" },
      ],
    })
    const provider = createMockProvider(json)
    const extractor = new LlmFallbackExtractor(provider, "test-model")
    const result = await extractor.extract([resolve(PACKAGES_DIR, "engine/src/errors.ts")])

    expect(result.types).toHaveLength(1)
    expect(result.types[0]?.name).toBe("Good")
  })
})
