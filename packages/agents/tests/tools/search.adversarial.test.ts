import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentContext } from "../../src/types.js"
import { searchTool } from "../../src/tools/search.js"

let workDir: string
let ctx: AgentContext

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bollard-test-"))
  ctx = {
    pipelineCtx: {} as AgentContext["pipelineCtx"],
    workDir,
  }
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe("Feature: searchTool is exported and has correct structure", () => {
  it("should export searchTool with required AgentTool properties", () => {
    expect(searchTool).toBeDefined()
    expect(typeof searchTool.name).toBe("string")
    expect(typeof searchTool.description).toBe("string")
    expect(typeof searchTool.inputSchema).toBe("object")
    expect(typeof searchTool.execute).toBe("function")
  })
})

describe("Feature: search executes grep against real files", () => {
  it("should find exact matches in single file", async () => {
    writeFileSync(join(workDir, "test.txt"), "hello world\nfoo bar\nhello again")
    
    const result = await searchTool.execute({ pattern: "hello", path: "test.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("hello world")
    expect(result).toContain("hello again")
    expect(result).not.toContain("foo bar")
  })

  it("should return 'No matches found.' when pattern doesn't match", async () => {
    writeFileSync(join(workDir, "test.txt"), "hello world\nfoo bar")
    
    const result = await searchTool.execute({ pattern: "nonexistent", path: "test.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe("No matches found.")
  })

  it("should handle regex patterns", async () => {
    writeFileSync(join(workDir, "test.txt"), "test123\ntest456\nabc789")
    
    const result = await searchTool.execute({ pattern: "test[0-9]+", path: "test.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("test123")
    expect(result).toContain("test456")
    expect(result).not.toContain("abc789")
  })

  it("should search in subdirectories", async () => {
    writeFileSync(join(workDir, "subdir", "nested.txt"), "nested content")
    
    const result = await searchTool.execute({ pattern: "nested", path: "subdir/nested.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("nested content")
  })

  it("should cap results at 100 lines", async () => {
    const content = Array.from({ length: 150 }, (_, i) => `match line ${i}`).join("\n")
    writeFileSync(join(workDir, "large.txt"), content)
    
    const result = await searchTool.execute({ pattern: "match", path: "large.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    const lines = result.split("\n").filter(line => line.trim())
    expect(lines.length).toBeLessThanOrEqual(100)
  })
})

describe("Feature: path traversal protection", () => {
  it("should reject path traversal attempts", async () => {
    const result = await searchTool.execute({ pattern: "test", path: "../../../etc/passwd" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("Invalid path")
  })

  it("should reject relative paths that escape workDir", async () => {
    const result = await searchTool.execute({ pattern: "test", path: "../../sensitive.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("Invalid path")
  })

  it("should allow safe relative paths within workDir", async () => {
    writeFileSync(join(workDir, "safe.txt"), "safe content")
    
    const result = await searchTool.execute({ pattern: "safe", path: "./safe.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("safe content")
  })
})

describe("Feature: error handling for invalid inputs", () => {
  it("should handle non-existent files gracefully", async () => {
    const result = await searchTool.execute({ pattern: "test", path: "nonexistent.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("No such file")
  })

  it("should handle empty pattern", async () => {
    writeFileSync(join(workDir, "test.txt"), "some content")
    
    const result = await searchTool.execute({ pattern: "", path: "test.txt" }, ctx)
    
    expect(typeof result).toBe("string")
  })

  it("should handle invalid regex patterns", async () => {
    writeFileSync(join(workDir, "test.txt"), "some content")
    
    const result = await searchTool.execute({ pattern: "[invalid", path: "test.txt" }, ctx)
    
    expect(typeof result).toBe("string")
  })
})

describe("Property: search results are deterministic for same input", () => {
  it("should return identical results for repeated searches", async () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes("\n")),
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z0-9_.-]+$/.test(s)),
      async (content, filename) => {
        writeFileSync(join(workDir, filename), content)
        
        const result1 = await searchTool.execute({ pattern: content.slice(0, 3), path: filename }, ctx)
        const result2 = await searchTool.execute({ pattern: content.slice(0, 3), path: filename }, ctx)
        
        expect(result1).toBe(result2)
      }
    ), { numRuns: 20 })
  })
})

describe("Property: search finds all occurrences of pattern", () => {
  it("should find all lines containing the pattern", async () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-zA-Z]+$/.test(s)),
      fc.integer({ min: 1, max: 10 }),
      async (pattern, occurrences) => {
        const lines = Array.from({ length: occurrences }, (_, i) => `line ${i} contains ${pattern}`)
        const content = lines.join("\n")
        writeFileSync(join(workDir, "test.txt"), content)
        
        const result = await searchTool.execute({ pattern, path: "test.txt" }, ctx)
        
        expect(typeof result).toBe("string")
        if (result !== "No matches found.") {
          const matchCount = result.split("\n").filter(line => line.includes(pattern)).length
          expect(matchCount).toBe(occurrences)
        }
      }
    ), { numRuns: 20 })
  })
})

describe("Property: empty files return no matches", () => {
  it("should return 'No matches found.' for any pattern in empty file", async () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      async (pattern) => {
        writeFileSync(join(workDir, "empty.txt"), "")
        
        const result = await searchTool.execute({ pattern, path: "empty.txt" }, ctx)
        
        expect(typeof result).toBe("string")
        expect(result).toBe("No matches found.")
      }
    ), { numRuns: 20 })
  })
})