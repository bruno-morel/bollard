# Stage 4c validation — Java/Kotlin Wave 1

**Date:** 2026-04-19
**Status:** YELLOW — automated suite GREEN, Phase 1 audit GREEN, cross-cutting checks GREEN, Bollard-on-bollard contract+mutation run surfaced a real contract-test placement bug at **node 15/28** (`run-contract-tests`) that blocks full-pipeline completion. All pre-failure validation points (detection, extraction, contract graph, contract test generation, JUnit 5 authoring, claim grounding, risk gate, boundary tests) are PASS. The failure is a genuine Wave 1 gap, not an environmental issue — see "Issues found during validation".

## Automated suite (Phase 0)

| Check | Result |
|-------|--------|
| `docker compose run --rm dev run typecheck` | **Pass** |
| `docker compose run --rm dev run lint` | **Pass** (`biome check .`, 167 files) |
| `docker compose run --rm dev run test` | **753 passed**, **4 skipped** (757 total, 60 files, 7.18s) |
| `docker compose run --rm dev exec vitest run --config vitest.adversarial.config.ts` | **331 passed**, 30 files, 0 failures |

(+9 pass vs the 2026-04-17 baseline of 744/4; net new tests added since then.)

## Integration point audit (Phase 1)

| # | Checkpoint | Status | Notes |
|---|------------|--------|-------|
| 1.1 | Java detector | PASS | `packages/detect/src/languages/java.ts`: Maven via `pom.xml`; Gradle via `build.gradle`/`.kts` + `settings.gradle`/`.kts`; recursive `.java`/`.kt` walk; Kotlin-only → `language: "kotlin"`, else `java`; Gradle wins when both exist (confirmed in Phase 2.5); typecheck `compileJava`[+`compileKotlin` when `.kt` seen]/`mvn compile`; lint Detekt vs Checkstyle vs fallback; test `./gradlew`/`gradle test` vs `mvn test`; audit dependency-check vs OWASP; `mutation.tool: "pitest"`, threshold 60, timeout 600s; patterns per `derive.ts`; `detectJava` sits before `detectFallback` in `detect.ts`. |
| 1.2 | Test fixtures | PASS | `packages/detect/tests/fixtures/`: `java-maven`, `java-gradle`, `kotlin-gradle`, `java-kotlin-mixed`, `java-gradle-with-pom` present with expected layouts. |
| 1.3 | GraalVM binary | PASS | `Dockerfile`: C1 `maven:3.9-eclipse-temurin-21` builds `scripts/extract_java/pom.xml`; C2 `ghcr.io/graalvm/native-image-community:21` → static binary; dev copies `/usr/local/bin/bollard-extract-java` and validates `--version`; `dev-full` adds Temurin JDK + Maven. `scripts/extract_java/`: JavaParser, `Main.java` (`--version`, `--kotlin`, `--bytecode`). Phase 2.3 confirmed the binary runs and emits valid JSON. |
| 1.4 | Signature extractor | PASS | `JavaParserExtractor` shells to `bollard-extract-java`, `.kt` → `--kotlin`, `.class` → `--bytecode`, JSON parse, `filterUnderWorkDir` path guard, 60s / 8MB limits, ENOENT soft-fallback. `getExtractor("java"\|"kotlin")` → `JavaParserExtractor`. |
| 1.5 | Contract graph provider | PASS | `JavaContractProvider`: Maven `<modules>`, Gradle `include(...)` + `include <...>` parsing, single-module fallback, walks `src/main/java` + `src/main/kotlin`, Java + Kotlin import regexes, package→module edges, `affectedFiles` scoping. `PROVIDERS.java` / `PROVIDERS.kotlin`. Fixtures `java-maven-multi`, `java-gradle-multi`. |
| 1.6 | PIT mutation provider | PASS | `PitestProvider`: Maven `mvn org.pitest:pitest-maven:mutationCoverage` / Gradle `./gradlew pitest`; FQCN from `src/main/java\|kotlin/...`; XML mutation counts (KILLED/SURVIVED/NO_COVERAGE/TIMED_OUT/RUN_ERROR); score = `(killed + timeout) / total * 100`; report discovery under `target/pit-reports/*/mutations.xml` / `build/reports/pitest/*/mutations.xml`; `getMutationProvider("java"\|"kotlin")` → pitest singleton. |
| 1.7 | Test output parsing | PASS | `dynamic.ts` `parseSummary`: Surefire `Tests run: …, Failures: …, Errors: …, Skipped: …`, Gradle `N tests completed[, M failed][, K skipped]`, added to chain after vitest/pytest/go/cargo, ANSI strip first. |
| 1.8 | Test path derivation | PASS | `deriveAdversarialTestPath`: Java/Kotlin map to `<Base>AdversarialTest.{java,kt}`, `<Base>ContractTest.{java,kt}`, `<Base>BehavioralTest.{java,kt}` under `src/test/java`/`src/test/kotlin` mirroring packages; multi-module `modulePrefix` preserved. Boundary uses `AdversarialTest` suffix to avoid clobbering existing `*Test.java` unit files (boundary-tester prompt aligned). |
| 1.9 | Risk gate | PASS | `isJavaExportChange` matches `+public (class\|interface\|enum\|record\|@interface)`, `+public <return> name(`, `+public static final`. `isKotlinExportChange` matches `fun`/`class`/`data class`/`interface`/`object`/`val N:`/`var N:` and **returns false** when the trimmed line starts with `private`/`internal`. |
| 1.10 | Prompt conditionals | PASS | `prompt-template.ts` populates `isJava: lang === "java"` and `isKotlin: lang === "kotlin"` in `conditionVars`. All five prompts include non-empty JVM blocks: `planner.md`, `coder.md`, `contract-tester.md`, `behavioral-tester.md` each have `{{#if isJava}}` + `{{#if isKotlin}}`; `boundary-tester.md` uses `{{else if isJava}}` / `{{else if isKotlin}}` inside its language chain. |
| 1.11 | Docker verify image | PASS | `docker/Dockerfile.verify-jvm`: Node 22 slim + Temurin 21 JDK + Maven; `ENTRYPOINT ["pnpm", "exec", "tsx"]` and runs `bollard verify` by default. |
| 1.12 | Compose generator | PASS | `compose-generator.ts`: `DEFAULT_IMAGES.java` / `kotlin` → `eclipse-temurin:21`; `generateBehavioralCompose` starts JVM projects with `./gradlew bootRun` / `gradle bootRun` (Gradle) or `mvn spring-boot:run` (Maven); `sleep 3600` fallback otherwise. |
| 1.13 | Type definitions | PASS | `packages/detect/src/types.ts`: `MutationToolId` includes `"pitest"`; `LanguageId` includes `"java"` and `"kotlin"`; `PackageManagerId` includes `"gradle"` and `"maven"`. |

