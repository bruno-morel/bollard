# Stage 4c Part 2 — Java/Kotlin Wave 1

> **Status:** Planning  
> **Prerequisite:** Stage 4c Part 1 GREEN (705 pass / 4 skip, streaming parity + hardening)  
> **Spec version:** 2026-04-17

---

## 1. Goal

Add Java and Kotlin as first-class Bollard languages. After this stage, `bollard run implement-feature --work-dir /path/to/jvm-project` works end-to-end against any Maven or Gradle project with the same 28-node pipeline that already handles TypeScript, Python, Go, and Rust.

**What ships:**

1. **Java/Kotlin detector** — auto-detects Maven or Gradle projects, JUnit 5, Checkstyle/SpotBugs/ktlint/detekt linters
2. **JavaParser-based signature extractor** — GraalVM native-image binary (`bollard-extract-java`), zero runtime JDK dependency in the `dev` image
3. **JVM contract graph provider** — discovers Maven modules / Gradle subprojects, builds module graph from import statements
4. **PIT mutation testing provider** — the reference JVM mutation tool, integrated via Maven/Gradle plugin
5. **JVM Docker verify image** — `Dockerfile.verify-jvm` shared by Java and Kotlin
6. **`dev-full` JDK extension** — Temurin JDK 21 + Maven + Gradle wrapper support in the `dev-full` image
7. **Adversarial test path derivation** — Java/Kotlin naming conventions for boundary/contract/behavioral test files
8. **Prompt template conditionals** — `{{#if isJava}}` / `{{#if isKotlin}}` blocks in boundary/contract/behavioral tester prompts

**What does NOT ship (deferred):**

- Kotlin-specific extractor (`.kt` files go through JavaParser via `.class` bytecode or kotlinc — see §3.2 decision)
- KSP (Kotlin Symbol Processing) integration
- TestNG support (JUnit 5 only in Wave 1)
- Annotation processor awareness in the extractor

---

## 2. Design Decisions

### 2.1 Extractor: GraalVM native-image from JavaParser JAR

The Go and Rust extractors are native binaries (`bollard-extract-go`, `bollard-extract-rs`) that need no runtime toolchain in the `dev` image. For Java, we follow the same pattern:

1. Build a small Maven project using JavaParser 3.x (AST library)
2. Compile to a **GraalVM native-image** in a Dockerfile builder stage
3. Copy the static binary to `/usr/local/bin/bollard-extract-java` in the `dev` image

This avoids adding a JRE to the base `dev` image (~100MB savings vs. JRE approach). The native-image binary is ~30–50MB and runs in milliseconds.

**Kotlin handling (Wave 1):** For `.kt` files, the JavaParser helper cannot parse Kotlin syntax directly. Wave 1 strategy:

- If the project has compiled `.class` files (e.g., in `build/classes` or `target/classes`), the extractor reads bytecode via ASM (already a JavaParser transitive dep) to extract public signatures.
- If no `.class` files exist, the extractor falls back to regex-based extraction for `.kt` files (same pattern as the Python extractor — good enough for public `fun`/`class`/`interface`/`object` declarations).
- Full Kotlin AST parsing via kotlinc or KSP is deferred to a future wave.

### 2.2 Build tools: Maven + Gradle from day one

Both are detected. The detector checks in order:

1. `build.gradle` or `build.gradle.kts` → Gradle
2. `settings.gradle` or `settings.gradle.kts` → Gradle (multi-module)
3. `pom.xml` → Maven

If both exist (rare but possible), Gradle wins — it's the more modern default.

### 2.3 JDK only in dev-full

The `dev` image gets only the native-image extractor binary (no JDK). The `dev-full` image adds Temurin JDK 21 + Maven 3.9.x (via apt). Gradle projects use the Gradle wrapper (`./gradlew`) which downloads its own distribution — no global Gradle install needed.

### 2.4 PIT as the mutation testing reference

PIT (`pitest`) is the most mature JVM mutation tool. It integrates via:

- **Maven:** `mvn org.pitest:pitest-maven:mutationCoverage` with `-DtargetClasses` and `-DtargetTests`
- **Gradle:** `gradle pitest` (requires the `info.solidsoft.pitest` plugin)

The `PitestProvider` parses PIT's XML report (`target/pit-reports/*/mutations.xml` for Maven, `build/reports/pitest/*/mutations.xml` for Gradle).

### 2.5 MutationToolId extension

Add `"pitest"` to the `MutationToolId` union in `packages/detect/src/types.ts`.

---

## 3. Implementation Plan

### 3.1 Java/Kotlin Detector

**File:** `packages/detect/src/languages/java.ts`

**Detection logic:**

