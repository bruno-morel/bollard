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

describe("Feature: All exported functions and classes have behavioral tests", () => {
  it("should have searchTool with correct structure", () => {
    expect(searchTool).toBeDefined()
    expect(typeof searchTool.name).toBe("string")
    expect(typeof searchTool.description).toBe("string")
    expect(typeof searchTool.inputSchema).toBe("object")
    expect(typeof searchTool.execute).toBe("function")
  })

  it("should execute search and return string result", async () => {
    writeFileSync(join(workDir, "test.txt"), "hello world\nfoo bar\n")
    
    const result = await searchTool.execute({ pattern: "hello", path: "test.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("hello")
  })

  it("should return 'No matches found.' when pattern doesn't match", async () => {
    writeFileSync(join(workDir, "test.txt"), "hello world\n")
    
    const result = await searchTool.execute({ pattern: "nonexistent", path: "test.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe("No matches found.")
  })

  it("should search in multiple files when path is directory", async () => {
    writeFileSync(join(workDir, "file1.txt"), "target content\n")
    writeFileSync(join(workDir, "file2.txt"), "other target\n")
    
    const result = await searchTool.execute({ pattern: "target", path: "." }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("target")
  })
})

describe("Feature: Property-based tests for string/collection parameters", () => {
  it("should handle arbitrary regex patterns", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('\0')),
      fc.string({ minLength: 1, maxLength: 100 }),
      async (pattern, content) => {
        writeFileSync(join(workDir, "prop-test.txt"), content)
        
        const result = await searchTool.execute({ pattern, path: "prop-test.txt" }, ctx)
        
        expect(typeof result).toBe("string")
        expect(result.length).toBeGreaterThan(0)
      }
    ))
  })

  it("should handle arbitrary file paths within workDir", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => 
        !s.includes('/') && !s.includes('\\') && !s.includes('\0') && s !== '.' && s !== '..'
      ),
      fc.string({ minLength: 0, maxLength: 100 }),
      async (filename, content) => {
        writeFileSync(join(workDir, filename), content)
        
        const result = await searchTool.execute({ pattern: ".*", path: filename }, ctx)
        
        expect(typeof result).toBe("string")
      }
    ))
  })

  it("should cap results at 100 lines", async () => {
    const manyLines = Array(200).fill("matching line").join("\n")
    writeFileSync(join(workDir, "large.txt"), manyLines)
    
    const result = await searchTool.execute({ pattern: "matching", path: "large.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    const lineCount = result.split("\n").length
    expect(lineCount).toBeLessThanOrEqual(100)
  })
})

describe("Feature: Negative tests for error conditions", () => {
  it("should reject path traversal attempts", async () => {
    const traversalPaths = [
      "../../../etc/passwd",
      "../../..",
      "../outside.txt",
      "subdir/../../escape.txt"
    ]
    
    for (const path of traversalPaths) {
      await expect(searchTool.execute({ pattern: "test", path }, ctx)).rejects.toThrow()
    }
  })

  it("should handle non-existent files gracefully", async () => {
    const result = await searchTool.execute({ pattern: "test", path: "nonexistent.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("No such file")
  })

  it("should handle invalid regex patterns", async () => {
    writeFileSync(join(workDir, "test.txt"), "content")
    
    const invalidPatterns = ["[", "(", "*", "+", "?"]
    
    for (const pattern of invalidPatterns) {
      const result = await searchTool.execute({ pattern, path: "test.txt" }, ctx)
      expect(typeof result).toBe("string")
    }
  })

  it("should handle empty pattern", async () => {
    writeFileSync(join(workDir, "test.txt"), "some content\n")
    
    const result = await searchTool.execute({ pattern: "", path: "test.txt" }, ctx)
    
    expect(typeof result).toBe("string")
  })

  it("should handle binary files", async () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE])
    writeFileSync(join(workDir, "binary.bin"), binaryData)
    
    const result = await searchTool.execute({ pattern: "test", path: "binary.bin" }, ctx)
    
    expect(typeof result).toBe("string")
  })

  it("should handle very long lines", async () => {
    const longLine = "x".repeat(10000) + "target" + "y".repeat(10000)
    writeFileSync(join(workDir, "long.txt"), longLine)
    
    const result = await searchTool.execute({ pattern: "target", path: "long.txt" }, ctx)
    
    expect(typeof result).toBe("string")
  })
})

describe("Feature: Domain-specific search behavior", () => {
  it("should preserve line context in search results", async () => {
    writeFileSync(join(workDir, "context.txt"), "line1\ntarget line\nline3\n")
    
    const result = await searchTool.execute({ pattern: "target", path: "context.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("target line")
  })

  it("should handle case-sensitive regex matching", async () => {
    writeFileSync(join(workDir, "case.txt"), "Hello\nhello\nHELLO\n")
    
    const lowerResult = await searchTool.execute({ pattern: "hello", path: "case.txt" }, ctx)
    const upperResult = await searchTool.execute({ pattern: "HELLO", path: "case.txt" }, ctx)
    
    expect(typeof lowerResult).toBe("string")
    expect(typeof upperResult).toBe("string")
    expect(lowerResult).toContain("hello")
    expect(upperResult).toContain("HELLO")
  })

  it("should handle special regex characters in content", async () => {
    writeFileSync(join(workDir, "special.txt"), "price: $100\nemail@domain.com\n[brackets]\n")
    
    const dollarResult = await searchTool.execute({ pattern: "\\$", path: "special.txt" }, ctx)
    const atResult = await searchTool.execute({ pattern: "@", path: "special.txt" }, ctx)
    
    expect(typeof dollarResult).toBe("string")
    expect(typeof atResult).toBe("string")
    expect(dollarResult).toContain("$100")
    expect(atResult).toContain("email@domain.com")
  })

  it("should search recursively in subdirectories", async () => {
    writeFileSync(join(workDir, "root.txt"), "root content\n")
    const subDir = join(workDir, "subdir")
    mkdirSync(subDir)
    writeFileSync(join(subDir, "sub.txt"), "sub content\n")
    
    const result = await searchTool.execute({ pattern: "content", path: "." }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("content")
  })

  it("should handle unicode content", async () => {
    writeFileSync(join(workDir, "unicode.txt"), "café\n日本語\n🚀 rocket\n")
    
    const cafeResult = await searchTool.execute({ pattern: "café", path: "unicode.txt" }, ctx)
    const japaneseResult = await searchTool.execute({ pattern: "日本語", path: "unicode.txt" }, ctx)
    const emojiResult = await searchTool.execute({ pattern: "🚀", path: "unicode.txt" }, ctx)
    
    expect(typeof cafeResult).toBe("string")
    expect(typeof japaneseResult).toBe("string")
    expect(typeof emojiResult).toBe("string")
    expect(cafeResult).toContain("café")
    expect(japaneseResult).toContain("日本語")
    expect(emojiResult).toContain("🚀")
  })
})