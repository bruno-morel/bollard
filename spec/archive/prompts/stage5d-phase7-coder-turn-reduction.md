# Cursor Prompt — Stage 5d Phase 7: Coder Turn Reduction

> **Purpose:** The 2026-05-13 Bollard-on-Bollard self-test exposed a critical cost failure: $16.17 total ($8.28 for the coder alone) vs. a $0.63 anchor — 2467% over anchor, driven by 159 Sonnet turns (80 on attempt 1 → rollback → 79 on attempt 2). Coder turns are the dominant cost variable in the pipeline. Phase 7 applies four concrete changes that attack the root causes directly: (7a) a scope guard section in `coder.md` to prevent drift beyond the plan, (7b) hard exit signals in the Turn Budget section at turns 52 and 58 replacing the advisory "if you're past turn 60", (7c) lower `maxTurns` 80→60 in `coder.ts`, (7d) a `non_goals[]` field added to the planner output schema so the planner explicitly constrains the coder's scope. No new infrastructure needed — all changes are in prompt text and a single config constant.

Read CLAUDE.md fully before writing any code. Then read:
- `spec/stage5d-token-economy.md` — Phase 7 design, root-cause analysis, and the four sub-changes
- `packages/agents/src/coder.ts` — `createCoderAgent`, current `maxTurns: 80`
- `packages/agents/prompts/coder.md` — current Turn Budget section (lines 80–95), the full prompt
- `packages/agents/prompts/planner.md` — current JSON output schema, the `steps` and `notes` fields
- `packages/agents/tests/coder.test.ts` — existing coder tests to understand what to update
- `packages/agents/tests/planner.test.ts` — existing planner tests

---

## Root cause summary (read before coding)

The 2026-05-13 self-test task said: "Add a `divide(factor: number): this` method to `CostTracker` that returns `this` for chaining." The phrase "returns `this` for chaining" caused the coder to also retrofit chaining onto `add()` and `subtract()`, which had never been asked for. That single scope drift:
1. Rewrote 3 methods instead of 1
2. Required updating every existing test that called those methods without chaining
3. Triggered a Biome lint error on the rewritten test file
4. Cascaded into the adversarial test file being rewritten from scratch (wrong pattern — coder should NEVER rewrite existing test files)
5. Exhausted 80 turns → rollback → 79 more turns = 159 total

**The two mechanical fixes that prevent this class of failure:**
- A scope guard ("implement ONLY what the plan says") stops the retrofitting drift at the source
- `non_goals[]` in the plan document makes the constraint machine-readable, not implicit

**The two exit-signal fixes that prevent budget exhaustion:**
- Hard exit at turn 52: "stop implementing, emit completion JSON now"  
- Advisory at turn 58: coder already in post-completion verification retry territory at 60; 58 is the last useful turn for a final fix attempt before ceiling
- `maxTurns` 80→60: removes the 20-turn no-man's-land where the coder fills the budget with low-value work

---

## What to change

### 7a — `packages/agents/prompts/coder.md`: scope guard section

Add a new `# Scope` section immediately after `# Rules` (after line 62, before `# Verification`). This section must appear early in the prompt — LLMs read top-to-bottom and anchor on early constraints.

```markdown
# Scope

**Implement ONLY what the approved plan says. Do not touch anything outside the plan's `affected_files`.**

Specific prohibitions (these caused a $16 cost explosion in a previous run):

- **Do NOT retrofit patterns to adjacent methods.** If the plan says "add method `divide()`", implement `divide()` only. Do not also retrofit chaining to `add()`, `subtract()`, or any other existing method unless the plan explicitly lists them.
- **Do NOT rewrite existing test files.** You may add new test cases to an existing test file (append only). You must never rewrite, restructure, or remove existing test cases. If an existing test breaks due to your implementation change, fix the implementation — not the test.
- **Do NOT touch files not in `affected_files.modify` or `affected_files.create`** unless a typecheck or lint failure in a pre-loaded file is directly caused by your changes to a listed file.

When in doubt: do less. A minimal implementation that passes tests is always better than a comprehensive one that exceeds scope and runs out of turns.
```