```typescript
export async function detect(cwd: string): Promise<Partial<ToolchainProfile> | null> {
  // 1. Check Gradle first (modern default)
  const hasGradleBuild = await exists(join(cwd, "build.gradle")) ||
                          await exists(join(cwd, "build.gradle.kts"))
  const hasGradleSettings = await exists(join(cwd, "settings.gradle")) ||
                             await exists(join(cwd, "settings.gradle.kts"))
  const hasMaven = await exists(join(cwd, "pom.xml"))

  if (!hasGradleBuild && !hasGradleSettings && !hasMaven) return null

  const isGradle = hasGradleBuild || hasGradleSettings
  const pkgMgr: PackageManagerId = isGradle ? "gradle" : "maven"

  // 2. Detect language: Kotlin vs Java (or both)
  const hasKotlin = await hasFilesMatching(cwd, "**/*.kt", ["build", ".gradle", "target"])
  const hasJava = await hasFilesMatching(cwd, "**/*.java", ["build", ".gradle", "target"])
  const language: LanguageId = hasKotlin && !hasJava ? "kotlin" : "java"
  // Mixed projects default to "java" — both file types are handled

  // 3. Build verification commands
  const checks = buildJvmChecks(cwd, pkgMgr, isGradle)

  // 4. Detect linters
  await detectLinters(cwd, checks, language, isGradle)

  return {
    language,
    packageManager: pkgMgr,
    checks,
    sourcePatterns: deriveSourcePatterns(language),
    testPatterns: deriveTestPatterns(language),
    ignorePatterns: deriveIgnorePatterns(language),
    allowedCommands: deriveAllowedCommands(language, pkgMgr,
      isGradle ? ["./gradlew", "java", "javac"] : ["mvn", "java", "javac"]),
    mutation: {
      enabled: true,
      tool: "pitest" as MutationToolId,
      threshold: 60,
      timeoutMs: 600_000,  // JVM mutation is slow
      concurrency: 2,
    },
  }
}
```

**Verification commands:**

| Check | Gradle | Maven |
|-------|--------|-------|
| typecheck | `./gradlew compileJava compileKotlin` | `mvn compile` |
| lint | auto-detected (see below) | auto-detected |
| test | `./gradlew test` | `mvn test` |
| audit | `./gradlew dependencyCheckAnalyze` (if plugin present) | `mvn org.owasp:dependency-check-maven:check` |

**Linter detection:**

- **Java:** Check for `checkstyle.xml` → Checkstyle; `spotbugs-exclude.xml` → SpotBugs; `.editorconfig` with Java sections → ErrorProne
- **Kotlin:** Check for `.editorconfig` with `ktlint` or `ktlint-maven-plugin` in `pom.xml` → ktlint; `detekt.yml` → detekt
- **Fallback:** Gradle `./gradlew check` / Maven `mvn verify` (includes whatever plugins are configured)

**Detector ordering:** Insert between Rust and fallback in `packages/detect/src/detect.ts`:

```typescript
const detectors = [
  detectTypescript,
  detectJavascript,
  detectPython,
  detectGo,
  detectRust,
  detectJava,    // NEW
  detectFallback,
]
```

**Helper function `hasFilesMatching`:** Walks up to 3 directory levels looking for files matching a glob pattern. Uses `readdir` + string matching, no external glob library. Respects skip directories.

### 3.2 JavaParser Signature Extractor

**Directory:** `scripts/extract_java/`

**Structure:**
```
scripts/extract_java/
├── pom.xml              # Maven project with JavaParser + ASM + GraalVM native-image plugin
├── src/main/java/dev/bollard/extract/
│   ├── Main.java        # CLI entry: parse args, dispatch, JSON output
│   ├── JavaExtractor.java    # JavaParser AST visitor for .java files
│   ├── KotlinRegexExtractor.java  # Regex fallback for .kt files (Wave 1)
│   ├── BytecodeExtractor.java     # ASM-based .class file reader
│   └── JsonOutput.java  # JSON serialization (no external JSON lib — manual StringBuilder)
└── src/test/java/dev/bollard/extract/
    ├── JavaExtractorTest.java
    ├── KotlinRegexExtractorTest.java
    └── BytecodeExtractorTest.java
```

**CLI interface** (same contract as Go/Rust helpers):

```bash
# Extract from Java source files
bollard-extract-java src/main/java/com/example/Foo.java src/main/java/com/example/Bar.java

# Extract from Kotlin files (regex mode)
bollard-extract-java --kotlin src/main/kotlin/com/example/Baz.kt

# Extract from bytecode (compiled .class)
bollard-extract-java --bytecode build/classes/java/main/com/example/Foo.class

# Version
bollard-extract-java --version
```

**Output format** (JSON to stdout, same schema as Go/Rust):

```json
{
  "signatures": [
    {
      "filePath": "src/main/java/com/example/Foo.java",
      "signatures": "public class Foo\npublic String getName()\npublic void setName(String name)\npublic static Foo create(String name)",
      "types": "public class Foo\npublic interface Nameable\npublic enum Status { ACTIVE, INACTIVE }",
      "imports": "import java.util.List\nimport java.util.Optional\nimport com.example.Bar"
    }
  ],
  "types": [
    {
      "name": "Foo",
      "kind": "interface",
      "definition": "public class Foo implements Nameable {\n  public String getName();\n  public void setName(String name);\n}",
      "filePath": "src/main/java/com/example/Foo.java"
    }
  ],
  "warnings": []
}
```

**What the JavaParser visitor extracts:**

