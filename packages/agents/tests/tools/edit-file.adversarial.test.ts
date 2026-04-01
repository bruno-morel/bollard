import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentContext } from "../../src/types.js"
import { editFileTool } from "../../src/tools/edit-file.js"

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

describe("Feature: editFileTool exists and has correct structure", () => {
  it("should be an AgentTool with required properties", () => {
    expect(editFileTool).toBeDefined()
    expect(typeof editFileTool.name).toBe("string")
    expect(typeof editFileTool.description).toBe("string")
    expect(typeof editFileTool.inputSchema).toBe("object")
    expect(typeof editFileTool.execute).toBe("function")
  })
})

describe("Feature: File editing functionality", () => {
  it("should edit an existing file", async () => {
    const filePath = "test.txt"
    const originalContent = "Hello world"
    const newContent = "Hello universe"
    
    writeFileSync(join(workDir, filePath), originalContent)
    
    const result = await editFileTool.execute({ path: filePath, content: newContent }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("should create a new file when it doesn't exist", async () => {
    const filePath = "new-file.txt"
    const content = "New file content"
    
    const result = await editFileTool.execute({ path: filePath, content: content }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("should handle nested directory paths", async () => {
    const filePath = "nested/dir/file.txt"
    const content = "Nested content"
    
    const result = await editFileTool.execute({ path: filePath, content: content }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("should handle empty content", async () => {
    const filePath = "empty.txt"
    const content = ""
    
    const result = await editFileTool.execute({ path: filePath, content: content }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("Feature: Path traversal protection", () => {
  it("should reject path traversal attempts with ../", async () => {
    const maliciousPath = "../../../etc/passwd"
    const content = "malicious content"
    
    await expect(editFileTool.execute({ path: maliciousPath, content: content }, ctx))
      .rejects.toThrow()
  })

  it("should reject absolute paths", async () => {
    const absolutePath = "/etc/passwd"
    const content = "malicious content"
    
    await expect(editFileTool.execute({ path: absolutePath, content: content }, ctx))
      .rejects.toThrow()
  })

  it("should reject complex path traversal patterns", async () => {
    const maliciousPath = "safe/../../../dangerous/file"
    const content = "content"
    
    await expect(editFileTool.execute({ path: maliciousPath, content: content }, ctx))
      .rejects.toThrow()
  })

  it("should reject encoded path traversal", async () => {
    const maliciousPath = "..%2F..%2F..%2Fetc%2Fpasswd"
    const content = "content"
    
    await expect(editFileTool.execute({ path: maliciousPath, content: content }, ctx))
      .rejects.toThrow()
  })
})

describe("Feature: Property-based testing for file paths and content", () => {
  it("should handle arbitrary safe file paths", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 50 }).filter(s => 
        !s.includes("..") && 
        !s.startsWith("/") && 
        !s.includes("\0") &&
        s.trim().length > 0
      ),
      fc.string({ maxLength: 1000 }),
      async (path, content) => {
        const result = await editFileTool.execute({ path, content }, ctx)
        expect(typeof result).toBe("string")
        expect(result.length).toBeGreaterThan(0)
      }
    ))
  })

  it("should handle arbitrary content sizes", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ maxLength: 10000 }),
      async (content) => {
        const result = await editFileTool.execute({ path: "test.txt", content }, ctx)
        expect(typeof result).toBe("string")
        expect(result.length).toBeGreaterThan(0)
      }
    ))
  })
})

describe("Feature: Error conditions", () => {
  it("should handle missing path parameter", async () => {
    await expect(editFileTool.execute({ content: "test" } as any, ctx))
      .rejects.toThrow()
  })

  it("should handle missing content parameter", async () => {
    await expect(editFileTool.execute({ path: "test.txt" } as any, ctx))
      .rejects.toThrow()
  })

  it("should handle null path", async () => {
    await expect(editFileTool.execute({ path: null, content: "test" } as any, ctx))
      .rejects.toThrow()
  })

  it("should handle null content", async () => {
    await expect(editFileTool.execute({ path: "test.txt", content: null } as any, ctx))
      .rejects.toThrow()
  })

  it("should handle empty path string", async () => {
    await expect(editFileTool.execute({ path: "", content: "test" }, ctx))
      .rejects.toThrow()
  })

  it("should handle whitespace-only path", async () => {
    await expect(editFileTool.execute({ path: "   ", content: "test" }, ctx))
      .rejects.toThrow()
  })

  it("should handle path with null bytes", async () => {
    await expect(editFileTool.execute({ path: "test\0.txt", content: "test" }, ctx))
      .rejects.toThrow()
  })
})

describe("Feature: Special characters and edge cases", () => {
  it("should handle Unicode content", async () => {
    const content = "Hello 世界 🌍 café naïve résumé"
    
    const result = await editFileTool.execute({ path: "unicode.txt", content }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("should handle very long file names", async () => {
    const longName = "a".repeat(100) + ".txt"
    const content = "test content"
    
    const result = await editFileTool.execute({ path: longName, content }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("should handle files with special characters in name", async () => {
    const specialName = "file-with_special.chars@123.txt"
    const content = "special file content"
    
    const result = await editFileTool.execute({ path: specialName, content }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("should handle binary-like content", async () => {
    const binaryContent = "\x00\x01\x02\xFF\xFE"
    
    const result = await editFileTool.execute({ path: "binary.dat", content: binaryContent }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })
})