### 7b — `packages/agents/prompts/coder.md`: replace Turn Budget section

Replace the current Turn Budget section (lines 80–111, from `# Turn Budget` through the closing paragraph) with:

```markdown
# Turn Budget

You have **60 turns**. This is a hard ceiling — the system stops you at 60 regardless.

**Turn allocation:**
- **Turns 1-3:** Read the plan, review pre-loaded files. Do NOT re-read pre-loaded files. Only read files NOT already in the message.
- **Turns 4-45:** Implement changes step by step. Use `edit_file` for existing files, `write_file` for new files. Write tests alongside implementation.
- **Turns 45-52:** Fix any remaining issues. Run targeted checks with `run_command` if needed.

**Hard exit signals — these override everything else:**

**TURN 52:** If you have not yet emitted a completion JSON, STOP all implementation work immediately and emit the completion JSON now:
```json
{
  "status": "complete",
  "files_modified": ["..."],
  "files_created": ["..."],
  "tests_added": 0,
  "notes": "Reached turn 52 budget signal — emitting completion for verification"
}
```
The verification system will tell you exactly what is broken. You will get up to 3 more turns to fix each issue. Do not try to preemptively fix hypothetical problems — emit and let verification report.

**TURN 58:** If you are still in a verification retry loop at turn 58, emit a final completion JSON and stop. Do not attempt another fix. The remaining failures will be escalated automatically.

**Efficiency rules:**
- Pre-loaded files are ALREADY in the message. Do NOT call `read_file` on them — scroll up and read them.
- If you need to find where something is defined, use `search` with a literal string. One search is cheaper than reading 5 files.
- Batch related edits: plan all changes to a file mentally, then make them in sequence.
- If you are past turn 40 and have not started tests yet, write tests BEFORE fixing implementation gaps. Incomplete code with tests is always better than complete code without tests.
```

Note: The turn 52/58 signals replace the old "if you're past turn 60, declare completion" advisory. The old advisory was treated as optional under pressure; the new signals use imperative language and show the exact JSON to emit.

### 7c — `packages/agents/src/coder.ts`: lower maxTurns

Change `maxTurns: 80` to `maxTurns: 60`.

```typescript
return {
  role: "coder",
  systemPrompt,
  tools: ALL_TOOLS,
  maxTurns: 60,  // was 80 — reduced in Stage 5d Phase 7 to enforce budget discipline
  temperature: 0.3,
  maxTokens: 16384,
}
```

This is the mechanical enforcement layer. The prompt budget signals (turn 52/58) are the behavioral layer; `maxTurns: 60` is the hard ceiling that cannot be overridden by the LLM.

### 7d — `packages/agents/prompts/planner.md`: add `non_goals[]` field

Add `non_goals` as a required top-level field in the planner's JSON output schema.

In the `# What You Produce` section of `planner.md`, update the JSON schema to include `non_goals` immediately after `notes`:

```json
{
  "summary": "One-line description of what will change",
  "acceptance_criteria": [...],
  "affected_files": {...},
  "risk_assessment": {...},
  "steps": [...],
  "non_goals": [
    "Do NOT retrofit chaining onto add() or subtract() — only divide() needs to return this",
    "Do NOT modify existing tests — only add new test cases"
  ],
  "notes": "Any additional context, warnings, or alternatives considered"
}
```

Also add a rule for `non_goals` in the `# Rules` section of `planner.md`:

```markdown
10. Always include `non_goals` as an explicit list. For every method, file, or behavior mentioned in the task description that could be interpreted as "change this too," add an explicit non-goal entry. Non-goals are the single most effective way to prevent the coder from overstepping the plan. At minimum: "Do not modify files not listed in affected_files.modify", "Do not rewrite existing tests", and any scope-adjacent behavior the task description implies but does not request.
```

