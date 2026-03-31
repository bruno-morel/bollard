import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { humanGateHandler } from "../src/human-gate.js"
import type { BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"

// Mock readline to control user input
vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn(),
  })),
}))

describe("Feature: Human gate handler processes user confirmation", () => {
  let mockReadline: any
  
  beforeEach(() => {
    const { createInterface } = await import("node:readline")
    mockReadline = {
      question: vi.fn(),
      close: vi.fn(),
    }
    vi.mocked(createInterface).mockReturnValue(mockReadline)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("should return success when user confirms with 'y'", async () => {
    mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
      callback("y")
    })

    const node: BlueprintNode = {
      id: "gate-1",
      type: "human-gate",
      config: { message: "Continue?" }
    }
    const ctx: PipelineContext = {
      variables: new Map(),
      artifacts: new Map()
    }

    const result = await humanGateHandler(node, ctx)
    
    expect(typeof result).toBe("object")
    expect(result).toHaveProperty("success")
    expect(result.success).toBe(true)
  })

  it("should return failure when user rejects with 'n'", async () => {
    mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
      callback("n")
    })

    const node: BlueprintNode = {
      id: "gate-2",
      type: "human-gate",
      config: { message: "Proceed?" }
    }
    const ctx: PipelineContext = {
      variables: new Map(),
      artifacts: new Map()
    }

    const result = await humanGateHandler(node, ctx)
    
    expect(typeof result).toBe("object")
    expect(result).toHaveProperty("success")
    expect(result.success).toBe(false)
  })

  it("should handle case-insensitive responses", async () => {
    mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
      callback("Y")
    })

    const node: BlueprintNode = {
      id: "gate-3",
      type: "human-gate",
      config: { message: "Continue?" }
    }
    const ctx: PipelineContext = {
      variables: new Map(),
      artifacts: new Map()
    }

    const result = await humanGateHandler(node, ctx)
    
    expect(result.success).toBe(true)
  })

  it("should handle whitespace in responses", async () => {
    mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
      callback("  y  ")
    })

    const node: BlueprintNode = {
      id: "gate-4",
      type: "human-gate",
      config: { message: "Continue?" }
    }
    const ctx: PipelineContext = {
      variables: new Map(),
      artifacts: new Map()
    }

    const result = await humanGateHandler(node, ctx)
    
    expect(result.success).toBe(true)
  })

  it("should reject invalid responses", async () => {
    mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
      callback("maybe")
    })

    const node: BlueprintNode = {
      id: "gate-5",
      type: "human-gate",
      config: { message: "Continue?" }
    }
    const ctx: PipelineContext = {
      variables: new Map(),
      artifacts: new Map()
    }

    const result = await humanGateHandler(node, ctx)
    
    expect(result.success).toBe(false)
  })

  it("should close readline interface after use", async () => {
    mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
      callback("y")
    })

    const node: BlueprintNode = {
      id: "gate-6",
      type: "human-gate",
      config: { message: "Continue?" }
    }
    const ctx: PipelineContext = {
      variables: new Map(),
      artifacts: new Map()
    }

    await humanGateHandler(node, ctx)
    
    expect(mockReadline.close).toHaveBeenCalledOnce()
  })
})

