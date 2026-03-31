# Pass 4 — Fixing the `{ success: boolean }` Fabrication Pattern ✅ DONE

> **Status:** Completed 2026-03-30. Failure rate dropped from 54.9% to 30.2% on the 8 worst files. Decision gate passed. See `docs/retro-adversarial-results.md` Pass 4 section for full results.

---

## Prompt

I'm building **Bollard**, an artifact integrity framework for AI-assisted software development. Read the `CLAUDE.md` at the repo root — it has all the context, types, and constraints.

We've run three passes of retroactive adversarial testing. Pass 3 validated that the context hints architecture works — it resolved the Category A specification gaps (write-file +8, config +3, agent-handler from compile error to 5/12, search +3). But a new dominant failure emerged: **the tester agent fabricates `{ success: boolean, data: ... }` return objects** when the type signature explicitly says `Promise<string>`.

Read `docs/retro-adversarial-results.md` — specifically the "Pass 4-prep" section. It documents the full root cause analysis.

### The Problem

47 of 78 Pass 3 failures (60%) come from one pattern:

```typescript
// The tester sees this signature:
execute(input: Record<string, unknown>, ctx: AgentContext): Promise<string>

// But writes this assertion:
const result = await tool.execute(input, ctx)
expect(result.success).toBe(true)  // ← WRONG: result is a string, not an object
expect(result.data).toContain("hello")  // ← WRONG: .data doesn't exist on string
```

**Why it happens:** LLM training data is saturated with API handler patterns that return `{ success, data, error }`. The tester defaults to this familiar pattern, overriding what the return type annotation actually says. Existing Rules 8 and 10 address property *names* and fixture *shapes*, but neither explicitly tells the tester that the return type is the authoritative truth about what comes back from a function call.

**Secondary pattern (8 of 78 failures):** Property-based tests generating random commands via `fc.string()` that get rejected by the command allowlist, producing unhandled rejections instead of meaningful property checks.

### The Fix

Two prompt rules + three context hint enhancements. Here's the build order:

### Step 1: Add Rule 14 to the tester prompt

In `packages/agents/prompts/tester.md`, add Rule 14 after Rule 13, in the `# Critical: Use ONLY What the Signatures Tell You` section:

```markdown
14. **The return type in the signature is the ONLY truth about what a function returns.** If the signature says `Promise<string>`, the function returns a string — assert with `expect(typeof result).toBe("string")` or `expect(result).toContain(...)`. Do NOT fabricate structured result objects like `{ success: boolean, data: ... }` or `{ ok: true, content: ... }`. Do NOT assert `.success`, `.data`, `.output`, `.result`, or any property on a string return. Read the return type annotation character by character. `Promise<string>` means string. `Promise<NodeResult>` means NodeResult. `Promise<void>` means no return value.
```

**Why this is different from Rules 8 and 10:**
- Rule 8 says "use exact identifiers from types" — but the tester fabricates identifiers that aren't in any type
- Rule 10 says "construct fixtures matching the exact type shape" — but it addresses *input* construction, not *output* assertion
- Rule 14 explicitly says: what the function *gives back* is determined by the return type annotation, nothing else

### Step 2: Add Rule 15 to the tester prompt

Still in `packages/agents/prompts/tester.md`, add Rule 15 after Rule 14:

```markdown
15. **Property-based tests must use valid inputs.** When generating arbitrary inputs with fast-check, constrain them to the valid domain. If a function only accepts values from a known set (e.g., an allowlist of commands), use `fc.constantFrom(...)` with values from that set — do NOT generate random strings that will be rejected. Invalid-input property tests are negative tests, not property tests; keep them separate.
```

**Why:** The tester generates `fc.string()` for commands, but the command allowlist rejects random strings. This produces unhandled rejections, not property violations. Property tests should verify invariants over *valid* inputs; rejection of *invalid* inputs should be explicit negative tests.

### Step 3: Add return type emphasis to the shared tool hint

In `scripts/retro-adversarial.ts`, in the `getContextHints()` function, find the section that starts with `if (relativePath.includes("agents/src/tools/"))`. After the path-traversal hint lines (the ones ending with `Test traversal with inputs like...`), add:

