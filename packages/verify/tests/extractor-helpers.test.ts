import { execFile } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const GO_FIXTURE = resolve(THIS_DIR, "fixtures/extractor-helpers/go/sample.go")
const RUST_FIXTURE = resolve(THIS_DIR, "fixtures/extractor-helpers/rust/sample.rs")

interface ExtractedSignature {
  filePath: string
  signatures: string
  types: string
  imports: string
}

interface ExtractedTypeDefinition {
  name: string
  kind: "interface" | "type" | "enum" | "const"
  definition: string
  filePath: string
}

interface HelperResult {
  signatures: ExtractedSignature[]
  types: ExtractedTypeDefinition[]
  warnings?: string[]
}

describe("bollard-extract-go helper", () => {
  it("extracts exported items and skips private ones from a Go file", async () => {
    const { stdout } = await execFileAsync("bollard-extract-go", [GO_FIXTURE], {
      cwd: dirname(GO_FIXTURE),
      timeout: 30_000,
    })

    const result: HelperResult = JSON.parse(stdout)

    expect(result.signatures).toBeInstanceOf(Array)
    expect(result.signatures.length).toBe(1)
    expect(result.types).toBeInstanceOf(Array)

    const sig = result.signatures[0]
    expect(sig).toBeDefined()
    expect(sig?.filePath).toBe(GO_FIXTURE)
    expect(sig?.signatures).toContain("NewConfig")
    expect(sig?.signatures).toContain("Greeter")
    expect(sig?.signatures).toContain("Config")
    expect(sig?.signatures).not.toContain("helperPrivate")

    const typeNames = result.types.map((t) => t.name)
    expect(typeNames).toContain("Greeter")
    expect(typeNames).toContain("Config")

    const greeter = result.types.find((t) => t.name === "Greeter")
    expect(greeter?.kind).toBe("interface")

    const config = result.types.find((t) => t.name === "Config")
    expect(config?.kind).toBe("type")
  })
})

describe("bollard-extract-rs helper", () => {
  it("extracts pub items and skips private ones from a Rust file", async () => {
    const { stdout } = await execFileAsync("bollard-extract-rs", [RUST_FIXTURE], {
      cwd: dirname(RUST_FIXTURE),
      timeout: 30_000,
    })

    const result: HelperResult = JSON.parse(stdout)

    expect(result.signatures).toBeInstanceOf(Array)
    expect(result.signatures.length).toBe(1)
    expect(result.types).toBeInstanceOf(Array)

    const sig = result.signatures[0]
    expect(sig).toBeDefined()
    expect(sig?.signatures).toContain("create_registry")
    expect(sig?.signatures).toContain("Registry")
    expect(sig?.signatures).toContain("Status")
    expect(sig?.signatures).toContain("Processor")
    expect(sig?.signatures).not.toContain("internal_helper")

    const typeNames = result.types.map((t) => t.name)
    expect(typeNames).toContain("Registry")
    expect(typeNames).toContain("Status")
    expect(typeNames).toContain("Processor")

    const proc = result.types.find((t) => t.name === "Processor")
    expect(proc?.kind).toBe("interface")

    const status = result.types.find((t) => t.name === "Status")
    expect(status?.kind).toBe("enum")
  })
})

describe("helper error handling", () => {
  it("returns empty signatures with warnings for unparseable files", async () => {
    const { stdout: goOut } = await execFileAsync(
      "bollard-extract-go",
      [join(dirname(GO_FIXTURE), "nonexistent.go")],
      { cwd: dirname(GO_FIXTURE), timeout: 30_000 },
    )
    const goResult: HelperResult = JSON.parse(goOut)
    expect(goResult.warnings).toBeDefined()
    expect(goResult.warnings?.length).toBeGreaterThan(0)
    expect(goResult.signatures[0]?.signatures).toBe("")
  })
})
