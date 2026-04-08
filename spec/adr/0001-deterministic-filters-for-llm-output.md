# ADR-0001: Deterministic filters for LLM output

**Status:** Accepted
**Date:** 2026-04-08
**Deciders:** Bruno (maintainer)
**Supersedes:** —
**Related:** [spec/08-contract-tester-grounding.md](../08-contract-tester-grounding.md), [spec/07-adversarial-scopes.md](../07-adversarial-scopes.md)

## Context

The contract-tester agent (Stage 3a) generates adversarial tests from a `ContractContext` that describes a package's exported surface and its reachable types. Its job is to propose test assertions that exercise real contract boundaries — argument validation, invariants, interactions between exported functions.

During Stage 3a validation, the agent repeatedly produced tests that referenced APIs that did not exist on the types it was testing. The canonical case: a test that called `CostTracker.subtract()` with elaborate assertions about its behavior — on a class that had no `subtract` method at all. The test file was syntactically valid TypeScript, passed fence-stripping and leak scanning, and was only caught at `run-contract-tests` time when `tsc` failed inside the Vitest config.

This is a recurring failure mode, not a one-off. The agent had enough context to know the method didn't exist (the `ContractContext` passed to it listed every public export of the package), but generated the hallucinated call anyway. The same shape of failure reappeared with different symbols across validation attempts.

The first instinct was to fix the prompt: add a "do not invent methods" rule, enumerate forbidden patterns, list the exact exported symbols again in the system message. This approach has two problems:

1. **It does not scale.** Every new failure mode adds another rule. The prompt grows linearly with the history of things the agent got wrong, and prompts that grow this way degrade on the rules that came earlier.
2. **It treats the LLM as the oracle.** The agent is being asked to self-certify that its output matches ground truth. But the ground truth (the contract corpus) is already available in deterministic form — we are choosing not to check.

The forces at play:

- The contract-tester must produce *creative* tests (no deterministic generator can invent meaningful property-based assertions for arbitrary APIs), so the agent cannot be removed.
- The contract corpus (`ContractContext.publicExports` and reachable types) is a complete, machine-checkable ground truth for "does this symbol exist?"
- The cost of a hallucinated test reaching `run-contract-tests` is high: it burns the turn budget, pollutes the `.bollard/tests/contract/` tree, and — worst — could pass if the hallucinated method happened to be a no-op in some edge case.
- The cost of a deterministic post-filter is low: a few hundred lines of TypeScript, one new blueprint node, no additional LLM spend.

## Decision

Introduce a **structured-claims protocol** between the contract-tester and `write-contract-tests`:

1. The contract-tester outputs a JSON document of **claims**, not a test file. Each claim is `{ symbol, grounding, test }` where `symbol` is the exported identifier the test targets and `grounding` points at the ContractContext entry that justifies the claim.
2. A new deterministic node, `verify-claim-grounding`, runs `parseClaimDocument` and `verifyClaimGrounding` against the `ContractCorpus`. Claims whose `symbol` is not present in the corpus are **dropped**, not repaired.
3. If zero claims survive, the node fails with `CONTRACT_TESTER_NO_GROUNDED_CLAIMS`. If the JSON is malformed, it fails with `CONTRACT_TESTER_OUTPUT_INVALID`. Both are retryable.
4. `write-contract-tests` assembles the surviving `test` fields into a single test file. It never sees ungrounded claims.

The filter is **lossy by design**. It can drop, it cannot repair. This is intentional: a filter that rewrites LLM output can itself introduce new defects, and the whole point of splitting producer from verifier is that the verifier cannot be manipulated by producer output.

## Options Considered

### Option A: Prompt-only fix

Add explicit rules to `contract-tester.md`: "do not invent methods", "only reference symbols in `publicExports`", enumerate the failure modes seen so far.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Cost | Low (prompt tokens) |
| Scalability | Poor — grows linearly with failure modes |
| Team familiarity | High |
| Load-bearing assumption | LLM will reliably follow enumerated rules |

