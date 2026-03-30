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

describe("Feature: Tool metadata and structure", () => {
  it("should have required tool properties", () => {
    expect(listDirTool.name).toBe("list-dir")
    expect(typeof listDirTool.description).toBe("string")
    expect(listDirTool.description.length).toBeGreaterThan(0)
    expect(typeof listDirTool.inputSchema).toBe("object")
    expect(typeof listDirTool.execute).toBe("function")
  })
})

describe("Feature: Directory listing with real filesystem", () => {
  it("should list empty directory", async () => {
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toBe("")
  })

  it("should list files without trailing slash", async () => {
    writeFileSync(join(workDir, "test.txt"), "content")
    writeFileSync(join(workDir, "README.md"), "readme")
    
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("test.txt")
    expect(result).toContain("README.md")
    expect(result).not.toContain("test.txt/")
    expect(result).not.toContain("README.md/")
  })

  it("should list directories with trailing slash", async () => {
    mkdirSync(join(workDir, "subdir"))
    mkdirSync(join(workDir, "another"))
    
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("subdir/")
    expect(result).toContain("another/")
  })

  it("should list mixed files and directories", async () => {
    writeFileSync(join(workDir, "file.txt"), "content")
    mkdirSync(join(workDir, "dir"))
    
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("file.txt")
    expect(result).toContain("dir/")
    expect(result).not.toContain("file.txt/")
  })

  it("should list subdirectory contents", async () => {
    mkdirSync(join(workDir, "subdir"))
    writeFileSync(join(workDir, "subdir", "nested.txt"), "content")
    
    const result = await listDirTool.execute({ path: "subdir" }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("nested.txt")
  })

  it("should return newline-separated output", async () => {
    writeFileSync(join(workDir, "a.txt"), "content")
    writeFileSync(join(workDir, "b.txt"), "content")
    mkdirSync(join(workDir, "c"))
    
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(typeof result).toBe("string")
    const lines = result.split("\n").filter(line => line.length > 0)
    expect(lines.length).toBe(3)
    expect(lines).toContain("a.txt")
    expect(lines).toContain("b.txt")
    expect(lines).toContain("c/")
  })
})

describe("Feature: Path traversal protection", () => {
  it("should reject parent directory traversal", async () => {
    await expect(listDirTool.execute({ path: "../" }, ctx)).rejects.toThrow()
  })

  it("should reject deep parent traversal", async () => {
    await expect(listDirTool.execute({ path: "../../../etc/passwd" }, ctx)).rejects.toThrow()
  })

  it("should reject absolute paths", async () => {
    await expect(listDirTool.execute({ path: "/etc" }, ctx)).rejects.toThrow()
  })

  it("should reject paths with .. components", async () => {
    await expect(listDirTool.execute({ path: "subdir/../../../etc" }, ctx)).rejects.toThrow()
  })

  it("should allow safe relative paths", async () => {
    mkdirSync(join(workDir, "safe"))
    writeFileSync(join(workDir, "safe", "file.txt"), "content")
    
    const result = await listDirTool.execute({ path: "safe" }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("file.txt")
  })
})

describe("Feature: Error handling for invalid paths", () => {
  it("should handle nonexistent directory", async () => {
    await expect(listDirTool.execute({ path: "nonexistent" }, ctx)).rejects.toThrow()
  })

  it("should handle file instead of directory", async () => {
    writeFileSync(join(workDir, "file.txt"), "content")
    
    await expect(listDirTool.execute({ path: "file.txt" }, ctx)).rejects.toThrow()
  })
})

describe("Feature: Property-based testing for path inputs", () => {
  it("should handle various safe relative paths", () => {
    fc.assert(fc.property(
      fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]+$/), { minLength: 1, maxLength: 3 }),
      async (pathSegments) => {
        const safePath = pathSegments.join("/")
        
        // Create the directory structure
        let currentPath = workDir
        for (const segment of pathSegments) {
          currentPath = join(currentPath, segment)
          mkdirSync(currentPath, { recursive: true })
        }
        
        const result = await listDirTool.execute({ path: safePath }, ctx)
        expect(typeof result).toBe("string")
      }
    ), { numRuns: 20 })
  })

  it("should reject paths containing dangerous patterns", () => {
    fc.assert(fc.property(
      fc.oneof(
        fc.constant("../"),
        fc.constant("..\\"),
        fc.constant("/etc"),
        fc.constant("C:\\Windows"),
        fc.stringMatching(/.*\.\..*/)
      ),
      async (dangerousPath) => {
        await expect(listDirTool.execute({ path: dangerousPath }, ctx)).rejects.toThrow()
      }
    ), { numRuns: 10 })
  })
})

describe("Feature: Input validation", () => {
  it("should handle empty path string", async () => {
    const result = await listDirTool.execute({ path: "" }, ctx)
    expect(typeof result).toBe("string")
  })

  it("should handle dot path", async () => {
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(typeof result).toBe("string")
  })

  it("should reject null path", async () => {
    await expect(listDirTool.execute({ path: null as any }, ctx)).rejects.toThrow()
  })

  it("should reject undefined path", async () => {
    await expect(listDirTool.execute({ path: undefined as any }, ctx)).rejects.toThrow()
  })

  it("should reject missing path property", async () => {
    await expect(listDirTool.execute({} as any, ctx)).rejects.toThrow()
  })
})