## Cross-cutting verification (Phase 2)

| # | Check | Status | Notes |
|---|-------|--------|-------|
| 2.1 | Maven profile detection | PASS (historical 2026-04-17) | `/tmp/java-test`: `language: "java"`, `packageManager: "maven"`, `mutation.tool: "pitest"`, `checks.test.cmd: "mvn"`. Re-run not needed; detector code unchanged. |
| 2.2 | Multi-module contract graph | PASS (historical 2026-04-17) | `/tmp/java-multi`: modules `module-a`, `module-b`; edge `module-b` → `module-a`; exports include `Service.run`, `Client.call`. |
| 2.3 | Extractor binary on non-trivial code | **PASS (re-run 2026-04-19)** | `/tmp/ext-test` Repository/UserService/User: generic interface `Repository<T, ID>` with all four methods captured **with type params** (`findById(ID id)`, `findAll()`, etc.); `UserService` constructor + `getUser`/`listUsers`/`legacyGet` extracted; `private void internalMethod()` **correctly excluded**; `User` record emitted with full header `public record User(long id, String name, String email)` and recognized as a record; `import java.util.List` / `import java.util.Optional` preserved in `imports` field. **Minor gap:** `@Deprecated` annotation is **not** preserved in the signature output — see Issues. |
| 2.4 | Kotlin-only detection | PASS (historical 2026-04-17) | `/tmp/kt-test`: `language: "kotlin"`, `packageManager: "gradle"`, patterns include `**/*.kt`. |
| 2.5 | Gradle-with-Maven precedence | **PASS (re-run 2026-04-19)** | `/tmp/both-test` with `build.gradle` + `pom.xml`: `verify --profile` returns `"packageManager": "gradle"`, `allowedCommands` contain `./gradlew` and `gradle` (not `mvn`). |
| 2.6 | Empty project (no crash) | PASS (historical 2026-04-17) | `/tmp/empty-java` with only `pom.xml`: profile returns java/maven without crashing. |

## Bollard-on-bollard — Run 1: Slim (contract/behavioral/mutation OFF)

(Historical result carried forward from the 2026-04-16 hardening run on bollard itself.)

| Metric | Value |
|--------|-------|
| Nodes passed | 28/28 |
| Language detected | typescript |
| Package manager | pnpm |
| Cost (USD) | ~$0.37 |
| Duration (s) | ~116 |
| docker-verify | skipped (Docker unavailable inside dev container) |

