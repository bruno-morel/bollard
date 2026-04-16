import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withBoundaryOverrides } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { afterEach, describe, expect, it } from "vitest"
import type { BehavioralContext } from "../src/behavioral-extractor.js"
import { generateBehavioralCompose, generateVerifyCompose } from "../src/compose-generator.js"

const TS_PROFILE: ToolchainProfile = {
  language: "typescript",
  packageManager: "pnpm",
  checks: {
    typecheck: { label: "tsc", cmd: "pnpm", args: ["run", "typecheck"], source: "auto-detected" },
    lint: { label: "Biome", cmd: "pnpm", args: ["run", "lint"], source: "auto-detected" },
    test: {
      label: "Vitest",
      cmd: "pnpm",
      args: ["exec", "vitest", "run"],
      source: "auto-detected",
    },
  },
  sourcePatterns: ["**/*.ts"],
  testPatterns: ["**/*.test.ts"],
  ignorePatterns: ["node_modules"],
  allowedCommands: ["pnpm"],
  adversarial: withBoundaryOverrides("typescript", { mode: "both" }),
}

const PY_PROFILE: ToolchainProfile = {
  language: "python",
  packageManager: "poetry",
  checks: {
    typecheck: { label: "mypy", cmd: "mypy", args: ["."], source: "auto-detected" },
    lint: { label: "Ruff", cmd: "ruff", args: ["check", "."], source: "auto-detected" },
    test: {
      label: "pytest",
      cmd: "poetry",
      args: ["run", "pytest", "-v"],
      source: "auto-detected",
    },
  },
  sourcePatterns: ["**/*.py"],
  testPatterns: ["**/test_*.py"],
  ignorePatterns: ["__pycache__"],
  allowedCommands: ["python", "poetry"],
  adversarial: withBoundaryOverrides("python", { mode: "both" }),
}

describe("generateVerifyCompose", () => {
  it("generates valid YAML for a TypeScript profile with all 3 services", () => {
    const result = generateVerifyCompose({
      workDir: "/tmp/project",
      profile: TS_PROFILE,
    })
    expect(result.services).toEqual(["project-verify", "verify-blackbox", "verify-native"])
    expect(result.yaml).toContain("services:")
    expect(result.yaml).toContain("project-verify:")
    expect(result.yaml).toContain("verify-blackbox:")
    expect(result.yaml).toContain("verify-native:")
    expect(result.yaml).toContain("node:22-slim")
    expect(result.yaml).toContain("bollard/verify:latest")
  })

  it("generates valid YAML for a Python profile with correct images", () => {
    const result = generateVerifyCompose({
      workDir: "/tmp/py-project",
      profile: PY_PROFILE,
    })
    expect(result.services).toContain("project-verify")
    expect(result.services).toContain("verify-blackbox")
    expect(result.services).toContain("verify-native")
    expect(result.yaml).toContain("python:3.12-slim")
    expect(result.yaml).toContain("bollard/verify:latest")
  })

  it("omits verify-native when adversarial mode is blackbox", () => {
    const blackboxProfile: ToolchainProfile = {
      ...TS_PROFILE,
      adversarial: withBoundaryOverrides("typescript", { mode: "blackbox" }),
    }
    const result = generateVerifyCompose({
      workDir: "/tmp/project",
      profile: blackboxProfile,
    })
    expect(result.services).toEqual(["project-verify", "verify-blackbox"])
    expect(result.yaml).not.toContain("verify-native:")
  })

  it("includes verify-native when mode is in-language", () => {
    const inLangProfile: ToolchainProfile = {
      ...TS_PROFILE,
      adversarial: withBoundaryOverrides("typescript", { mode: "in-language" }),
    }
    const result = generateVerifyCompose({
      workDir: "/tmp/project",
      profile: inLangProfile,
    })
    expect(result.services).toContain("verify-native")
    expect(result.yaml).toContain("verify-native:")
  })

  it("includes verify-native when mode is both", () => {
    const result = generateVerifyCompose({
      workDir: "/tmp/project",
      profile: TS_PROFILE,
    })
    expect(result.services).toContain("verify-native")
  })

  it("uses custom runtimeImage from profile", () => {
    const customProfile: ToolchainProfile = {
      ...PY_PROFILE,
      adversarial: withBoundaryOverrides("python", {
        mode: "both",
        runtimeImage: "python:3.11-bookworm",
      }),
    }
    const result = generateVerifyCompose({
      workDir: "/tmp/project",
      profile: customProfile,
    })
    expect(result.yaml).toContain("python:3.11-bookworm")
    expect(result.yaml).not.toContain("python:3.12-slim")
  })

  it("uses custom bollardImageTag", () => {
    const result = generateVerifyCompose({
      workDir: "/tmp/project",
      profile: TS_PROFILE,
      bollardImageTag: "v2.0",
    })
    expect(result.yaml).toContain("bollard/verify:v2.0")
    expect(result.yaml).not.toContain("bollard/verify:latest")
  })

  it("includes correct volume mounts", () => {
    const result = generateVerifyCompose({
      workDir: "/tmp/project",
      profile: TS_PROFILE,
    })
    expect(result.yaml).toContain("${WORK_DIR}:/workspace")
    expect(result.yaml).toContain("${WORK_DIR}:/workspace:ro")
    expect(result.yaml).toContain("${WORK_DIR}/.bollard/tests:/tests:ro")
  })

  it("includes depends_on for verify-blackbox", () => {
    const result = generateVerifyCompose({
      workDir: "/tmp/project",
      profile: TS_PROFILE,
    })
    expect(result.yaml).toContain("depends_on:")
    expect(result.yaml).toContain("condition: service_completed_successfully")
  })

  it("includes test command from profile in project-verify", () => {
    const result = generateVerifyCompose({
      workDir: "/tmp/project",
      profile: PY_PROFILE,
    })
    expect(result.yaml).toContain("poetry run pytest -v")
  })
})

