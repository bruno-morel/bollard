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
  it("should have readFileTool with correct structure", () => {
    expect(readFileTool).toBeDefined()
    expect(typeof readFileTool.execute).toBe("function")
    expect(readFileTool.name).toBeDefined()
    expect(readFileTool.description).toBeDefined()
  })

  it("should read existing file content as string", async () => {
    const content = "Hello, world!"
    const filename = "test.txt"
    writeFileSync(join(workDir, filename), content, "utf-8")

    const result = await readFileTool.execute({ path: filename }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe(content)
  })

  it("should read UTF-8 encoded files correctly", async () => {
    const content = "Hello 世界 🌍"
    const filename = "unicode.txt"
    writeFileSync(join(workDir, filename), content, "utf-8")

    const result = await readFileTool.execute({ path: filename }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe(content)
  })
})

describe("Feature: Property-based tests for string parameters", () => {
  it("should read any valid filename with alphanumeric content", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9._-]+$/.test(s)),
      fc.string({ minLength: 0, maxLength: 1000 }),
      async (filename, content) => {
        writeFileSync(join(workDir, filename), content, "utf-8")
        
        const result = await readFileTool.execute({ path: filename }, ctx)
        
        expect(typeof result).toBe("string")
        expect(result).toBe(content)
      }
    ))
  })

  it("should handle files with various content lengths", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 0, maxLength: 10000 }),
      async (content) => {
        const filename = "length-test.txt"
        writeFileSync(join(workDir, filename), content, "utf-8")
        
        const result = await readFileTool.execute({ path: filename }, ctx)
        
        expect(typeof result).toBe("string")
        expect(result.length).toBe(content.length)
        expect(result).toBe(content)
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
    await expect(readFileTool.execute({ path: "../../../etc/passwd" }, ctx))
      .rejects.toThrow()
  })

  it("should reject absolute paths outside workDir", async () => {
    await expect(readFileTool.execute({ path: "/etc/passwd" }, ctx))
      .rejects.toThrow()
  })

  it("should reject complex path traversal with mixed separators", async () => {
    await expect(readFileTool.execute({ path: "..\\..\\..\\windows\\system32\\drivers\\etc\\hosts" }, ctx))
      .rejects.toThrow()
  })

  it("should reject paths with null bytes", async () => {
    await expect(readFileTool.execute({ path: "test\0.txt" }, ctx))
      .rejects.toThrow()
  })

  it("should reject empty path", async () => {
    await expect(readFileTool.execute({ path: "" }, ctx))
      .rejects.toThrow()
  })

  it("should reject directory paths", async () => {
    const dirname = "testdir"
    writeFileSync(join(workDir, dirname), "", "utf-8")
    
    await expect(readFileTool.execute({ path: dirname }, ctx))
      .rejects.toThrow()
  })
})

describe("Feature: Domain-specific file reading properties", () => {
  it("should preserve exact file content including whitespace", async () => {
    const content = "  \n\t  spaces and tabs  \n  "
    const filename = "whitespace.txt"
    writeFileSync(join(workDir, filename), content, "utf-8")

    const result = await readFileTool.execute({ path: filename }, ctx)
    
    expect(result).toBe(content)
    expect(result.includes("\n")).toBe(true)
    expect(result.includes("\t")).toBe(true)
  })

  it("should handle empty files", async () => {
    const filename = "empty.txt"
    writeFileSync(join(workDir, filename), "", "utf-8")

    const result = await readFileTool.execute({ path: filename }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe("")
    expect(result.length).toBe(0)
  })

  it("should read files in subdirectories within workDir", async () => {
    const subdir = "subdir"
    const filename = "nested.txt"
    const content = "nested content"
    
    writeFileSync(join(workDir, subdir), "", "utf-8")
    rmSync(join(workDir, subdir))
    writeFileSync(join(workDir, subdir, filename), content, "utf-8")

    const result = await readFileTool.execute({ path: join(subdir, filename) }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe(content)
  })

  it("should handle files with special characters in content", async () => {
    const content = "Special chars: !@#$%^&*()[]{}|\\:;\"'<>?,./"
    const filename = "special.txt"
    writeFileSync(join(workDir, filename), content, "utf-8")

    const result = await readFileTool.execute({ path: filename }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe(content)
  })

  it("should return string with correct line endings", async () => {
    const content = "line1\nline2\r\nline3\r"
    const filename = "lineendings.txt"
    writeFileSync(join(workDir, filename), content, "utf-8")

    const result = await readFileTool.execute({ path: filename }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toBe(content)
    expect(result.split("\n").length).toBe(3)
  })
})