```typescript
"",
"## Return type: plain string",
"CRITICAL: `execute()` returns `Promise<string>` — a plain string, NOT an object.",
"Do NOT assert `.success`, `.data`, `.output`, or any property. Assert on the string itself:",
'`expect(typeof result).toBe("string")`, `expect(result).toContain(...)`, `expect(result.length).toBeGreaterThan(0)`.',
```

This goes in the shared tool block (not per-tool) because ALL 5 tools have the same `Promise<string>` return type.

### Step 4: Add property-based testing guidance to run-command hint

In `scripts/retro-adversarial.ts`, in the `getContextHints()` function, find the `run-command` section (the one checking `if (relativePath.includes("tools/run-command"))`). After the existing `` `ctx.allowedCommands` can override the default list`` line, add:

```typescript
"",
"## Property-based testing guidance",
"For property-based tests, use `fc.constantFrom('cat', 'head', 'tail', 'wc', 'git')` for valid commands.",
"Do NOT use `fc.string()` for the command — random strings will be rejected by the allowlist and the test will not verify useful properties.",
"Negative tests for disallowed commands should be explicit `it()` blocks, not property tests.",
```

### Step 5: Add property-based testing guidance to search hint

In `scripts/retro-adversarial.ts`, in the `getContextHints()` function, find the `search` section. After the "Results are capped at 100 lines" line, add:

```typescript
"For property-based tests, create files with known content first, then search for patterns that should match.",
```

### Step 6: Run Pass 4 on the 8 worst files

```bash
docker compose run --rm --entrypoint sh dev -c "pnpm exec tsx scripts/retro-adversarial.ts --files \
  agents/src/eval-loader.ts \
  agents/src/tools/search.ts \
  agents/src/tools/write-file.ts \
  agents/src/tools/list-dir.ts \
  agents/src/tools/read-file.ts \
  agents/src/tools/run-command.ts \
  cli/src/config.ts \
  cli/src/agent-handler.ts"
```

**Expected outcomes:**
- `{ success: boolean }` fabrication (~47 failures): should drop to near-zero. Rule 14 + the return type hint are redundant on purpose — belt and suspenders.
- Random-command property tests (~8 failures): should drop to near-zero. Rule 15 + the `fc.constantFrom` hint.
- Other LLM variance (~23 failures): expect ~15-20 to remain. Some irreducible variance in LLM output.
- **Total expected: ~15-25 failures** (down from 78).

**Decision gate:**
- If failure rate drops below 20% → Done. The adversarial pipeline is tuned. Document and move on.
- If failure rate is 20–35% → Analyze remaining failures for new patterns. One more iteration if a clear pattern exists.
- If failure rate stays above 35% → The tester is hitting an LLM capability wall. Consider whether the remaining failures justify further tuning or are acceptable noise.

### Step 7: Update the results doc

Append a Pass 4 section to `docs/retro-adversarial-results.md`:
- Before/after table (same format as Pass 2 and Pass 3)
- Total token cost
- Which rules (14/15) had the most impact
- Final decision gate result
- Updated cumulative stats (total cost, total rules, final pass rate)

If the decision gate passes (<20% failure rate), add a final "Conclusion" section declaring the adversarial pipeline tuned and ready for Stage 1.5/Stage 2 work.

---

### Important reminders

- **Read `docs/retro-adversarial-results.md` before starting.** The Pass 4-prep section documents exactly what needs to change and why. Don't re-analyze — just implement.
- **Rules 14 and 15 are different in character.** Rule 14 addresses a training-data bias (fabricated return types). Rule 15 addresses a testing methodology error (random inputs for constrained domains). Keep them separate.
- **The return type hint is belt-and-suspenders.** Rule 14 in the prompt is universal. The hint in the retro script is specific reinforcement for the tool `execute()` pattern. Both are needed because the LLM bias is strong enough to override a single instruction.
- **Don't modify any other rules (8–13).** They're working. The regressions in Pass 3 were NOT caused by Rules 8–13 failing — they were caused by the absence of Rules 14–15.
- **All 162 hand-written tests must still pass.** The changes are prompt + hints only — no production code changes.
- **No new dependencies.** Everything here is string changes in prompts and the hint function.
- **Commit after each logical step** with message format: `Stage 1-adversarial: <what>`.
