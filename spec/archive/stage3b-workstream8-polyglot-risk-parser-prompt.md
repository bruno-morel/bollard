# Stage 3b — Workstream 8: Polyglot risk gate + test summary parsers

> **Scope:** two focused changes: (1) make `scanDiffForExportChanges` language-aware so the risk gate works for Python, Go, and Rust diffs, and (2) add `parseSummary` branches for pytest, `go test`, and `cargo test` output so the `run-tests` node reports accurate pass/fail counts for non-Vitest runners.

## Context

### Risk gate (`scanDiffForExportChanges`)

Currently at `packages/blueprints/src/implement-feature.ts:56`:

```typescript
export function scanDiffForExportChanges(diffText: string): boolean {
  return diffText.split("\n").some((line) => /^[+-]export\s/.test(line))
}
```

This detects TypeScript `export` keyword additions/removals in a diff. It doesn't detect:

- **Python:** changes to `def`/`class` at module top-level (all top-level functions and classes are implicitly public unless prefixed with `_`), changes to `__all__`, changes to `from .x import y` in `__init__.py`.
- **Go:** changes to capitalized identifiers (`func Foo`, `type Bar`, `var Baz`).
- **Rust:** changes to `pub fn`, `pub struct`, `pub enum`, `pub trait`, `pub type`, `pub mod`.

The fix: `scanDiffForExportChanges` takes an optional `LanguageId` parameter and applies per-language patterns. The `hasExportedSymbolChanges` caller already has access to `profile.language`.

### Test summary parser (`parseSummary`)

Currently at `packages/verify/src/dynamic.ts:27`:

```typescript
function parseSummary(output: string): Pick<TestRunResult, "passed" | "failed" | "total" | "failedTests"> {
  // Only handles Vitest output: "Tests  N failed | M passed (T)"
  // Falls back to zero/error detection for non-Vitest runners
}
```

The comment at line 23 says: "Stage 3: add deterministic parsers for pytest, go test, cargo test output." This is that stage.

Test output formats:

**pytest:**
```
===== 5 passed, 2 failed in 0.42s =====
```
or
```
===== 5 passed in 0.42s =====
```
Failed test names appear as `FAILED tests/test_foo.py::test_bar - AssertionError`.

**go test:**
```
ok      github.com/user/proj/pkg  0.042s
FAIL    github.com/user/proj/api  0.123s
```
Summary line: `ok` means all passed. `FAIL` means at least one failure. Individual failures appear as `--- FAIL: TestFoo (0.00s)`.

**cargo test:**
```
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s
```
or
```
test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out
```
Failed test names appear as `test module::test_name ... FAILED`.

## Files to change

### 1. `packages/blueprints/src/implement-feature.ts` — polyglot risk gate

Expand `scanDiffForExportChanges` to accept an optional `LanguageId`:

```typescript
export function scanDiffForExportChanges(diffText: string, language?: LanguageId): boolean {
  const lines = diffText.split("\n")
  return lines.some((line) => isExportChangeLine(line, language))
}

function isExportChangeLine(line: string, language?: LanguageId): boolean {
  // Only look at added/removed lines (start with + or -)
  if (!line.startsWith("+") && !line.startsWith("-")) return false
  const content = line.slice(1) // strip the +/- prefix

  switch (language) {
    case "python":
      return isPythonExportChange(content)
    case "go":
      return isGoExportChange(content)
    case "rust":
      return isRustExportChange(content)
    case "typescript":
    case "javascript":
    default:
      return /^export\s/.test(content)
  }
}
```

Per-language detectors (keep them simple — these are heuristics for a risk gate, not full parsers):

**Python (`isPythonExportChange`):**
```typescript
function isPythonExportChange(content: string): boolean {
  const trimmed = content.trimStart()
  // Top-level def/class (no leading whitespace in the original = column 0)
  // A diff line like "+def foo():" where the def is at column 0 means a new public function.
  // We check for no leading whitespace after stripping the +/- prefix.
  if (content === trimmed) {
    if (/^(def|class|async\s+def)\s/.test(trimmed)) return true
  }
  // __all__ changes
  if (trimmed.includes("__all__")) return true
  // Re-export in __init__.py (from .x import y)
  if (/^from\s+\./.test(trimmed)) return true
  return false
}
```

