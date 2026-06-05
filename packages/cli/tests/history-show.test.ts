import { describe, expect, it } from "vitest"
import { formatNodeAgentSuffix } from "../src/history.js"

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

describe("formatNodeAgentSuffix", () => {
  it("renders turns and model with middle-dot separator", () => {
    const suffix = formatNodeAgentSuffix({
      turns: 22,
      model: "claude-sonnet-4-6",
    })
    const plain = suffix.replace(ANSI_PATTERN, "")
    expect(plain).toBe(" 22t · claude-sonnet-4-6")
  })
})
