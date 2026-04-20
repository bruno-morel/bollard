# Stage 4c Part 2 — Java/Kotlin Wave 1 — Full Validation Prompt

> Run this prompt in Cursor to complete Stage 4c validation.
>
> **What was already proven (first run, 2026-04-16):**
> - Automated suite: 749 passed / 4 skipped (after Biome import-order fix)
> - Adversarial suite: 331 passed in 30 files
> - Bollard-on-bollard slim run (contract OFF, behavioral OFF, mutation OFF): 28/28 nodes, $0.37, 116s
>
> **What was NOT proven (gaps this prompt fills):**
> - Contract scope against a multi-module Java project (JavaContractProvider never exercised end-to-end)
> - PIT mutation testing against real Java code (PitestProvider never invoked for real)
> - Maven Surefire parser against real `mvn test` output (boundary tests ran through Vitest, not Maven)
> - Gradle detection + Gradle test output parsing
> - Extractor binary on non-trivial code (generics, annotations, interfaces)
> - Phase 1 integration point audit (file-by-file spec check)
> - Behavioral extractor for Java is intentionally unsupported — document this gap
>
> **Spec:** `spec/stage4c-java-kotlin-wave1.md`
> **Output:** `spec/stage4c-validation-results.md`

---

## Phase 0 — Gate (already passed — verify still clean)

