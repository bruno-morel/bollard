import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildContractContext } from "../src/contract-extractor.js"

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(THIS_DIR, "../../..")

const tsProfile: ToolchainProfile = {
  language: "typescript",
  packageManager: "pnpm",
  checks: {
    test: {
      label: "Vitest",
      cmd: "pnpm",
      args: ["run", "test"],
      source: "auto-detected",
    },
  },
  sourcePatterns: ["**/*.ts"],
  testPatterns: ["**/*.test.ts"],
  ignorePatterns: [],
  allowedCommands: ["pnpm"],
  adversarial: defaultAdversarialConfig({ language: "typescript" }),
}

describe("buildContractContext", () => {
  it("returns empty graph for Python profile against a TS-only workspace", async () => {
    const py: ToolchainProfile = {
      ...tsProfile,
      language: "python",
      adversarial: defaultAdversarialConfig({ language: "python" }),
    }
    const warn = vi.fn()
    const ctx = await buildContractContext([], py, REPO_ROOT, warn)
    expect(ctx.modules).toHaveLength(0)
    expect(ctx.edges).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
  })

  it("builds a bounded workspace graph for the Bollard monorepo", async () => {
    const ctx = await buildContractContext([], tsProfile, REPO_ROOT)
    expect(ctx.modules.length).toBeGreaterThan(0)
    expect(ctx.modules.length).toBeLessThanOrEqual(50)
    expect(ctx.edges.length).toBeGreaterThan(0)
    expect(ctx.edges.length).toBeLessThanOrEqual(200)
  })

  it("narrows affectedEdges when affected files touch specific packages", async () => {
    const ctx = await buildContractContext(["packages/engine/src/errors.ts"], tsProfile, REPO_ROOT)
    expect(ctx.affectedEdges.length).toBeLessThanOrEqual(ctx.edges.length)
  })

  it("does not leak private CostTracker fields into serialized context", async () => {
    const sourcePath = "packages/engine/src/cost-tracker.ts"
    const raw = await readFile(resolve(REPO_ROOT, sourcePath), "utf-8")
    expect(raw).toContain("_total")

    const ctx = await buildContractContext([sourcePath], tsProfile, REPO_ROOT)
    const blob = JSON.stringify(ctx)
    expect(blob).not.toContain("_total")
    expect(blob).not.toContain("_limit")
  })

  it("does not leak internal implementation identifiers into serialized contract context", async () => {
    const ctx = await buildContractContext([], tsProfile, REPO_ROOT)
    const blob = JSON.stringify(ctx)
    expect(blob).not.toContain("compactOlderTurns")
    expect(blob).not.toContain("skipVerificationAfterTurn")
    expect(blob).not.toContain("processConcernBlocks")
    expect(blob).not.toContain("extractClassSignature")
  })

  it("returns empty graph and warns for an unimplemented language provider", async () => {
    const ruby: ToolchainProfile = {
      ...tsProfile,
      language: "ruby",
      adversarial: defaultAdversarialConfig({ language: "ruby" }),
    }
    const warn = vi.fn()
    const ctx = await buildContractContext([], ruby, REPO_ROOT, warn)
    expect(ctx).toEqual({ modules: [], edges: [], affectedEdges: [] })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain("ruby")
    expect(warn.mock.calls[0]?.[0]).toContain("provider not implemented")
  })

  it("routes TypeScript profile through the provider and returns modules", async () => {
    const ctx = await buildContractContext([], tsProfile, REPO_ROOT)
    expect(ctx.modules.length).toBeGreaterThan(0)
    const languages = new Set(ctx.modules.map((m) => m.language))
    expect(languages).toEqual(new Set(["typescript"]))
  })
})

// ── Python contract graph provider tests ──────────────────────────────

