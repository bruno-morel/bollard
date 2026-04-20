#!/bin/sh
set -e

git config --global user.email "bollard@example.com"
git config --global user.name "bollard"

mkdir -p /tmp/gradle-test/src/main/java/com/example
mkdir -p /tmp/gradle-test/src/test/java/com/example

cat > /tmp/gradle-test/build.gradle <<'GEOF'
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

cat > /tmp/gradle-test/settings.gradle <<'SEOF'
rootProject.name = "gradle-test"
SEOF

cat > /tmp/gradle-test/src/main/java/com/example/StringUtils.java <<'JEOF'
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

cd /tmp/gradle-test
git init -q && git branch -M main && git add -A && git commit -q -m "init"

echo "=== gradle availability ==="
which gradle && gradle --version | head -3 || echo "WARN: gradle not installed in dev-full"
echo ""

echo "=== verify --profile output ==="
cd /app
pnpm --filter @bollard/cli run start -- verify --profile --work-dir /tmp/gradle-test 2>&1