- **Classes:** public classes, abstract classes, interfaces, enums, records, annotations
- **Methods:** public and protected methods with full signatures (return type, parameters, throws)
- **Fields:** public and protected fields with types
- **Generics:** type parameters on classes and methods
- **Constructors:** public constructors with parameter types
- **Nested types:** public static inner classes/interfaces
- **Filtered out:** private members, package-private members (no modifier), implementation bodies, comments

**Kotlin regex extractor (Wave 1 fallback):**

Patterns to extract:
- `fun <name>(<params>): <ReturnType>` — top-level and member functions
- `class <name>(<params>)` — data classes, regular classes
- `interface <name>` — interfaces
- `object <name>` — singletons
- `enum class <name>` — enums
- `val <name>: <Type>` — public properties
- `typealias <name> = <Type>` — type aliases

Visibility: Skip `private` and `internal` declarations. Default visibility in Kotlin is `public`.

### 3.3 Node.js Extractor Wrapper

**File:** `packages/verify/src/extractors/java.ts`

```typescript
export class JavaParserExtractor implements SignatureExtractor {
  private readonly warn?: (msg: string) => void

  constructor(warn?: (msg: string) => void) {
    this.warn = warn
  }

  async extract(
    files: string[],
    profile?: ToolchainProfile,
    workDir?: string,
  ): Promise<ExtractionResult> {
    const cwd = workDir ?? process.cwd()
    const filtered = filterUnderWorkDir(files, cwd)
    if (filtered.length === 0) return { signatures: [], types: [] }

    // Separate Java and Kotlin files
    const javaFiles = filtered.filter(f => f.endsWith(".java"))
    const ktFiles = filtered.filter(f => f.endsWith(".kt"))

    const results: ExtractionResult = { signatures: [], types: [] }

    // Extract Java files via bollard-extract-java
    if (javaFiles.length > 0) {
      const javaResult = await this.runHelper(javaFiles, cwd)
      results.signatures.push(...javaResult.signatures)
      results.types.push(...javaResult.types)
    }

    // Extract Kotlin files via bollard-extract-java --kotlin
    if (ktFiles.length > 0) {
      const ktResult = await this.runHelper(ktFiles, cwd, ["--kotlin"])
      results.signatures.push(...ktResult.signatures)
      results.types.push(...ktResult.types)
    }

    return results
  }

  private async runHelper(
    files: string[],
    cwd: string,
    extraArgs: string[] = [],
  ): Promise<ExtractionResult> {
    try {
      const { stdout } = await execFileAsync(
        HELPER_BINARY,
        [...extraArgs, ...files],
        { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
      )
      return parseHelperOutput(stdout, this.warn)
    } catch (err) {
      if (isExecNotFound(err)) {
        this.warn?.("bollard-extract-java not found on PATH")
      }
      return { signatures: [], types: [] }
    }
  }
}
```

**Register in `getExtractor`** (`packages/verify/src/type-extractor.ts`):

```typescript
case "java":
case "kotlin":
  return new JavaParserExtractor(warn)
```

### 3.4 JVM Contract Graph Provider

**File:** `packages/verify/src/contract-providers/java.ts`

**Class:** `JavaContractProvider implements ContractGraphProvider`

**Module discovery:**

- **Gradle:** Read `settings.gradle(.kts)`, parse `include` directives: `include ':module-a', ':module-b'`. Each included project maps to a directory. Walk for `build.gradle(.kts)` to confirm existence.
- **Maven:** Read root `pom.xml`, parse `<modules>` element. Each `<module>` maps to a subdirectory with its own `pom.xml`.
- **Single-module:** If no subprojects found, treat the root as a single module.

**Source listing:**

Walk `src/main/java/` and `src/main/kotlin/` directories (skip `src/test/`, `build/`, `target/`, `.gradle/`). Collect `*.java` and `*.kt` files.

**Import parsing:**

Java: `import <package>.<ClassName>;` — regex: `^import\s+(?:static\s+)?([a-zA-Z_][\w.]*);`
Kotlin: `import <package>.<name>` — regex: `^import\s+([a-zA-Z_][\w.]*)`

**Edge building:**

For each file, extract imports. Map imports to the owning module by matching package prefixes against module source roots. Build `ContractEdge` from consumer → dependency.

**Error types:**

Classes whose name ends in `Exception` or `Error`, or that extend `Exception`/`RuntimeException`/`Throwable`.

**Register in `buildContractContext`** (`packages/verify/src/contract-providers/types.ts`):

```typescript
case "java":
case "kotlin":
  return new JavaContractProvider().build(affectedFiles, profile, workDir, warn)
```

### 3.5 PIT Mutation Testing Provider

**File:** Add `PitestProvider` class in `packages/verify/src/mutation.ts`

