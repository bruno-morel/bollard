# Fix: Coder Write-Scope Guard (Plan-Scoped File Enforcement)

## Context

Bollard-on-Bollard self-tests consistently show the coder agent violating the plan's `affected_files`
boundary. In the clamp() run (`20260525-0038-run-ee973e`), the coder spent 25+ turns editing
`packages/engine/tests/cost-tracker.test.ts` — a 1330-line file not listed in `affected_files.modify`
— because it contained pre-existing tests for related methods. This file-scope violation caused:

1. 25+ wasted coder turns (42% of a 54-turn run)
2. Stale line-number corruption when edits shifted file content mid-session
3. 14 TypeScript errors in the final state (2 corrupted method signatures)
4. 100% contract claim drop (grounding corpus mismatched corrupted source)

The coder prompt already says "Do NOT touch files not in `affected_files.modify` or
`affected_files.create`" — but this is advisory only. The coder ignores it under pressure. This fix
enforces the constraint in infrastructure: `write_file` and `edit_file` return an error string (not
throw) when the target path is outside `allowedWritePaths`. Additionally, workspace-root writes
(files directly at `workDir/` like `test-clamp.js`, `debug-clamp.test.ts`) are blocked as a
belt-and-suspenders guard against scratch file creation.

## Files to change

1. `packages/agents/src/types.ts` — add `allowedWritePaths` to `AgentContext`
2. `packages/agents/src/tools/write-file.ts` — add scope guard
3. `packages/agents/src/tools/edit-file.ts` — add scope guard
4. `packages/cli/src/agent-handler.ts` — populate `allowedWritePaths` for coder role
5. `packages/agents/tests/tools.test.ts` — add tests for the new behavior

## Exact changes

### 1. `packages/agents/src/types.ts`

Add `allowedWritePaths?: string[]` to the `AgentContext` interface, between `allowedCommands` and
`progress`:

```typescript
export interface AgentContext {
  pipelineCtx: PipelineContext
  workDir: string
  allowedCommands?: string[]
  allowedWritePaths?: string[]  // ← ADD THIS LINE
  progress?: AgentProgressCallback
}
```

No other changes to this file.

### 2. `packages/agents/src/tools/write-file.ts`

After the existing path-traversal guard and before the `mkdir`/`writeFile` calls, insert a scope
guard. The guard returns an error string (same pattern as `edit-file.ts` error returns — NOT a
throw) when `allowedWritePaths` is set and the resolved path is not in the set:

```typescript
async execute(input, ctx) {
  const filePath = resolve(ctx.workDir, String(input["path"] ?? ""))
  if (!filePath.startsWith(resolve(ctx.workDir))) {
    throw new Error("Path traversal detected: path must be within the project directory")
  }

  // Scope guard: if allowedWritePaths is set, only allow writes to listed paths
  if (ctx.allowedWritePaths !== undefined) {
    const workDir = resolve(ctx.workDir)
    // Block workspace-root writes (scratch files like debug.ts, test-foo.js at project root)
    const { dirname } = await import("node:path")
    if (dirname(filePath) === workDir) {
      return `Error: writing files directly to the project root is not allowed. ` +
        `Only allowed paths: ${ctx.allowedWritePaths.join(", ")}`
    }
    if (!ctx.allowedWritePaths.includes(filePath)) {
      return `Error: "${String(input["path"])}" is not in the plan's affected_files. ` +
        `Only allowed to write: ${ctx.allowedWritePaths.map((p) => p.replace(workDir + "/", "")).join(", ")}. ` +
        `If you need to modify this file, read the plan again — it must be listed there.`
    }
  }

  const content = String(input["content"] ?? "")
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, "utf-8")
  return `Written ${content.length} bytes to ${String(input["path"])}`
},
```

Note: `dirname` is already imported at the top of this file. The `await import("node:path")` pattern
above is illustrative; use the static import that already exists.

The complete file should look like this after the change:

```typescript
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { AgentTool } from "../types.js"