Note: this has false positives (any top-level `def` change triggers the gate, including private `_foo` functions). That's acceptable — the risk gate is conservative by design. False positives mean "run the contract tests," which is safe. False negatives mean "skip contract tests when we shouldn't," which is dangerous.

**Go (`isGoExportChange`):**
```typescript
function isGoExportChange(content: string): boolean {
  const trimmed = content.trimStart()
  // Exported = capitalized. Look for top-level declarations with uppercase first letter.
  // func Foo, type Bar, var Baz, const Qux
  const match = trimmed.match(/^(func|type|var|const)\s+([A-Z])/)
  if (match) return true
  // Method on exported type: func (r *Foo) Bar()
  if (/^func\s*\([^)]+\)\s*[A-Z]/.test(trimmed)) return true
  return false
}
```

**Rust (`isRustExportChange`):**
```typescript
function isRustExportChange(content: string): boolean {
  const trimmed = content.trimStart()
  // pub fn, pub struct, pub enum, pub trait, pub type, pub mod, pub use
  if (/^pub\s+(fn|struct|enum|trait|type|mod|use)\s/.test(trimmed)) return true
  // pub(crate) also triggers — it's still a visibility boundary change
  if (/^pub\s*\(/.test(trimmed)) return true
  return false
}
```

Update the caller `hasExportedSymbolChanges` to pass `profile.language`:

```typescript
async function hasExportedSymbolChanges(
  workDir: string,
  profile: ToolchainProfile,
  warn: (message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "main", "--", ...profile.sourcePatterns],
      { cwd: workDir },
    )
    return scanDiffForExportChanges(stdout, profile.language)
  } catch (err: unknown) {
    warn("hasExportedSymbolChanges: git diff failed, assuming exports changed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return true
  }
}
```

Remove or update the comment at line 60 that says "Crude TypeScript-biased check; Stage 3b refines per-language."

### 2. `packages/blueprints/tests/implement-feature.risk-gate.test.ts` — per-language test cases

Expand the `describe("scanDiffForExportChanges")` block. Current tests only cover the TypeScript path. Add:

**Python (3 cases):**
1. `+def greet(name):` at column 0 → `true` (new public function)
2. `+    def helper(self):` (indented = method, not top-level) → `false` (but this one is tricky — in a diff, the indentation might indicate a class method. For simplicity: the current heuristic checks `content === trimmed` i.e. no leading whitespace. An indented `def` returns `false`, which is correct for the risk gate — class methods are less likely to be public API changes than top-level functions.)
3. `+__all__ = ["foo", "bar"]` → `true`
4. `+from .core import greet` → `true` (re-export in `__init__.py`)

**Go (3 cases):**
1. `+func Login(user string) error {` → `true` (exported function)
2. `+func helper() {` → `false` (unexported)
3. `+type Config struct {` → `true` (exported type)

**Rust (3 cases):**
1. `+pub fn process(data: &[u8]) -> Result<()> {` → `true`
2. `+fn internal_helper() {` → `false` (no `pub`)
3. `+pub struct Config {` → `true`

Each case calls `scanDiffForExportChanges(diff, language)` with the appropriate `LanguageId`.

### 3. `packages/verify/src/dynamic.ts` — polyglot test summary parsers

Expand `parseSummary` to detect output format and delegate to per-runner parsers. The function stays private — the public API (`runTests`, `TestRunResult`) doesn't change.

```typescript
function parseSummary(
  output: string,
): Pick<TestRunResult, "passed" | "failed" | "total" | "failedTests"> {
  const clean = stripAnsi(output)

  // Try each parser in order. First match wins.
  const vitest = parseVitestSummary(clean)
  if (vitest) return vitest

  const pytest = parsePytestSummary(clean)
  if (pytest) return pytest

  const goTest = parseGoTestSummary(clean)
  if (goTest) return goTest

  const cargo = parseCargoTestSummary(clean)
  if (cargo) return cargo

  // Fallback: look for generic FAIL markers
  const failedNames: string[] = []
  const failMatch = clean.matchAll(/FAIL\s+(\S+\.test\.ts)/g)
  for (const m of failMatch) {
    if (m[1]) failedNames.push(m[1])
  }
  return { passed: 0, failed: failedNames.length || 0, total: 0, failedTests: failedNames }
}
```

