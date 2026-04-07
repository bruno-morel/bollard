import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"

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