export const writeFileTool: AgentTool = {
  name: "write_file",
  description:
    "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to the file from the project root" },
      content: { type: "string", description: "The content to write to the file" },
    },
    required: ["path", "content"],
  },
  async execute(input, ctx) {
    const filePath = resolve(ctx.workDir, String(input["path"] ?? ""))
    if (!filePath.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected: path must be within the project directory")
    }

    // Scope guard: if allowedWritePaths is set, only allow writes to listed paths
    if (ctx.allowedWritePaths !== undefined) {
      const workDir = resolve(ctx.workDir)
      // Block workspace-root writes (scratch files like debug.ts, test-foo.js at project root)
      if (dirname(filePath) === workDir) {
        return (
          `Error: writing files directly to the project root is not allowed. ` +
          `Allowed paths: ${ctx.allowedWritePaths.map((p) => p.replace(workDir + "/", "")).join(", ")}`
        )
      }
      if (!ctx.allowedWritePaths.includes(filePath)) {
        return (
          `Error: "${String(input["path"])}" is not in the plan's affected_files. ` +
          `Only allowed to write: ${ctx.allowedWritePaths.map((p) => p.replace(workDir + "/", "")).join(", ")}. ` +
          `If you need to modify this file, read the plan again — it must be listed there.`
        )
      }
    }

    const content = String(input["content"] ?? "")
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, "utf-8")
    return `Written ${content.length} bytes to ${String(input["path"])}`
  },
}
```

### 3. `packages/agents/src/tools/edit-file.ts`

Add the same scope guard immediately after the existing path-traversal check (line 46 in the
current file), before `const newString = String(input["new_string"] ?? "")`:

```typescript
async execute(input, ctx) {
  const filePath = resolve(ctx.workDir, String(input["path"] ?? ""))
  if (!filePath.startsWith(resolve(ctx.workDir))) {
    throw new Error("Path traversal detected: path must be within the project directory")
  }

  // Scope guard: if allowedWritePaths is set, only allow edits to listed paths
  if (ctx.allowedWritePaths !== undefined) {
    const workDir = resolve(ctx.workDir)
    if (dirname(filePath) === workDir) {
      return (
        `Error: editing files directly at the project root is not allowed. ` +
        `Allowed paths: ${ctx.allowedWritePaths.map((p) => p.replace(workDir + "/", "")).join(", ")}`
      )
    }
    if (!ctx.allowedWritePaths.includes(filePath)) {
      return (
        `Error: "${String(input["path"])}" is not in the plan's affected_files. ` +
        `Only allowed to edit: ${ctx.allowedWritePaths.map((p) => p.replace(workDir + "/", "")).join(", ")}. ` +
        `If you need to modify this file, read the plan again — it must be listed there.`
      )
    }
  }

  const newString = String(input["new_string"] ?? "")
  // ... rest of function unchanged
```

You need to add `import { dirname } from "node:path"` to the imports (currently only `resolve` is
imported from `"node:path"`). The import line at the top changes from:

```typescript
import { resolve } from "node:path"
```

to:

```typescript
import { dirname, resolve } from "node:path"
```

### 4. `packages/cli/src/agent-handler.ts`

Find the section where the coder `agentCtx` is constructed (around lines 524–549). It currently
looks like:

```typescript
const agentCtx: AgentContext = {
  pipelineCtx: ctx,
  workDir,
  ...(profile?.allowedCommands ? { allowedCommands: profile.allowedCommands } : {}),
  progress: (ev) => spinner.handleEvent(ev),
}
```

After the existing `agentCtx` construction, and before `userMessage` is constructed, add the
`allowedWritePaths` population for the coder role. Insert this block:

```typescript
// For the coder role, derive allowedWritePaths from the plan's affected_files
if (agentRole === "coder" && ctx.plan) {
  const plan = ctx.plan as {
    affected_files?: { modify?: string[]; create?: string[] }
  }
  const affectedFiles = [
    ...(plan.affected_files?.modify ?? []),
    ...(plan.affected_files?.create ?? []),
  ]
  if (affectedFiles.length > 0) {
    agentCtx.allowedWritePaths = affectedFiles.map((f) => resolve(workDir, f))
  }
}
```

**Important:** This block must be inserted AFTER `const agentCtx: AgentContext = { ... }` and
BEFORE the `userMessage` construction that follows it. Do not restructure the surrounding code.

The `resolve` function is already imported from `"node:path"` in `agent-handler.ts`. No new imports
needed.

### 5. `packages/agents/tests/tools.test.ts`

Add tests at the end of the `describe("write_file", ...)` block and the end of the
`describe("edit_file", ...)` block.

**In `describe("write_file", ...)` (after the existing `"rejects path traversal"` test):**

```typescript
  it("returns error when path is outside allowedWritePaths", async () => {
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await writeFileTool.execute(
      { path: "src/other.ts", content: "x" },
      ctxWithScope,
    )
    expect(result).toContain("Error:")
    expect(result).toContain("not in the plan's affected_files")
    expect(result).toContain("src/allowed.ts")
  })

  it("allows write to a path that is in allowedWritePaths", async () => {
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await writeFileTool.execute(
      { path: "src/allowed.ts", content: "export const x = 1" },
      ctxWithScope,
    )
    expect(result).toContain("bytes")
    expect(result).not.toContain("Error:")
  })

  it("blocks write to workspace root when allowedWritePaths is set", async () => {
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await writeFileTool.execute(
      { path: "scratch.ts", content: "x" },
      ctxWithScope,
    )
    expect(result).toContain("Error:")
    expect(result).toContain("project root is not allowed")
  })

  it("allows write to any path when allowedWritePaths is not set (backward-compatible)", async () => {
    const result = await writeFileTool.execute(
      { path: "anywhere/file.ts", content: "export {}" },
      ctx, // no allowedWritePaths
    )
    expect(result).toContain("bytes")
    expect(result).not.toContain("Error:")
  })
```

**In `describe("edit_file", ...)` (after the existing `"rejects path traversal"` test):**

```typescript
  it("returns error when path is outside allowedWritePaths", async () => {
    writeFileSync(join(tempDir, "src", "other.ts"), "const x = 1\n", )
    // note: mkdirSync needed first
    mkdirSync(join(tempDir, "src"), { recursive: true })
    writeFileSync(join(tempDir, "src", "other.ts"), "const x = 1\n")
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await editFileTool.execute(
      { path: "src/other.ts", old_string: "const x = 1", new_string: "const x = 2" },
      ctxWithScope,
    )
    expect(result).toContain("Error:")
    expect(result).toContain("not in the plan's affected_files")
  })

  it("allows edit to a path in allowedWritePaths", async () => {
    mkdirSync(join(tempDir, "src"), { recursive: true })
    writeFileSync(join(tempDir, "src", "allowed.ts"), "const x = 1\n")
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await editFileTool.execute(
      { path: "src/allowed.ts", old_string: "const x = 1", new_string: "const x = 2" },
      ctxWithScope,
    )
    expect(result).toContain("Replaced")
    expect(result).not.toContain("Error:")
  })

  it("blocks edit to workspace root when allowedWritePaths is set", async () => {
    writeFileSync(join(tempDir, "debug.ts"), "const x = 1\n")
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await editFileTool.execute(
      { path: "debug.ts", old_string: "const x = 1", new_string: "const x = 2" },
      ctxWithScope,
    )
    expect(result).toContain("Error:")
    expect(result).toContain("project root is not allowed")
  })
```

Note: For the `edit_file` tests, the imports at the top of `tools.test.ts` already include
`mkdirSync` and `writeFileSync` from `"node:fs"`.

## Self-check before completing

After implementing all changes, run inside the Docker container:

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Verify:
- `typecheck`: zero errors
- `lint`: zero errors (run `biome check --fix --unsafe .` if needed, then re-check)
- `test`: ≥ 1154 passed / 6 skipped — the new scope guard tests must appear in the output
- `git diff --name-only` shows ONLY these files:
  - `packages/agents/src/types.ts`
  - `packages/agents/src/tools/write-file.ts`
  - `packages/agents/src/tools/edit-file.ts`
  - `packages/cli/src/agent-handler.ts`
  - `packages/agents/tests/tools.test.ts`

Do NOT touch any other file. Do NOT create scratch files at the project root.