```typescript
export class PitestProvider implements MutationTestingProvider {
  readonly language: LanguageId = "java"

  async run(
    workDir: string,
    profile: ToolchainProfile,
    mutateFiles?: string[],
  ): Promise<MutationTestResult> {
    const startMs = Date.now()
    const isGradle = profile.packageManager === "gradle"

    // Derive target classes from mutateFiles or source patterns
    const targetClasses = deriveTargetClasses(mutateFiles, profile)

    if (isGradle) {
      return this.runGradle(workDir, targetClasses, profile, startMs)
    }
    return this.runMaven(workDir, targetClasses, profile, startMs)
  }

  private async runMaven(
    workDir: string,
    targetClasses: string,
    profile: ToolchainProfile,
    startMs: number,
  ): Promise<MutationTestResult> {
    const timeout = profile.mutation?.timeoutMs ?? 600_000
    const args = [
      "org.pitest:pitest-maven:mutationCoverage",
      `-DtargetClasses=${targetClasses}`,
      "-DoutputFormats=XML",
      "-DtimestampedReports=false",
    ]

    try {
      await execFileAsync("mvn", args, { cwd: workDir, maxBuffer: 10 * 1024 * 1024, timeout })
    } catch (err) {
      if (isExecNotFound(err)) {
        throw new BollardError({
          code: "NODE_EXECUTION_FAILED",
          message: "mvn not found — install Maven or use the dev-full image",
        })
      }
      return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
    }

    // Parse PIT XML report
    const reportPath = join(workDir, "target/pit-reports/mutations.xml")
    return this.parseReport(reportPath, startMs)
  }

  private async runGradle(
    workDir: string,
    targetClasses: string,
    profile: ToolchainProfile,
    startMs: number,
  ): Promise<MutationTestResult> {
    const timeout = profile.mutation?.timeoutMs ?? 600_000
    const gradlew = join(workDir, "gradlew")
    const cmd = (await exists(gradlew)) ? "./gradlew" : "gradle"

    try {
      await execFileAsync(cmd, ["pitest", `-DtargetClasses=${targetClasses}`], {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout,
      })
    } catch (err) {
      if (isExecNotFound(err)) {
        throw new BollardError({
          code: "NODE_EXECUTION_FAILED",
          message: "gradle/gradlew not found — ensure Gradle wrapper exists or use dev-full image",
        })
      }
      return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
    }

    const reportPath = join(workDir, "build/reports/pitest/mutations.xml")
    return this.parseReport(reportPath, startMs)
  }
}
```

**PIT XML report parsing:**

PIT's `mutations.xml` format:

```xml
<mutations>
  <mutation detected="true" status="KILLED">
    <sourceFile>Foo.java</sourceFile>
    <mutatedClass>com.example.Foo</mutatedClass>
    <mutatedMethod>getName</mutatedMethod>
    <mutator>org.pitest.mutationtest.engine.gregor.mutators.ReturnValsMutator</mutator>
  </mutation>
  <mutation detected="false" status="SURVIVED">
    ...
  </mutation>
</mutations>
```

Parse with regex (no XML lib — same minimal-dep philosophy):
- Count `status="KILLED"` → killed
- Count `status="SURVIVED"` → survived
- Count `status="NO_COVERAGE"` → noCoverage
- Count `status="TIMED_OUT"` → timeout

**`deriveTargetClasses` helper:**

Converts file paths to Java package-qualified class globs for PIT:
- `src/main/java/com/example/Foo.java` → `com.example.Foo`
- If no specific files, use `*` (all classes matching source patterns)

**Register in `getMutationProvider`:**

```typescript
case "java":
case "kotlin":
  return pitestSingleton
```

**Add to `MutationToolId`:**

```typescript
export type MutationToolId = "stryker" | "mutmut" | "go-mutesting" | "cargo-mutants" | "mutant" | "pitest"
```

### 3.6 JVM Test Output Parser

**File:** Update `packages/verify/src/dynamic.ts` (or wherever test output parsing lives)

Add parsing for JUnit 5 / Maven Surefire / Gradle Test output:

**Maven Surefire output:**
```
Tests run: 42, Failures: 0, Errors: 0, Skipped: 2
```
Regex: `Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)`

**Gradle Test output:**
```
42 tests completed, 2 failed, 1 skipped
```
Regex: `(\d+)\s+tests?\s+completed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?`

### 3.7 Adversarial Test Path Derivation

**File:** `packages/blueprints/src/write-tests-helpers.ts`

Add Java/Kotlin path derivation functions following the existing pattern:

```typescript
// Java boundary: src/main/java/com/example/Foo.java
// → .bollard/tests/boundary/<task-slug>/FooTest.java
function deriveJavaBoundaryPath(sourceFile: string): string {
  const basename = sourceFile.replace(/\.java$/, "").split("/").pop() ?? "Unknown"
  return `${basename}Test.java`
}

// Java contract: → .bollard/tests/contract/<task-slug>/FooContractTest.java
function deriveJavaContractPath(sourceFile: string): string {
  const basename = sourceFile.replace(/\.java$/, "").split("/").pop() ?? "Unknown"
  return `${basename}ContractTest.java`
}

// Java behavioral: → .bollard/tests/behavioral/<task-slug>/FooBehavioralTest.java
function deriveJavaBehavioralPath(sourceFile: string): string {
  const basename = sourceFile.replace(/\.java$/, "").split("/").pop() ?? "Unknown"
  return `${basename}BehavioralTest.java`
}

// Kotlin follows same pattern with .kt extension
function deriveKotlinBoundaryPath(sourceFile: string): string {
  const basename = sourceFile.replace(/\.kt$/, "").split("/").pop() ?? "Unknown"
  return `${basename}Test.kt`
}
```