describe("PythonContractProvider", () => {
  let tempDir: string

  const pyProfile: ToolchainProfile = {
    language: "python",
    packageManager: "pip",
    checks: {
      test: {
        label: "pytest",
        cmd: "pytest",
        args: [],
        source: "auto-detected",
      },
    },
    sourcePatterns: ["**/*.py"],
    testPatterns: ["**/test_*.py"],
    ignorePatterns: [],
    allowedCommands: ["python3", "pytest"],
    adversarial: defaultAdversarialConfig({ language: "python" }),
  }

  async function writeFixture(relPath: string, content: string): Promise<void> {
    const abs = join(tempDir, relPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, "utf-8")
  }

  beforeEach(async () => {
    tempDir = join(tmpdir(), `bollard-py-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("discovers multi-package workspace with cross-package import", async () => {
    await writeFixture(
      "packages/alpha/pyproject.toml",
      '[project]\nname = "alpha"\nversion = "0.1.0"\n',
    )
    await writeFixture("packages/alpha/__init__.py", "from .core import greet\n")
    await writeFixture("packages/alpha/core.py", "def greet(name):\n    return f'Hello, {name}'\n")
    await writeFixture(
      "packages/beta/pyproject.toml",
      '[project]\nname = "beta"\nversion = "0.1.0"\n',
    )
    await writeFixture("packages/beta/__init__.py", "from .handler import handle\n")
    await writeFixture(
      "packages/beta/handler.py",
      "import alpha\n\ndef handle():\n    return alpha.greet('world')\n",
    )

    const ctx = await buildContractContext([], pyProfile, tempDir)

    expect(ctx.modules).toHaveLength(2)
    const ids = ctx.modules.map((m) => m.id).sort()
    expect(ids).toEqual(["alpha", "beta"])

    const alpha = ctx.modules.find((m) => m.id === "alpha")
    expect(alpha?.language).toBe("python")
    expect(alpha?.publicExports.some((s) => s.signatures.includes("greet"))).toBe(true)

    expect(ctx.edges).toHaveLength(1)
    expect(ctx.edges[0]?.from).toBe("beta")
    expect(ctx.edges[0]?.to).toBe("alpha")
    expect(ctx.edges[0]?.importedSymbols).toContain("alpha")
  })

  it("limits public surface when __all__ is defined", async () => {
    await writeFixture(
      "packages/mypkg/pyproject.toml",
      '[project]\nname = "mypkg"\nversion = "0.1.0"\n',
    )
    await writeFixture(
      "packages/mypkg/__init__.py",
      '__all__ = ["public_fn"]\nfrom .pub import public_fn\nfrom .priv import private_fn\n',
    )
    await writeFixture("packages/mypkg/pub.py", "def public_fn():\n    return 'public'\n")
    await writeFixture("packages/mypkg/priv.py", "def private_fn():\n    return 'private'\n")

    const ctx = await buildContractContext([], pyProfile, tempDir)

    expect(ctx.modules).toHaveLength(1)
    const mod = ctx.modules[0]
    expect(mod?.id).toBe("mypkg")

    const allSigs = mod?.publicExports.flatMap((s) => s.signatures) ?? []
    const joined = allSigs.join("\n")
    expect(joined).toContain("public_fn")
    expect(joined).not.toContain("private_fn")
  })

  it("returns empty graph and warns for an empty workspace", async () => {
    const warn = vi.fn()
    const ctx = await buildContractContext([], pyProfile, tempDir, warn)

    expect(ctx).toEqual({ modules: [], edges: [], affectedEdges: [] })
    expect(warn).toHaveBeenCalled()
  })

  it("filters affectedEdges based on affected files", async () => {
    await writeFixture(
      "packages/alpha/pyproject.toml",
      '[project]\nname = "alpha"\nversion = "0.1.0"\n',
    )
    await writeFixture("packages/alpha/__init__.py", "from .core import greet\n")
    await writeFixture("packages/alpha/core.py", "def greet(name):\n    return f'Hello, {name}'\n")
    await writeFixture(
      "packages/beta/pyproject.toml",
      '[project]\nname = "beta"\nversion = "0.1.0"\n',
    )
    await writeFixture("packages/beta/__init__.py", "from .handler import handle\n")
    await writeFixture(
      "packages/beta/handler.py",
      "import alpha\n\ndef handle():\n    return alpha.greet('world')\n",
    )
    await writeFixture(
      "packages/gamma/pyproject.toml",
      '[project]\nname = "gamma"\nversion = "0.1.0"\n',
    )
    await writeFixture("packages/gamma/__init__.py", "from .util import helper\n")
    await writeFixture("packages/gamma/util.py", "def helper():\n    return 42\n")

    const ctx = await buildContractContext(["packages/alpha/core.py"], pyProfile, tempDir)

    expect(ctx.edges.length).toBeGreaterThanOrEqual(1)
    expect(ctx.affectedEdges).toHaveLength(1)
    expect(ctx.affectedEdges[0]?.from).toBe("beta")
    expect(ctx.affectedEdges[0]?.to).toBe("alpha")
  })

  it("falls back to __init__.py directories when no nested pyproject.toml", async () => {
    await writeFixture("pyproject.toml", '[project]\nname = "myapp"\nversion = "0.1.0"\n')
    await writeFixture("auth/__init__.py", "def login():\n    return 'logged in'\n")
    await writeFixture(
      "billing/__init__.py",
      "import auth\n\ndef charge():\n    return auth.login()\n",
    )

    const ctx = await buildContractContext([], pyProfile, tempDir)

    expect(ctx.modules).toHaveLength(2)
    const ids = ctx.modules.map((m) => m.id).sort()
    expect(ids).toEqual(["auth", "billing"])

    expect(ctx.edges).toHaveLength(1)
    expect(ctx.edges[0]?.from).toBe("billing")
    expect(ctx.edges[0]?.to).toBe("auth")
  })
})

// ── Go contract graph provider tests ──────────────────────────────────

describe("GoContractProvider", () => {
  let tempDir: string

  const goProfile: ToolchainProfile = {
    language: "go",
    packageManager: "go",
    checks: {
      test: {
        label: "go test",
        cmd: "go",
        args: ["test", "./..."],
        source: "auto-detected",
      },
    },
    sourcePatterns: ["**/*.go"],
    testPatterns: ["**/*_test.go"],
    ignorePatterns: [],
    allowedCommands: ["go"],
    adversarial: defaultAdversarialConfig({ language: "go" }),
  }

  async function writeFixture(relPath: string, content: string): Promise<void> {
    const abs = join(tempDir, relPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, "utf-8")
  }

  beforeEach(async () => {
    tempDir = join(tmpdir(), `bollard-go-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("discovers multi-module workspace via go.work with cross-module edge", async () => {
    await writeFixture("go.work", "go 1.22\n\nuse (\n\t./svc/auth\n\t./svc/billing\n)\n")
    await writeFixture("svc/auth/go.mod", "module example.com/myapp/svc/auth\n\ngo 1.22\n")
    await writeFixture(
      "svc/auth/auth.go",
      "package auth\n\nfunc Login(user string) error { return nil }\n",
    )
    await writeFixture("svc/billing/go.mod", "module example.com/myapp/svc/billing\n\ngo 1.22\n")
    await writeFixture(
      "svc/billing/billing.go",
      'package billing\n\nimport "example.com/myapp/svc/auth"\n\nfunc Charge() { auth.Login("x") }\n',
    )

    const ctx = await buildContractContext([], goProfile, tempDir)

    expect(ctx.modules).toHaveLength(2)
    const ids = ctx.modules.map((m) => m.id).sort()
    expect(ids).toEqual(["example.com/myapp/svc/auth", "example.com/myapp/svc/billing"])

    const authMod = ctx.modules.find((m) => m.id === "example.com/myapp/svc/auth")
    expect(authMod?.language).toBe("go")
    expect(authMod?.publicExports.some((s) => s.signatures.includes("Login"))).toBe(true)

    expect(ctx.edges).toHaveLength(1)
    expect(ctx.edges[0]?.from).toBe("example.com/myapp/svc/billing")
    expect(ctx.edges[0]?.to).toBe("example.com/myapp/svc/auth")
    expect(ctx.edges[0]?.importedSymbols).toContain("auth")
  })

  it("falls back to single-module when no go.work exists", async () => {
    await writeFixture("go.mod", "module example.com/mylib\n\ngo 1.22\n")
    await writeFixture("mylib.go", 'package mylib\n\nfunc Hello() string { return "hi" }\n')

    const ctx = await buildContractContext([], goProfile, tempDir)

    expect(ctx.modules).toHaveLength(1)
    expect(ctx.modules[0]?.id).toBe("example.com/mylib")
    expect(ctx.modules[0]?.publicExports.some((s) => s.signatures.includes("Hello"))).toBe(true)
    expect(ctx.edges).toHaveLength(0)
  })

  it("excludes internal/ packages from public surface", async () => {
    await writeFixture("go.mod", "module example.com/myapp\n\ngo 1.22\n")
    await writeFixture("api/handler.go", "package api\n\nfunc Handle() {}\n")
    await writeFixture("internal/secret/secret.go", "package secret\n\nfunc Hidden() {}\n")

    const ctx = await buildContractContext([], goProfile, tempDir)

    expect(ctx.modules).toHaveLength(1)
    const mod = ctx.modules[0]
    const allSigs = mod?.publicExports.flatMap((s) => s.signatures) ?? []
    const joined = allSigs.join("\n")
    expect(joined).toContain("Handle")
    expect(joined).not.toContain("Hidden")
  })

  it("returns empty graph and warns for an empty workspace", async () => {
    const warn = vi.fn()
    const ctx = await buildContractContext([], goProfile, tempDir, warn)

    expect(ctx).toEqual({ modules: [], edges: [], affectedEdges: [] })
    expect(warn).toHaveBeenCalled()
  })

  it("filters affectedEdges based on affected files", async () => {
    await writeFixture("go.work", "go 1.22\n\nuse (\n\t./svc/auth\n\t./svc/billing\n)\n")
    await writeFixture("svc/auth/go.mod", "module example.com/myapp/svc/auth\n\ngo 1.22\n")
    await writeFixture(
      "svc/auth/auth.go",
      "package auth\n\nfunc Login(user string) error { return nil }\n",
    )
    await writeFixture("svc/billing/go.mod", "module example.com/myapp/svc/billing\n\ngo 1.22\n")
    await writeFixture(
      "svc/billing/billing.go",
      'package billing\n\nimport "example.com/myapp/svc/auth"\n\nfunc Charge() { auth.Login("x") }\n',
    )

    const ctx = await buildContractContext(["svc/auth/auth.go"], goProfile, tempDir)

    expect(ctx.edges.length).toBeGreaterThanOrEqual(1)
    expect(ctx.affectedEdges).toHaveLength(1)
    expect(ctx.affectedEdges[0]?.from).toBe("example.com/myapp/svc/billing")
    expect(ctx.affectedEdges[0]?.to).toBe("example.com/myapp/svc/auth")
  })
})

// ── Rust contract graph provider tests ────────────────────────────────

describe("RustContractProvider", () => {
  let tempDir: string

  const rustProfile: ToolchainProfile = {
    language: "rust",
    packageManager: "cargo",
    checks: {
      test: {
        label: "cargo test",
        cmd: "cargo",
        args: ["test"],
        source: "auto-detected",
      },
    },
    sourcePatterns: ["**/*.rs"],
    testPatterns: ["**/*_test.rs"],
    ignorePatterns: [],
    allowedCommands: ["cargo"],
    adversarial: defaultAdversarialConfig({ language: "rust" }),
  }

  async function writeFixture(relPath: string, content: string): Promise<void> {
    const abs = join(tempDir, relPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, "utf-8")
  }

  beforeEach(async () => {
    tempDir = join(tmpdir(), `bollard-rs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("discovers Cargo workspace with cross-crate import", async () => {
    await writeFixture("Cargo.toml", '[workspace]\nmembers = ["crates/auth", "crates/billing"]\n')
    await writeFixture(
      "crates/auth/Cargo.toml",
      '[package]\nname = "auth"\nversion = "0.1.0"\nedition = "2021"\n',
    )
    await writeFixture("crates/auth/src/lib.rs", "pub fn login(user: &str) -> bool { true }\n")
    await writeFixture(
      "crates/billing/Cargo.toml",
      '[package]\nname = "billing"\nversion = "0.1.0"\nedition = "2021"\n',
    )
    await writeFixture(
      "crates/billing/src/lib.rs",
      'use auth::login;\npub fn charge() { login("x"); }\n',
    )

    const ctx = await buildContractContext([], rustProfile, tempDir)

    expect(ctx.modules).toHaveLength(2)
    const ids = ctx.modules.map((m) => m.id).sort()
    expect(ids).toEqual(["auth", "billing"])

    const authMod = ctx.modules.find((m) => m.id === "auth")
    expect(authMod?.language).toBe("rust")
    expect(authMod?.publicExports.some((s) => s.signatures.includes("login"))).toBe(true)

    expect(ctx.edges).toHaveLength(1)
    expect(ctx.edges[0]?.from).toBe("billing")
    expect(ctx.edges[0]?.to).toBe("auth")
    expect(ctx.edges[0]?.importedSymbols).toContain("auth")
  })

  it("falls back to single-crate when no [workspace]", async () => {
    await writeFixture(
      "Cargo.toml",
      '[package]\nname = "mylib"\nversion = "0.1.0"\nedition = "2021"\n',
    )
    await writeFixture("src/lib.rs", 'pub fn hello() -> String { String::from("hi") }\n')

    const ctx = await buildContractContext([], rustProfile, tempDir)

    expect(ctx.modules).toHaveLength(1)
    expect(ctx.modules[0]?.id).toBe("mylib")
    expect(ctx.modules[0]?.publicExports.some((s) => s.signatures.includes("hello"))).toBe(true)
    expect(ctx.edges).toHaveLength(0)
  })

  it("filters pub(crate) items from public surface", async () => {
    await writeFixture(
      "Cargo.toml",
      '[package]\nname = "mylib"\nversion = "0.1.0"\nedition = "2021"\n',
    )
    await writeFixture("src/lib.rs", "pub fn public_fn() {}\npub(crate) fn internal_fn() {}\n")

    const ctx = await buildContractContext([], rustProfile, tempDir)

    expect(ctx.modules).toHaveLength(1)
    const mod = ctx.modules[0]
    const allSigs = mod?.publicExports.flatMap((s) => s.signatures) ?? []
    const joined = allSigs.join("\n")
    expect(joined).toContain("public_fn")
    expect(joined).not.toContain("internal_fn")
  })

  it("returns empty graph and warns for an empty workspace", async () => {
    const warn = vi.fn()
    const ctx = await buildContractContext([], rustProfile, tempDir, warn)

    expect(ctx).toEqual({ modules: [], edges: [], affectedEdges: [] })
    expect(warn).toHaveBeenCalled()
  })

  it("normalizes hyphens to underscores for cross-crate edge matching", async () => {
    await writeFixture(
      "Cargo.toml",
      '[workspace]\nmembers = ["crates/my-crate", "crates/consumer"]\n',
    )
    await writeFixture(
      "crates/my-crate/Cargo.toml",
      '[package]\nname = "my-crate"\nversion = "0.1.0"\nedition = "2021"\n',
    )
    await writeFixture("crates/my-crate/src/lib.rs", "pub fn do_stuff() {}\n")
    await writeFixture(
      "crates/consumer/Cargo.toml",
      '[package]\nname = "consumer"\nversion = "0.1.0"\nedition = "2021"\n',
    )
    await writeFixture(
      "crates/consumer/src/lib.rs",
      "use my_crate::do_stuff;\npub fn run() { do_stuff(); }\n",
    )

    const ctx = await buildContractContext([], rustProfile, tempDir)

    expect(ctx.modules).toHaveLength(2)
    expect(ctx.edges).toHaveLength(1)
    expect(ctx.edges[0]?.from).toBe("consumer")
    expect(ctx.edges[0]?.to).toBe("my-crate")
  })
})