**Pros:** Cheapest to ship. No new nodes, no new error codes, no schema. Keeps the blueprint shape unchanged.
**Cons:** Does not eliminate the failure mode, only makes it rarer. Prompt bloat degrades unrelated rules. Every regression becomes "add another bullet point." Treats the LLM as both producer and verifier of the same output.

### Option B: Structured claims + deterministic grounding verifier (chosen)

The contract-tester emits JSON claims with grounding pointers. A deterministic node cross-checks each claim against the `ContractCorpus` and drops ungrounded ones before the test file is assembled.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — new node, new error codes, new output schema, new parser |
| Cost | Moderate one-time (a few hundred LOC + tests), zero per-run LLM cost |
| Scalability | Good — new failure modes of the "nonexistent symbol" class are caught for free |
| Team familiarity | Medium — the claims protocol is new but follows the existing agent-output-as-JSON pattern |
| Load-bearing assumption | `ContractCorpus` accurately reflects the reachable API surface |

**Pros:** Eliminates the entire class of "hallucinated symbol" failures in one change. The filter is auditable: the `verify-claim-grounding` node logs which claims were dropped and why, giving Stage 3b a measurable signal for whether prompts are improving. Separates creative work (proposing tests) from verification (does the symbol exist), which is the same principle the blueprint applies elsewhere.
**Cons:** Adds a blueprint node and an output contract the agent must learn. If the `ContractCorpus` is wrong, the filter drops legitimate claims — a new failure mode, but a deterministic and debuggable one. The structured-claims format constrains prompt evolution: future changes to claim shape require migration.

### Option C: Repair, don't drop

Same as Option B, but when a claim references a missing symbol, rewrite it to reference a nearby real symbol, or regenerate the test body against the real corpus.

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — repair logic is effectively a second agent |
| Cost | High — repair either needs another LLM call or encodes domain knowledge deterministically |
| Scalability | Poor — repair rules accumulate like prompt rules |
| Load-bearing assumption | We can mechanically guess what the agent meant |

**Pros:** Higher yield per run — fewer dropped claims.
**Cons:** Reintroduces the same problem one level down. A repair step is a producer; its output also needs verification. The lossy-drop design exists precisely so that the filter cannot be manipulated by bad producer output.

## Trade-off Analysis

The decisive trade-off is **scalability of the failure-mode response**, not shipping speed.

Option A looks cheapest on day one but gets more expensive every time the agent finds a new way to hallucinate. Option C looks highest-yield but dissolves the producer/verifier separation that justifies the whole architecture. Option B has the highest one-time cost and the lowest marginal cost per new failure mode. Given that Stage 3b extends the contract graph to three new languages (Python, Go, Rust), the number of future failure modes is guaranteed to grow, and Option A would compound poorly.

The lossy-by-design choice (drop, not repair) is the other load-bearing call. It means the filter is a *filter*, not a second producer. This is important when reasoning about correctness: we only need to prove that the filter does not let bad claims through, not that its repairs are themselves correct.

## Principle: when to add a deterministic filter for LLM output

Add one when **all** of the following hold:

1. **There is a machine-checkable ground truth.** The failure can be expressed as "does X exist in Y?" or "does X satisfy invariant Z?" against a data structure the pipeline already produces.
2. **The failure mode is recurring, not one-off.** A single bad output is a prompt-quality issue; a pattern across runs is a structural issue.
3. **The filter can be lossy.** Dropping is acceptable (the agent can be re-prompted, the run can fail loudly). A filter that must *repair* is a second producer in disguise.
4. **The filter's oracle is independent of the producer.** If the ground truth is itself LLM-generated, the filter cannot verify anything it couldn't verify at producer time.

## Principle: when NOT to add one

