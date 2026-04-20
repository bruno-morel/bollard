import type { Dirent } from "node:fs"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  deriveAllowedCommands,
  deriveIgnorePatterns,
  deriveSourcePatterns,
  deriveTestPatterns,
} from "../derive.js"
import type {
  MutationToolId,
  PackageManagerId,
  ToolchainProfile,
  VerificationCommand,
} from "../types.js"

const SKIP_DIRS = new Set(["build", "target", ".gradle", "node_modules", ".git", "out"])

/** Read a file if present; return empty string on any error so callers can just substring-match. */
async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8")
  } catch {
    return ""
  }
}

/**
 * OWASP dependency-check isn't applied transitively in Maven/Gradle — it has to be declared
 * explicitly in the target build file. Emitting the command unconditionally fails on the
 * common case (no plugin), so we only surface the audit check when we can see the plugin.
 */
function hasOwaspMavenPlugin(pomContent: string): boolean {
  return (
    pomContent.includes("dependency-check-maven") ||
    /org\.owasp(\.dependencycheck)?/.test(pomContent)
  )
}

function hasOwaspGradlePlugin(buildContent: string): boolean {
  return (
    buildContent.includes("org.owasp.dependencycheck") || buildContent.includes("dependencyCheck")
  )
}

/** Walk up to `maxDepth` directory levels looking for .java / .kt files (no glob lib). */
async function hasSourceFiles(
  cwd: string,
  ext: ".java" | ".kt",
  maxDepth: number,
  depth = 0,
): Promise<boolean> {
  if (depth > maxDepth) return false
  let entries: Dirent[]
  try {
    entries = (await readdir(cwd, { withFileTypes: true })) as Dirent[]
  } catch {
    return false
  }
  for (const e of entries) {
    const p = join(cwd, e.name)
    if (e.isFile() && e.name.endsWith(ext)) return true
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
      if (await hasSourceFiles(p, ext, maxDepth, depth + 1)) return true
    }
  }
  return false
}

function detectLintGradle(cwd: string, gradleCmd: string): VerificationCommand {
  if (existsSync(join(cwd, "detekt.yml")) || existsSync(join(cwd, "detekt.yaml"))) {
    return {
      label: "detekt",
      cmd: gradleCmd,
      args: ["detekt"],
      source: "auto-detected",
    }
  }
  if (existsSync(join(cwd, "checkstyle.xml"))) {
    return {
      label: "checkstyle",
      cmd: gradleCmd,
      args: ["checkstyleMain"],
      source: "auto-detected",
    }
  }
  return {
    label: "gradle check",
    cmd: gradleCmd,
    args: ["check"],
    source: "auto-detected",
  }
}

function detectLintMaven(cwd: string): VerificationCommand {
  if (existsSync(join(cwd, "checkstyle.xml"))) {
    return {
      label: "checkstyle",
      cmd: "mvn",
      args: ["checkstyle:check"],
      source: "auto-detected",
    }
  }
  return {
    label: "maven verify",
    cmd: "mvn",
    args: ["verify", "-DskipTests"],
    source: "auto-detected",
  }
}

export async function detect(cwd: string): Promise<Partial<ToolchainProfile> | null> {
  const hasGradleBuild =
    existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"))
  const hasGradleSettings =
    existsSync(join(cwd, "settings.gradle")) || existsSync(join(cwd, "settings.gradle.kts"))
  const hasMaven = existsSync(join(cwd, "pom.xml"))

  if (!hasGradleBuild && !hasGradleSettings && !hasMaven) return null

  const isGradle = hasGradleBuild || hasGradleSettings
  const pkgMgr: PackageManagerId = isGradle ? "gradle" : "maven"

  /** Deep enough for `src/main/kotlin/com/example/Foo.kt` (directory depth, not file walk budget). */
  const srcDepth = 12
  const hasKt = await hasSourceFiles(cwd, ".kt", srcDepth)
  const hasJava = await hasSourceFiles(cwd, ".java", srcDepth)
  const language = hasKt && !hasJava ? "kotlin" : "java"

  let checks: ToolchainProfile["checks"]

  if (isGradle) {
    const gradlew = existsSync(join(cwd, "gradlew"))
    const gradleCmd = gradlew ? "./gradlew" : "gradle"
    const compileArgs = hasKt ? ["compileJava", "compileKotlin"] : ["compileJava"]
    const typecheck: VerificationCommand = {
      label: "gradle compile",
      cmd: gradleCmd,
      args: compileArgs,
      source: "auto-detected",
    }
    const lint = detectLintGradle(cwd, gradleCmd)
    const test: VerificationCommand = {
      label: "gradle test",
      cmd: gradleCmd,
      args: ["test"],
      source: "auto-detected",
    }
    const gradleBuild = `${await readIfExists(join(cwd, "build.gradle"))}\n${await readIfExists(
      join(cwd, "build.gradle.kts"),
    )}`
    checks = hasOwaspGradlePlugin(gradleBuild)
      ? {
          typecheck,
          lint,
          test,
          audit: {
            label: "gradle dependencyCheckAnalyze",
            cmd: gradleCmd,
            args: ["dependencyCheckAnalyze"],
            source: "auto-detected",
          },
        }
      : { typecheck, lint, test }
  } else {
    const typecheck: VerificationCommand = {
      label: "maven compile",
      cmd: "mvn",
      args: ["compile", "-q"],
      source: "auto-detected",
    }
    const lint = detectLintMaven(cwd)
    const test: VerificationCommand = {
      label: "maven test",
      cmd: "mvn",
      args: ["test"],
      source: "auto-detected",
    }
    const pomContent = await readIfExists(join(cwd, "pom.xml"))
    checks = hasOwaspMavenPlugin(pomContent)
      ? {
          typecheck,
          lint,
          test,
          audit: {
            label: "OWASP dependency-check",
            cmd: "mvn",
            args: ["org.owasp:dependency-check-maven:check"],
            source: "auto-detected",
          },
        }
      : { typecheck, lint, test }
  }

  const allowedCommands = deriveAllowedCommands(language, pkgMgr)

  return {
    language,
    packageManager: pkgMgr,
    checks,
    sourcePatterns: deriveSourcePatterns(language),
    testPatterns: deriveTestPatterns(language),
    ignorePatterns: deriveIgnorePatterns(language),
    allowedCommands,
    mutation: {
      enabled: true,
      tool: "pitest" as MutationToolId,
      threshold: 60,
      timeoutMs: 600_000,
      concurrency: 2,
    },
  }
}
