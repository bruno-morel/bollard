import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { BollardError, type BollardErrorCode } from "../src/errors.js"

const validErrorCodes: BollardErrorCode[] = [
  "LLM_TIMEOUT",
  "LLM_RATE_LIMIT", 
  "LLM_AUTH",
  "LLM_PROVIDER_ERROR",
  "LLM_INVALID_RESPONSE",
  "COST_LIMIT_EXCEEDED",
  "TIME_LIMIT_EXCEEDED",
  "NODE_EXECUTION_FAILED",
  "POSTCONDITION_FAILED",
  "STATIC_CHECK_FAILED",
  "TEST_FAILED",
  "MUTATION_THRESHOLD_NOT_MET",
  "CONTRACT_VIOLATION",
  "HUMAN_REJECTED",
  "RISK_GATE_BLOCKED",
  "CONFIG_INVALID",
  "CONCERN_CONFIG_INVALID",
  "DETECTION_FAILED",
  "PROFILE_INVALID",
  "PROVIDER_NOT_FOUND",
  "MODEL_NOT_AVAILABLE",
  "CONTRACT_TESTER_OUTPUT_INVALID",
  "CONTRACT_TESTER_NO_GROUNDED_CLAIMS",
  "REVIEW_OUTPUT_INVALID",
  "BEHAVIORAL_CONTEXT_EMPTY",
  "BEHAVIORAL_TESTER_OUTPUT_INVALID",
  "BEHAVIORAL_NO_GROUNDED_CLAIMS",
  "FAULT_INJECTION_FAILED",
]

describe("Feature: BollardError construction and properties", () => {
  it("should create error with required code and message", () => {
    const error = new BollardError({ code: "LLM_TIMEOUT", message: "Request timed out" })
    
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(BollardError)
    expect(error.code).toBe("LLM_TIMEOUT")
    expect(error.message).toBe("Request timed out")
    expect(error.context).toEqual({})
  })

  it("should preserve context data", () => {
    const context = { provider: "openai", model: "gpt-4", timeout: 30000 }
    const error = new BollardError({ 
      code: "LLM_PROVIDER_ERROR", 
      message: "Provider failed",
      context 
    })
    
    expect(error.context).toEqual(context)
    expect(error.context).not.toBe(context) // should be immutable
  })

  it("should handle empty context", () => {
    const error = new BollardError({ code: "CONFIG_INVALID", message: "Bad config" })
    expect(error.context).toEqual({})
  })
})

describe("Feature: BollardError retryable classification", () => {
  it("should classify network/rate limit errors as retryable", () => {
    const retryableErrors = [
      "LLM_TIMEOUT",
      "LLM_RATE_LIMIT", 
      "LLM_PROVIDER_ERROR"
    ]
    
    retryableErrors.forEach(code => {
      const error = new BollardError({ code: code as BollardErrorCode, message: "test" })
      expect(error.retryable).toBe(true)
    })
  })

  it("should classify auth/config errors as non-retryable", () => {
    const nonRetryableErrors = [
      "LLM_AUTH",
      "CONFIG_INVALID",
      "HUMAN_REJECTED"
    ]
    
    nonRetryableErrors.forEach(code => {
      const error = new BollardError({ code: code as BollardErrorCode, message: "test" })
      expect(error.retryable).toBe(false)
    })
  })
})

describe("Feature: BollardError type guards", () => {
  it("should identify BollardError instances", () => {
    const bollardError = new BollardError({ code: "TEST_FAILED", message: "test" })
    const regularError = new Error("regular error")
    const notError = { code: "TEST_FAILED", message: "fake" }
    
    expect(BollardError.is(bollardError)).toBe(true)
    expect(BollardError.is(regularError)).toBe(false)
    expect(BollardError.is(notError)).toBe(false)
    expect(BollardError.is(null)).toBe(false)
    expect(BollardError.is(undefined)).toBe(false)
  })

  it("should match specific error codes", () => {
    const error = new BollardError({ code: "COST_LIMIT_EXCEEDED", message: "over budget" })
    
    expect(BollardError.hasCode(error, "COST_LIMIT_EXCEEDED")).toBe(true)
    expect(BollardError.hasCode(error, "TIME_LIMIT_EXCEEDED")).toBe(false)
    expect(BollardError.hasCode(new Error("regular"), "COST_LIMIT_EXCEEDED")).toBe(false)
    expect(BollardError.hasCode(null, "COST_LIMIT_EXCEEDED")).toBe(false)
  })
})

describe("Property-based tests: BollardError with arbitrary inputs", () => {
  it("should handle any valid error code", () => {
    fc.assert(fc.property(
      fc.constantFrom(...validErrorCodes),
      fc.string({ minLength: 1 }),
      fc.record(fc.string(), fc.anything()),
      (code, message, context) => {
        const error = new BollardError({ code, message, context })
        
        expect(error.code).toBe(code)
        expect(error.message).toBe(message)
        expect(typeof error.retryable).toBe("boolean")
        expect(BollardError.is(error)).toBe(true)
        expect(BollardError.hasCode(error, code)).toBe(true)
      }
    ))
  })

  it("should preserve context structure", () => {
    fc.assert(fc.property(
      fc.constantFrom(...validErrorCodes),
      fc.string(),
      fc.record(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean())),
      (code, message, context) => {
        const error = new BollardError({ code, message, context })
        
        Object.keys(context).forEach(key => {
          expect(error.context[key]).toEqual(context[key])
        })
      }
    ))
  })
})

describe("Negative tests: Invalid inputs", () => {
  it("should handle empty message", () => {
    const error = new BollardError({ code: "LLM_TIMEOUT", message: "" })
    expect(error.message).toBe("")
    expect(error.code).toBe("LLM_TIMEOUT")
  })

  it("should handle null context values", () => {
    const error = new BollardError({ 
      code: "NODE_EXECUTION_FAILED", 
      message: "failed",
      context: { value: null, other: undefined }
    })
    expect(error.context.value).toBe(null)
    expect(error.context.other).toBe(undefined)
  })

  it("should handle deeply nested context", () => {
    const deepContext = {
      level1: {
        level2: {
          level3: { data: "deep" }
        }
      }
    }
    const error = new BollardError({ 
      code: "DETECTION_FAILED", 
      message: "deep failure",
      context: deepContext
    })
    expect(error.context.level1.level2.level3.data).toBe("deep")
  })

  it("should handle circular references in context", () => {
    const circular: any = { name: "test" }
    circular.self = circular
    
    // Should not throw during construction
    expect(() => {
      new BollardError({ 
        code: "PROFILE_INVALID", 
        message: "circular",
        context: { circular }
      })
    }).not.toThrow()
  })
})

describe("Edge cases: Type guard behavior", () => {
  it("should handle objects that look like BollardError", () => {
    const fake = {
      code: "LLM_TIMEOUT",
      message: "fake error",
      context: {},
      retryable: true
    }
    
    expect(BollardError.is(fake)).toBe(false)
    expect(BollardError.hasCode(fake, "LLM_TIMEOUT")).toBe(false)
  })

  it("should handle primitive values", () => {
    expect(BollardError.is("error")).toBe(false)
    expect(BollardError.is(42)).toBe(false)
    expect(BollardError.is(true)).toBe(false)
    expect(BollardError.hasCode("LLM_TIMEOUT", "LLM_TIMEOUT")).toBe(false)
  })

  it("should handle errors with wrong code types", () => {
    const errorWithWrongCode = new Error("test")
    ;(errorWithWrongCode as any).code = 123
    
    expect(BollardError.hasCode(errorWithWrongCode, "LLM_TIMEOUT")).toBe(false)
  })
})