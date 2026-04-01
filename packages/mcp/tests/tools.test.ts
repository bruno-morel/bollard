import { describe, expect, it } from "vitest"
import { tools } from "../src/tools.js"

describe("MCP tool definitions", () => {
  it("registers exactly 6 tools", () => {
    expect(tools).toHaveLength(6)
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

  it("bollard_profile handler detects toolchain", async () => {
    const tool = tools.find((t) => t.name === "bollard_profile")
    const result = (await tool?.handler({}, "/app")) as { language: string }
    expect(result.language).toBe("typescript")
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
