import { createServer } from "node:http"
import type { ProbeDefinition } from "@bollard/engine/src/blueprint.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { describe, expect, it } from "vitest"

import { HttpProbeExecutor } from "../src/probe-runner.js"

function baseProbe(overrides: Partial<ProbeDefinition>): ProbeDefinition {
  return {
    id: "p1",
    name: "t",
    endpoint: "/",
    method: "GET",
    assertions: [{ type: "status", expected: 200 }],
    intervalSeconds: 60,
    riskTier: "low",
    ...overrides,
  }
}

describe("HttpProbeExecutor", () => {
  it("passes when status matches", async () => {
    const server = createServer((_, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`
    const ex = new HttpProbeExecutor({ timeoutMs: 5000 })
    const probe = baseProbe({ endpoint: "/" })
    const result = await ex.execute(probe, base)
    expect(result.status).toBe("pass")
    server.close()
  })

  it("fails assertion when status mismatches", async () => {
    const server = createServer((_, res) => {
      res.writeHead(500)
      res.end("err")
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`
    const ex = new HttpProbeExecutor()
    const probe = baseProbe({ assertions: [{ type: "status", expected: 200 }] })
    const result = await ex.execute(probe, base)
    expect(result.status).toBe("fail")
    server.close()
  })

  it("evaluates body_contains", async () => {
    const server = createServer((_, res) => {
      res.writeHead(200)
      res.end("hello world")
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`
    const ex = new HttpProbeExecutor()
    const probe = baseProbe({
      assertions: [
        { type: "status", expected: 200 },
        { type: "body_contains", expected: "world" },
      ],
    })
    const result = await ex.execute(probe, base)
    expect(result.status).toBe("pass")
    server.close()
  })

  it("throws PROBE_EXECUTION_FAILED on bad host", async () => {
    const ex = new HttpProbeExecutor({ timeoutMs: 200 })
    const probe = baseProbe({ endpoint: "/" })
    await expect(ex.execute(probe, "http://127.0.0.1:1")).rejects.toMatchObject({
      code: "PROBE_EXECUTION_FAILED",
    })
  })

  it("evaluates header assertion", async () => {
    const server = createServer((_, res) => {
      res.writeHead(200, { "x-test": "yes" })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`
    const ex = new HttpProbeExecutor()
    const probe = baseProbe({
      assertions: [
        { type: "status", expected: 200 },
        { type: "header", name: "x-test", expected: "yes" },
      ],
    })
    const result = await ex.execute(probe, base)
    expect(result.status).toBe("pass")
    server.close()
  })

  it("json_field assertion", async () => {
    const server = createServer((_, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ a: { b: 1 } }))
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`
    const ex = new HttpProbeExecutor()
    const probe = baseProbe({
      assertions: [
        { type: "status", expected: 200 },
        { type: "json_field", path: "a.b", expected: 1 },
      ],
    })
    const result = await ex.execute(probe, base)
    expect(result.status).toBe("pass")
    server.close()
  })
})

describe("BollardError", () => {
  it("is thrown for execution failures", async () => {
    const ex = new HttpProbeExecutor({ timeoutMs: 50 })
    const probe = baseProbe({ endpoint: "/" })
    try {
      await ex.execute(probe, "http://127.0.0.1:1")
      expect.fail("expected throw")
    } catch (e: unknown) {
      expect(BollardError.hasCode(e, "PROBE_EXECUTION_FAILED")).toBe(true)
    }
  })
})
