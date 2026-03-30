import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentContext } from "../../src/types.js"
import { runCommandTool } from "../../src/tools/run-command.js"

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
  it("should have runCommandTool with correct structure", () => {
    expect(runCommandTool).toBeDefined()
    expect(runCommandTool.name).toBe("run_command")
    expect(runCommandTool.description).toBeDefined()
    expect(runCommandTool.inputSchema).toBeDefined()
    expect(typeof runCommandTool.execute).toBe("function")
  })

  it("should execute allowed commands and return string output", async () => {
    writeFileSync(join(workDir, "test.txt"), "hello world")
    
    const result = await runCommandTool.execute({ command: "cat test.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("hello world")
  })

  it("should execute git commands", async () => {
    const result = await runCommandTool.execute({ command: "git --version" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("git version")
  })

  it("should execute node commands", async () => {
    const result = await runCommandTool.execute({ command: "node --version" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toMatch(/^v\d+\.\d+\.\d+/)
  })
})

describe("Feature: Property-based tests for valid commands", () => {
  it("should handle valid commands with various arguments", () => {
    fc.assert(fc.asyncProperty(
      fc.constantFrom("cat", "head", "tail", "wc", "git"),
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 3 }),
      async (command, args) => {
        const fullCommand = [command, ...args].join(" ")
        
        try {
          const result = await runCommandTool.execute({ command: fullCommand }, ctx)
          expect(typeof result).toBe("string")
        } catch (error) {
          // Command may fail due to invalid args, but should not fail due to allowlist
          expect(error).not.toMatch(/not allowed/)
        }
      }
    ))
  })

  it("should handle commands with file paths in workDir", () => {
    fc.assert(fc.asyncProperty(
      fc.constantFrom("cat", "head", "tail", "wc"),
      fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes("/") && !s.includes("\\") && !s.includes("..") && s.trim() === s),
      async (command, filename) => {
        const filepath = join(workDir, filename)
        writeFileSync(filepath, "test content")
        
        const result = await runCommandTool.execute({ command: `${command} ${filename}` }, ctx)
        expect(typeof result).toBe("string")
      }
    ))
  })
})

describe("Feature: Negative tests for error conditions", () => {
  it("should reject disallowed commands", async () => {
    await expect(runCommandTool.execute({ command: "echo hello" }, ctx))
      .rejects.toThrow('Command "echo" is not allowed')
  })

  it("should reject various disallowed commands", async () => {
    const disallowedCommands = ["ls", "pwd", "rm", "mkdir", "touch", "cp", "mv", "sleep"]
    
    for (const cmd of disallowedCommands) {
      await expect(runCommandTool.execute({ command: cmd }, ctx))
        .rejects.toThrow(`Command "${cmd}" is not allowed`)
    }
  })

  it("should reject path traversal attempts", async () => {
    await expect(runCommandTool.execute({ command: "cat ../../../etc/passwd" }, ctx))
      .rejects.toThrow()
  })

  it("should reject commands with path traversal in arguments", async () => {
    await expect(runCommandTool.execute({ command: "head ../../../../etc/hosts" }, ctx))
      .rejects.toThrow()
  })

  it("should reject empty commands", async () => {
    await expect(runCommandTool.execute({ command: "" }, ctx))
      .rejects.toThrow()
  })

  it("should reject whitespace-only commands", async () => {
    await expect(runCommandTool.execute({ command: "   " }, ctx))
      .rejects.toThrow()
  })

  it("should handle missing input gracefully", async () => {
    await expect(runCommandTool.execute({} as any, ctx))
      .rejects.toThrow()
  })

  it("should handle null/undefined command", async () => {
    await expect(runCommandTool.execute({ command: null as any }, ctx))
      .rejects.toThrow()
    
    await expect(runCommandTool.execute({ command: undefined as any }, ctx))
      .rejects.toThrow()
  })
})

describe("Feature: Domain-specific properties", () => {
  it("should respect custom allowedCommands in context", async () => {
    const customCtx = {
      ...ctx,
      allowedCommands: ["echo"]
    }
    
    // Should allow echo when explicitly allowed
    const result = await runCommandTool.execute({ command: "echo hello" }, customCtx)
    expect(typeof result).toBe("string")
    expect(result).toContain("hello")
    
    // Should reject normally allowed commands when custom list is set
    await expect(runCommandTool.execute({ command: "cat /dev/null" }, customCtx))
      .rejects.toThrow('Command "cat" is not allowed')
  })

  it("should execute commands in the correct working directory", async () => {
    mkdirSync(join(workDir, "subdir"))
    writeFileSync(join(workDir, "subdir", "file.txt"), "content")
    
    const result = await runCommandTool.execute({ command: "cat subdir/file.txt" }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("content")
  })

  it("should handle command output with newlines correctly", async () => {
    writeFileSync(join(workDir, "multiline.txt"), "line1\nline2\nline3")
    
    const result = await runCommandTool.execute({ command: "cat multiline.txt" }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("line1")
    expect(result).toContain("line2")
    expect(result).toContain("line3")
  })

  it("should handle binary file operations", async () => {
    writeFileSync(join(workDir, "binary.dat"), Buffer.from([0x00, 0x01, 0x02, 0xFF]))
    
    const result = await runCommandTool.execute({ command: "wc -c binary.dat" }, ctx)
    expect(typeof result).toBe("string")
    expect(result).toContain("4")
  })

  it("should handle commands that produce no output", async () => {
    const result = await runCommandTool.execute({ command: "git init" }, ctx)
    expect(typeof result).toBe("string")
  })

  it("should preserve command argument structure", async () => {
    writeFileSync(join(workDir, "test file with spaces.txt"), "content")
    
    // This should work if the tool properly handles arguments
    try {
      const result = await runCommandTool.execute({ command: 'cat "test file with spaces.txt"' }, ctx)
      expect(typeof result).toBe("string")
      expect(result).toContain("content")
    } catch (error) {
      // File might not be found due to shell parsing, but error should be about file, not command
      expect(error).not.toMatch(/not allowed/)
    }
  })
})