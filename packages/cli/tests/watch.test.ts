import type { StaticCheckResult } from "@bollard/verify/src/static.js"
import { describe, expect, it } from "vitest"
import {
  buildJsonWatchErrorOutput,
  buildJsonWatchOutput,
  buildQuietWatchOutput,
  matchesIgnorePattern,
  matchesSourcePattern,
} from "../src/watch.js"

describe("matchesSourcePattern", () => {
  it("matches src/**/*.ts for nested ts under src", () => {
    expect(matchesSourcePattern("src/foo/bar.ts", ["src/**/*.ts"])).toBe(true)
  })

  it("does not match node_modules path for src-only pattern", () => {
    expect(matchesSourcePattern("node_modules/x.ts", ["src/**/*.ts"])).toBe(false)
  })

  it("excludes paths matched by negated patterns", () => {
    expect(
      matchesSourcePattern("node_modules/pkg/index.ts", ["**/*.ts", "!**/node_modules/**"]),
    ).toBe(false)
  })
})

describe("matchesIgnorePattern", () => {
  it("matches node_modules when pattern uses ** segment", () => {
    expect(matchesIgnorePattern("node_modules/foo/bar.ts", ["node_modules/**"])).toBe(true)
  })

  it("returns false when no ignore segment appears in filename", () => {
    expect(matchesIgnorePattern("src/lib.ts", ["node_modules"])).toBe(false)
  })
})

describe("buildQuietWatchOutput", () => {
  it("emits fail schema with checks and timestamp", () => {
    const results: StaticCheckResult[] = [
      {
        check: "typecheck",
        passed: true,
        output: "",
        durationMs: 1,
      },
      {
        check: "lint",
        passed: false,
        output: "line1\nline2\nline3\nline4",
        durationMs: 2,
      },
    ]
    const payload = buildQuietWatchOutput(results)
    expect(payload.status).toBe("fail")
    expect(typeof payload.timestamp).toBe("number")
    expect(payload.checks).toHaveLength(2)
    expect(payload.checks[0]).toEqual({ label: "typecheck", passed: true })
    expect(payload.checks[1]?.label).toBe("lint")
    expect(payload.checks[1]?.passed).toBe(false)
    expect(payload.checks[1]?.message).toBe("line1; line2; line3")
  })
})

describe("buildJsonWatchOutput", () => {
  it("emits pass with allPassed true and full checks when all passed", () => {
    const results: StaticCheckResult[] = [
      { check: "typecheck", passed: true, output: "ok", durationMs: 10 },
      { check: "lint", passed: true, output: "", durationMs: 5 },
    ]
    const payload = buildJsonWatchOutput(results, true)
    expect(payload.status).toBe("pass")
    expect(payload.allPassed).toBe(true)
    expect(typeof payload.timestamp).toBe("number")
    expect(payload.checks).toEqual(results)
    expect(payload.error).toBeUndefined()
  })

  it("emits fail with allPassed false and full checks when any failed", () => {
    const results: StaticCheckResult[] = [
      { check: "typecheck", passed: true, output: "", durationMs: 1 },
      { check: "lint", passed: false, output: "err\nhere", durationMs: 2 },
    ]
    const payload = buildJsonWatchOutput(results, false)
    expect(payload.status).toBe("fail")
    expect(payload.allPassed).toBe(false)
    expect(typeof payload.timestamp).toBe("number")
    expect(payload.checks).toEqual(results)
  })
})

describe("buildJsonWatchErrorOutput", () => {
  it("emits error with message from Error and no checks", () => {
    const payload = buildJsonWatchErrorOutput(new Error("boom"))
    expect(payload.status).toBe("error")
    expect(payload.error).toBe("boom")
    expect(typeof payload.timestamp).toBe("number")
    expect(payload.checks).toBeUndefined()
    expect(payload.allPassed).toBeUndefined()
  })

  it("stringifies non-Error throwables", () => {
    const payload = buildJsonWatchErrorOutput(42)
    expect(payload.status).toBe("error")
    expect(payload.error).toBe("42")
  })
})
