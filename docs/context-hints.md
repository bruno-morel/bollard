# Context Hints Architecture

## The Problem

Type signatures are necessary but insufficient for blind test generation. An adversarial tester agent that receives only function signatures and acceptance criteria cannot write correct tests for code with runtime constraints invisible in types:

- **Filesystem requirements:** `workDir: string` doesn't tell you it must be a real temp directory with `mkdtempSync`
- **Validation strictness:** Zod `.strict()` rejects extra properties, but the TypeScript type allows them
- **Allowlists:** `command: string` accepts anything in types, but only `pnpm`, `node`, `git`, etc. are allowed at runtime
- **Edge-case semantics:** `loadEvalCases("")` returns all cases (empty string is falsy), not an empty array
- **Environment dependencies:** `resolveConfig()` requires `ANTHROPIC_API_KEY` in `process.env` — invisible in the return type

These gaps produced 57 Category A failures in the retro adversarial Pass 2: structurally correct tests against genuinely ambiguous signatures.

## The Solution

A **Runtime Constraints** section in the tester agent's user message, positioned between acceptance criteria and the public API surface. The tester prompt's Rule 13 instructs the agent to treat these constraints as authoritative specification:

```
13. Follow Runtime Constraints exactly. When the task includes a
    "Runtime Constraints" section, treat it as authoritative specification.
    These describe behaviors not visible in types — filesystem requirements,
    validation strictness, environment dependencies, allowlists, edge-case
    semantics. Use the exact fixture setup patterns provided.
```

The Runtime Constraints section is injected identically regardless of where the constraints originate. From the tester's perspective, there is one mechanism: read the constraints, follow them.

## Two Sources of Constraints

### Retro Testing: `getContextHints()`

For retroactive testing against existing code, the `scripts/retro-adversarial.ts` script contains a `getContextHints(relativePath)` function that returns per-module runtime constraints based on substring matching on the file path.

This is a hardcoded stopgap. It works because:
- The module count grows slowly (26 source files at Stage 1)
- The constraints are stable (filesystem I/O and allowlists don't change often)
- The hints are precise (exact fixture patterns, exact allowlist values)

### Pipeline Testing: `runtimeConstraints` in the Plan

For the implement-feature pipeline, the planner agent generates constraints as part of its structured plan output. Each step in the plan has an optional `runtimeConstraints` array:

```json
{
  "description": "Implement the file upload handler",
  "files": ["packages/upload/src/handler.ts"],
  "tests": "Path traversal protection, file size limits, content type validation",
  "runtimeConstraints": [
    "handler() requires a real temp directory for workDir — files are written to disk",
    "Only .jpg, .png, .gif extensions are accepted; others return 415 Unsupported Media Type",
    "Max file size is 10MB — enforced at runtime, not visible in the FileUpload type"
  ]
}
```

The planner derives these from its codebase exploration (reading implementation files, searching for constants, understanding validation schemas). Rule 9 in the planner prompt instructs it to surface facts the tester can't infer from types alone.

At pipeline execution time, `buildTesterMessage()` in `packages/cli/src/agent-handler.ts` extracts constraints from all plan steps, deduplicates them, and injects the Runtime Constraints section.

## Constraint Taxonomy

When writing constraints (manually in `getContextHints()` or via planner exploration), categorize them:

### Filesystem
Functions requiring real directories, path resolution guards, temp directory patterns, cleanup requirements.

*Example: "execute() requires AgentContext with a real workDir temp directory created via mkdtempSync"*

### Validation
Zod/schema strictness beyond TypeScript types, required environment variables, config shape constraints.

*Example: "Zod .strict() validation — extra properties in .bollard.yml cause rejection"*

### Allowlists
Command whitelists, permitted values, enum-like behavior encoded in runtime code rather than types.

*Example: "Only these commands are allowed: pnpm, npx, node, tsc, biome, git, cat, head, tail, wc, diff"*

### Edge Cases
Falsy-value behavior, empty-input semantics, default return values that differ from type expectations.

*Example: "loadEvalCases('') returns ALL cases when agentFilter is empty string — the filter falls through to return-all"*

### Dependencies
Required mocks, external services, heavy constructors that need stubbing.

*Example: "Tests must mock executeAgent, createPlannerAgent, createCoderAgent, and LLMClient"*

### Output Format
String format of return values, delimiter conventions, truncation limits.

*Example: "Directories appear with trailing '/' in output, files don't. Output is newline-separated."*

## When NOT to Write Constraints

Constraints should cover ONLY what types can't express. Do not write constraints for:

- **Pure functions with obvious behavior:** `add(a: number, b: number): number` needs no constraints
- **Behavior already in acceptance criteria:** If the criteria say "returns 404 on missing resource," don't repeat it as a constraint
- **Type-derivable facts:** If the return type is `Promise<string>`, don't write "returns a string" — the type says that
- **Implementation details the tester shouldn't know:** Internal helper functions, private state management, optimization strategies

The goal is to bridge the gap between what types express and what the implementation requires — nothing more, nothing less.

## Validation

Pass 3 of the retro adversarial testing validated this architecture against the 8 worst-performing files. Context hints resolved their target categories: write-file (+8 pass), config (+3 pass), agent-handler (compile error fixed), search (+3 pass). See `docs/retro-adversarial-results.md` for full results.

The planner eval cases (`planner-constraints-filesystem` and `planner-constraints-rate-limiting`) verify that the planner generates meaningful constraints for tasks involving filesystem boundaries and rate limiting.
