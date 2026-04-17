# Stage 4c validation — Java/Kotlin Wave 1

**Date:** 2026-04-17  
**Status:** YELLOW — automated suite and cross-cutting CLI checks are **GREEN**. Full **Phase 3** Bollard-on-bollard `implement-feature` run against a Maven Java project was **not executed** in this validation pass (requires `ANTHROPIC_API_KEY`, `docker compose --profile full build dev-full`, and a long-running pipeline).

## Automated suite (Phase 0 gate)

| Check | Result |
|-------|--------|
| `docker compose build dev` | Pass |
| `docker compose run --rm dev run typecheck` | Pass |
| `docker compose run --rm dev run lint` | Pass (`biome check .`, 167 files) |
| `docker compose run --rm dev run test` | **744 passed**, **4 skipped** (748 total) |
| `docker compose run --rm dev exec vitest run --config vitest.adversarial.config.ts` | **331 passed**, 30 files, 0 failures |

## Integration point audit (Phase 1)

| Checkpoint | Status | Notes |
|------------|--------|-------|
| 1.1 Java detector | PASS | Maven/Gradle markers, Kotlin-only vs mixed/Java, Gradle over Maven when both present; pitest mutation; patterns/commands per `packages/detect/src/languages/java.ts`; registered before fallback in `detect.ts`. |
| 1.2 Test fixtures | PASS | `java-maven`, `java-gradle`, `kotlin-gradle`, `java-kotlin-mixed`, `java-gradle-with-pom` present under `packages/detect/tests/fixtures/`. |
| 1.3 GraalVM binary | PASS | Dockerfile: Maven JAR stage + GraalVM `native-image` → `/usr/local/bin/bollard-extract-java`; dev validates `--version`; `scripts/extract_java/` Maven + JavaParser + Kotlin regex + bytecode paths. **Fix applied:** `JavaExtractor` uses `ParserConfiguration.LanguageLevel.RAW` so native-image does not run JavaParser validators that threw `NoSuchFieldError` under GraalVM. |
| 1.4 Signature extractor | PASS | `JavaParserExtractor` in `packages/verify/src/extractors/java.ts`; `getExtractor` routes `java` and `kotlin`; binary invocation, timeouts, path guards. |
| 1.5 Contract graph | PASS | `JavaContractProvider`; Maven/Gradle multi-module fixtures; import edges; registered for `java`/`kotlin`. Contract CLI on multi-module sample returns two modules and b→a edge. |
| 1.6 PIT mutation | PASS | `PitestProvider` in `mutation.ts`; Maven/Gradle report paths; FQCN derivation; registered for `java`/`kotlin`. |
| 1.7 Test output parsing | PASS | Surefire + Gradle summaries in `parseSummary` chain with ANSI stripping (`dynamic.ts`). |
| 1.8 Test path derivation | PASS | Java/Kotlin boundary/contract/behavioral suffixes covered in `write-tests-helpers` tests. |
| 1.9 Risk gate | PASS | Java/Kotlin export heuristics in `implement-feature.ts` + tests. |
| 1.10 Prompt conditionals | PASS | `isJava` / `isKotlin` in `prompt-template.ts`; JVM blocks in all five agent prompts. |
| 1.11 Docker verify JVM | PASS | `docker/Dockerfile.verify-jvm` — Node 22 base + Temurin 21 + Maven. |
| 1.12 Compose generator | PASS | `DEFAULT_IMAGES` includes `eclipse-temurin:21` for `java`/`kotlin`; `generateBehavioralCompose` uses Spring Boot-style JVM start commands for Gradle vs Maven. |
| 1.13 Type definitions | PASS | `MutationToolId` includes `pitest`; `LanguageId` / `PackageManagerId` include JVM ids. |

## Cross-cutting verification (Phase 2)

| Check | Status | Notes |
|-------|--------|-------|
| 2.1 Profile round-trip (Maven) | PASS | `/tmp/java-test`: `language: "java"`, `packageManager: "maven"`, `mutation.tool: "pitest"`, `checks.test.cmd: "mvn"`, Java source/test patterns. |
| 2.2 Contract graph round-trip | PASS | `/tmp/java-multi`: modules `module-a`, `module-b`; edge `module-b` → `module-a`; exports include `Service.run`, `Client.call`. No extractor stderr after RAW fix. |
| 2.3 Extractor binary | PASS | `add`/`subtract` public; `internal` not listed; `Calculator` type present. |
| 2.4 Kotlin detection | PASS | `/tmp/kt-test`: `language: "kotlin"`, `packageManager: "gradle"`, patterns include `**/*.kt`. |

## Bollard-on-bollard (Phase 3)

| Metric | Value |
|--------|-------|
| Nodes passed | *Not run* |
| Language detected | *Not run* |
| Signatures extracted | *Not run* |
| JUnit 5 tests generated | *Not run* |
| Surefire output parsed | *Not run* |
| Contract graph built | *Not run* |
| Information barrier | *Not run* |
| Cost (USD) | — |
| Duration (s) | — |
| Coder turns | — |

## Edge cases (Phase 4)

| Case | Status | Notes |
|------|--------|-------|
| 4.1 Gradle E2E | Not run | Optional follow-up. |
| 4.2 Mixed Java/Kotlin E2E | Not run | Detector unit tests cover mixed → `language: "java"`. |
| 4.3 Empty/minimal POM | PASS | `/tmp/empty-java` with only `pom.xml`: profile returns Java/Maven without crashing. |

## Delivered (Wave 1 scope)

- `@bollard/detect`: JVM detector (`packages/detect/src/languages/java.ts`), fixtures, `pitest` on profile.
- `bollard-extract-java` GraalVM native binary in dev image; `scripts/extract_java/` (JavaParser + Kotlin regex + ASM bytecode).
- `@bollard/verify`: `JavaParserExtractor`, `JavaContractProvider`, `PitestProvider`, Surefire/Gradle test summaries, JVM `DEFAULT_IMAGES`, behavioral compose for Spring-style JVM apps, `Dockerfile.verify-jvm`.
- `@bollard/blueprints`: Java/Kotlin adversarial test paths, risk-gate diff patterns.
- `@bollard/agents`: `isJava` / `isKotlin` templating and prompt blocks.

## Issues found and fixes

1. **GraalVM + JavaParser validators:** Native `bollard-extract-java` could throw `NoSuchFieldError` during semantic validation. **Fix:** parse with `LanguageLevel.RAW` (no validators/post-processors) in `JavaExtractor`.
2. **Search tool adversarial property:** Patterns starting with `-` were passed to `rg` as flags. **Fix:** extend fast-check filter with `!p.startsWith("-")` in `search.adversarial.test.ts`.

## Manual follow-ups

- Run **Phase 3** `implement-feature` on `/tmp/bollard-java-test` with `dev-full`, `BOLLARD_AUTO_APPROVE=1`, and a real `ANTHROPIC_API_KEY`; record nodes, cost, and barrier check.
- Optional: Gradle-only and mixed Java/Kotlin pipeline smoke tests (Phase 4.1–4.2).
