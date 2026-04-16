import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { tools } from "../src/tools.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

describe("MCP tool definitions", () => {
  it("registers exactly 8 tools", () => {
    expect(tools).toHaveLength(8)
  })

  it("all tools have name, description, inputSchema, and handler", () => {
    for (const tool of tools) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeDefined()
      expect(typeof tool.handler).toBe("function")
    }
  })

  it("includes bollard_verify tool", () => {
    const tool = tools.find((t) => t.name === "bollard_verify")
    expect(tool).toBeDefined()
    expect(tool?.description).toContain("verification")
  })

  it("includes bollard_plan tool", () => {
    const tool = tools.find((t) => t.name === "bollard_plan")
    expect(tool).toBeDefined()
    expect(tool?.description).toContain("plan")
  })

  it("includes bollard_implement tool", () => {
    const tool = tools.find((t) => t.name === "bollard_implement")
    expect(tool).toBeDefined()
    expect(tool?.description).toContain("implement")
  })

  it("includes bollard_eval tool", () => {
    const tool = tools.find((t) => t.name === "bollard_eval")
    expect(tool).toBeDefined()
    expect(tool?.description).toContain("eval")
  })

  it("includes bollard_config tool", () => {
    const tool = tools.find((t) => t.name === "bollard_config")
    expect(tool).toBeDefined()
    expect(tool?.description).toContain("configuration")
  })

  it("includes bollard_profile tool", () => {
    const tool = tools.find((t) => t.name === "bollard_profile")
    expect(tool).toBeDefined()
    expect(tool?.description).toContain("profile")
  })

  it("includes bollard_contract tool", () => {
    const tool = tools.find((t) => t.name === "bollard_contract")
    expect(tool).toBeDefined()
    expect(tool?.description).toContain("contract")
  })

  it("includes bollard_behavioral tool", () => {
    const tool = tools.find((t) => t.name === "bollard_behavioral")
    expect(tool).toBeDefined()
    expect(tool?.description).toContain("behavioral")
  })

  it("bollard_plan requires task parameter", () => {
    const tool = tools.find((t) => t.name === "bollard_plan")
    const schema = tool?.inputSchema as { required?: string[] }
    expect(schema.required).toContain("task")
  })

  it("bollard_implement requires task parameter", () => {
    const tool = tools.find((t) => t.name === "bollard_implement")
    const schema = tool?.inputSchema as { required?: string[] }
    expect(schema.required).toContain("task")
  })

  it("bollard_profile handler returns resolved profile", async () => {
    const tool = tools.find((t) => t.name === "bollard_profile")
    const result = (await tool?.handler({}, REPO_ROOT)) as {
      language: string
      adversarial: unknown
    }
    expect(result.language).toBe("typescript")
    expect(result.adversarial).toBeDefined()
  })

  it("bollard_contract handler returns contract context shape", async () => {
    const tool = tools.find((t) => t.name === "bollard_contract")
    const result = (await tool?.handler({}, REPO_ROOT)) as {
      modules: unknown[]
      edges: unknown[]
      affectedEdges: unknown[]
    }
    expect(Array.isArray(result.modules)).toBe(true)
    expect(Array.isArray(result.edges)).toBe(true)
    expect(Array.isArray(result.affectedEdges)).toBe(true)
  })

  it("bollard_plan handler returns status", async () => {
    const tool = tools.find((t) => t.name === "bollard_plan")
    const result = (await tool?.handler({ task: "test task" }, "/app")) as { status: string }
    expect(result.status).toBe("ok")
  })

  it("tool input schemas have correct structure", () => {
    for (const tool of tools) {
      const schema = tool.inputSchema as { type: string }
      expect(schema.type).toBe("object")
    }
  })
})
