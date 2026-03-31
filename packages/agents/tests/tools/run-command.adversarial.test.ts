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
  it("should have a runCommandTool with execute method", () => {
    expect(runCommandTool).toBeDefined()
    expect(typeof runCommandTool.execute).toBe("function")
  })

  it("should execute allowed commands and return string output", async () => {
    writeFileSync(join(workDir, "test.txt"), "hello world\n")
    
    const result = await runCommandTool.execute({ command: "cat test.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("hello world")
  })

  it("should handle commands with arguments", async () => {
    writeFileSync(join(workDir, "multiline.txt"), "line1\nline2\nline3\n")
    
    const result = await runCommandTool.execute({ command: "head -n 2 multiline.txt" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result).toContain("line1")
    expect(result).toContain("line2")
    expect(result).not.toContain("line3")
  })
})

describe("Feature: Property-based tests for string parameters", () => {
  it("should handle valid commands with arbitrary file content", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("cat", "head", "tail", "wc"),
      fc.string({ minLength: 1, maxLength: 100 }),
      async (command, content) => {
        const filename = "prop-test.txt"
        writeFileSync(join(workDir, filename), content)
        
        const result = await runCommandTool.execute({ command: `${command} ${filename}` }, ctx)
        
        expect(typeof result).toBe("string")
        expect(result.length).toBeGreaterThanOrEqual(0)
      }
    ))
  })

  it("should handle git commands in various directories", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("git status", "git log --oneline", "git branch"),
      async (command) => {
        // Initialize a git repo for testing
        await runCommandTool.execute({ command: "git init" }, ctx)
        
        const result = await runCommandTool.execute({ command }, ctx)
        
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

  it("should reject dangerous commands", async () => {
    const dangerousCommands = ["rm", "ls", "pwd", "sleep", "curl", "wget"]
    
    for (const cmd of dangerousCommands) {
      await expect(runCommandTool.execute({ command: cmd }, ctx))
        .rejects.toThrow(`Command "${cmd}" is not allowed`)
    }
  })

  it("should reject path traversal attempts", async () => {
    await expect(runCommandTool.execute({ command: "cat ../../../etc/passwd" }, ctx))
      .rejects.toThrow()
  })

  it("should reject commands that try to escape workDir", async () => {
    const traversalAttempts = [
      "cat ../../../../etc/passwd",
      "head ../../../root/.bashrc",
      "tail /etc/shadow"
    ]
    
    for (const command of traversalAttempts) {
      await expect(runCommandTool.execute({ command }, ctx))
        .rejects.toThrow()
    }
  })

  it("should handle non-existent files gracefully", async () => {
    await expect(runCommandTool.execute({ command: "cat nonexistent.txt" }, ctx))
      .rejects.toThrow()
  })

  it("should respect custom allowedCommands in context", async () => {
    const restrictedCtx = {
      ...ctx,
      allowedCommands: ["cat"]
    }
    
    // Should work with allowed command
    writeFileSync(join(workDir, "test.txt"), "content")
    const result = await runCommandTool.execute({ command: "cat test.txt" }, restrictedCtx)
    expect(typeof result).toBe("string")
    
    // Should fail with normally-allowed but now-restricted command
    await expect(runCommandTool.execute({ command: "git status" }, restrictedCtx))
      .rejects.toThrow('Command "git" is not allowed')
  })

  it("should handle empty command strings", async () => {
    await expect(runCommandTool.execute({ command: "" }, ctx))
      .rejects.toThrow()
  })

  it("should handle commands with only whitespace", async () => {
    await expect(runCommandTool.execute({ command: "   " }, ctx))
      .rejects.toThrow()
  })
})

describe("Feature: Domain-specific property assertions", () => {
  it("should return file contents when using cat command", async () => {
    const testContent = "specific test content for verification"
    writeFileSync(join(workDir, "content-test.txt"), testContent)
    
    const result = await runCommandTool.execute({ command: "cat content-test.txt" }, ctx)
    
    expect(result).toBe(testContent)
  })

  it("should return line count information for wc command", async () => {
    writeFileSync(join(workDir, "lines.txt"), "line1\nline2\nline3\n")
    
    const result = await runCommandTool.execute({ command: "wc -l lines.txt" }, ctx)
    
    expect(result).toMatch(/3.*lines\.txt/)
  })

  it("should return limited output for head command", async () => {
    const manyLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
    writeFileSync(join(workDir, "many-lines.txt"), manyLines)
    
    const result = await runCommandTool.execute({ command: "head -n 5 many-lines.txt" }, ctx)
    
    const resultLines = result.trim().split("\n")
    expect(resultLines.length).toBe(5)
    expect(result).toContain("line1")
    expect(result).toContain("line5")
    expect(result).not.toContain("line6")
  })

  it("should return git repository information", async () => {
    await runCommandTool.execute({ command: "git init" }, ctx)
    writeFileSync(join(workDir, "README.md"), "# Test repo")
    await runCommandTool.execute({ command: "git add README.md" }, ctx)
    await runCommandTool.execute({ command: "git config user.email 'test@example.com'" }, ctx)
    await runCommandTool.execute({ command: "git config user.name 'Test User'" }, ctx)
    await runCommandTool.execute({ command: "git commit -m 'Initial commit'" }, ctx)
    
    const result = await runCommandTool.execute({ command: "git log --oneline" }, ctx)
    
    expect(result).toContain("Initial commit")
  })

  it("should handle TypeScript compilation commands", async () => {
    writeFileSync(join(workDir, "test.ts"), "const x: number = 42;")
    writeFileSync(join(workDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "es2020", module: "commonjs" }
    }))
    
    const result = await runCommandTool.execute({ command: "tsc --noEmit test.ts" }, ctx)
    
    expect(typeof result).toBe("string")
  })

  it("should handle package manager commands", async () => {
    writeFileSync(join(workDir, "package.json"), JSON.stringify({
      name: "test-package",
      version: "1.0.0"
    }))
    
    const result = await runCommandTool.execute({ command: "pnpm --version" }, ctx)
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })
})