**Wire into `deriveAdversarialTestPath`:**

```typescript
case "java":
  return scope === "boundary" ? deriveJavaBoundaryPath(sourceFile)
       : scope === "contract" ? deriveJavaContractPath(sourceFile)
       : deriveJavaBehavioralPath(sourceFile)
case "kotlin":
  return scope === "boundary" ? deriveKotlinBoundaryPath(sourceFile)
       : scope === "contract" ? deriveKotlinContractPath(sourceFile)
       : deriveKotlinBehavioralPath(sourceFile)
```

### 3.8 Agent Prompt Templates

Add `{{#if isJava}}` and `{{#if isKotlin}}` conditionals to the five agent prompts:

**`packages/agents/prompts/boundary-tester.md`** — add Java/Kotlin test template section:

```markdown
{{#if isJava}}
Generate JUnit 5 tests. Use:
- `@Test` annotation (from `org.junit.jupiter.api.Test`)
- `assertThrows`, `assertEquals`, `assertNotNull` from `org.junit.jupiter.api.Assertions`
- `@ParameterizedTest` with `@ValueSource` or `@CsvSource` for edge cases
- Package declaration matching the source under test
- Class name ending in `Test`

Do NOT use: JUnit 4 (`@RunWith`, `Assert.*`), Mockito, Spring test annotations.
{{/if}}

{{#if isKotlin}}
Generate JUnit 5 tests in Kotlin. Use:
- `@Test` annotation
- `assertEquals`, `assertThrows` from `org.junit.jupiter.api.Assertions`
- Kotlin-specific: `assertFailsWith<ExceptionType>`, backtick test names
- `@ParameterizedTest` for edge cases

Do NOT use: JUnit 4, Mockito, Spring test annotations.
{{/if}}
```

**`packages/agents/prompts/contract-tester.md`** — add JVM-specific contract testing guidance (Maven/Gradle module boundaries, Java package visibility).

**`packages/agents/prompts/behavioral-tester.md`** — add JVM-specific behavioral patterns (Spring Boot endpoints, servlet containers, JAR main class).

**`packages/agents/prompts/coder.md`** — add JVM build commands and file layout conventions.

**`packages/agents/prompts/planner.md`** — add JVM project structure awareness.

**Register booleans in `fillPromptTemplate`** (`packages/agents/src/prompt-template.ts`):

```typescript
isJava: profile.language === "java",
isKotlin: profile.language === "kotlin",
```

### 3.9 Docker Verify Image

**File:** `docker/Dockerfile.verify-jvm`

```dockerfile
FROM node:22-slim AS base
WORKDIR /bollard
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ packages/
RUN pnpm install --frozen-lockfile
COPY . .

FROM base AS verify-jvm
# Temurin JDK 21
COPY --from=eclipse-temurin:21 /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME="/opt/java/openjdk" PATH="/opt/java/openjdk/bin:${PATH}"
# Maven (for Maven-based projects)
RUN apt-get update && apt-get install -y --no-install-recommends maven && rm -rf /var/lib/apt/lists/*
# Gradle wrapper will self-download; no global gradle needed
ENTRYPOINT ["pnpm", "exec", "tsx"]
CMD ["packages/cli/src/index.ts", "verify"]
```

**Update `compose-generator.ts`:**

```typescript
const DEFAULT_IMAGES: Partial<Record<LanguageId, string>> = {
  typescript: "node:22-slim",
  javascript: "node:22-slim",
  python: "python:3.12-slim",
  go: "golang:1.22",
  rust: "rust:1.77-slim",
  java: "eclipse-temurin:21",     // NEW
  kotlin: "eclipse-temurin:21",   // NEW (shared JVM image)
}
```

### 3.10 Dockerfile Updates

**Main `Dockerfile` — add GraalVM native-image builder stage:**

```dockerfile
# Stage D — Java helper builder (GraalVM native-image)
FROM ghcr.io/graalvm/graalvm-community:21 AS java-helper-builder
WORKDIR /src
COPY scripts/extract_java/pom.xml ./
# Pre-download dependencies
RUN mvn dependency:resolve
COPY scripts/extract_java/src ./src
# Run tests
RUN mvn test
# Build fat JAR
RUN mvn package -DskipTests
# Build native image
RUN native-image \
  --no-server \
  --static \
  -jar target/bollard-extract-java-1.0.0-jar-with-dependencies.jar \
  -o /out/bollard-extract-java \
  --no-fallback \
  -H:+ReportExceptionStackTraces
```

**Dev stage — copy helper:**

```dockerfile
COPY --from=java-helper-builder /out/bollard-extract-java /usr/local/bin/bollard-extract-java
RUN bollard-extract-java --version
```

**Dev-full stage — add JDK:**

```dockerfile
# In the consolidated RUN layer, add:
# Java: Temurin JDK 21 + Maven
COPY --from=eclipse-temurin:21 /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME="/opt/java/openjdk" PATH="/opt/java/openjdk/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends maven \
    && rm -rf /var/lib/apt/lists/* \
    && java -version && mvn --version
```