## Bollard-on-bollard — Run 2: Full (contract ON, mutation ON) — Java Maven multi-module

**Work dir:** `/tmp/bollard-contract-test` (multi-module: `core`, `api`; cross-module imports `com.example.core.*` from `api`).
**Task:** "Add a `power(int base, int exponent)` method to `Calculator` in core ... and a `computePower` operation to `CalculatorFacade` in api ..."
**Run ID:** `20260419-2240-run-643ec0`

| Node | Result | Notes |
|------|--------|-------|
| 1  create-branch | ✓ 2ms | |
| 2  generate-plan | ✓ 29.0s ($0.0585) | Plan cited both modules and public-API constraints correctly |
| 3  approve-plan | ✓ | Auto-approved (`BOLLARD_AUTO_APPROVE=1`) |
| 4  implement-code | ✓ 60.2s ($0.3203) | Coder completed power + computePower; all project tests green |
| 5  static-checks | ✓ 1.2s | Typecheck + lint + test + audit (audit overridden to no-op in `.bollard.yml` — see Issues) |
| 6  extract-signatures | ✓ 27ms | `bollard-extract-java` shell-out succeeded |
| 7  generate-tests (boundary) | ✓ 19.3s ($0.0330) | Boundary-tester produced JUnit 5 |
| 8  write-adversarial-tests | ✓ 6ms | File written under `src/test/java/.../*AdversarialTest.java` |
| 9  run-tests | ✓ 2.8s | Surefire summary parsed |
| 10 assess-contract-risk | ✓ 3ms | `contract_scope_decision`: `{decision: "run", touchesExportedSymbols: true, skipContract: false}` |
| 11 extract-contracts | ✓ 7ms | Two modules discovered, api→core edge, public exports listed |
| 12 generate-contract-tests | ✓ 15.9s ($0.0324) | Contract-tester produced JUnit 5 |
| 13 verify-claim-grounding | ✓ 2ms | `contract_grounding_result`: `{proposed: 5, grounded: 5, dropped: 0, dropRate: 0, language: "java"}` |
| 14 write-contract-tests | ✓ 5ms | Wrote `core/src/test/java/com/example/core/CalculatorContractTest.java` (1881 bytes, 5 claims) |
| 15 run-contract-tests | **✗ 831ms** | **`TEST_FAILED` — cross-module compile error**: test placed in `core` imports `com.example.api.CalculatorFacade`, but `core` has no dependency on `api` (correct DAG). See Issues. |
| 16–28 | — | Not reached (pipeline halted at node 15) |

| Metric | Value |
|--------|-------|
| Nodes passed | **14/28** (pipeline halted at contract test execution) |
| Language detected | java |
| Package manager | maven |
| Signatures extracted | yes (`bollard-extract-java` invoked at node 6) |
| Contract graph | 2 modules (`core`, `api`), 1 edge (`api` → `core`) |
| Contract claims | 5 proposed / 5 grounded / 0 dropped |
| JUnit 5 boundary tests | yes (`@Test`, `assertEquals`, `assertThrows`) |
| JUnit 5 contract tests | yes (1881 bytes, 5 claims) — **but placed in the wrong module** |
| Surefire parsed | yes (test+contract runs both report `Tests run: N, Failures: …`) |
| Risk gate fired | yes (`touchesExportedSymbols: true`, decision: run) |
| Behavioral scope | not reached (pipeline halted) — expected behavior when it would have run is empty-context skip for Java |
| PIT mutation | not reached |
| Information barrier | clean (no `BollardError` / `PipelineContext` / `executeAgent` strings in agent outputs) |
| Cost (USD) | **$0.4442** |
| Duration (s) | **129.4** |
| Coder turns | 35/60 |

**Artifacts:** `phase3-artifacts/pipeline.log`, `phase3-artifacts/pipeline.clean.log`, `phase3-artifacts/setup-and-run.sh`, `phase3-artifacts/pipeline-run1-audit-fail.log` (first run, pre audit override).

## Gradle variant (Phase 4)

| Metric | Value |
|--------|-------|
| Detection correct | **yes** (re-verified 2026-04-19) |
| Language | `"java"` |
| Package manager | `"gradle"` |
| `checks.typecheck` | `gradle compileJava` |
| `checks.lint` | `gradle check` |
| `checks.test` | `gradle test` |
| Live pipeline | **Deferred** — `which gradle` is empty inside `dev-full`; Gradle is expected via project-local `./gradlew`. Live run skipped for this project (no wrapper). Unit tests in `@bollard/detect` cover Gradle parsing. |

## Delivered (Wave 1 scope)