Per-runner parsers (each returns `null` if the output doesn't match its format):

**`parseVitestSummary`** — extract the existing Vitest regex into its own function:
```typescript
function parseVitestSummary(clean: string): Pick<TestRunResult, ...> | null {
  const testsLine = clean.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)/)
  if (!testsLine) return null
  const failed = testsLine[1] ? Number(testsLine[1]) : 0
  const passed = Number(testsLine[2])
  const total = Number(testsLine[3])
  return { passed, failed, total, failedTests: [] }
}
```

**`parsePytestSummary`:**
```typescript
function parsePytestSummary(clean: string): Pick<TestRunResult, ...> | null {
  // "===== 5 passed, 2 failed in 0.42s =====" or "===== 5 passed in 0.42s ====="
  const summaryMatch = clean.match(/=+\s+(.*?)\s+in\s+[\d.]+s\s*=+/)
  if (!summaryMatch) return null
  const summary = summaryMatch[1] ?? ""
  const passedMatch = summary.match(/(\d+)\s+passed/)
  const failedMatch = summary.match(/(\d+)\s+failed/)
  const passed = passedMatch ? Number(passedMatch[1]) : 0
  const failed = failedMatch ? Number(failedMatch[1]) : 0
  const total = passed + failed
  // Extract failed test names: "FAILED tests/test_foo.py::test_bar"
  const failedNames: string[] = []
  const failedTests = clean.matchAll(/FAILED\s+(\S+)/g)
  for (const m of failedTests) {
    if (m[1]) failedNames.push(m[1])
  }
  return { passed, failed, total, failedTests: failedNames }
}
```

**`parseGoTestSummary`:**
```typescript
function parseGoTestSummary(clean: string): Pick<TestRunResult, ...> | null {
  // "ok  pkg  0.042s" and "FAIL  pkg  0.123s"
  const okMatches = clean.matchAll(/^ok\s+\S+/gm)
  const failMatches = clean.matchAll(/^FAIL\s+(\S+)/gm)
  const okCount = [...okMatches].length
  const failLines = [...failMatches]
  if (okCount === 0 && failLines.length === 0) return null
  // Individual failures: "--- FAIL: TestFoo (0.00s)"
  const failedNames: string[] = []
  const individualFails = clean.matchAll(/---\s+FAIL:\s+(\S+)/g)
  for (const m of individualFails) {
    if (m[1]) failedNames.push(m[1])
  }
  // Go doesn't report a total count easily; approximate from ok + fail package lines
  // Each package is one unit. Pass/fail is per-package, not per-test.
  // For a better approximation, count "--- PASS:" and "--- FAIL:" lines.
  const passLines = [...clean.matchAll(/---\s+PASS:\s+/g)].length
  const passed = passLines || okCount
  const failed = failedNames.length || failLines.length
  return { passed, failed, total: passed + failed, failedTests: failedNames }
}
```

**`parseCargoTestSummary`:**
```typescript
function parseCargoTestSummary(clean: string): Pick<TestRunResult, ...> | null {
  // "test result: ok. 5 passed; 0 failed; 0 ignored; ..."
  // "test result: FAILED. 3 passed; 2 failed; 0 ignored; ..."
  const resultMatch = clean.match(/test result:\s+\S+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/)
  if (!resultMatch) return null
  const passed = Number(resultMatch[1])
  const failed = Number(resultMatch[2])
  // Failed test names: "test module::test_name ... FAILED"
  const failedNames: string[] = []
  const failedTests = clean.matchAll(/test\s+(\S+)\s+\.\.\.\s+FAILED/g)
  for (const m of failedTests) {
    if (m[1]) failedNames.push(m[1])
  }
  return { passed, failed, total: passed + failed, failedTests: failedNames }
}
```

Remove/update the TODO comment at line 23 that says "Stage 3: add deterministic parsers for pytest, go test, cargo test output."

### 4. `packages/verify/tests/dynamic.test.ts` — parser test cases

Add a `describe("parseSummary — polyglot")` block. Since `parseSummary` is private, test it indirectly or export it for testing. Preferred approach: export a `parseSummary` function (it's pure, no side effects, safe to expose) and test directly.

If exporting is too invasive, test via `runTests` with mocked `execFileAsync` that returns per-runner output strings. Either approach is acceptable.

Required cases (8 total, 2 per runner):

**Vitest (verify existing behavior still works):**
1. `"Tests  2 failed | 8 passed (10)"` → `{ passed: 8, failed: 2, total: 10 }`
2. `"Tests  10 passed (10)"` → `{ passed: 10, failed: 0, total: 10 }`

**pytest:**
3. `"===== 5 passed, 2 failed in 0.42s ====="` → `{ passed: 5, failed: 2, total: 7 }`
4. `"===== 12 passed in 1.03s ====="` → `{ passed: 12, failed: 0, total: 12 }`

**go test:**
5. Output with `ok  pkg1  0.1s\nok  pkg2  0.2s\n--- PASS: TestA (0.0s)\n--- PASS: TestB (0.0s)` → `passed >= 2, failed: 0`
6. Output with `--- FAIL: TestBroken (0.0s)\nFAIL  pkg1  0.1s\nok  pkg2  0.2s` → `failed >= 1`, `failedTests` includes `"TestBroken"`

**cargo test:**
7. `"test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s"` → `{ passed: 5, failed: 0, total: 5 }`
8. `"test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out"` + `"test my_mod::test_thing ... FAILED"` → `{ passed: 3, failed: 2, total: 5, failedTests: ["my_mod::test_thing"] }`

### 5. `CLAUDE.md`

- **"Known limitations"** — remove or update the "Test output parsing is Vitest-specific" bullet. Replace with something like: "Test output parsing supports Vitest, pytest, go test, and cargo test summary formats. Non-standard runners fall back to zero/error detection."
- **"Known limitations"** — remove the "Risk gate per-language refinement" bullet (it's now done).
- **"Stage 3a → Stage 3b follow-ups"** — mark "Risk gate per-language refinement" as Done (workstream 8).
- **Test count** — bump. Expect 501 → ~511 (+10 from risk-gate cases and +8 from parser cases, but some may overlap with existing test cases that get updated). Report the actual count.

## Out of scope

- `parseSummary` for Jest, Mocha, JUnit XML, TAP format — Stage 4 language waves.
- Risk gate detection for Java/Kotlin/C# exports — Stage 4.
- Making the risk gate structural (AST-based diff analysis) rather than regex-based — would require a before/after extraction run, which is too expensive for a gate. Regex heuristics are sufficient.
- Wiring `profile.language` through `parseSummary` (the parser auto-detects output format, so it doesn't need a language hint).

## Validation

```bash
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: typecheck + lint clean. Test count `501 passed / 2 skipped` → somewhere around `511–519 passed / 2 skipped` depending on exact test structure.

## Commit

One commit:

```
Stage 3b: polyglot risk gate + test summary parsers

- scanDiffForExportChanges now takes optional LanguageId
  Python: top-level def/class, __all__, __init__.py re-exports
  Go: capitalized func/type/var/const declarations
  Rust: pub fn/struct/enum/trait/type/mod declarations
- parseSummary delegates to per-runner parsers: Vitest, pytest,
  go test, cargo test (auto-detected from output format)
- 10 risk-gate test cases (Python/Go/Rust diff patterns)
- 8 parser test cases (2 per runner)
- Update CLAUDE.md: remove Vitest-only + risk-gate-TS-biased caveats
```

## Reporting back

When done, report:
1. Test count before → after
2. Files changed
3. Commit SHA
4. Deviations, especially:
   - Did `parseSummary` need to be exported for testing, or was it tested indirectly?
   - Any edge cases in the regex patterns that needed adjustment (e.g. Go's method receiver syntax, Rust's `pub(crate)` in diffs)?
   - Did the existing `scanDiffForExportChanges` tests need updating for the new optional parameter?