**Image size impact:**
- `dev`: +30–50 MB (native-image binary only)
- `dev-full`: +~250 MB (JDK 21 ~200 MB + Maven ~50 MB)

### 3.11 Risk Gate: Polyglot Export Change Detection

**File:** `packages/blueprints/src/implement-feature.ts` (where `scanDiffForExportChanges` and `isExportChangeLine` live)

Add Java/Kotlin export-change patterns:

**Java:**
- `public class <Name>` / `public interface <Name>` — class/interface declaration
- `public <ReturnType> <name>(` — public method
- `public static final <Type> <NAME>` — public constant
- `public <Type> <name>` — public field

**Kotlin:**
- `fun <name>(` — public function (default visibility is public)
- `class <Name>` — class declaration
- `interface <Name>` — interface
- `val <name>:` / `var <name>:` — public property
- `object <Name>` — singleton
- Look for `internal` / `private` modifiers to exclude

### 3.12 Prompt Template Booleans

**File:** `packages/agents/src/prompt-template.ts`

Add to the boolean map in `fillPromptTemplate`:

```typescript
const booleans: Record<string, boolean> = {
  isTypeScript: lang === "typescript",
  isPython: lang === "python",
  isGo: lang === "go",
  isRust: lang === "rust",
  isJava: lang === "java",      // NEW
  isKotlin: lang === "kotlin",  // NEW
}
```

---

## 4. Test Plan

### 4.1 Detector Tests

**File:** `packages/detect/tests/detect.test.ts` (extend existing)

**New fixtures:**

```
packages/detect/tests/fixtures/
├── java-maven/
│   ├── pom.xml
│   └── src/main/java/com/example/App.java
├── java-gradle/
│   ├── build.gradle
│   ├── settings.gradle
│   └── src/main/java/com/example/App.java
├── kotlin-gradle/
│   ├── build.gradle.kts
│   ├── settings.gradle.kts
│   └── src/main/kotlin/com/example/App.kt
└── java-kotlin-mixed/
    ├── build.gradle.kts
    ├── src/main/java/com/example/Foo.java
    └── src/main/kotlin/com/example/Bar.kt
```

**Tests (~12):**

1. Maven project detected as `java` + `maven`
2. Gradle project detected as `java` + `gradle`
3. Kotlin-only Gradle detected as `kotlin` + `gradle`
4. Mixed Java/Kotlin detected as `java` + `gradle`
5. Gradle wins over Maven when both present
6. `settings.gradle.kts` alone triggers Gradle detection
7. Correct source/test patterns for Java
8. Correct source/test patterns for Kotlin
9. Allowed commands include `java`, `javac`, and build tool
10. Mutation config defaults to `pitest`
11. Checkstyle detected when `checkstyle.xml` present
12. No detection when no JVM files exist

### 4.2 Extractor Tests

**File:** `packages/verify/tests/type-extractor.test.ts` (extend existing)

**Fixtures:**

```
packages/verify/tests/fixtures/extractors/
├── java/
│   └── Sample.java    # public class, interface, enum, record, methods, fields
├── kotlin/
│   └── Sample.kt      # class, interface, object, data class, fun, val
```

**Tests (~8):**

1. Java: extracts public class and method signatures
2. Java: extracts interface definitions
3. Java: extracts enum declarations
4. Java: filters private/package-private members
5. Java: extracts generic type parameters
6. Kotlin: extracts public functions and classes (regex mode)
7. Kotlin: filters `private` and `internal` declarations
8. Java: returns empty for non-Java files

**Toolchain-gated integration tests** (skip if `bollard-extract-java` not on PATH):

9. Live extraction on fixture files
10. Error handling when helper binary missing

### 4.3 Contract Graph Tests

**File:** `packages/verify/tests/contract-extractor.test.ts` (extend existing)

**Fixtures:**

```
packages/verify/tests/fixtures/contract/
├── java-maven-multi/
│   ├── pom.xml           # <modules>module-a, module-b</modules>
│   ├── module-a/
│   │   ├── pom.xml
│   │   └── src/main/java/com/example/a/ServiceA.java
│   └── module-b/
│       ├── pom.xml
│       └── src/main/java/com/example/b/ServiceB.java  # imports ServiceA
├── java-gradle-multi/
│   ├── settings.gradle
│   ├── module-a/
│   │   ├── build.gradle
│   │   └── src/main/java/...
│   └── module-b/
│       ├── build.gradle
│       └── src/main/java/...
```

**Tests (~8):**

1. Maven multi-module: discovers 2 modules
2. Maven multi-module: builds correct edges from imports
3. Gradle multi-module: discovers subprojects from `settings.gradle`
4. Gradle multi-module: handles `include ':sub:nested'` syntax
5. Single-module project: 1 module, 0 edges
6. Error types: finds classes extending Exception
7. Affected edges: only returns edges touching changed files
8. Import parsing: handles static imports, star imports

### 4.4 Mutation Testing Tests

**File:** `packages/verify/tests/mutation.test.ts` (extend existing)