---

## Tests to update / add

### `packages/agents/tests/coder.test.ts`

1. Update the test that asserts `maxTurns: 80` → assert `maxTurns: 60`.
2. Add a test: "coder prompt includes scope guard section" — check that the raw template text contains the string `"Do NOT retrofit patterns to adjacent methods"`.
3. Add a test: "coder prompt includes turn 52 hard exit signal" — check that the template contains `"TURN 52"`.

### `packages/agents/tests/planner.test.ts`

1. Add a test: "planner output schema includes non_goals field" — verify that the JSON schema embedded in the prompt mentions `non_goals`.
2. Add a test: "planner prompt rule 10 covers non_goals" — check that the prompt contains `"non_goals"` in the Rules section.

---

## CLAUDE.md update

Find the "Stage 5d Phase 7 (IN PROGRESS)" section. After implementing and verifying, update it:

```
### Stage 5d Phase 7 (DONE) — Coder Turn Reduction:

Four changes: (7a) scope guard in `coder.md` — implement only what the plan says, no retrofitting adjacent methods, no rewriting existing test files; (7b) hard exit signals at turns 52 ("emit completion JSON NOW") and 58 (stop retrying) in `coder.md`; (7c) `maxTurns` 80→60 in `coder.ts`; (7d) `non_goals[]` field added to planner JSON schema. Success metric: coder turns < 40 on bounded single-method tasks, rollback rate = 0, cost < $3.00 per run.
```

Also update the test count line in CLAUDE.md to reflect the actual post-Phase-7 count.

---

## Validation

```bash
# Tests must pass:
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test

# Verify maxTurns is 60 in the compiled agent:
docker compose run --rm dev sh -c \
  'node -e "const {createCoderAgent} = require(\"./packages/agents/src/coder.js\"); createCoderAgent().then(a => { console.assert(a.maxTurns === 60, \"FAIL: maxTurns should be 60\"); console.log(\"maxTurns:\", a.maxTurns) })"'
# Expected: maxTurns: 60

# Verify scope guard appears in the prompt:
grep -n "Do NOT retrofit patterns" packages/agents/prompts/coder.md
# Expected: line number with the scope guard text

# Verify turn 52 signal appears in the prompt:
grep -n "TURN 52" packages/agents/prompts/coder.md
# Expected: line number with the hard exit signal

# Verify non_goals appears in planner prompt:
grep -n "non_goals" packages/agents/prompts/planner.md
# Expected: 2+ lines (schema example + rule 10)
```

No Bollard-on-Bollard self-test required for Phase 7 until Phase 7 is validated — the whole point of Phase 7 is to reduce self-test cost. Run the self-test once after Phase 7 is in place and compare `coder turns` before (159) and after (target: < 40). Cost target: < $3.00.

---

## Constraints

- **Do not reduce `maxTokens: 16384`.** The per-turn output budget is not the problem — it is the number of turns that needs reducing.
- **The turn 52/58 signals must use imperative language, not advisory.** "STOP and emit" not "consider emitting." The 2026-05-13 run showed that advisory turn budgets are ignored under pressure.
- **`non_goals[]` is required, not optional.** The planner JSON schema should treat it as a required field (same level as `acceptance_criteria`). An empty `non_goals: []` is acceptable for tasks with no scope-adjacent behavior.
- **Do not change the planner's `maxTurns` or `temperature`.** Planner is already on Haiku via Phase 5 defaults. Its 25-turn ceiling is sufficient.
- **Do not add enforcement code in the executor for the 52/58 signals.** These are prompt-layer constraints only. The `maxTurns: 60` in `coder.ts` is the only code-layer enforcement needed.
- **The scope guard section must appear BEFORE `# Verification` in `coder.md`.** Position matters — the LLM reads top-to-bottom and anchors on early constraints.
