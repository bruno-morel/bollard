import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resources } from "../src/resources.js"

describe("MCP resource definitions", () => {
  it("registers exactly 6 resources", () => {
    expect(resources).toHaveLength(6)
  })

  it("all resources have unique URIs starting with bollard://", () => {
    const uris = resources.map((r) => r.uri)
    expect(new Set(uris).size).toBe(uris.length)
    for (const uri of uris) {
      expect(uri.startsWith("bollard://")).toBe(true)
    }
  })

  it("all resources use application/json mime type", () => {
    for (const r of resources) {
      expect(r.mimeType).toBe("application/json")
    }
  })

  it("probes handler returns empty array JSON when .bollard/probes/ is absent", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "bollard-mcp-probes-"))
    const probeResource = resources.find((r) => r.uri === "bollard://probes")
    expect(probeResource).toBeDefined()
    if (probeResource === undefined) {
      throw new Error("expected probes resource")
    }
    const text = await probeResource.handler(emptyDir)
    expect(text).toBe(JSON.stringify([]))
    expect(JSON.parse(text)).toEqual([])
  })

  it("last-verified handler returns status when no file exists", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "bollard-mcp-verified-"))
    const lastVerified = resources.find((r) => r.uri === "bollard://last-verified")
    expect(lastVerified).toBeDefined()
    if (lastVerified === undefined) {
      throw new Error("expected last-verified resource")
    }
    const text = await lastVerified.handler(emptyDir)
    const parsed = JSON.parse(text) as { status: string }
    expect(parsed.status).toBe("no verification recorded")
  })

  it("flags handler returns empty object JSON when flags file is absent", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "bollard-mcp-flags-"))
    const flagsResource = resources.find((r) => r.uri === "bollard://flags")
    expect(flagsResource).toBeDefined()
    if (flagsResource === undefined) {
      throw new Error("expected flags resource")
    }
    const text = await flagsResource.handler(emptyDir)
    expect(text).toBe(JSON.stringify({}))
    expect(JSON.parse(text)).toEqual({})
  })
})
