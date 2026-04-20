import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { buildBehavioralContext } from "../src/behavioral-extractor.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

function profileFor(lang: ToolchainProfile["language"]): ToolchainProfile {
  return {
    language: lang,
    packageManager: "pnpm",
    checks: {},
    sourcePatterns: ["**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: [],
    adversarial: defaultAdversarialConfig({ language: lang }),
  }
}

async function makeTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bollard-beh-"))
}

describe("buildBehavioralContext", () => {
  it("returns empty context for unknown language with warning", async () => {
    const warnings: string[] = []
    const dir = await makeTempProject()
    const p = profileFor("typescript")
    const prof = { ...p, language: "java" as ToolchainProfile["language"] }
    const ctx = await buildBehavioralContext(prof, dir, (m) => warnings.push(m))
    expect(ctx.endpoints).toHaveLength(0)
    expect(ctx.dependencies).toHaveLength(0)
    expect(warnings.some((w) => w.includes("not supported"))).toBe(true)
  })

  it("extracts Express routes from TypeScript", async () => {
    const dir = await makeTempProject()
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(
      join(dir, "src", "routes.ts"),
      `
import express from 'express'
const app = express()
app.get('/api/health', () => {})
app.post('/v1/users', () => {})
`,
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("typescript"), dir)
    expect(ctx.endpoints.some((e) => e.path === "/api/health" && e.method === "GET")).toBe(true)
    expect(ctx.endpoints.some((e) => e.path === "/v1/users" && e.method === "POST")).toBe(true)
  })

  it("extracts Fastify routes", async () => {
    const dir = await makeTempProject()
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(
      join(dir, "src", "app.ts"),
      `
import fastify from 'fastify'
const app = fastify()
app.get('/x', async () => {})
`,
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("typescript"), dir)
    expect(ctx.endpoints.some((e) => e.path === "/x")).toBe(true)
  })

  it("extracts Nest-style decorators", async () => {
    const dir = await makeTempProject()
    await writeFile(
      join(dir, "ctrl.ts"),
      `
@Get('/users')
class C {}
`,
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("typescript"), dir)
    expect(ctx.endpoints.some((e) => e.path === "/users")).toBe(true)
  })

  it("extracts FastAPI routes from Python", async () => {
    const dir = await makeTempProject()
    await writeFile(
      join(dir, "main.py"),
      `
from fastapi import FastAPI
app = FastAPI()
@app.get("/items")
def items(): ...
`,
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("python"), dir)
    expect(ctx.endpoints.some((e) => e.path === "/items")).toBe(true)
  })

  it("extracts Django path() routes", async () => {
    const dir = await makeTempProject()
    await writeFile(
      join(dir, "urls.py"),
      `
from django.urls import path
urlpatterns = [path("admin/", admin.site.urls)]
`,
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("python"), dir)
    expect(ctx.endpoints.some((e) => e.path === "admin/")).toBe(true)
  })

  it("extracts Go http.HandleFunc and Echo routes", async () => {
    const dir = await makeTempProject()
    await writeFile(
      join(dir, "main.go"),
      `
package main
import "net/http"
func main() {
  http.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {})
}
`,
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("go"), dir)
    expect(ctx.endpoints.some((e) => e.path === "/ping")).toBe(true)
  })

  it("extracts Echo GET routes", async () => {
    const dir = await makeTempProject()
    await writeFile(
      join(dir, "srv.go"),
      `
package main
func x() {
  e.GET("/hello", handler)
}
`,
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("go"), dir)
    expect(ctx.endpoints.some((e) => e.path === "/hello")).toBe(true)
  })

  it("extracts Rust actix route attributes", async () => {
    const dir = await makeTempProject()
    await writeFile(
      join(dir, "main.rs"),
      `
#[get("/api/status")]
async fn status() {}
`,
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("rust"), dir)
    expect(ctx.endpoints.some((e) => e.path === "/api/status")).toBe(true)
  })

  it("extracts process.env CONFIG keys from TypeScript", async () => {
    const dir = await makeTempProject()
    await writeFile(
      join(dir, "cfg.ts"),
      "void process.env.PORT\nvoid process.env.DATABASE_URL\n",
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("typescript"), dir)
    expect(ctx.config.some((c) => c.key === "PORT")).toBe(true)
    expect(ctx.config.some((c) => c.key === "DATABASE_URL")).toBe(true)
  })

  it("extracts os.environ from Python", async () => {
    const dir = await makeTempProject()
    await writeFile(join(dir, "c.py"), "x = os.environ['FOO']\ny = os.getenv('BAR')\n", "utf-8")
    const ctx = await buildBehavioralContext(profileFor("python"), dir)
    expect(ctx.config.some((c) => c.key === "FOO")).toBe(true)
    expect(ctx.config.some((c) => c.key === "BAR")).toBe(true)
  })

  it("extracts os.Getenv from Go", async () => {
    const dir = await makeTempProject()
    await writeFile(
      join(dir, "cfg.go"),
      'package main\nimport "os"\nvar _ = os.Getenv("HOME")\n',
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("go"), dir)
    expect(ctx.config.some((c) => c.key === "HOME")).toBe(true)
  })

  it("extracts std::env::var from Rust", async () => {
    const dir = await makeTempProject()
    await writeFile(join(dir, "cfg.rs"), 'let _ = std::env::var("RUST_LOG");\n', "utf-8")
    const ctx = await buildBehavioralContext(profileFor("rust"), dir)
    expect(ctx.config.some((c) => c.key === "RUST_LOG")).toBe(true)
  })

  it("reads keys from .env file", async () => {
    const dir = await makeTempProject()
    await writeFile(join(dir, ".env"), "SECRET_KEY=abc\n# comment\nOTHER=1\n", "utf-8")
    const ctx = await buildBehavioralContext(profileFor("typescript"), dir)
    expect(ctx.config.some((c) => c.key === "SECRET_KEY" && c.source === "file")).toBe(true)
  })

  it("detects pg dependency from imports", async () => {
    const dir = await makeTempProject()
    await writeFile(join(dir, "db.ts"), 'import pg from "pg"\n', "utf-8")
    const ctx = await buildBehavioralContext(profileFor("typescript"), dir)
    expect(ctx.dependencies.some((d) => d.name === "postgres")).toBe(true)
  })

  it("detects axios and LLM SDK deps", async () => {
    const dir = await makeTempProject()
    await writeFile(
      join(dir, "c.ts"),
      `import axios from "axios"
import OpenAI from "openai"
`,
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("typescript"), dir)
    expect(ctx.dependencies.some((d) => d.clientLibrary === "axios")).toBe(true)
    expect(ctx.dependencies.some((d) => d.name === "openai-api")).toBe(true)
  })

  it("builds failure modes from dependency types", async () => {
    const dir = await makeTempProject()
    await writeFile(join(dir, "db.ts"), 'import pg from "pg"\n', "utf-8")
    const ctx = await buildBehavioralContext(profileFor("typescript"), dir)
    expect(ctx.failureModes.some((f) => f.mode === "timeout")).toBe(true)
    expect(ctx.failureModes.some((f) => f.mode === "connection_refused")).toBe(true)
  })

  it("marks empty project as no endpoints and no deps", async () => {
    const dir = await makeTempProject()
    await writeFile(join(dir, "empty.ts"), "// noop\n", "utf-8")
    const ctx = await buildBehavioralContext(profileFor("typescript"), dir)
    expect(ctx.endpoints).toHaveLength(0)
    expect(ctx.dependencies).toHaveLength(0)
  })

  it("integration: Bollard repo exposes MCP and LLM deps and env keys", async () => {
    const ctx = await buildBehavioralContext(profileFor("typescript"), REPO_ROOT)
    expect(ctx.dependencies.length).toBeGreaterThan(0)
    const libs = ctx.dependencies.map((d) => d.clientLibrary).join(" ")
    expect(libs).toMatch(
      /@anthropic-ai\/sdk|openai|@google\/generative-ai|@modelcontextprotocol\/sdk/,
    )
    expect(ctx.config.some((c) => c.key === "ANTHROPIC_API_KEY")).toBe(true)
  }, 20_000)

  it("extracts JavaScript app routes", async () => {
    const dir = await makeTempProject()
    await writeFile(
      join(dir, "index.js"),
      `
const app = require('express')()
app.get('/js', () => {})
`,
      "utf-8",
    )
    const ctx = await buildBehavioralContext(profileFor("javascript"), dir)
    expect(ctx.endpoints.some((e) => e.path === "/js")).toBe(true)
  })
})
