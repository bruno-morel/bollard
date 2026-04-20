import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import type { BehavioralContext } from "./behavioral-extractor.js"

export interface VerifyComposeConfig {
  workDir: string
  profile: ToolchainProfile
  bollardImageTag?: string
}

export interface GeneratedCompose {
  yaml: string
  services: string[]
}

const DEFAULT_IMAGES: Partial<Record<LanguageId, string>> = {
  typescript: "node:22-slim",
  javascript: "node:22-slim",
  python: "python:3.12-slim",
  go: "golang:1.22",
  rust: "rust:1.77-slim",
  java: "eclipse-temurin:21",
  kotlin: "eclipse-temurin:21",
}

function resolveRuntimeImage(profile: ToolchainProfile): string {
  if (profile.adversarial.boundary.runtimeImage) {
    return profile.adversarial.boundary.runtimeImage
  }
  return DEFAULT_IMAGES[profile.language] ?? "node:22-slim"
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces)
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `${pad}${line}`))
    .join("\n")
}

function buildProjectVerifyService(runtimeImage: string, profile: ToolchainProfile): string {
  const testCmd = profile.checks.test
  const command = testCmd
    ? `${testCmd.cmd} ${testCmd.args.join(" ")}`
    : "echo 'no test command configured'"

  const lines = [
    "project-verify:",
    `  image: ${runtimeImage}`,
    "  working_dir: /workspace",
    "  volumes:",
    "    - ${WORK_DIR}:/workspace",
    `  command: ["sh", "-c", ${JSON.stringify(command)}]`,
  ]
  return lines.join("\n")
}

function buildBlackboxService(bollardTag: string): string {
  const lines = [
    "verify-blackbox:",
    `  image: bollard/verify:${bollardTag}`,
    "  working_dir: /bollard",
    "  volumes:",
    "    - ${WORK_DIR}:/workspace:ro",
    "  depends_on:",
    "    project-verify:",
    "      condition: service_completed_successfully",
  ]
  return lines.join("\n")
}

function buildNativeService(runtimeImage: string, profile: ToolchainProfile): string {
  const testCmd = profile.checks.test
  const command = testCmd
    ? `${testCmd.cmd} ${testCmd.args.join(" ")} .bollard/tests/`
    : "echo 'no test command configured'"

  const lines = [
    "verify-native:",
    `  image: ${runtimeImage}`,
    "  working_dir: /workspace",
    "  volumes:",
    "    - ${WORK_DIR}:/workspace:ro",
    "    - ${WORK_DIR}/.bollard/tests:/tests:ro",
    `  command: ["sh", "-c", ${JSON.stringify(command)}]`,
    "  depends_on:",
    "    project-verify:",
    "      condition: service_completed_successfully",
  ]
  return lines.join("\n")
}

export function generateVerifyCompose(config: VerifyComposeConfig): GeneratedCompose {
  const bollardTag = config.bollardImageTag ?? "latest"
  const runtimeImage = resolveRuntimeImage(config.profile)
  const mode = config.profile.adversarial.boundary.mode ?? "in-language"
  const services: string[] = ["project-verify", "verify-blackbox"]

  const serviceBlocks = [
    buildProjectVerifyService(runtimeImage, config.profile),
    buildBlackboxService(bollardTag),
  ]

  if (mode === "in-language" || mode === "both") {
    services.push("verify-native")
    serviceBlocks.push(buildNativeService(runtimeImage, config.profile))
  }

  const servicesYaml = serviceBlocks.map((block) => indent(block, 4)).join("\n\n")

  const yaml = ["services:", servicesYaml, ""].join("\n")

  return { yaml, services }
}

export interface BehavioralComposeConfig {
  workDir: string
  profile: ToolchainProfile
  behavioralContext: BehavioralContext
  /** Relative path from workDir to the generated behavioral test file */
  behavioralTestRelPath: string
  bollardImageTag?: string
}

/**
 * Two-service compose: `project` (app under test) and `verify-behavioral` (runs the test command).
 * Uses `${WORK_DIR}` volume placeholder (same pattern as verify compose).
 */
export async function generateBehavioralCompose(
  config: BehavioralComposeConfig,
): Promise<GeneratedCompose> {
  void config.behavioralContext
  const runtimeImage = resolveRuntimeImage(config.profile)
  let startCmd = "sleep 3600"
  const lang = config.profile.language
  if (lang === "java" || lang === "kotlin") {
    const gradlew = join(config.workDir, "gradlew")
    const hasGradle =
      existsSync(join(config.workDir, "build.gradle")) ||
      existsSync(join(config.workDir, "build.gradle.kts"))
    const hasMaven = existsSync(join(config.workDir, "pom.xml"))
    if (hasGradle) {
      startCmd = existsSync(gradlew) ? "./gradlew bootRun" : "gradle bootRun"
    } else if (hasMaven) {
      startCmd = "mvn spring-boot:run"
    }
  } else {
    try {
      const pkgPath = join(config.workDir, "package.json")
      const raw = await readFile(pkgPath, "utf-8")
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
      const pm =
        config.profile.packageManager === "pnpm"
          ? "pnpm"
          : config.profile.packageManager === "yarn"
            ? "yarn"
            : "npm"
      const scripts = pkg.scripts
      if (scripts?.["start"]) {
        startCmd = `${pm} run start`
      } else if (scripts?.["dev"]) {
        startCmd = `${pm} run dev`
      }
    } catch {
      /* keep placeholder when no package.json */
    }
  }

  const testRel = config.behavioralTestRelPath.replace(/\\/g, "/")
  const testCmd =
    config.profile.checks.test !== undefined
      ? `${config.profile.checks.test.cmd} ${[...config.profile.checks.test.args, testRel].join(" ")}`.trim()
      : `pnpm exec vitest run ${testRel}`

  const projectBlock = [
    "project:",
    `  image: ${runtimeImage}`,
    "  working_dir: /workspace",
    "  volumes:",
    "    - ${WORK_DIR}:/workspace",
    "  ports:",
    '    - "3000:3000"',
    `  command: ["sh", "-c", ${JSON.stringify(startCmd)}]`,
  ].join("\n")

  const verifyBlock = [
    "verify-behavioral:",
    `  image: ${runtimeImage}`,
    "  working_dir: /workspace",
    "  volumes:",
    "    - ${WORK_DIR}:/workspace",
    "  environment:",
    "    - BASE_URL=http://project:3000",
    "  depends_on:",
    "    - project",
    `  command: ["sh", "-c", ${JSON.stringify(testCmd)}]`,
  ].join("\n")

  const servicesYaml = [projectBlock, verifyBlock].map((block) => indent(block, 4)).join("\n\n")
  const yaml = ["services:", servicesYaml, ""].join("\n")

  return { yaml, services: ["project", "verify-behavioral"] }
}
