import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentContext } from "../../src/types.js"
import { writeFileTool } from "../../src/tools/write-file.js"

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
  it("should have writeFileTool with correct structure", () => {
    expect(writeFileTool).toBeDefined()
    expect(typeof writeFileTool.execute).toBe("function")
    expect(writeFileTool.name).toBeDefined()
    expect(writeFileTool.description).toBeDefined()
  })

  it("should write file and return confirmation string", async () => {
    const input = { path: "test.txt", content: "Hello World" }
    const result = await writeFileTool.execute(input, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain("11")  // byte count for "Hello World"
    
    const writtenContent = readFileSync(join(workDir, "test.txt"), "utf-8")
    expect(writtenContent).toBe("Hello World")
  })

  it("should create parent directories automatically", async () => {
    const input = { path: "nested/deep/file.txt", content: "nested content" }
    const result = await writeFileTool.execute(input, ctx)
    
    expect(typeof result).toBe("string")
    expect(existsSync(join(workDir, "nested/deep"))).toBe(true)
    
    const writtenContent = readFileSync(join(workDir, "nested/deep/file.txt"), "utf-8")
    expect(writtenContent).toBe("nested content")
  })
})

describe("Feature: Property-based tests for string parameters", () => {
  it("should handle arbitrary valid file paths and content", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes("..") && !s.startsWith("/") && s.trim().length > 0),
      fc.string({ maxLength: 1000 }),
      async (path, content) => {
        const input = { path, content }
        const result = await writeFileTool.execute(input, ctx)
        
        expect(typeof result).toBe("string")
        expect(result.length).toBeGreaterThan(0)
        
        const writtenContent = readFileSync(join(workDir, path), "utf-8")
        expect(writtenContent).toBe(content)
        expect(result).toContain(Buffer.byteLength(content, "utf-8").toString())
      }
    ))
  })

  it("should handle various content types and encodings", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("simple.txt", "with-dash.txt", "with_underscore.txt", "file.json", "data.csv"),
      fc.oneof(
        fc.string(),
        fc.string().map(s => JSON.stringify({ data: s })),
        fc.array(fc.string()).map(arr => arr.join("\n")),
        fc.string().map(s => s.repeat(10))
      ),
      async (path, content) => {
        const input = { path, content }
        const result = await writeFileTool.execute(input, ctx)
        
        expect(typeof result).toBe("string")
        const writtenContent = readFileSync(join(workDir, path), "utf-8")
        expect(writtenContent).toBe(content)
      }
    ))
  })
})

describe("Feature: Negative tests for error conditions", () => {
  it("should reject path traversal attempts", async () => {
    const traversalPaths = [
      "../../../etc/passwd",
      "../../outside.txt",
      "../escape.txt",
      "subdir/../../escape.txt",
      "/absolute/path.txt"
    ]

    for (const path of traversalPaths) {
      const input = { path, content: "malicious content" }
      await expect(writeFileTool.execute(input, ctx)).rejects.toThrow()
    }
  })

  it("should handle missing required parameters", async () => {
    await expect(writeFileTool.execute({} as any, ctx)).rejects.toThrow()
    await expect(writeFileTool.execute({ path: "test.txt" } as any, ctx)).rejects.toThrow()
    await expect(writeFileTool.execute({ content: "test" } as any, ctx)).rejects.toThrow()
  })

  it("should handle null and undefined inputs", async () => {
    await expect(writeFileTool.execute(null as any, ctx)).rejects.toThrow()
    await expect(writeFileTool.execute(undefined as any, ctx)).rejects.toThrow()
    await expect(writeFileTool.execute({ path: null, content: "test" } as any, ctx)).rejects.toThrow()
    await expect(writeFileTool.execute({ path: "test.txt", content: null } as any, ctx)).rejects.toThrow()
  })

  it("should handle empty and whitespace-only paths", async () => {
    const invalidPaths = ["", "   ", "\t", "\n", "  \t  \n  "]
    
    for (const path of invalidPaths) {
      const input = { path, content: "test content" }
      await expect(writeFileTool.execute(input, ctx)).rejects.toThrow()
    }
  })

  it("should handle invalid context", async () => {
    const input = { path: "test.txt", content: "test" }
    
    await expect(writeFileTool.execute(input, null as any)).rejects.toThrow()
    await expect(writeFileTool.execute(input, undefined as any)).rejects.toThrow()
    await expect(writeFileTool.execute(input, {} as any)).rejects.toThrow()
    await expect(writeFileTool.execute(input, { workDir: null } as any)).rejects.toThrow()
  })
})

describe("Feature: Domain-specific properties", () => {
  it("should return byte count matching actual file size", async () => {
    const testCases = [
      { content: "", expectedBytes: 0 },
      { content: "a", expectedBytes: 1 },
      { content: "Hello", expectedBytes: 5 },
      { content: "🚀", expectedBytes: 4 }, // emoji is 4 bytes in UTF-8
      { content: "Hello\nWorld", expectedBytes: 11 },
      { content: "Line1\r\nLine2", expectedBytes: 13 }
    ]

    for (const { content, expectedBytes } of testCases) {
      const input = { path: `test-${expectedBytes}.txt`, content }
      const result = await writeFileTool.execute(input, ctx)
      
      expect(result).toContain(expectedBytes.toString())
      
      const actualSize = readFileSync(join(workDir, input.path)).length
      expect(actualSize).toBe(expectedBytes)
    }
  })

  it("should preserve exact content including special characters", async () => {
    const specialContents = [
      "Line1\nLine2\nLine3",
      "Tab\tSeparated\tValues",
      "Windows\r\nLine\r\nEndings",
      "Mixed\nLine\r\nEndings\rHere",
      "Unicode: 🚀 🌟 ✨",
      "JSON: {\"key\": \"value\", \"number\": 42}",
      "XML: <root><item>value</item></root>",
      "Binary-like: \x00\x01\x02\x03",
      "Quotes: 'single' \"double\" `backtick`"
    ]

    for (let i = 0; i < specialContents.length; i++) {
      const content = specialContents[i]
      const input = { path: `special-${i}.txt`, content }
      
      await writeFileTool.execute(input, ctx)
      
      const writtenContent = readFileSync(join(workDir, input.path), "utf-8")
      expect(writtenContent).toBe(content)
      expect(writtenContent.length).toBe(content.length)
    }
  })

  it("should handle concurrent writes to different files", async () => {
    const promises = Array.from({ length: 10 }, (_, i) => {
      const input = { path: `concurrent-${i}.txt`, content: `Content ${i}` }
      return writeFileTool.execute(input, ctx)
    })

    const results = await Promise.all(promises)
    
    results.forEach((result, i) => {
      expect(typeof result).toBe("string")
      const writtenContent = readFileSync(join(workDir, `concurrent-${i}.txt`), "utf-8")
      expect(writtenContent).toBe(`Content ${i}`)
    })
  })

  it("should overwrite existing files completely", async () => {
    const path = "overwrite-test.txt"
    
    // Write initial content
    await writeFileTool.execute({ path, content: "Initial long content" }, ctx)
    let content = readFileSync(join(workDir, path), "utf-8")
    expect(content).toBe("Initial long content")
    
    // Overwrite with shorter content
    await writeFileTool.execute({ path, content: "Short" }, ctx)
    content = readFileSync(join(workDir, path), "utf-8")
    expect(content).toBe("Short")
    expect(content.length).toBe(5)
  })
})