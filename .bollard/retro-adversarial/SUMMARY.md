# Retro-Adversarial Pass — Stage 2 Validation

## Date
2026-04-02

## Packages tested
- @bollard/engine
- @bollard/llm
- @bollard/agents
- @bollard/verify
- @bollard/detect

## Methodology
Ran the tester agent (claude-sonnet-4-20250514) against TsCompilerExtractor output for each package. The tester received only public API signatures and referenced type definitions — no implementation bodies.

## Findings per package

### @bollard/engine
- **Coverage divergence:** Adversarial tests add type-shape drills (composite NodeResult with data + error + probes), combined imports across modules, and `runEvals([])` empty case list edge case. Hand-written tests focus on behavior (runner sequencing, eval assertions, CostTracker rules).
- **Information leaks:** None. No private identifiers referenced. Hand-written tests import `_generateTempRunId` and `_slugify` from context.ts; adversarial tests do NOT.
- **Property-based tests:** Yes — fc.assert/fc.property for cost tracking invariants, NodeType shapes, BollardErrorCode shapes.
- **Test quality:** Several CostTracker tests contradict the real implementation (expects negative remaining when add() actually throws). validConfig scope bug (declared in one describe, used in sibling).
- **Runnable:** No — markdown fences, scope bug, CostTracker expectation mismatches.
- **New bugs found:** None (CostTracker failures are test-side issues, not code bugs).

### @bollard/llm
- **Coverage divergence:** Adds generative checks over arbitrary agent names/API keys via fast-check. Type-shape examples for LLMContentBlock, LLMTool, LLMResponse structures. Hand-written tests cover exact BollardError codes and provider resolution which adversarial tests don't.
- **Information leaks:** None.
- **Property-based tests:** Yes — three fc.assert/fc.property blocks.
- **Test quality:** Shallow negative tests (empty strings, `as any` casts). MockProvider(undefined) is not valid under strict types.
- **Runnable:** No — markdown fences, import paths resolve to wrong directory.
- **New bugs found:** None.

### @bollard/agents
- **Coverage divergence:** Tests all three agent factories, eval loader edge cases (unknown agent filter), compactOlderTurns with null/undefined content, tool registry shape validation, individual tool execution boundaries. Some of these are novel vs hand-written tests.
- **Information leaks:** None. No `_`-prefixed imports.
- **Property-based tests:** Yes — arbitrary temperature, maxTurns, role/systemPrompt values.
- **Test quality:** Profile stubs use `framework`/`testFramework` fields instead of the real `ToolchainProfile` shape (`checks`, `sourcePatterns`, etc.). Mock provider objects aren't proper LLMProvider instances.
- **Runnable:** No — markdown fences, profile typing issues.
- **New bugs found:** None.

### @bollard/verify
- **Coverage divergence:** Tests compose generation, dynamic/static check nodes, lifecycle resolution, type extraction including extractPrivateIdentifiers. Good breadth across the package.
- **Information leaks:** None — extractPrivateIdentifiers is a public API (despite the name).
- **Property-based tests:** Yes — compose generation and lifecycle output dir.
- **Test quality:** FILE IS TRUNCATED — cuts off mid-test at line 423. ToolchainProfile stubs are invalid (missing checks, sourcePatterns, etc.). Lifecycle test asserts "persistent-isolated" which is never returned by current code.
- **Runnable:** No — truncated file, fences, invalid profile stubs.
- **New bugs found:** None.

### @bollard/detect
- **Coverage divergence:** Comprehensive coverage of all derive functions across all LanguageIds, detectToolchain with various project layouts, per-language detectors, fallback.detect(), buildManualProfile with minimal and full options. Good novel coverage.
- **Information leaks:** Imports from internal `languages/*.js` modules (not `_`-prefixed but package-internal). Minor concern.
- **Property-based tests:** Yes — language and parameter combinations for deriveAllowedCommands.
- **Test quality:** Good overall. Minor path alias issues.
- **Runnable:** Partial — fences need stripping, import paths need fixing.
- **New bugs found:** None.

## Overall assessment

- **Tester prompt quality:** 3/5 — Produces well-structured tests with good breadth and property-based coverage. Weaknesses: markdown fences not always stripped, ToolchainProfile stubs consistently wrong (uses imaginary fields), some CostTracker expectations contradict the implementation.
- **Signature extractor quality:** 4/5 — TsCompilerExtractor correctly strips implementation bodies and extracts type definitions. Minor gap: the tester still constructs wrong ToolchainProfile shapes despite seeing the real type definition, suggesting the type is complex enough to confuse the model.
- **Information barrier integrity:** PASS — No private identifiers (_-prefixed) leaked into adversarial tests across all 5 packages. The tester only sees signatures and type definitions.
- **Bugs found:** 0 new production bugs. One pre-existing bug fixed during validation: eval-runner.ts regex validation (found by existing adversarial test suite, not retro pass).
- **Prompt tuning needed:** Yes:
  1. Reinforce in tester prompt: "Do NOT wrap output in markdown fences"
  2. Add explicit example of correct ToolchainProfile construction to the context
  3. Consider including a "valid usage example" section from hand-written tests

## Cross-cutting observations

1. **Markdown fences in all outputs:** The tester wraps all output in ```typescript fences despite the prompt saying "Output ONLY the TypeScript test code." The write-tests blueprint node handles this via stripMarkdownFences, but standalone usage requires the same stripping.

2. **ToolchainProfile confusion:** All packages that test profile-dependent code construct profiles with wrong fields (framework, testFramework instead of checks.typecheck, checks.lint, etc.). This is the single most common issue and suggests the type signature alone isn't enough — the tester needs concrete examples.

3. **Import paths:** All generated files use relative `../src/...` imports. In the pipeline, deriveAdversarialTestPath places the test adjacent to source. The retro script places them in `.bollard/retro-adversarial/`, breaking resolution. This is a script issue, not a tester issue.

4. **verify package truncation:** The tester's response for @bollard/verify was cut off mid-file. This may be a token limit issue (verify has the most complex types). Consider splitting large packages into multiple extraction passes.

## Cost
- @bollard/engine: $0.0778
- @bollard/llm: $0.0491
- @bollard/agents: $0.0703
- @bollard/verify: $0.0717
- @bollard/detect: $0.0714
- **Total: $0.3402**

## Action items
- [x] Fix eval-runner.ts regex validation (done during Step 1)
- [ ] Add "no markdown fences" reinforcement to tester.md prompt (Stage 3)
- [ ] Add ToolchainProfile construction example to tester context (Stage 3)
- [ ] Consider max_tokens increase for verify package (large type surface)
- [ ] Add `python`, `pytest` to allowedCommands for Python projects (Stage 3)
- [ ] Investigate coder lint failure after skipVerificationAfterTurn — consider running format as final step