- Java/Kotlin detector (`packages/detect/src/languages/java.ts`) — Maven + Gradle, language discrimination, Gradle-over-Maven precedence
- GraalVM native binary (`bollard-extract-java`) — JavaParser-based, zero JRE in `dev` image
- `JavaParserExtractor` (`packages/verify/src/extractors/java.ts`) — `.java` AST, `.kt` regex, `.class` bytecode
- `JavaContractProvider` (`packages/verify/src/contract-providers/java.ts`) — Maven/Gradle multi-module, import-based edges
- `PitestProvider` (`packages/verify/src/mutation.ts`) — PIT integration for Java/Kotlin
- Surefire + Gradle test output parsers (`packages/verify/src/dynamic.ts`)
- JUnit 5 adversarial test path derivation (all three scopes × two languages; `*AdversarialTest` / `*ContractTest` / `*BehavioralTest`)
- Java/Kotlin export change detection in risk gate (`packages/blueprints/src/implement-feature.ts`)
- `isJava` / `isKotlin` prompt template conditionals across all five agent prompts
- `docker/Dockerfile.verify-jvm` — Node 22 + Temurin 21 + Maven
- `eclipse-temurin:21` in compose generator for java/kotlin
- `MutationToolId` includes `"pitest"`

## Known gaps (documented, not bugs)

1. **Behavioral scope for Java** — `buildBehavioralContext` does not support Java. Spring Boot endpoint extraction (`@RestController`, `@GetMapping`) is not implemented. The compose generator has `bootRun` / `spring-boot:run` start commands ready for when extraction is added. Future enhancement.
2. **PIT requires plugin in target project** — `PitestProvider` invokes `mvn org.pitest:pitest-maven:mutationCoverage`; that only succeeds if the project's `pom.xml` includes the `pitest-maven` plugin. Bollard does not inject it. By design (Bollard does not modify project build files).
3. **Kotlin extraction is regex-based** — `bollard-extract-java --kotlin` uses regex, not a Kotlin compiler. Complex patterns (extension functions with receivers, inline classes, sealed hierarchies) may be incomplete.
4. **Gradle live pipeline** — `dev-full` does not pre-install Gradle; projects are expected to ship a `./gradlew` wrapper. Detection and unit tests cover Gradle parsing; live pipeline through dev-full is deferred for wrapper-less projects.
5. **`docker-verify` always skips in dev-full** — Docker-in-Docker is unavailable inside the dev-full container, so the `docker-verify` node always skips. Consistent with every prior bollard-on-bollard run.
6. **OWASP `dependency-check-maven` audit requires offline DB or network** — The auto-detected `audit` command for Maven projects (`mvn org.owasp:dependency-check-maven:check`) attempts to download the NVD database and fails on fresh projects without the plugin configured. In Phase 3 we overrode it to `cmd: "true"` via `.bollard.yml`. Wave 2 candidate: gate audit activation on plugin presence in `pom.xml`.

## Issues found during validation

1. **[Blocker at node 15] Cross-module contract test placement** — `deriveAdversarialTestPath(scope: "contract")` for Java mirrors the affected source path into `src/test/java/...`. When the contract-tester produces a test that references symbols from *another* module (here: `com.example.api.CalculatorFacade`), the test is written to the *wrong* module (`core/src/test/java/...`), which does not depend on `api`. `mvn test` then fails to compile the test. Two reasonable fixes:
   - Place the contract test in the **consumer** module (downstream edge endpoint) instead of the producer, when grounded claims reference symbols outside the source module.
   - Or: prompt the contract-tester to restrict cross-module assertions to the consumer side and write there.
   File an issue for Wave 1.1. Validation is YELLOW until this is fixed and Run 2 reaches node 28.
2. **Extractor does not preserve `@Deprecated` (Phase 2.3)** — The spec calls out `@Deprecated` should be "preserved or noted". `JavaExtractor` currently drops method annotations from the rendered `signatures` string. Low priority — the presence of the method is captured; filling annotations needs a small JavaParser visitor change.
3. **OWASP audit plugin not gated on project presence** — See Known gap 6. When `pom.xml` lacks `<plugin>org.owasp:dependency-check-maven</plugin>`, the auto-detector should emit no `audit` check (or fall back to `mvn verify -DskipTests` without dependency-check).

## Post-validation

- [x] `spec/stage4c-validation-results.md` updated with full Phase 0–4 results
- [x] `spec/ROADMAP.md` updated — Stage 4c Part 2 status annotated (YELLOW pending Wave 1.1 contract-test placement fix)
- [x] `CLAUDE.md` test count updated to 753 / 4 (was 744 / 4)
- [ ] Commit — see final step in the validation plan
- [ ] Re-run Phase 3 after fixing cross-module contract placement (pipeline must complete 28/28 for GREEN)