const EMPTY_BEHAVIORAL: BehavioralContext = {
  endpoints: [],
  config: [],
  dependencies: [],
  failureModes: [],
}

describe("generateBehavioralCompose", () => {
  let tempDir: string | undefined
  afterEach(async () => {
    tempDir = undefined
  })

  it("generates two services project and verify-behavioral", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-beh-compose-"))
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ scripts: { start: "node index.js" } }),
      "utf-8",
    )
    const result = await generateBehavioralCompose({
      workDir: tempDir,
      profile: TS_PROFILE,
      behavioralContext: EMPTY_BEHAVIORAL,
      behavioralTestRelPath: ".bollard/runs/x/adversarial/behavioral/t.behavioral.test.ts",
    })
    expect(result.services).toEqual(["project", "verify-behavioral"])
    expect(result.yaml).toContain("project:")
    expect(result.yaml).toContain("verify-behavioral:")
    expect(result.yaml).toContain("BASE_URL=http://project:3000")
    expect(result.yaml).toContain("3000:3000")
  })

  it("embeds vitest fallback when profile has no test command", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-beh-compose-"))
    await writeFile(join(tempDir, "package.json"), JSON.stringify({}), "utf-8")
    const minimalProfile: ToolchainProfile = {
      ...TS_PROFILE,
      checks: {},
    }
    const result = await generateBehavioralCompose({
      workDir: tempDir,
      profile: minimalProfile,
      behavioralContext: EMPTY_BEHAVIORAL,
      behavioralTestRelPath: "tests/x.test.ts",
    })
    expect(result.yaml).toContain("vitest run")
  })

  it("uses pnpm run start when package.json defines start", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-beh-compose-"))
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js" } }),
      "utf-8",
    )
    const result = await generateBehavioralCompose({
      workDir: tempDir,
      profile: TS_PROFILE,
      behavioralContext: EMPTY_BEHAVIORAL,
      behavioralTestRelPath: "t.test.ts",
    })
    expect(result.yaml).toContain("pnpm run start")
  })
})