Confirm the suite is still green after any changes since the first run:

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
docker compose run --rm dev exec vitest run --config vitest.adversarial.config.ts
```

**Expected:** 749+ passed / 4 skipped, adversarial 331 passed. If anything regressed, fix before continuing.

---

## Phase 1 — Integration Point Audit (13 checkpoints)

For each checkpoint, **read the source file**, verify the implementation matches the spec at `spec/stage4c-java-kotlin-wave1.md`, and record PASS/FAIL with a one-line note. If anything is wrong, fix it and note what you changed.

### 1.1 — Java Detector (`packages/detect/src/languages/java.ts`)

Read the file. Verify:
- [ ] Detects Maven via `pom.xml`
- [ ] Detects Gradle via `build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts`
- [ ] Language discrimination: scans for `.java` / `.kt` files recursively
- [ ] Returns `language: "kotlin"` when ONLY `.kt` files found; `"java"` otherwise (even mixed)
- [ ] Gradle takes precedence over Maven when both exist
- [ ] `checks.typecheck`: Gradle → `compileJava compileKotlin` / Maven → `compile`
- [ ] `checks.lint`: detects `detekt.yml` → Detekt; `checkstyle.xml` → Checkstyle; fallback
- [ ] `checks.test`: Gradle → `./gradlew test` / Maven → `mvn test`
- [ ] `checks.audit`: Gradle dependency-check or Maven OWASP (if plugin present)
- [ ] `mutation.toolId: "pitest"`, `threshold: 60`, `timeout: 600`
- [ ] Source patterns: `**/*.java`, `**/*.kt`, exclude `**/test/**`, `**/build/**`
- [ ] Test patterns: `**/test/**/*.java`, `**/test/**/*.kt`
- [ ] `allowedCommands` includes `java`, `javac`, and the build tool
- [ ] Detector registered in `packages/detect/src/detect.ts` (before fallback)

### 1.2 — Test Fixtures (`packages/detect/tests/fixtures/`)

Verify directories exist with correct content:
- [ ] `java-maven/` — `pom.xml` + `src/main/java/` with `.java` file
- [ ] `java-gradle/` — `build.gradle` + `src/main/java/`
- [ ] `kotlin-gradle/` — `build.gradle.kts` + `src/main/kotlin/` with `.kt`, NO `.java`
- [ ] `java-kotlin-mixed/` — both `.java` and `.kt` in correct directories
- [ ] `java-gradle-with-pom/` — both `build.gradle` and `pom.xml` (test Gradle precedence)

### 1.3 — GraalVM Native Binary

Read `Dockerfile`:
- [ ] Stage C1: Maven 3.9 builds `scripts/extract_java/pom.xml` → JAR
- [ ] Stage C2: GraalVM `native-image-community:21` → native binary
- [ ] Dev stage: copies to `/usr/local/bin/bollard-extract-java`, validates `--version`
- [ ] Dev-full: adds Temurin JDK 21 + Maven 3.9

Read `scripts/extract_java/`:
- [ ] `pom.xml` with JavaParser dependency
- [ ] Source files in `src/main/java/dev/bollard/extract/`
- [ ] Entry point (`Main.java` or equivalent)
- [ ] Handles `--version` flag
- [ ] Handles `--kotlin` flag for Kotlin regex extraction

Verify binary runs:
```bash
docker compose run --rm --entrypoint sh dev -c 'bollard-extract-java --version'
```
- [ ] Prints version without error

### 1.4 — Signature Extractor (`packages/verify/src/extractors/java.ts`)

Read the file:
- [ ] `JavaParserExtractor` implements `SignatureExtractor`
- [ ] Shells out to `bollard-extract-java`
- [ ] Default mode for `.java`, `--kotlin` for `.kt`
- [ ] `--bytecode` path for `.class` files
- [ ] JSON output → `{ filePath, signatures, types }`
- [ ] Path traversal protection
- [ ] Timeout 60s, buffer 8MB
- [ ] Graceful fallback when binary missing

Read `packages/verify/src/type-extractor.ts`:
- [ ] `getExtractor("java")` → `JavaParserExtractor`
- [ ] `getExtractor("kotlin")` → `JavaParserExtractor`

### 1.5 — Contract Graph Provider (`packages/verify/src/contract-providers/java.ts`)

Read the file:
- [ ] `JavaContractProvider` implements `ContractGraphProvider`
- [ ] Maven: parses `<modules>` from `pom.xml`
- [ ] Gradle: parses `include(...)` from `settings.gradle(.kts)`
- [ ] Single-module fallback
- [ ] Source discovery: walks `src/main/java/` and `src/main/kotlin/`
- [ ] Import parsing: Java (`import com.foo.Bar;`) and Kotlin (`import com.foo.Bar`)
- [ ] Edge building via package prefix → module mapping
- [ ] `affectedFiles` filtering support

Read `packages/verify/src/contract-providers/types.ts`:
- [ ] `PROVIDERS` map has `java: new JavaContractProvider("java")`
- [ ] `PROVIDERS` map has `kotlin: new JavaContractProvider("kotlin")`

Verify fixtures:
- [ ] `packages/verify/tests/fixtures/contract/java-maven-multi/` — module-a, module-b with cross-imports
- [ ] `packages/verify/tests/fixtures/contract/java-gradle-multi/` — same

### 1.6 — PIT Mutation Provider (`packages/verify/src/mutation.ts`)

Read the PitestProvider code:
- [ ] Maven: `mvn org.pitest:pitest-maven:mutationCoverage -DtargetClasses=...`
- [ ] Gradle: `./gradlew pitest` (or `gradle pitest`)
- [ ] FQCN derivation: `src/main/java/com/example/Foo.java` → `com.example.Foo`
- [ ] Kotlin: `src/main/kotlin/com/example/Bar.kt` → `com.example.Bar`
- [ ] XML parsing: counts KILLED / SURVIVED / NO_COVERAGE / TIMED_OUT / RUN_ERROR
- [ ] Score: `(killed + timeout) / total * 100`
- [ ] Report paths: Maven `target/pit-reports/*/mutations.xml`, Gradle `build/reports/pitest/*/mutations.xml`
- [ ] `getMutationProvider("java")` → `PitestProvider`
- [ ] `getMutationProvider("kotlin")` → `PitestProvider`

### 1.7 — Test Output Parsing (`packages/verify/src/dynamic.ts`)

Read the `parseSummary` chain:
- [ ] Surefire regex: `Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)`
- [ ] Gradle regex: `(\d+)\s+tests?\s+completed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?`
- [ ] Both integrated in parse chain (after vitest/pytest/go/cargo)
- [ ] ANSI stripping before parsing

### 1.8 — Test Path Derivation (`packages/blueprints/src/write-tests-helpers.ts`)

Read `deriveAdversarialTestPath` for all 6 combos:
- [ ] Java boundary: `Foo.java` → `FooTest.java`
- [ ] Java contract: `Foo.java` → `FooContractTest.java`
- [ ] Java behavioral: `Foo.java` → `FooBehavioralTest.java`
- [ ] Kotlin boundary: `Bar.kt` → `BarTest.kt`
- [ ] Kotlin contract: `Bar.kt` → `BarContractTest.kt`
- [ ] Kotlin behavioral: `Bar.kt` → `BarBehavioralTest.kt`

### 1.9 — Risk Gate (`packages/blueprints/src/implement-feature.ts`)

Read `isExportChangeLine` / `scanDiffForExportChanges`:
- [ ] Java: `+public class`, `+public interface`, `+public enum`, `+public record`, `+public @interface`
- [ ] Java: `+public <return> name(`
- [ ] Java: `+public static final`
- [ ] Kotlin: `+fun name(`, `+class Name`, `+data class Name`
- [ ] Kotlin: `+interface Name`, `+object Name`
- [ ] Kotlin: `+val name:`, `+var name:`
- [ ] Kotlin exclusion: `private` / `internal` lines NOT flagged

### 1.10 — Prompt Conditionals

Read `packages/agents/src/prompt-template.ts`:
- [ ] `isJava: lang === "java"` in conditionVars
- [ ] `isKotlin: lang === "kotlin"` in conditionVars

Read each prompt file — verify `{{#if isJava}}` and `{{#if isKotlin}}` blocks are **non-empty and meaningful**:
- [ ] `prompts/planner.md` — Maven/Gradle project layout
- [ ] `prompts/coder.md` — `mvn`/`./gradlew` usage, `src/main/java` layout
- [ ] `prompts/boundary-tester.md` — JUnit 5 patterns (`@Test`, `assertEquals`, `@ParameterizedTest`), NO JUnit 4
- [ ] `prompts/contract-tester.md` — public API boundaries, `internal` visibility, module rules
- [ ] `prompts/behavioral-tester.md` — Spring Boot/Ktor HTTP client patterns

### 1.11 — Docker Verify Image (`docker/Dockerfile.verify-jvm`)

- [ ] File exists
- [ ] Based on Node 22 + Temurin JDK 21
- [ ] Includes Maven
- [ ] Can run JUnit 5 tests

### 1.12 — Compose Generator (`packages/verify/src/compose-generator.ts`)

- [ ] `DEFAULT_IMAGES.java === "eclipse-temurin:21"`
- [ ] `DEFAULT_IMAGES.kotlin === "eclipse-temurin:21"`
- [ ] `generateBehavioralCompose` handles Java: Spring Boot `bootRun` (Gradle) / `spring-boot:run` (Maven)
- [ ] Fallback start command when no Spring Boot detected

### 1.13 — Type Definitions (`packages/detect/src/types.ts`)

- [ ] `MutationToolId` includes `"pitest"`
- [ ] `LanguageId` includes `"java"` and `"kotlin"`
- [ ] `PackageManagerId` includes `"gradle"` and `"maven"`

---

## Phase 2 — Cross-Cutting Round-Trip Tests

These tests create real (temp) Java projects inside Docker and verify the CLI commands produce correct output end-to-end.

### 2.1 — Maven Profile Detection

```bash
docker compose run --rm --entrypoint sh dev -c '
  mkdir -p /tmp/java-test/src/main/java/com/example
  cat > /tmp/java-test/pom.xml << "EOF"
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>1.0.0</version>
</project>
EOF
  cat > /tmp/java-test/src/main/java/com/example/Hello.java << "EOF"
package com.example;
public class Hello {
    public String greet(String name) { return "Hello, " + name; }
}
EOF
  pnpm --filter @bollard/cli run start -- verify --profile --work-dir /tmp/java-test
'
```

Verify output:
- [ ] `language: "java"`, `packageManager: "maven"`
- [ ] `mutation.toolId: "pitest"`
- [ ] `checks.test.cmd` uses `mvn`

### 2.2 — Multi-Module Contract Graph

```bash
docker compose run --rm --entrypoint sh dev -c '
  mkdir -p /tmp/java-multi/module-a/src/main/java/com/a
  mkdir -p /tmp/java-multi/module-b/src/main/java/com/b
  cat > /tmp/java-multi/pom.xml << "EOF"
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>parent</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <modules>
    <module>module-a</module>
    <module>module-b</module>
  </modules>
</project>
EOF
  cat > /tmp/java-multi/module-a/pom.xml << "EOF"
<project>
  <parent><groupId>com.example</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent>
  <artifactId>module-a</artifactId>
</project>
EOF
  cat > /tmp/java-multi/module-b/pom.xml << "EOF"
<project>
  <parent><groupId>com.example</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent>
  <artifactId>module-b</artifactId>
</project>
EOF
  cat > /tmp/java-multi/module-a/src/main/java/com/a/Service.java << "EOF"
package com.a;
public class Service {
    public String run() { return "ok"; }
}
EOF
  cat > /tmp/java-multi/module-b/src/main/java/com/b/Client.java << "EOF"
package com.b;
import com.a.Service;
public class Client {
    private final Service svc = new Service();
    public String call() { return svc.run(); }
}
EOF
  pnpm --filter @bollard/cli run start -- contract --work-dir /tmp/java-multi
'
```

Verify:
- [ ] 2 modules discovered (module-a, module-b)
- [ ] Edge: module-b → module-a (from `import com.a.Service`)
- [ ] Public exports listed for both modules

### 2.3 — Extractor Binary on Non-Trivial Code

```bash
docker compose run --rm --entrypoint sh dev -c '
  mkdir -p /tmp/ext-test/src/main/java/com/example
  cat > /tmp/ext-test/src/main/java/com/example/Repository.java << "EOF"
package com.example;

import java.util.List;
import java.util.Optional;

public interface Repository<T, ID> {
    Optional<T> findById(ID id);
    List<T> findAll();
    T save(T entity);
    void deleteById(ID id);
}
EOF
  cat > /tmp/ext-test/src/main/java/com/example/UserService.java << "EOF"
package com.example;

import java.util.List;
import java.util.Optional;

public class UserService {
    private final Repository<User, Long> repo;

    public UserService(Repository<User, Long> repo) {
        this.repo = repo;
    }

    public Optional<User> getUser(long id) {
        return repo.findById(id);
    }

    public List<User> listUsers() {
        return repo.findAll();
    }

    @Deprecated
    public User legacyGet(long id) {
        return getUser(id).orElse(null);
    }

    private void internalMethod() { /* not exposed */ }
}
EOF
  cat > /tmp/ext-test/src/main/java/com/example/User.java << "EOF"
package com.example;

public record User(long id, String name, String email) {
    public User {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("Name required");
        }
    }
}
EOF
  bollard-extract-java /tmp/ext-test/src/main/java/com/example/Repository.java \
    /tmp/ext-test/src/main/java/com/example/UserService.java \
    /tmp/ext-test/src/main/java/com/example/User.java
'
```

Verify:
- [ ] Generic interface `Repository<T, ID>` signatures extracted (with type params)
- [ ] `UserService` constructor + public methods extracted
- [ ] `@Deprecated` annotation preserved or noted
- [ ] `internalMethod()` NOT in output (private)
- [ ] `User` record with compact constructor extracted
- [ ] `record` type recognized

### 2.4 — Kotlin-Only Detection

```bash
docker compose run --rm --entrypoint sh dev -c '
  mkdir -p /tmp/kt-test/src/main/kotlin/com/example
  cat > /tmp/kt-test/build.gradle.kts << "EOF"
plugins { kotlin("jvm") version "1.9.0" }
EOF
  cat > /tmp/kt-test/src/main/kotlin/com/example/Greeter.kt << "EOF"
package com.example
fun greet(name: String): String = "Hello, $name"
data class User(val name: String, val age: Int)
EOF
  pnpm --filter @bollard/cli run start -- verify --profile --work-dir /tmp/kt-test
'
```

Verify:
- [ ] `language: "kotlin"` (not "java")
- [ ] `packageManager: "gradle"`
- [ ] Source patterns include `**/*.kt`

### 2.5 — Gradle-with-Maven Precedence

```bash
docker compose run --rm --entrypoint sh dev -c '
  mkdir -p /tmp/both-test/src/main/java/com/example
  cat > /tmp/both-test/build.gradle << "EOF"
apply plugin: "java"
EOF
  cat > /tmp/both-test/pom.xml << "EOF"
<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>y</artifactId><version>1</version></project>
EOF
  cat > /tmp/both-test/src/main/java/com/example/X.java << "EOF"
package com.example;
public class X {}
EOF
  pnpm --filter @bollard/cli run start -- verify --profile --work-dir /tmp/both-test
'
```

Verify:
- [ ] `packageManager: "gradle"` (Gradle wins over Maven)

### 2.6 — Empty Project (no crash)

```bash
docker compose run --rm --entrypoint sh dev -c '
  mkdir -p /tmp/empty-java
  echo "<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>y</artifactId><version>1</version></project>" > /tmp/empty-java/pom.xml
  pnpm --filter @bollard/cli run start -- verify --profile --work-dir /tmp/empty-java
'
```

Verify:
- [ ] Detects as Java/Maven
- [ ] Does NOT crash on empty source directories

---

## Phase 3 — Bollard-on-Bollard: Contract Scope (the critical gap)

This is the main missing piece. The first run had contract OFF. Now we run with contract ON against a multi-module Maven project with cross-module imports.

### 3.1 — Create a Multi-Module Maven Project with Tests

```bash
docker compose --profile full build dev-full

docker compose --profile full run --rm dev-full sh -c '
  # --- Root POM ---
  mkdir -p /tmp/bollard-contract-test
  cat > /tmp/bollard-contract-test/pom.xml << "POMEOF"
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>calculator-suite</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <modules>
    <module>core</module>
    <module>api</module>
  </modules>
</project>
POMEOF

  # --- Core module (math logic) ---
  mkdir -p /tmp/bollard-contract-test/core/src/main/java/com/example/core
  mkdir -p /tmp/bollard-contract-test/core/src/test/java/com/example/core
  cat > /tmp/bollard-contract-test/core/pom.xml << "POMEOF"
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>calculator-suite</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>core</artifactId>
  <properties>
    <maven.compiler.source>21</maven.compiler.source>
    <maven.compiler.target>21</maven.compiler.target>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
POMEOF

  cat > /tmp/bollard-contract-test/core/src/main/java/com/example/core/Calculator.java << "JEOF"
package com.example.core;

public class Calculator {
    public int add(int a, int b) { return a + b; }
    public int multiply(int a, int b) { return a * b; }

    public double divide(double a, double b) {
        if (b == 0) throw new ArithmeticException("Division by zero");
        return a / b;
    }
}
JEOF

  cat > /tmp/bollard-contract-test/core/src/main/java/com/example/core/MathUtils.java << "JEOF"
package com.example.core;

public final class MathUtils {
    private MathUtils() {}

    public static int factorial(int n) {
        if (n < 0) throw new IllegalArgumentException("Negative input");
        int result = 1;
        for (int i = 2; i <= n; i++) result *= i;
        return result;
    }

    public static boolean isPrime(int n) {
        if (n < 2) return false;
        for (int i = 2; i * i <= n; i++) {
            if (n % i == 0) return false;
        }
        return true;
    }
}
JEOF

  cat > /tmp/bollard-contract-test/core/src/test/java/com/example/core/CalculatorTest.java << "TEOF"
package com.example.core;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CalculatorTest {
    private final Calculator calc = new Calculator();

    @Test void addPositive() { assertEquals(5, calc.add(2, 3)); }
    @Test void multiplyByZero() { assertEquals(0, calc.multiply(7, 0)); }
    @Test void divideByZero() { assertThrows(ArithmeticException.class, () -> calc.divide(1, 0)); }
}
TEOF

  # --- API module (depends on core) ---
  mkdir -p /tmp/bollard-contract-test/api/src/main/java/com/example/api
  mkdir -p /tmp/bollard-contract-test/api/src/test/java/com/example/api
  cat > /tmp/bollard-contract-test/api/pom.xml << "POMEOF"
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>calculator-suite</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>api</artifactId>
  <properties>
    <maven.compiler.source>21</maven.compiler.source>
    <maven.compiler.target>21</maven.compiler.target>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>core</artifactId>
      <version>1.0.0</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
POMEOF

  cat > /tmp/bollard-contract-test/api/src/main/java/com/example/api/CalculatorFacade.java << "JEOF"
package com.example.api;

import com.example.core.Calculator;
import com.example.core.MathUtils;

public class CalculatorFacade {
    private final Calculator calc = new Calculator();

    public int compute(String op, int a, int b) {
        return switch (op) {
            case "add" -> calc.add(a, b);
            case "multiply" -> calc.multiply(a, b);
            case "factorial" -> MathUtils.factorial(a);
            default -> throw new UnsupportedOperationException("Unknown: " + op);
        };
    }

    public boolean checkPrime(int n) {
        return MathUtils.isPrime(n);
    }
}
JEOF

  cat > /tmp/bollard-contract-test/api/src/test/java/com/example/api/CalculatorFacadeTest.java << "TEOF"
package com.example.api;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CalculatorFacadeTest {
    private final CalculatorFacade facade = new CalculatorFacade();

    @Test void computeAdd() { assertEquals(7, facade.compute("add", 3, 4)); }
    @Test void computeFactorial() { assertEquals(120, facade.compute("factorial", 5, 0)); }
    @Test void checkPrime() { assertTrue(facade.checkPrime(7)); }
}
TEOF

  # Initialize git (needed for bollard pipeline)
  cd /tmp/bollard-contract-test && git init && git branch -M main && git add -A && git commit -m "init"

  # Verify: compile + test both modules
  mvn test
'
```

**Gate:** Must show `Tests run: 6, Failures: 0` (3 per module). Fix if not.

### 3.2 — Create `.bollard.yml` with All Scopes Enabled

```bash
docker compose --profile full run --rm dev-full sh -c '
  cat > /tmp/bollard-contract-test/.bollard.yml << "YEOF"
adversarial:
  boundary:
    enabled: true
    lifecycle: ephemeral
  contract:
    enabled: true
    lifecycle: ephemeral
  behavioral:
    enabled: true
    lifecycle: ephemeral
mutation:
  enabled: true
  threshold: 50
YEOF
  cd /tmp/bollard-contract-test && git add .bollard.yml && git commit -m "add bollard config"
'
```

**Note on behavioral:** Behavioral is enabled in config but `buildBehavioralContext` does NOT support Java — it will return an empty context, and the behavioral nodes will short-circuit with `BEHAVIORAL_CONTEXT_EMPTY`. This is expected and should be documented as a known gap.

### 3.3 — Run Full Pipeline (Contract + Mutation ON)

```bash
docker compose --profile full run --rm -e BOLLARD_AUTO_APPROVE=1 dev-full sh -c '
  pnpm --filter @bollard/cli run start -- run implement-feature \
    --task "Add a power(int base, int exponent) method to Calculator in core module. Handle negative exponents by returning 1.0/power(base, -exponent). Throw IllegalArgumentException when base is 0 and exponent is negative. Also add a computePower operation to CalculatorFacade in the api module that delegates to Calculator.power()." \
    --work-dir /tmp/bollard-contract-test
'
```

### 3.4 — What to Check (Critical)

After the pipeline run, verify each of these. **These are the gaps from the first run.**

**Detection + Profile:**
- [ ] Language detected as `java`, package manager `maven`
- [ ] `mutation.toolId` is `pitest`

**Signature Extraction (node: extract-signatures):**
- [ ] `bollard-extract-java` was invoked (check logs)
- [ ] Signatures extracted for Calculator, MathUtils, CalculatorFacade
- [ ] Generic types and annotations handled (if any)

**Contract Graph (node: extract-contracts):**
- [ ] `buildContractContext` returned a non-empty graph
- [ ] 2 modules: core, api
- [ ] Edge: api → core (via `import com.example.core.*`)
- [ ] Public exports listed per module

**Contract Test Generation (node: generate-contract-tests):**
- [ ] Contract-tester agent produced JUnit 5 test code (NOT Vitest)
- [ ] Tests exercise cross-module contracts (api calling core)
- [ ] Claims document has grounded claims

**Claim Grounding (node: verify-claim-grounding):**
- [ ] `contract_grounding_result` log event present
- [ ] proposed > 0, grounded > 0, dropRate < 100%

**Boundary Tests (node: generate-tests):**
- [ ] Boundary-tester produced JUnit 5 code
- [ ] Uses `@Test`, `assertEquals`, `assertThrows` (not `it()` or `expect()`)

**Test Execution (node: run-tests):**
- [ ] Maven Surefire output parsed correctly (if tests ran via `mvn test`)
- [ ] OR Vitest output parsed correctly (if tests ran via `.bollard/` path)
- [ ] Pass count > 0, no false failures from parser mismatch

**Risk Gate (node: assess-contract-risk):**
- [ ] `contract_scope_decision` log event present
- [ ] If the coder added `public` methods, risk gate should have flagged export changes

**Behavioral (node: extract-behavioral-context):**
- [ ] Expected: skipped with empty context (Java not supported)
- [ ] Check log for `"not supported"` warning — this is correct behavior
- [ ] Downstream behavioral nodes (17-20) short-circuited cleanly

**Mutation (node: run-mutation-testing):**
- [ ] If PIT ran: `PitestProvider` invoked `mvn org.pitest:pitest-maven:mutationCoverage`
- [ ] If PIT was skipped: document why (PIT Maven plugin not in pom.xml? → expected without `<plugin>` in pom)
- [ ] **NOTE:** PIT requires the `pitest-maven` plugin in the project POM to run. If the project doesn't have it, mutation testing will fail. This is expected — document as "PIT requires plugin in target project POM."

**Information Barrier:**
- [ ] Neither boundary-tester nor contract-tester referenced Bollard internals (e.g., `BollardError`, `PipelineContext`, `executeAgent`)

**Summary Metrics:**
- [ ] Nodes passed: /28
- [ ] Cost (USD)
- [ ] Duration (s)
- [ ] Coder turns: /60

### 3.5 — Common Failure Modes

1. **`extract-signatures` fails:** `bollard-extract-java` not in PATH → check Dockerfile dev-full copies binary
2. **`generate-tests` produces Vitest/Python:** Profile not threaded → `ctx.toolchainProfile.language` must be `"java"`
3. **`run-tests` fails to parse:** Surefire output format mismatch → check regex + ANSI stripping
4. **`static-checks` fails on lint:** No `checkstyle.xml` → detector should handle gracefully (skip or use `mvn verify`)
5. **Contract tester produces empty output:** Contract graph was empty → check `buildContractContext` logs
6. **Mutation fails with "plugin not found":** PIT plugin not in pom.xml → expected, document as known limitation
7. **`docker-verify` skipped:** Docker not available inside dev-full → expected, record `skipped: true`

---

## Phase 4 — Gradle Variant (required for full validation)

The first run and Phase 3 both used Maven. Gradle is an equally important path.

### 4.1 — Create a Gradle Project

```bash
docker compose --profile full run --rm dev-full sh -c '
  mkdir -p /tmp/gradle-test/src/main/java/com/example
  mkdir -p /tmp/gradle-test/src/test/java/com/example

  cat > /tmp/gradle-test/build.gradle << "GEOF"
plugins {
    id "java"
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

repositories {
    mavenCentral()
}

dependencies {
    testImplementation "org.junit.jupiter:junit-jupiter:5.10.2"
}

test {
    useJUnitPlatform()
}
GEOF

  cat > /tmp/gradle-test/settings.gradle << "SEOF"
rootProject.name = "gradle-test"
SEOF

  cat > /tmp/gradle-test/src/main/java/com/example/StringUtils.java << "JEOF"
package com.example;

public final class StringUtils {
    private StringUtils() {}

    public static String reverse(String s) {
        if (s == null) throw new NullPointerException("Input null");
        return new StringBuilder(s).reverse().toString();
    }

    public static boolean isPalindrome(String s) {
        String clean = s.toLowerCase().replaceAll("[^a-z0-9]", "");
        return clean.contentEquals(new StringBuilder(clean).reverse());
    }
}
JEOF

  cat > /tmp/gradle-test/src/test/java/com/example/StringUtilsTest.java << "TEOF"
package com.example;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class StringUtilsTest {
    @Test void reverseHello() { assertEquals("olleH", StringUtils.reverse("Hello")); }
    @Test void reverseNull() { assertThrows(NullPointerException.class, () -> StringUtils.reverse(null)); }
    @Test void palindrome() { assertTrue(StringUtils.isPalindrome("racecar")); }
}
TEOF

  cd /tmp/gradle-test && git init && git branch -M main && git add -A && git commit -m "init"

  # Check if gradle is available, test the project
  which gradle && gradle test || echo "WARN: gradle not in dev-full — skip live test, verify detection only"
'
```

### 4.2 — Verify Detection

```bash
docker compose --profile full run --rm dev-full sh -c '
  pnpm --filter @bollard/cli run start -- verify --profile --work-dir /tmp/gradle-test
'
```

Verify:
- [ ] `language: "java"`, `packageManager: "gradle"`
- [ ] `checks.test` uses `gradle test` (not `mvn test`)
- [ ] `checks.typecheck` uses `gradle compileJava`

### 4.3 — Run Pipeline Against Gradle Project (if Gradle available)

```bash
docker compose --profile full run --rm -e BOLLARD_AUTO_APPROVE=1 dev-full sh -c '
  pnpm --filter @bollard/cli run start -- run implement-feature \
    --task "Add a capitalize(String s) method to StringUtils that uppercases the first letter. Throw NullPointerException if null. Return empty string if empty." \
    --work-dir /tmp/gradle-test
'
```

Verify:
- [ ] Pipeline uses `gradle` commands, not `mvn`
- [ ] Test output parsed with Gradle regex (not Surefire)
- [ ] OR: If Gradle is NOT in dev-full, record as **deferred** — detection verified, live pipeline deferred

**NOTE:** If Gradle is not installed in `dev-full`, the detection verification (4.2) is still valid and valuable. The live pipeline run is deferred but the unit tests cover Gradle parsing/detection.

---

## Phase 5 — Document Known Gaps

Before writing the validation results, explicitly document these **known and accepted gaps**:

1. **Behavioral scope for Java:** `buildBehavioralContext` does NOT support Java. Spring Boot endpoint extraction (`@RestController`, `@GetMapping`) is not implemented. The compose-generator has Spring Boot start commands ready (`bootRun`, `spring-boot:run`), but the context extractor will always return empty for Java. **This is a future enhancement, not a bug.** Document in validation results.

2. **PIT requires plugin in target project:** `PitestProvider` invokes `mvn org.pitest:pitest-maven:mutationCoverage`, but this only works if the target project's `pom.xml` includes the pitest-maven plugin. Bollard does NOT inject the plugin — the project must already have it. Without it, mutation testing fails gracefully. **This is by design** (Bollard doesn't modify project build files).

3. **Kotlin extraction is regex-based:** `bollard-extract-java --kotlin` uses regex, not a Kotlin compiler. Complex Kotlin patterns (extension functions with receivers, inline classes, sealed hierarchies) may be incomplete. **Wave 1 acknowledged this in the spec.**

4. **Gradle live pipeline:** If `dev-full` doesn't include Gradle, the Gradle path is validated at the detection + unit test level only, not end-to-end.

5. **`docker-verify` inside dev-full:** Docker-in-Docker is unavailable inside the dev-full container, so the `docker-verify` node always skips. This is consistent with all previous bollard-on-bollard runs.

---

## Phase 6 — Write Validation Results

Create `spec/stage4c-validation-results.md`:

```markdown
# Stage 4c validation — Java/Kotlin Wave 1

**Date:** YYYY-MM-DD
**Status:** GREEN / YELLOW / RED

## Automated suite

| Check | Result |
|-------|--------|
| `docker compose run --rm dev run typecheck` | Pass |
| `docker compose run --rm dev run lint` | Pass |
| `docker compose run --rm dev run test` | 749 passed, 4 skipped |
| Adversarial suite | 331 passed in 30 files |

## Integration point audit (Phase 1)

| # | Checkpoint | Status | Notes |
|---|------------|--------|-------|
| 1.1 | Java detector | | |
| 1.2 | Test fixtures | | |
| 1.3 | GraalVM binary | | |
| 1.4 | Signature extractor | | |
| 1.5 | Contract graph provider | | |
| 1.6 | PIT mutation provider | | |
| 1.7 | Test output parsing | | |
| 1.8 | Test path derivation | | |
| 1.9 | Risk gate patterns | | |
| 1.10 | Prompt conditionals | | |
| 1.11 | Docker verify image | | |
| 1.12 | Compose generator | | |
| 1.13 | Type definitions | | |

## Cross-cutting verification (Phase 2)

| # | Check | Status | Notes |
|---|-------|--------|-------|
| 2.1 | Maven profile detection | | |
| 2.2 | Multi-module contract graph | | |
| 2.3 | Extractor on non-trivial code | | |
| 2.4 | Kotlin-only detection | | |
| 2.5 | Gradle-with-Maven precedence | | |
| 2.6 | Empty project (no crash) | | |

## Bollard-on-bollard — Run 1: Slim (contract/behavioral/mutation OFF)

| Metric | Value |
|--------|-------|
| Nodes passed | 28/28 |
| Language detected | java |
| Package manager | maven |
| Cost (USD) | $0.37 |
| Duration (s) | 116 |
| docker-verify | skipped (Docker unavailable) |

## Bollard-on-bollard — Run 2: Full (contract ON, mutation ON)

| Metric | Value |
|--------|-------|
| Nodes passed | /28 |
| Language detected | |
| Signatures extracted | yes/no |
| Contract graph | modules / edges |
| Contract claims | proposed / grounded / dropped |
| JUnit 5 boundary tests | yes/no |
| JUnit 5 contract tests | yes/no |
| Surefire parsed | yes/no |
| Risk gate fired | yes/no |
| Behavioral scope | skipped (Java not supported — expected) |
| PIT mutation | ran/skipped (reason) |
| Information barrier | clean/LEAKED |
| Cost (USD) | |
| Duration (s) | |
| Coder turns | /60 |

## Gradle variant (Phase 4)

| Metric | Value |
|--------|-------|
| Detection correct | yes/no |
| Package manager | gradle |
| Live pipeline | ran/deferred (reason) |

## Delivered

- Java/Kotlin detector (`packages/detect/src/languages/java.ts`) — Maven + Gradle, language discrimination
- GraalVM native binary (`bollard-extract-java`) — JavaParser-based, zero JRE in dev image
- `JavaParserExtractor` (`packages/verify/src/extractors/java.ts`) — .java AST, .kt regex, .class bytecode
- `JavaContractProvider` (`packages/verify/src/contract-providers/java.ts`) — Maven/Gradle multi-module
- `PitestProvider` (`packages/verify/src/mutation.ts`) — PIT integration for Java/Kotlin
- Surefire + Gradle test output parsers (`packages/verify/src/dynamic.ts`)
- JUnit 5 adversarial test path derivation (all 3 scopes × 2 languages)
- Java/Kotlin export change detection in risk gate
- `isJava` / `isKotlin` prompt template conditionals (all 5 agent prompts)
- `docker/Dockerfile.verify-jvm` — Node 22 + Temurin 21 + Maven
- `eclipse-temurin:21` in compose generator for java/kotlin
- `MutationToolId` includes `"pitest"`

## Known gaps (documented, not bugs)

1. **Behavioral scope for Java** — `buildBehavioralContext` does not support Java. Spring Boot endpoint/config extraction is not implemented. Compose generator has Spring Boot start commands ready for when extraction is added. Future enhancement.
2. **PIT requires plugin in target project** — Bollard does not inject `pitest-maven` into pom.xml. Target projects must include the plugin for mutation testing to work.
3. **Kotlin extraction is regex-based** — Complex patterns (extension receivers, inline classes, sealed hierarchies) may be incomplete.
4. **docker-verify always skips in dev-full** — Docker-in-Docker unavailable. Consistent with all prior bollard-on-bollard runs.
5. **Gradle live pipeline** — Deferred if Gradle not in dev-full; detection and unit tests validated.

## Issues found during validation

- (List issues and fixes applied during validation)

## Post-validation

- [ ] Commit validation results
- [ ] Update CLAUDE.md test counts if changed
- [ ] Update spec/ROADMAP.md — mark Stage 4c Part 2 validated with date
```

---

## Phase 7 — Post-Validation Cleanup

After writing validation results:

1. **Commit:**
   ```
   git add spec/stage4c-validation-results.md
   git commit -m "Stage 4c: Java/Kotlin Wave 1 validation results"
   ```

2. **Update CLAUDE.md** if any test counts changed during validation.

3. **Update `spec/ROADMAP.md`** — mark Stage 4c Part 2 validated.

4. **Optional tag:**
   ```
   git tag -a stage-4c-green -m "Stage 4c Part 2 (Java/Kotlin Wave 1) validated GREEN"
   ```

---

## Summary Checklist

| Phase | Description | Gap Filled | Status |
|-------|-------------|------------|--------|
| 0 | Re-confirm automated suite | baseline | |
| 1 | 13 integration point file audits | never done | |
| 2 | 6 cross-cutting round-trip tests | partially done | |
| 3 | Bollard-on-bollard: contract ON + mutation ON | **critical gap** | |
| 4 | Gradle variant | never tested | |
| 5 | Document known gaps | missing | |
| 6 | Write `stage4c-validation-results.md` | missing | |
| 7 | Post-validation cleanup | missing | |