- **The failure is a prompt-quality issue.** Missing context, ambiguous instructions, or a system prompt that contradicts itself. Fix the prompt first.
- **There is no deterministic oracle.** "Is this test assertion *semantically meaningful*?" has no ground truth. A filter here would itself need to be an LLM, reintroducing the original problem.
- **Two filters in a row for the same agent.** If the same agent needs a second grounding-style filter downstream, the prompt is fundamentally underspecified. Stop and rewrite the prompt; do not stack filters.
- **The filter's drops exceed its passes in steady state.** If grounding drops most claims, the producer is not learning from its context — that is a prompt or context-construction bug, not a filter target.

## Worked example: `CostTracker.subtract()`

**Before grounding (Stage 3a validation, earlier attempts).** The contract-tester was asked to generate tests for `@bollard/engine` after a plan that added a `subtract()` method to `CostTracker`. On an attempt where the implementation hadn't actually landed yet (coder had written the plan but not the code), the agent emitted a test file that called `tracker.subtract(0.01)`. The file passed fence-stripping and leak scanning. It failed at `run-contract-tests` with a TypeScript error. Turn budget burned, partial files on disk, no signal about *why* the output was wrong.

**After grounding (2026-04-08, full implement-feature self-test for `CostTracker.subtract()`).** Run results:

- 17/17 nodes passed on first attempt, no retries.
- `verify-claim-grounding`: 5 claims proposed, 5 grounded, 0 dropped.
- Surviving assertions: negative input throws, underflow throws, basic subtraction correctness, interaction with `add`, `snapshot` reflects subtracted cost.
- Notable absence: no float-exactness assertions, no frozen-mutation traps, no assertions against methods that don't exist.

The positive case (5/5 grounded) does not by itself prove the filter is doing work — the prompt improvements in commit `dfced13` also do real work, and the two changes shipped together. The filter's value is visible in the negative case: the earlier hallucinated `subtract()` call from a validation attempt *before* the method existed is exactly the failure the grounding node now catches deterministically, regardless of prompt quality.

## Consequences

**Easier:**
- Adding new failure-mode categories of the "symbol doesn't exist" shape — the filter catches them for free.
- Reasoning about contract-tester correctness — the claim schema gives a typed interface between producer and verifier.
- Measuring prompt quality — drop rate per run is a directly observable metric for Stage 3b.

**Harder:**
- Evolving the claim schema — any change requires migrating both the prompt and the parser.
- Debugging dropped claims — a legitimate claim dropped because the `ContractCorpus` was incomplete looks the same as a hallucination. Mitigation: `verify-claim-grounding` logs the dropped claim and the corpus slice it was checked against.
- Stage 3b extractor work — Python, Go, and Rust `ContractCorpus` builders must be as accurate as the TypeScript one, or they will drop legitimate claims.

**To revisit:**
- If Stage 3b introduces a second grounding-style filter for contract-tester, pause Stage 3b and rewrite the prompt. Two filters in a row = the prompt is the problem.
- If steady-state drop rate exceeds ~20% of proposed claims on non-trivial tasks, re-examine the context-construction step (`buildContractContext`) — the agent is likely missing information it needs to avoid hallucinating.
- If the filter starts dropping claims that are legitimate but reference transitively-reachable symbols not in `publicExports`, revisit the re-export closure logic in `buildContractContext` before widening the grounding check.

## Action Items

1. [x] Ship `verify-claim-grounding` as node 12 of `implement-feature` (commit `5e5e11f`)
2. [x] Update contract-tester prompt and evals for the claims protocol (commit `dfced13`)
3. [x] Validate with `CostTracker.subtract()` self-test (commit `f9a9a47`)
4. [x] Flip Stage 3a status YELLOW → GREEN (commit `82da59e`)
5. [ ] Record drop-rate per run in `ctx.log` under a stable event name (`contract_grounding_result`) so Stage 3b has a baseline
6. [ ] Revisit this ADR after Stage 3b's Python/Go/Rust extractors land — verify that the drop rate on those languages stays in the same band as TypeScript
