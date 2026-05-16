# Cursor Prompt — Stage 5a Phase 4a: CI-Aware Verification

> **Context:** Stage 5a Phases 1–3 are done (run history, SQLite, MCP history tools, watch/MCP recording). Phase 4a adds CI-awareness to `bollard verify`: detect the CI provider from env vars, parse JUnit XML artifacts for prior check results, and let the caller skip checks that CI already ran via `--ci-passed` or `skipChecks`. No schema changes to `RunRecord`. No test promotion (that's Phase 4b). This is entirely deterministic — no LLM calls.
>
> **Read CLAUDE.md fully before writing any code.** Then read:
> - `packages/verify/src/static.ts` — `runStaticChecks(workDir, profile?, options?: { onlyChecks? })`, `StaticCheckResult` — you will add `skipChecks?: string[]` to `options`
> - `packages/cli/src/index.ts` — the `verify` command block (around line 617); how `--profile` and `--quiet` flags are parsed; follow the same pattern for `--ci-passed`
> - `spec/stage5a-self-hosting.md` §12 — full CI-awareness design including `CIEnvironment`, `PriorCheckResult`, and the "what Bollard never skips" rule

---

## What to build

Four self-contained pieces, each independently shippable.

### 4a-1 — `packages/verify/src/ci-environment.ts` (new file)

```typescript
export type CIProvider =
  | "github-actions"
  | "gitlab-ci"
  | "circleci"
  | "jenkins"
  | "buildkite"
  | "local"
  | "unknown"

export interface PriorCheckResult {
  check: "typecheck" | "lint" | "test" | "audit" | "secretScan"
  source: "junit-xml" | "ci-step" | "injected"
  passed: boolean
  timestamp: number
  detail?: string   // e.g. "12 passed, 0 failed"
}

export interface CIEnvironment {
  provider: CIProvider
  priorResults: PriorCheckResult[]
  artifactPaths: string[]   // paths where JUnit XML may live
}
```

**`detectCIEnvironment(env?: NodeJS.ProcessEnv): CIEnvironment`**

Detection is pure env-var inspection — no file I/O, no network, deterministic:

| Provider | Env var(s) to check |
|---|---|
| `github-actions` | `GITHUB_ACTIONS === "true"` |
| `gitlab-ci` | `GITLAB_CI === "true"` |
| `circleci` | `CIRCLECI === "true"` |
| `jenkins` | `JENKINS_URL` is set |
| `buildkite` | `BUILDKITE === "true"` |
| `local` | none of the above but `CI` is unset or `"false"` |
| `unknown` | `CI` is set but no specific provider matched |

`artifactPaths` defaults:
- GitHub Actions: `["test-results", "junit.xml", ".bollard/junit.xml"]`
- GitLab CI: `["junit.xml", "test-results/junit.xml"]`
- CircleCI: `["~/test-results", "junit.xml"]`
- Others: `["junit.xml"]`
- Local: `[]`

`priorResults` starts empty — it is populated by `readJUnitResults()` and/or by explicit injection (see 4a-3). `detectCIEnvironment` itself only sets `provider` and `artifactPaths`.

**`readJUnitResults(xmlPath: string): Promise<PriorCheckResult[]>`**

Parse a JUnit XML file (no external XML library — use Node's built-in `string` parsing with a regex-based mini-parser, or use the `@xmldom/xmldom` package if already present; if neither, implement a simple line-by-line state machine):

JUnit XML shape to parse:
```xml
<testsuite name="..." tests="12" failures="0" errors="0" skipped="1" timestamp="...">
  <testcase .../>
</testsuite>
```

Extract:
- `tests`, `failures`, `errors`, `skipped` attributes from `<testsuite>` (or sum across multiple `<testsuite>` elements)
- `timestamp` attribute → parse to ms
- Infer `check: "test"` (JUnit XML is always from a test runner)
- `passed = failures === 0 && errors === 0`
- `detail = "${tests - failures - errors - skipped} passed, ${failures + errors} failed, ${skipped} skipped"`
- `source: "junit-xml"`

If the file doesn't exist or is malformed, return `[]` — never throw.

Export both functions. Do NOT import this module from any existing file yet — it will be wired in 4a-3.

**No external dependencies.** Use Node's built-in string/regex. If the XML is too complex, a simple regex on `testsuite` attributes is sufficient — JUnit XML is well-structured and the attributes are on a single line in practice.

### 4a-2 — Extend `runStaticChecks` with `skipChecks`

In `packages/verify/src/static.ts`, extend the existing `options` parameter:

```typescript
// Before
options?: { onlyChecks?: string[] }

// After
options?: { onlyChecks?: string[]; skipChecks?: string[] }
```

When a check's `name` is in `skipChecks`, emit a result immediately without running the command:

```typescript
{
  check: checkName,
  passed: true,
  output: "skipped (prior CI pass)",
  durationMs: 0,
}
```

The check still appears in `results` (so the caller sees it), but `passed: true` so it doesn't block `allPassed`. The `output` string `"skipped (prior CI pass)"` is the sentinel — callers and tests can detect skipped checks by looking for this string.

**Important:** `skipChecks` entries are matched against `check.name` (the label string, e.g. `"typecheck"`, `"lint"`, `"audit"`) — not the command. Match case-insensitively with `.toLowerCase()` on both sides.

This is the only change to `static.ts`.

### 4a-3 — `--ci-passed` flag on `bollard verify`

In `packages/cli/src/index.ts`, in the `verify` command block:

1. Parse `--ci-passed <list>` where `<list>` is a comma-separated string of check names:
   ```
   bollard verify --ci-passed typecheck,lint,audit
   ```
   Parse it as: `const ciPassed = rest.find((_, i, a) => a[i-1] === "--ci-passed") ?? ""`; split on `,`; trim; filter empty strings.

2. Also auto-detect from CI environment: if running in CI (i.e. `detectCIEnvironment(process.env).provider !== "local"` and `!== "unknown"`), attempt to read JUnit XML from `artifactPaths` and populate `priorResults`. Any check in `priorResults` where `passed === true` is added to the skip list.

3. Merge explicit `--ci-passed` names with auto-detected ones into a single `skipChecks` array. Pass it to `runStaticChecks(workDir, profile, { skipChecks })`.

4. If any checks were skipped, log a dim line before the verify output:
   ```
   ⓘ  Skipping checks already passed in CI: typecheck, lint
   ```

5. The `VerifyRecord` written to history should still record all results (including skipped ones) — `buildVerifyRecord` already takes the full `results` array, so no change needed there.

Wire the import: `import { detectCIEnvironment, readJUnitResults } from "@bollard/verify/src/ci-environment.js"`.

### 4a-4 — `--ci-passed` flag on `bollard run implement-feature`

In `packages/cli/src/index.ts`, in the `run implement-feature` block:

The `static-checks` blueprint node calls `runStaticChecks` via `createStaticCheckNode`. That node needs to know about `skipChecks` too — but it's constructed inside `implement-feature.ts` which doesn't have access to CLI args.

The right approach: pass `skipChecks` through `PipelineContext`. Add an optional field:

```typescript
// packages/engine/src/context.ts
skipChecks?: string[]   // checks to skip in static-checks node (CI-injected)
```

Then in `packages/blueprints/src/implement-feature.ts`, the `static-checks` node reads `ctx.skipChecks` and passes it to `runStaticChecks`:

```typescript
const { results, allPassed } = await runStaticChecks(workDir, ctx.toolchainProfile, {
  skipChecks: ctx.skipChecks ?? [],
})
```

In `packages/cli/src/index.ts`, in the `run implement-feature` block, parse `--ci-passed` the same way as for `verify`, and set `ctx.skipChecks` before `runBlueprint`. Since `PipelineContext` is created inside `runBlueprint`, the right place is to pass it as a new option — but to keep the change minimal, just add `skipChecks` to `BollardConfig` (which is already in `PipelineContext`):

Actually, simpler: add `skipChecks?: string[]` directly to `PipelineContext` in `context.ts`, set it from the CLI via a pre-run hook, or pass it as an additional option to `runBlueprint`. The cleanest minimal approach: add it to `PipelineContext` and set it in `createContext`:

```typescript
// context.ts — add to PipelineContext interface
skipChecks?: string[]
```

Then in the CLI, after `runBlueprint` is called but the context is created inside — use the `onProgress` callback's first `node_start` event to inject it. Actually, the simplest approach: add `skipChecks?: string[]` to `BollardConfig` (already passed to `createContext`). Wire it through.

**If this feels overly complex, do the simpler thing:** skip the `implement-feature` integration for now — just add `--ci-passed` to `bollard verify` (4a-3) and leave `bollard run implement-feature` for a follow-up. Document the gap in a `// TODO(stage-5a-phase-4a): thread skipChecks into implement-feature` comment. Phase 4a's primary value is `bollard verify --ci-passed` since that's what the GitHub Actions workflow in Phase 5 will call.

---

## Tests to add

### `packages/verify/tests/ci-environment.test.ts` (new file)

1. **`detectCIEnvironment` returns `local` when no CI env vars set** — pass `{}` as env
2. **`detectCIEnvironment` returns `github-actions`** — pass `{ GITHUB_ACTIONS: "true" }`
3. **`detectCIEnvironment` returns `gitlab-ci`** — pass `{ GITLAB_CI: "true" }`
4. **`detectCIEnvironment` returns `circleci`** — pass `{ CIRCLECI: "true" }`
5. **`detectCIEnvironment` returns `jenkins`** — pass `{ JENKINS_URL: "http://jenkins" }`
6. **`detectCIEnvironment` returns `buildkite`** — pass `{ BUILDKITE: "true" }`
7. **`detectCIEnvironment` returns `unknown`** — pass `{ CI: "true" }` (no specific provider)
8. **`detectCIEnvironment` github-actions has correct artifactPaths** — check array includes `"junit.xml"`
9. **`readJUnitResults` returns empty array for nonexistent file**
10. **`readJUnitResults` parses valid JUnit XML** — write a temp file with `<testsuite tests="5" failures="0" errors="0" skipped="1" timestamp="2026-05-15T04:00:00">`, expect `[{ check: "test", passed: true, detail: "4 passed, 0 failed, 1 skipped", source: "junit-xml" }]`
11. **`readJUnitResults` returns `passed: false` when failures > 0**

### `packages/verify/tests/static.test.ts`

Add 2 tests to the existing file:

12. **`skipChecks` skips named checks** — call `runStaticChecks` with a real profile but `skipChecks: ["typecheck"]`; the typecheck result should have `output: "skipped (prior CI pass)"` and `passed: true`
13. **`skipChecks` is case-insensitive** — `skipChecks: ["TypeCheck"]` still skips `typecheck`

---

## CLAUDE.md update

Find the `### Stage 5a Phase 3 (DONE)` entry. After it add:

```
### Stage 5a Phase 4a (DONE) — CI-Aware Verification:

`detectCIEnvironment(env?)` in `@bollard/verify` — pure env-var detection for GitHub Actions, GitLab CI, CircleCI, Jenkins, Buildkite, local, unknown. `readJUnitResults(xmlPath)` — regex-based JUnit XML parser, returns `PriorCheckResult[]` (non-throwing). `runStaticChecks` gains `options.skipChecks?: string[]` — skipped checks emit `passed: true, output: "skipped (prior CI pass)"`. `bollard verify --ci-passed typecheck,lint,audit` — explicit injection escape hatch; also auto-detects from CI env + JUnit XML artifacts. Bollard never skips adversarial scopes, mutation testing, semantic review, or Bollard-generated test execution regardless of CI context.
```

Also update the roadmap line: mark Phase 4a DONE, Next → Phase 5 (Bollard-on-Bollard CI).

---

## Validation

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: clean typecheck + lint, test count increases by 13 (11 ci-environment + 2 static).

Then smoke test:
```bash
# Should show "Skipping checks already passed in CI: typecheck, lint" then run audit + secretScan
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- verify --ci-passed typecheck,lint'
```

---

## Constraints

- Do NOT add any external XML parsing dependency — regex on the `<testsuite ...>` line is sufficient.
- Do NOT skip adversarial tests, grounding, mutation, semantic review, or Bollard-generated test execution — only `typecheck`, `lint`, `audit`, `secretScan` are skippable (the checks in `StaticCheckResult`). If `skipChecks` contains `"test"`, log a warning and do NOT skip it.
- `detectCIEnvironment` must be pure (no file I/O, no side effects) — takes an optional env dict, defaults to `process.env`.
- `readJUnitResults` must never throw — always return `[]` on any error.
- The `--ci-passed` flag on `implement-feature` is optional for this phase — implement it only if it falls out naturally from the context threading. Add a TODO comment if deferred.
- All new code in `packages/verify/` follows the existing no-class, named-export, kebab-case-files conventions.
