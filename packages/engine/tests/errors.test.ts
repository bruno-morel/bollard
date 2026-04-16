import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { BollardError } from "../src/errors.js"
import type { BollardErrorCode } from "../src/errors.js"

const ALL_CODES: BollardErrorCode[] = [
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

const EXPECTED_RETRYABLE: BollardErrorCode[] = [
  "LLM_TIMEOUT",
  "LLM_RATE_LIMIT",
  "LLM_PROVIDER_ERROR",
]

describe("BollardError", () => {
  it("constructs with code, message, and optional context", () => {
    const err = new BollardError({
      code: "NODE_EXECUTION_FAILED",
      message: "node blew up",
      context: { nodeId: "n1" },
    })

    expect(err.code).toBe("NODE_EXECUTION_FAILED")
    expect(err.message).toBe("node blew up")
    expect(err.context).toEqual({ nodeId: "n1" })
    expect(err.name).toBe("BollardError")
  })

  it("defaults context to empty object when omitted", () => {
    const err = new BollardError({ code: "CONFIG_INVALID", message: "bad" })
    expect(err.context).toEqual({})
  })

  it("preserves cause for chaining", () => {
    const cause = new Error("root cause")
    const err = new BollardError({
      code: "LLM_AUTH",
      message: "auth failed",
      cause,
    })
    expect(err.cause).toBe(cause)
  })

  it("is an instance of Error", () => {
    const err = new BollardError({ code: "CONFIG_INVALID", message: "x" })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(BollardError)
  })

  describe("retryable", () => {
    it("returns true for LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_PROVIDER_ERROR", () => {
      for (const code of EXPECTED_RETRYABLE) {
        const err = new BollardError({ code, message: "retry me" })
        expect(err.retryable).toBe(true)
      }
    })

    it("returns false for all non-retryable codes", () => {
      const nonRetryable = ALL_CODES.filter((c) => !EXPECTED_RETRYABLE.includes(c))
      for (const code of nonRetryable) {
        const err = new BollardError({ code, message: "no retry" })
        expect(err.retryable).toBe(false)
      }
    })

    it("(property) retryable codes are exactly the 3 expected ones", () => {
      fc.assert(
        fc.property(fc.constantFrom(...ALL_CODES), (code) => {
          const err = new BollardError({ code, message: "test" })
          const shouldBeRetryable = EXPECTED_RETRYABLE.includes(code)
          return err.retryable === shouldBeRetryable
        }),
      )
    })
  })

  describe("type guards", () => {
    it("BollardError.is() returns true for BollardError instances", () => {
      const err = new BollardError({ code: "CONFIG_INVALID", message: "x" })
      expect(BollardError.is(err)).toBe(true)
    })

    it("BollardError.is() returns false for plain errors", () => {
      expect(BollardError.is(new Error("plain"))).toBe(false)
    })

    it("BollardError.is() returns false for non-error values", () => {
      expect(BollardError.is(null)).toBe(false)
      expect(BollardError.is(undefined)).toBe(false)
      expect(BollardError.is("string")).toBe(false)
      expect(BollardError.is(42)).toBe(false)
    })

    it("BollardError.hasCode() matches code correctly", () => {
      const err = new BollardError({ code: "LLM_TIMEOUT", message: "x" })
      expect(BollardError.hasCode(err, "LLM_TIMEOUT")).toBe(true)
      expect(BollardError.hasCode(err, "LLM_AUTH")).toBe(false)
    })

    it("BollardError.hasCode() returns false for non-BollardError values", () => {
      expect(BollardError.hasCode(new Error("x"), "LLM_TIMEOUT")).toBe(false)
      expect(BollardError.hasCode(null, "LLM_TIMEOUT")).toBe(false)
    })
  })
})