**Tests (~6):**

1. `parsePitReport` — parses sample PIT XML with KILLED/SURVIVED/NO_COVERAGE/TIMED_OUT
2. `parsePitReport` — handles empty report
3. `deriveTargetClasses` — converts file paths to package-qualified class patterns
4. `PitestProvider` — throws with installation message when `mvn` not found
5. `PitestProvider` — uses `./gradlew` when Gradle project
6. Mutation score calculation from PIT counts

### 4.5 Path Derivation Tests

**File:** `packages/blueprints/tests/write-tests-helpers.test.ts` (extend existing)

**Tests (~6):**

1. Java boundary path: `Foo.java` → `FooTest.java`
2. Java contract path: `Foo.java` → `FooContractTest.java`
3. Java behavioral path: `Foo.java` → `FooBehavioralTest.java`
4. Kotlin boundary path: `Bar.kt` → `BarTest.kt`
5. Kotlin contract path: `Bar.kt` → `BarContractTest.kt`
6. Kotlin behavioral path: `Bar.kt` → `BarBehavioralTest.kt`

### 4.6 Prompt Template Tests

**File:** `packages/agents/tests/prompt-template.test.ts` (extend existing)

**Tests (~4):**

1. `isJava` boolean set for Java profile
2. `isKotlin` boolean set for Kotlin profile
3. `{{#if isJava}}` block rendered for Java, stripped for others
4. JVM allowed commands include `java`, `javac`

### 4.7 Risk Gate Tests

**File:** `packages/blueprints/tests/implement-feature.test.ts` (update existing `scanDiffForExportChanges` tests)

**Tests (~4):**

1. Java: detects `public class` addition
2. Java: detects `public` method signature change
3. Kotlin: detects `fun` addition (default public)
4. Kotlin: ignores `private fun` addition

### 4.8 Compose Generator Tests

**File:** `packages/verify/tests/compose-generator.test.ts` (extend existing)

**Tests (~2):**

1. Java profile generates compose with `eclipse-temurin:21` image
2. Kotlin profile generates compose with `eclipse-temurin:21` image

### 4.9 Test Output Parser Tests

**Tests (~4):**

1. Parse Maven Surefire output format
2. Parse Gradle test output format
3. Handle zero-test output
4. Handle failure output

**Total estimated new tests: ~54**

---

## 5. File Manifest

### New files

| File | Description |
|------|-------------|
| `packages/detect/src/languages/java.ts` | JVM detector (Maven + Gradle) |
| `packages/verify/src/extractors/java.ts` | JavaParserExtractor wrapper |
| `packages/verify/src/contract-providers/java.ts` | JavaContractProvider |
| `scripts/extract_java/pom.xml` | Maven project for JavaParser helper |
| `scripts/extract_java/src/main/java/dev/bollard/extract/Main.java` | CLI entry |
| `scripts/extract_java/src/main/java/dev/bollard/extract/JavaExtractor.java` | AST visitor |
| `scripts/extract_java/src/main/java/dev/bollard/extract/KotlinRegexExtractor.java` | Regex fallback |
| `scripts/extract_java/src/main/java/dev/bollard/extract/BytecodeExtractor.java` | ASM .class reader |
| `scripts/extract_java/src/main/java/dev/bollard/extract/JsonOutput.java` | JSON serializer |
| `scripts/extract_java/src/test/java/dev/bollard/extract/*.java` | Helper tests |
| `docker/Dockerfile.verify-jvm` | JVM verify image |
| `packages/detect/tests/fixtures/java-maven/` | Maven fixture |
| `packages/detect/tests/fixtures/java-gradle/` | Gradle fixture |
| `packages/detect/tests/fixtures/kotlin-gradle/` | Kotlin fixture |
| `packages/detect/tests/fixtures/java-kotlin-mixed/` | Mixed fixture |
| `packages/verify/tests/fixtures/extractors/java/Sample.java` | Extractor fixture |
| `packages/verify/tests/fixtures/extractors/kotlin/Sample.kt` | Extractor fixture |
| `packages/verify/tests/fixtures/contract/java-maven-multi/` | Contract graph fixture |
| `packages/verify/tests/fixtures/contract/java-gradle-multi/` | Contract graph fixture |

### Modified files