describe("Feature: Property-based testing for human gate", () => {
  let mockReadline: any
  
  beforeEach(() => {
    const { createInterface } = await import("node:readline")
    mockReadline = {
      question: vi.fn(),
      close: vi.fn(),
    }
    vi.mocked(createInterface).mockReturnValue(mockReadline)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("should always return NodeResult with success property", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        id: fc.string({ minLength: 1 }),
        type: fc.constant("human-gate"),
        config: fc.record({
          message: fc.string()
        })
      }),
      fc.constantFrom("y", "n", "yes", "no", "Y", "N", "invalid", "", "  y  ", "  n  "),
      async (node, userResponse) => {
        mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
          callback(userResponse)
        })

        const ctx: PipelineContext = {
          variables: new Map(),
          artifacts: new Map()
        }

        const result = await humanGateHandler(node, ctx)
        
        expect(typeof result).toBe("object")
        expect(result).toHaveProperty("success")
        expect(typeof result.success).toBe("boolean")
      }
    ))
  })

  it("should consistently map positive responses to success=true", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        id: fc.string({ minLength: 1 }),
        type: fc.constant("human-gate"),
        config: fc.record({
          message: fc.string()
        })
      }),
      fc.constantFrom("y", "yes", "Y", "YES", "  y  ", "  yes  "),
      async (node, positiveResponse) => {
        mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
          callback(positiveResponse)
        })

        const ctx: PipelineContext = {
          variables: new Map(),
          artifacts: new Map()
        }

        const result = await humanGateHandler(node, ctx)
        
        expect(result.success).toBe(true)
      }
    ))
  })

  it("should consistently map negative responses to success=false", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        id: fc.string({ minLength: 1 }),
        type: fc.constant("human-gate"),
        config: fc.record({
          message: fc.string()
        })
      }),
      fc.constantFrom("n", "no", "N", "NO", "  n  ", "  no  "),
      async (node, negativeResponse) => {
        mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
          callback(negativeResponse)
        })

        const ctx: PipelineContext = {
          variables: new Map(),
          artifacts: new Map()
        }

        const result = await humanGateHandler(node, ctx)
        
        expect(result.success).toBe(false)
      }
    ))
  })
})

describe("Feature: Negative tests for error conditions", () => {
  let mockReadline: any
  
  beforeEach(() => {
    const { createInterface } = await import("node:readline")
    mockReadline = {
      question: vi.fn(),
      close: vi.fn(),
    }
    vi.mocked(createInterface).mockReturnValue(mockReadline)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("should handle readline interface creation failure", async () => {
    const { createInterface } = await import("node:readline")
    vi.mocked(createInterface).mockImplementation(() => {
      throw new Error("Failed to create interface")
    })

    const node: BlueprintNode = {
      id: "gate-error",
      type: "human-gate",
      config: { message: "Continue?" }
    }
    const ctx: PipelineContext = {
      variables: new Map(),
      artifacts: new Map()
    }

    // ASSUMPTION: throws on readline creation failure
    await expect(humanGateHandler(node, ctx)).rejects.toThrow("Failed to create interface")
  })

  it("should handle question callback error", async () => {
    mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
      throw new Error("Question failed")
    })

    const node: BlueprintNode = {
      id: "gate-callback-error",
      type: "human-gate",
      config: { message: "Continue?" }
    }
    const ctx: PipelineContext = {
      variables: new Map(),
      artifacts: new Map()
    }

    // ASSUMPTION: throws on question error
    await expect(humanGateHandler(node, ctx)).rejects.toThrow("Question failed")
  })

  it("should handle empty string response", async () => {
    mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
      callback("")
    })

    const node: BlueprintNode = {
      id: "gate-empty",
      type: "human-gate",
      config: { message: "Continue?" }
    }
    const ctx: PipelineContext = {
      variables: new Map(),
      artifacts: new Map()
    }

    const result = await humanGateHandler(node, ctx)
    
    expect(result.success).toBe(false)
  })

  it("should handle null node config", async () => {
    mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
      callback("y")
    })

    const node: BlueprintNode = {
      id: "gate-null-config",
      type: "human-gate",
      config: null as any
    }
    const ctx: PipelineContext = {
      variables: new Map(),
      artifacts: new Map()
    }

    // ASSUMPTION: handles null config gracefully or throws
    const result = await humanGateHandler(node, ctx)
    expect(typeof result).toBe("object")
  })

  it("should handle missing message in config", async () => {
    mockReadline.question.mockImplementation((prompt: string, callback: (answer: string) => void) => {
      callback("y")
    })

    const node: BlueprintNode = {
      id: "gate-no-message",
      type: "human-gate",
      config: {} as any
    }
    const ctx: PipelineContext = {
      variables: new Map(),
      artifacts: new Map()
    }

    const result = await humanGateHandler(node, ctx)
    expect(typeof result).toBe("object")
    expect(result).toHaveProperty("success")
  })
})