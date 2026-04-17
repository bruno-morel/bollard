import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentContext } from "../../src/types.js"
import { listDirTool } from "../../src/tools/list-dir.js"

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
  it("should have listDirTool with execute method", () => {
    expect(listDirTool).toBeDefined()
    expect(typeof listDirTool.execute).toBe("function")
  })

  it("should return string for empty directory", async () => {
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toBe("")
  })

  it("should list files without trailing slash", async () => {
    writeFileSync(join(workDir, "test.txt"), "content")
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toBe("test.txt")
  })

  it("should list directories with trailing slash", async () => {
    mkdirSync(join(workDir, "subdir"))
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toBe("subdir/")
  })

  it("should list mixed files and directories", async () => {
    writeFileSync(join(workDir, "file.txt"), "content")
    mkdirSync(join(workDir, "dir"))
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(typeof result).toBe("string")
    const lines = result.split("\n").sort()
    expect(lines).toEqual(["dir/", "file.txt"])
  })

  it("should list subdirectory contents", async () => {
    mkdirSync(join(workDir, "subdir"))
    writeFileSync(join(workDir, "subdir", "nested.txt"), "content")
    const result = await listDirTool.execute({ path: "subdir" }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toBe("nested.txt")
  })
})

describe("Feature: Property-based tests for string parameters", () => {
  it("should handle arbitrary valid relative paths", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]+$/), { minLength: 1, maxLength: 3 }),
      async (pathSegments) => {
        const relativePath = pathSegments.join("/")
        let currentDir = workDir
        
        // Create nested directory structure
        for (const segment of pathSegments) {
          currentDir = join(currentDir, segment)
          mkdirSync(currentDir, { recursive: true })
        }
        
        writeFileSync(join(currentDir, "test.txt"), "content")
        
        const result = await listDirTool.execute({ path: relativePath }, ctx)
        expect(typeof result).toBe("string")
        expect(result).toContain("test.txt")
      }
    ))
  })

  it("should handle various file name patterns", async () => {
    await fc.assert(fc.asyncProperty(
      fc.stringMatching(/^[a-zA-Z0-9._-]+$/).filter((f) => f !== "." && f !== ".."),
      async (filename) => {
        fc.pre(filename.length > 0 && filename.length < 100)
        writeFileSync(join(workDir, filename), "content")
        
        const result = await listDirTool.execute({ path: "." }, ctx)
        expect(typeof result).toBe("string")
        expect(result.split("\n")).toContain(filename)
      }
    ))
  })
})

describe("Feature: Negative tests for error conditions", () => {
  it("should reject path traversal attempts", async () => {
    await expect(listDirTool.execute({ path: "../../../etc/passwd" }, ctx))
      .rejects.toThrow()
  })

  it("should reject absolute paths", async () => {
    await expect(listDirTool.execute({ path: "/etc/passwd" }, ctx))
      .rejects.toThrow()
  })

  it("should reject paths with .. components", async () => {
    await expect(listDirTool.execute({ path: "subdir/../../../etc" }, ctx))
      .rejects.toThrow()
  })

  it("should handle non-existent directory", async () => {
    await expect(listDirTool.execute({ path: "nonexistent" }, ctx))
      .rejects.toThrow()
  })

  it("should handle file instead of directory", async () => {
    writeFileSync(join(workDir, "file.txt"), "content")
    await expect(listDirTool.execute({ path: "file.txt" }, ctx))
      .rejects.toThrow()
  })

  it("treats nullish path as project root listing", async () => {
    writeFileSync(join(workDir, "x.txt"), "1")
    const r1 = await listDirTool.execute({ path: null as unknown as string }, ctx)
    const r2 = await listDirTool.execute({ path: undefined as unknown as string }, ctx)
    const r3 = await listDirTool.execute({ path: "" }, ctx)
    expect(typeof r1).toBe("string")
    expect(typeof r2).toBe("string")
    expect(typeof r3).toBe("string")
  })
})

describe("Feature: Domain-specific properties", () => {
  it("lists all created files", async () => {
    const files = ["zebra.txt", "alpha.txt", "beta.txt"]
    files.forEach((file) => writeFileSync(join(workDir, file), "content"))
    const result = await listDirTool.execute({ path: "." }, ctx)
    const lines = result.split("\n").filter(Boolean)
    expect(new Set(lines)).toEqual(new Set(files))
  })

  it("should distinguish files from directories consistently", async () => {
    writeFileSync(join(workDir, "file"), "content")
    mkdirSync(join(workDir, "dir"))
    
    const result = await listDirTool.execute({ path: "." }, ctx)
    const lines = result.split("\n")
    
    const fileEntry = lines.find(line => line === "file")
    const dirEntry = lines.find(line => line === "dir/")
    
    expect(fileEntry).toBeDefined()
    expect(dirEntry).toBeDefined()
    expect(fileEntry).not.toContain("/")
    expect(dirEntry).toContain("/")
  })

  it("should handle directories with many entries", async () => {
    const numFiles = 100
    for (let i = 0; i < numFiles; i++) {
      writeFileSync(join(workDir, `file${i.toString().padStart(3, "0")}.txt`), "content")
    }
    
    const result = await listDirTool.execute({ path: "." }, ctx)
    const lines = result.split("\n")
    expect(lines).toHaveLength(numFiles)
    expect(lines.every(line => line.endsWith(".txt"))).toBe(true)
  })

  it("should handle special characters in filenames", async () => {
    const specialFiles = ["file with spaces.txt", "file-with-dashes.txt", "file_with_underscores.txt"]
    specialFiles.forEach(file => writeFileSync(join(workDir, file), "content"))
    
    const result = await listDirTool.execute({ path: "." }, ctx)
    const lines = result.split("\n")
    
    specialFiles.forEach(expectedFile => {
      expect(lines).toContain(expectedFile)
    })
  })

  it("should return newline-separated entries for multiple items", async () => {
    writeFileSync(join(workDir, "file1.txt"), "content")
    writeFileSync(join(workDir, "file2.txt"), "content")
    mkdirSync(join(workDir, "dir1"))
    
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(typeof result).toBe("string")
    expect(result.split("\n")).toHaveLength(3)
    expect(result).toMatch(/^[^\n]+\n[^\n]+\n[^\n]+$/)
  })
})