| File | Changes |
|------|---------|
| `packages/detect/src/types.ts` | Add `"pitest"` to `MutationToolId` |
| `packages/detect/src/detect.ts` | Import + register `detectJava` |
| `packages/detect/src/derive.ts` | Refine Java/Kotlin patterns (already stubbed) |
| `packages/verify/src/type-extractor.ts` | Add `case "java"` / `case "kotlin"` to `getExtractor` |
| `packages/verify/src/contract-providers/types.ts` | Import + register `JavaContractProvider` |
| `packages/verify/src/mutation.ts` | Add `PitestProvider`, `parsePitReport`, register in `getMutationProvider` |
| `packages/verify/src/compose-generator.ts` | Add `java`/`kotlin` to `DEFAULT_IMAGES` |
| `packages/verify/src/dynamic.ts` | Add JUnit/Surefire/Gradle test output parsing |
| `packages/blueprints/src/write-tests-helpers.ts` | Add Java/Kotlin path derivation |
| `packages/agents/src/prompt-template.ts` | Add `isJava`/`isKotlin` booleans |
| `packages/agents/prompts/boundary-tester.md` | Add `{{#if isJava}}`/`{{#if isKotlin}}` blocks |
| `packages/agents/prompts/contract-tester.md` | Add JVM contract guidance |
| `packages/agents/prompts/behavioral-tester.md` | Add JVM behavioral patterns |
| `packages/agents/prompts/coder.md` | Add JVM build commands |
| `packages/agents/prompts/planner.md` | Add JVM project structure |
| `Dockerfile` | Add `java-helper-builder` stage + COPY to dev + JDK in dev-full |
| `compose.yaml` | Add `verify-jvm` service (if needed) |
| `packages/detect/tests/detect.test.ts` | Add JVM detector tests |
| `packages/verify/tests/type-extractor.test.ts` | Add Java/Kotlin extractor tests |
| `packages/verify/tests/contract-extractor.test.ts` | Add JVM contract graph tests |
| `packages/verify/tests/mutation.test.ts` | Add PIT parser tests |
| `packages/blueprints/tests/write-tests-helpers.test.ts` | Add JVM path derivation tests |
| `packages/agents/tests/prompt-template.test.ts` | Add isJava/isKotlin tests |
| `packages/verify/tests/compose-generator.test.ts` | Add JVM compose tests |

---

## 6. Validation Plan

### 6.1 Build validation

```bash
# Rebuild dev image (includes GraalVM native-image build)
docker compose build dev

# Verify helper binary
docker compose run --rm --entrypoint sh dev -c "bollard-extract-java --version"

# Type check
docker compose run --rm dev run typecheck

# Lint
docker compose run --rm dev run lint

# Full test suite
docker compose run --rm dev run test
```

**Target: 705 + ~54 = ~759 tests passing, 4 skipped.**

### 6.2 Integration validation

```bash
# Detect a real Java/Maven project
docker compose run --rm dev --filter @bollard/cli run start -- verify --profile --work-dir /path/to/java-project

# Detect a real Kotlin/Gradle project
docker compose run --rm dev --filter @bollard/cli run start -- verify --profile --work-dir /path/to/kotlin-project

# Contract graph
docker compose run --rm dev --filter @bollard/cli run start -- contract --work-dir /path/to/java-multi-module
```

### 6.3 End-to-end validation (post-unit-tests)

Run the full 28-node pipeline against a small Java project to validate the complete stack:

```bash
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev-full sh -c \
  'pnpm --filter @bollard/cli run start -- run implement-feature \
    --task "Add a health check endpoint that returns JSON {status: ok, uptime: <seconds>}" \
    --work-dir /path/to/java-spring-boot-project'
```

This requires `dev-full` (JDK needed for compilation, testing, and mutation testing).

---

## 7. Commit Guidance

One commit per logical unit, conventional format:

```
Stage 4c: add MutationToolId "pitest" to detect types
Stage 4c: Java/Kotlin detector (Maven + Gradle)
Stage 4c: JavaParser extractor helper (scripts/extract_java)
Stage 4c: GraalVM native-image builder stage in Dockerfile
Stage 4c: JavaParserExtractor wrapper + getExtractor routing
Stage 4c: JVM contract graph provider (Maven + Gradle multi-module)
Stage 4c: PIT mutation testing provider + XML report parser
Stage 4c: JVM test output parsers (Surefire + Gradle Test)
Stage 4c: Java/Kotlin adversarial test path derivation
Stage 4c: agent prompt templates for Java/Kotlin
Stage 4c: JVM risk gate export-change patterns
Stage 4c: Dockerfile.verify-jvm + compose-generator update
Stage 4c: dev-full JDK 21 + Maven extension
```

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| GraalVM native-image build fails for JavaParser | Medium | High | Fallback: ship as JAR + require JRE in dev image |
| PIT Gradle plugin not present in target projects | Medium | Medium | Detect plugin presence; skip mutation with warning |
| Kotlin regex extractor misses complex declarations | Medium | Low | Acceptable for Wave 1; full kotlinc integration in Wave 2 |
| JDK 21 in dev-full pushes image past 2.5 GB | Low | Low | Temurin is slim; expected ~2.45 GB |
| `settings.gradle.kts` Kotlin DSL parsing edge cases | Medium | Low | Start with `include` directive parsing; complex builds fall back to single-module |

---

## 9. GraalVM Native-Image Fallback

If GraalVM native-image compilation proves problematic (e.g., JavaParser uses reflection that native-image can't trace), the fallback plan is:

1. Ship `bollard-extract-java.jar` (fat JAR) instead of a native binary
2. Add a minimal JRE (Eclipse Temurin JRE 21, ~100MB) to the `dev` image
3. Call via `java -jar /usr/local/bin/bollard-extract-java.jar` instead of direct execution
4. The Node.js wrapper (`JavaParserExtractor`) handles both paths transparently

This increases the `dev` image by ~100 MB but guarantees the extractor works without GraalVM complications.
