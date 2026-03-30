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
  it("should have writeFileTool with required properties", () => {
    expect(writeFileTool).toBeDefined()
    expect(writeFileTool.name).toBeDefined()
    expect(writeFileTool.description).toBeDefined()
    expect(writeFileTool.inputSchema).toBeDefined()
    expect(typeof writeFileTool.execute).toBe("function")
  })

  it("should write file and return confirmation string", async () => {
    const input = { path: "test.txt", content: "Hello World" }
    const result = await writeFileTool.execute(input, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("11")
    expect(result.length).toBeGreaterThan(0)
    
    const writtenContent = readFileSync(join(workDir, "test.txt"), "utf-8")
    expect(writtenContent).toBe("Hello World")
  })

  it("should create parent directories automatically", async () => {
    const input = { path: "nested/deep/file.txt", content: "content" }
    const result = await writeFileTool.execute(input, ctx)
    
    expect(typeof result).toBe("string")
    expect(existsSync(join(workDir, "nested/deep"))).toBe(true)
    
    const writtenContent = readFileSync(join(workDir, "nested/deep/file.txt"), "utf-8")
    expect(writtenContent).toBe("content")
  })
})

describe("Feature: Property-based tests for string parameters", () => {
  it("should handle arbitrary valid file paths and content", () => {
    fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes("..") && !s.startsWith("/") && s.trim().length > 0),
      fc.string({ maxLength: 1000 }),
      async (path, content) => {
        const input = { path, content }
        const result = await writeFileTool.execute(input, ctx)
        
        expect(typeof result).toBe("string")
        expect(result).toContain(content.length.toString())
        
        const writtenContent = readFileSync(join(workDir, path), "utf-8")
        expect(writtenContent).toBe(content)
      }
    ))
  })

  it("should handle various content types and sizes", () => {
    fc.assert(fc.asyncProperty(
      fc.oneof(
        fc.string(),
        fc.string({ minLength: 0, maxLength: 0 }),
        fc.string({ minLength: 1000, maxLength: 2000 }),
        fc.constantFrom("", "\n", "\t", " ", "special chars: !@#$%^&*()")
      ),
      async (content) => {
        const input = { path: "test.txt", content }
        const result = await writeFileTool.execute(input, ctx)
        
        expect(typeof result).toBe("string")
        expect(result).toContain(content.length.toString())
        
        const writtenContent = readFileSync(join(workDir, "test.txt"), "utf-8")
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
      "subdir/../../../etc/passwd"
    ]
    
    for (const path of traversalPaths) {
      const input = { path, content: "malicious" }
      await expect(writeFileTool.execute(input, ctx)).rejects.toThrow()
    }
  })

  it("should reject absolute paths", async () => {
    const absolutePaths = [
      "/etc/passwd",
      "/tmp/file.txt",
      "/home/user/file.txt"
    ]
    
    for (const path of absolutePaths) {
      const input = { path, content: "content" }
      await expect(writeFileTool.execute(input, ctx)).rejects.toThrow()
    }
  })

  it("should handle missing required input properties", async () => {
    await expect(writeFileTool.execute({} as any, ctx)).rejects.toThrow()
    await expect(writeFileTool.execute({ path: "test.txt" } as any, ctx)).rejects.toThrow()
    await expect(writeFileTool.execute({ content: "content" } as any, ctx)).rejects.toThrow()
  })

  it("should handle null and undefined inputs", async () => {
    await expect(writeFileTool.execute(null as any, ctx)).rejects.toThrow()
    await expect(writeFileTool.execute(undefined as any, ctx)).rejects.toThrow()
    
    const nullInputs = [
      { path: null, content: "content" },
      { path: "test.txt", content: null },
      { path: undefined, content: "content" },
      { path: "test.txt", content: undefined }
    ]
    
    for (const input of nullInputs) {
      await expect(writeFileTool.execute(input as any, ctx)).rejects.toThrow()
    }
  })

  it("should handle empty and invalid path strings", async () => {
    const invalidPaths = ["", " ", "\t", "\n", ".", ".."]
    
    for (const path of invalidPaths) {
      const input = { path, content: "content" }
      await expect(writeFileTool.execute(input, ctx)).rejects.toThrow()
    }
  })
})

describe("Feature: Domain-specific properties", () => {
  it("should return byte count matching actual written content", async () => {
    const testCases = [
      { content: "", expectedBytes: 0 },
      { content: "a", expectedBytes: 1 },
      { content: "hello", expectedBytes: 5 },
      { content: "unicode: 🚀", expectedBytes: Buffer.from("unicode: 🚀", "utf-8").length },
      { content: "newlines\n\r\n", expectedBytes: Buffer.from("newlines\n\r\n", "utf-8").length }
    ]
    
    for (const { content, expectedBytes } of testCases) {
      const input = { path: `test-${expectedBytes}.txt`, content }
      const result = await writeFileTool.execute(input, ctx)
      
      expect(result).toContain(expectedBytes.toString())
      
      const writtenContent = readFileSync(join(workDir, input.path), "utf-8")
      expect(Buffer.from(writtenContent, "utf-8").length).toBe(expectedBytes)
    }
  })

  it("should preserve exact content including special characters", async () => {
    const specialContents = [
      "line1\nline2\nline3",
      "tabs\t\there",
      "quotes \"and\" 'single'",
      "unicode: 🎉 🚀 ñ é",
      "mixed\n\t\"special🎉\"content"
    ]
    
    for (let i = 0; i < specialContents.length; i++) {
      const content = specialContents[i]
      const input = { path: `special-${i}.txt`, content }
      await writeFileTool.execute(input, ctx)
      
      const writtenContent = readFileSync(join(workDir, input.path), "utf-8")
      expect(writtenContent).toBe(content)
    }
  })

  it("should handle concurrent writes to different files", async () => {
    const promises = Array.from({ length: 5 }, (_, i) => {
      const input = { path: `concurrent-${i}.txt`, content: `content-${i}` }
      return writeFileTool.execute(input, ctx)
    })
    
    const results = await Promise.all(promises)
    
    results.forEach((result, i) => {
      expect(typeof result).toBe("string")
      expect(result).toContain(`content-${i}`.length.toString())
      
      const writtenContent = readFileSync(join(workDir, `concurrent-${i}.txt`), "utf-8")
      expect(writtenContent).toBe(`content-${i}`)
    })
  })

  it("should overwrite existing files", async () => {
    const path = "overwrite.txt"
    
    // First write
    await writeFileTool.execute({ path, content: "original" }, ctx)
    let content = readFileSync(join(workDir, path), "utf-8")
    expect(content).toBe("original")
    
    // Second write should overwrite
    const result = await writeFileTool.execute({ path, content: "updated" }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("7") // "updated" is 7 bytes
    
    content = readFileSync(join(workDir, path), "utf-8")
    expect(content).toBe("updated")
  })
})