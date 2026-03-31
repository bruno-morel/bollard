import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentContext } from "../../src/types.js"
import { readFileTool } from "../../src/tools/read-file.js"

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
  it("should read file content as UTF-8 string", async () => {
    const content = "Hello, world!\nThis is a test file."
    writeFileSync(join(workDir, "test.txt"), content, "utf-8")
    
    const result = await readFileTool.execute({ path: "test.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe(content)
  })

  it("should read empty file as empty string", async () => {
    writeFileSync(join(workDir, "empty.txt"), "", "utf-8")
    
    const result = await readFileTool.execute({ path: "empty.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe("")
  })

  it("should read file with unicode content", async () => {
    const content = "Hello 世界! 🌍 Café naïve résumé"
    writeFileSync(join(workDir, "unicode.txt"), content, "utf-8")
    
    const result = await readFileTool.execute({ path: "unicode.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe(content)
  })

  it("should read file in subdirectory", async () => {
    const subDir = join(workDir, "subdir")
    mkdirSync(subDir)
    const content = "Nested file content"
    writeFileSync(join(subDir, "nested.txt"), content, "utf-8")
    
    const result = await readFileTool.execute({ path: "subdir/nested.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe(content)
  })
})

describe("Feature: Property-based tests for string parameters", () => {
  it("should read any valid filename within workDir", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 50 }).filter(s => 
        !s.includes('/') && !s.includes('\\') && !s.includes('\0') && 
        s !== '.' && s !== '..' && s.trim() === s
      ),
      fc.string({ minLength: 0, maxLength: 1000 }),
      async (filename, content) => {
        writeFileSync(join(workDir, filename), content, "utf-8")
        
        const result = await readFileTool.execute({ path: filename }, ctx)
        
        expect(typeof result).toBe("string")
        expect(result).toBe(content)
      }
    ))
  })

  it("should preserve exact content for any UTF-8 string", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string(),
      async (content) => {
        writeFileSync(join(workDir, "prop-test.txt"), content, "utf-8")
        
        const result = await readFileTool.execute({ path: "prop-test.txt" }, ctx)
        
        expect(typeof result).toBe("string")
        expect(result).toBe(content)
        expect(result.length).toBe(content.length)
      }
    ))
  })
})

describe("Feature: Negative tests for error conditions", () => {
  it("should throw when file does not exist", async () => {
    await expect(readFileTool.execute({ path: "nonexistent.txt" }, ctx))
      .rejects.toThrow()
  })

  it("should reject path traversal attempts", async () => {
    // Create a file outside workDir to ensure it exists
    const outsideFile = join(tmpdir(), "outside-file.txt")
    writeFileSync(outsideFile, "secret content", "utf-8")
    
    try {
      await expect(readFileTool.execute({ path: "../outside-file.txt" }, ctx))
        .rejects.toThrow()
      
      await expect(readFileTool.execute({ path: "../../outside-file.txt" }, ctx))
        .rejects.toThrow()
      
      await expect(readFileTool.execute({ path: "../../../etc/passwd" }, ctx))
        .rejects.toThrow()
      
      await expect(readFileTool.execute({ path: "../../../../tmp/outside-file.txt" }, ctx))
        .rejects.toThrow()
    } finally {
      rmSync(outsideFile, { force: true })
    }
  })

  it("should reject absolute paths", async () => {
    await expect(readFileTool.execute({ path: "/etc/passwd" }, ctx))
      .rejects.toThrow()
    
    await expect(readFileTool.execute({ path: "/tmp/test.txt" }, ctx))
      .rejects.toThrow()
  })

  it("should reject null bytes in path", async () => {
    await expect(readFileTool.execute({ path: "test\0.txt" }, ctx))
      .rejects.toThrow()
    
    await expect(readFileTool.execute({ path: "test.txt\0" }, ctx))
      .rejects.toThrow()
  })

  it("should throw when trying to read directory", async () => {
    mkdirSync(join(workDir, "testdir"))
    
    await expect(readFileTool.execute({ path: "testdir" }, ctx))
      .rejects.toThrow()
  })

  it("should handle empty path", async () => {
    await expect(readFileTool.execute({ path: "" }, ctx))
      .rejects.toThrow()
  })

  it("should handle path with only dots", async () => {
    await expect(readFileTool.execute({ path: "." }, ctx))
      .rejects.toThrow()
    
    await expect(readFileTool.execute({ path: ".." }, ctx))
      .rejects.toThrow()
  })
})

describe("Feature: Domain-specific properties", () => {
  it("should preserve line endings exactly", async () => {
    const contentWithCRLF = "line1\r\nline2\r\nline3"
    const contentWithLF = "line1\nline2\nline3"
    const contentWithCR = "line1\rline2\rline3"
    
    writeFileSync(join(workDir, "crlf.txt"), contentWithCRLF, "utf-8")
    writeFileSync(join(workDir, "lf.txt"), contentWithLF, "utf-8")
    writeFileSync(join(workDir, "cr.txt"), contentWithCR, "utf-8")
    
    const crlfResult = await readFileTool.execute({ path: "crlf.txt" }, ctx)
    const lfResult = await readFileTool.execute({ path: "lf.txt" }, ctx)
    const crResult = await readFileTool.execute({ path: "cr.txt" }, ctx)
    
    expect(crlfResult).toBe(contentWithCRLF)
    expect(lfResult).toBe(contentWithLF)
    expect(crResult).toBe(contentWithCR)
    expect(crlfResult).not.toBe(lfResult)
    expect(lfResult).not.toBe(crResult)
  })

  it("should handle files with no trailing newline", async () => {
    const contentNoNewline = "content without newline"
    const contentWithNewline = "content with newline\n"
    
    writeFileSync(join(workDir, "no-newline.txt"), contentNoNewline, "utf-8")
    writeFileSync(join(workDir, "with-newline.txt"), contentWithNewline, "utf-8")
    
    const noNewlineResult = await readFileTool.execute({ path: "no-newline.txt" }, ctx)
    const withNewlineResult = await readFileTool.execute({ path: "with-newline.txt" }, ctx)
    
    expect(noNewlineResult).toBe(contentNoNewline)
    expect(withNewlineResult).toBe(contentWithNewline)
    expect(noNewlineResult.endsWith('\n')).toBe(false)
    expect(withNewlineResult.endsWith('\n')).toBe(true)
  })

  it("should read binary data as UTF-8 interpretation", async () => {
    // Write some bytes that aren't valid UTF-8
    const buffer = Buffer.from([0xFF, 0xFE, 0x00, 0x41]) // Invalid UTF-8 sequence
    writeFileSync(join(workDir, "binary.txt"), buffer)
    
    const result = await readFileTool.execute({ path: "binary.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    // The exact content depends on how Node.js handles invalid UTF-8, but it should be a string
  })

  it("should handle very large files", async () => {
    const largeContent = "x".repeat(100000) // 100KB of 'x'
    writeFileSync(join(workDir, "large.txt"), largeContent, "utf-8")
    
    const result = await readFileTool.execute({ path: "large.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBe(100000)
    expect(result).toBe(largeContent)
  })
})