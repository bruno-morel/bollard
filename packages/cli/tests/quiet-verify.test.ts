import { describe, expect, it } from "vitest"
import { formatQuietVerifyResult } from "../src/quiet-verify.js"

describe("formatQuietVerifyResult", () => {
  it("returns null when allPassed is true", () => {
    expect(
      formatQuietVerifyResult([{ check: "lint", passed: true, output: "", durationMs: 0 }], true),
    ).toBeNull()
  })

  it("returns fail payload with truncated message for failed checks", () => {
    const out = formatQuietVerifyResult(
      [
        {
          check: "typecheck",
          passed: false,
          output: "error one\nerror two\nerror three\nerror four",
          durationMs: 10,
        },
        { check: "lint", passed: true, output: "", durationMs: 5 },
      ],
      false,
    )
    expect(out).not.toBeNull()
    expect(out?.status).toBe("fail")
    expect(out?.checks).toEqual([
      {
        label: "typecheck",
        passed: false,
        message: "error one; error two; error three",
      },
      { label: "lint", passed: true },
    ])
  })

  it("omits message field on passed checks (exactOptionalPropertyTypes)", () => {
    const out = formatQuietVerifyResult(
      [
        { check: "a", passed: true, output: "x", durationMs: 1 },
        { check: "b", passed: false, output: "fail\nline", durationMs: 2 },
      ],
      false,
    )
    expect(out).not.toBeNull()
    const passed = out?.checks.find((c) => c.label === "a")
    expect(passed).toBeDefined()
    expect("message" in (passed ?? {})).toBe(false)
  })
})
