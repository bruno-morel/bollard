import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { createInterface } from "node:readline"
import type { BlueprintNode } from "@bollard/engine/src/blueprint.js"
import { createContext } from "@bollard/engine/src/context.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import { humanGateHandler } from "../src/human-gate.js"

vi.mock("node:readline", () => ({
  createInterface: vi.fn(),
}))

const testConfig: BollardConfig = {
  llm: { default: { provider: "mock", model: "m" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

function baseNode(id: string): BlueprintNode {
  return { id, name: "Human gate", type: "human_gate" }
}

function makeCtx() {
  return createContext("task", "bp", testConfig)
}

describe("humanGateHandler", () => {
  let mockRl: { question: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  let origAuto: string | undefined

  beforeEach(() => {
    origAuto = process.env["BOLLARD_AUTO_APPROVE"]
    delete process.env["BOLLARD_AUTO_APPROVE"]
    mockRl = { question: vi.fn(), close: vi.fn() }
    vi.mocked(createInterface).mockReturnValue(mockRl as never)
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (origAuto !== undefined) process.env["BOLLARD_AUTO_APPROVE"] = origAuto
    else delete process.env["BOLLARD_AUTO_APPROVE"]
  })

  it("returns ok when user confirms with y", async () => {
    mockRl.question.mockImplementation((_p, cb: (a: string) => void) => {
      cb("y")
    })
    const r = await humanGateHandler(baseNode("gate-1"), makeCtx())
    expect(r.status).toBe("ok")
    expect(String(r.data)).toContain("Approved")
  })

  it("returns block when user rejects with n", async () => {
    mockRl.question.mockImplementation((_p, cb: (a: string) => void) => {
      cb("n")
    })
    const r = await humanGateHandler(baseNode("gate-2"), makeCtx())
    expect(r.status).toBe("block")
    expect(r.error?.code).toBe("HUMAN_REJECTED")
  })

  it("treats y as approve", async () => {
    mockRl.question.mockImplementation((_p, cb: (a: string) => void) => {
      cb("y")
    })
    const r = await humanGateHandler(baseNode("gate-3"), makeCtx())
    expect(r.status).toBe("ok")
  })

  it("closes readline after use", async () => {
    mockRl.question.mockImplementation((_p, cb: (a: string) => void) => {
      cb("y")
    })
    await humanGateHandler(baseNode("gate-4"), makeCtx())
    expect(mockRl.close).toHaveBeenCalled()
  })
})

describe("humanGateHandler property tests", () => {
  let mockRl: { question: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  let origAuto: string | undefined

  beforeEach(() => {
    origAuto = process.env["BOLLARD_AUTO_APPROVE"]
    delete process.env["BOLLARD_AUTO_APPROVE"]
    mockRl = { question: vi.fn(), close: vi.fn() }
    vi.mocked(createInterface).mockReturnValue(mockRl as never)
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (origAuto !== undefined) process.env["BOLLARD_AUTO_APPROVE"] = origAuto
    else delete process.env["BOLLARD_AUTO_APPROVE"]
  })

  it("maps answers to ok or block", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (answer) => {
        mockRl.question.mockImplementation((_p, cb: (a: string) => void) => {
          cb(answer)
        })
        const r = await humanGateHandler(baseNode("g"), makeCtx())
        expect(r.status === "ok" || r.status === "block").toBe(true)
      }),
    )
  })
})
