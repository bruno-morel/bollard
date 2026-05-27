import { resolve, sep } from "node:path"
import { describe, expect, it } from "vitest"
import { deriveUnitTestPath, injectUnitTestIfMissing } from "../src/agent-handler.js"

const workDir = "/app"
const srcRel = "packages/engine/src/cost-tracker.ts"
const srcAbs = resolve(workDir, srcRel)

describe("deriveUnitTestPath", () => {
  it("derives cap from cost-tracker source and task string", () => {
    const task = "Add a cap(maxUsd: number): CostTracker method..."
    const result = deriveUnitTestPath(srcAbs, task)
    expect(result).toBe(resolve("/app/packages/engine/tests/cost-tracker-cap.test.ts"))
  })

  it("derives percentUsed from task string", () => {
    const task = "Add a percentUsed(): number method..."
    const result = deriveUnitTestPath(srcAbs, task)
    expect(result).toBe(resolve("/app/packages/engine/tests/cost-tracker-percentUsed.test.ts"))
  })

  it("falls back to 'new' when no method name found", () => {
    const task = "Refactor the class internals"
    const result = deriveUnitTestPath(srcAbs, task)
    expect(result).toBe(resolve("/app/packages/engine/tests/cost-tracker-new.test.ts"))
  })

  it("skips common non-method words to find real method name", () => {
    const task = "Add a toJSON(): object method that returns serializable state"
    const result = deriveUnitTestPath(srcAbs, task)
    expect(result).toBe(resolve("/app/packages/engine/tests/cost-tracker-toJSON.test.ts"))
  })

  it("produces same name as planner Rule 11 convention for cap()", () => {
    const task = "Add a cap(maxUsd: number): CostTracker..."
    const derived = deriveUnitTestPath(srcAbs, task)
    expect(derived).toContain("cost-tracker-cap.test.ts")
    expect(derived).toContain(`tests${sep}cost-tracker-cap.test.ts`)
  })
})

describe("injectUnitTestIfMissing", () => {
  const task = "Add a cap(maxUsd: number): CostTracker method..."

  it("does not inject when filtered already has a new non-adversarial unit test", () => {
    const filtered = [srcAbs, resolve(workDir, "packages/engine/tests/cost-tracker-cap.test.ts")]
    const result = injectUnitTestIfMissing(filtered, [srcRel], task, workDir, () => false)
    expect(result).toEqual(filtered)
  })

  it("does not inject when modifyFiles and createFiles are both empty", () => {
    const filtered = [srcAbs]
    const result = injectUnitTestIfMissing(filtered, [], task, workDir, () => false, [])
    expect(result).toEqual(filtered)
  })

  it("injects from createFiles when modifyFiles is empty (verification-only run)", () => {
    const filtered = [srcAbs]
    const result = injectUnitTestIfMissing(filtered, [], task, workDir, () => false, [srcRel])
    expect(result).toHaveLength(2)
    expect(result[1]).toBe(resolve(workDir, "packages/engine/tests/cost-tracker-cap.test.ts"))
  })

  it("does not inject from createFiles when synthesized path already exists on disk", () => {
    const filtered = [srcAbs]
    const injectedPath = deriveUnitTestPath(srcAbs, task)
    const result = injectUnitTestIfMissing(
      filtered,
      [],
      task,
      workDir,
      (p) => p === injectedPath,
      [srcRel],
    )
    expect(result).toEqual(filtered)
  })

  it("does not inject when the first modified .ts is a test file", () => {
    const filtered = [resolve(workDir, "packages/engine/tests/cost-tracker.test.ts")]
    const result = injectUnitTestIfMissing(
      filtered,
      ["packages/engine/tests/cost-tracker.test.ts"],
      task,
      workDir,
      () => false,
    )
    expect(result).toEqual(filtered)
  })

  it("injects when modifyFiles has source .ts and filtered has no new unit test", () => {
    const filtered = [srcAbs]
    const result = injectUnitTestIfMissing(filtered, [srcRel], task, workDir, () => false)
    expect(result).toHaveLength(2)
    expect(result[1]).toBe(resolve(workDir, "packages/engine/tests/cost-tracker-cap.test.ts"))
  })

  it("does not treat adversarial test paths as satisfying the guard", () => {
    const filtered = [
      srcAbs,
      resolve(workDir, "packages/engine/tests/cost-tracker.adversarial.test.ts"),
    ]
    const result = injectUnitTestIfMissing(filtered, [srcRel], task, workDir, () => false)
    expect(result).toHaveLength(3)
    expect(result[2]).toBe(resolve(workDir, "packages/engine/tests/cost-tracker-cap.test.ts"))
  })

  it("injected path matches deriveUnitTestPath output exactly", () => {
    const filtered = [srcAbs]
    const result = injectUnitTestIfMissing(filtered, [srcRel], task, workDir, () => false)
    expect(result.at(-1)).toBe(deriveUnitTestPath(srcAbs, task))
  })

  it("does not inject when synthesized path already exists on disk", () => {
    const filtered = [srcAbs]
    const injectedPath = deriveUnitTestPath(srcAbs, task)
    const result = injectUnitTestIfMissing(
      filtered,
      [srcRel],
      task,
      workDir,
      (p) => p === injectedPath,
    )
    expect(result).toEqual(filtered)
  })
})
