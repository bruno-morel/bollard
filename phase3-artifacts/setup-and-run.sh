#!/bin/sh
set -e

git config --global user.email "bollard@example.com"
git config --global user.name "bollard"

SUREFIRE_BLOCK='  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>'

# ---- root POM ----
mkdir -p /tmp/bollard-contract-test
cat > /tmp/bollard-contract-test/pom.xml <<'POMEOF'
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

# ---- core module ----
mkdir -p /tmp/bollard-contract-test/core/src/main/java/com/example/core
mkdir -p /tmp/bollard-contract-test/core/src/test/java/com/example/core
cat > /tmp/bollard-contract-test/core/pom.xml <<POMEOF
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
${SUREFIRE_BLOCK}
</project>
POMEOF

cat > /tmp/bollard-contract-test/core/src/main/java/com/example/core/Calculator.java <<'JEOF'
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

cat > /tmp/bollard-contract-test/core/src/main/java/com/example/core/MathUtils.java <<'JEOF'
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

cat > /tmp/bollard-contract-test/core/src/test/java/com/example/core/CalculatorTest.java <<'TEOF'
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

# ---- api module ----
mkdir -p /tmp/bollard-contract-test/api/src/main/java/com/example/api
mkdir -p /tmp/bollard-contract-test/api/src/test/java/com/example/api
cat > /tmp/bollard-contract-test/api/pom.xml <<POMEOF
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
${SUREFIRE_BLOCK}
</project>
POMEOF

cat > /tmp/bollard-contract-test/api/src/main/java/com/example/api/CalculatorFacade.java <<'JEOF'
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

cat > /tmp/bollard-contract-test/api/src/test/java/com/example/api/CalculatorFacadeTest.java <<'TEOF'
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

# ---- .bollard.yml ----
# Override audit to a no-op: the auto-detected OWASP dependency-check plugin
# is not in this POM, and it would otherwise download the NVD DB and fail.
cat > /tmp/bollard-contract-test/.bollard.yml <<'YEOF'
toolchain:
  checks:
    audit:
      cmd: "true"
      args: []
  extra_commands: ["true"]
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

cd /tmp/bollard-contract-test
git init -q && git branch -M main && git add -A && git commit -q -m "init"

echo "=== mvn test gate ==="
mvn -q test 2>&1 | tail -20
echo "=== end mvn test ==="

echo ""
echo "=== running implement-feature pipeline ==="
cd /app
pnpm --filter @bollard/cli run start -- run implement-feature \
  --task "Add a power(int base, int exponent) method to Calculator in core module. Handle negative exponents by returning 1.0/power(base, -exponent). Throw IllegalArgumentException when base is 0 and exponent is negative. Also add a computePower operation to CalculatorFacade in the api module that delegates to Calculator.power()." \
  --work-dir /tmp/bollard-contract-test 2>&1
echo "=== pipeline exit: $? ==="
