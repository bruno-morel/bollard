import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { detectCIEnvironment, readJUnitResults } from "../src/ci-environment.js"

describe("detectCIEnvironment", () => {
  it("returns local when no CI env vars set", () => {
    const env = detectCIEnvironment({})
    expect(env.provider).toBe("local")
    expect(env.priorResults).toEqual([])
    expect(env.artifactPaths).toEqual([])
  })

  it("returns github-actions when GITHUB_ACTIONS is true", () => {
    const env = detectCIEnvironment({ GITHUB_ACTIONS: "true" })
    expect(env.provider).toBe("github-actions")
  })

  it("returns gitlab-ci when GITLAB_CI is true", () => {
    const env = detectCIEnvironment({ GITLAB_CI: "true" })
    expect(env.provider).toBe("gitlab-ci")
  })

  it("returns circleci when CIRCLECI is true", () => {
    const env = detectCIEnvironment({ CIRCLECI: "true" })
    expect(env.provider).toBe("circleci")
  })

  it("returns jenkins when JENKINS_URL is set", () => {
    const env = detectCIEnvironment({ JENKINS_URL: "http://jenkins" })
    expect(env.provider).toBe("jenkins")
  })

  it("returns buildkite when BUILDKITE is true", () => {
    const env = detectCIEnvironment({ BUILDKITE: "true" })
    expect(env.provider).toBe("buildkite")
  })

  it("returns google-cloud-build when CLOUD_BUILD_ID is set", () => {
    const env = detectCIEnvironment({ CLOUD_BUILD_ID: "abc123" })
    expect(env.provider).toBe("google-cloud-build")
  })

  it("returns aws-codebuild when CODEBUILD_BUILD_ID is set", () => {
    const env = detectCIEnvironment({ CODEBUILD_BUILD_ID: "my-project:abc" })
    expect(env.provider).toBe("aws-codebuild")
  })

  it("returns azure-pipelines when TF_BUILD is True", () => {
    const env = detectCIEnvironment({ TF_BUILD: "True" })
    expect(env.provider).toBe("azure-pipelines")
  })

  it("returns travis-ci when TRAVIS is true", () => {
    const env = detectCIEnvironment({ TRAVIS: "true" })
    expect(env.provider).toBe("travis-ci")
  })

  it("returns drone when DRONE is true", () => {
    const env = detectCIEnvironment({ DRONE: "true" })
    expect(env.provider).toBe("drone")
  })

  it("returns unknown when CI is set but no specific provider matched", () => {
    const env = detectCIEnvironment({ CI: "true" })
    expect(env.provider).toBe("unknown")
  })

  it("github-actions has artifactPaths including junit.xml", () => {
    const env = detectCIEnvironment({ GITHUB_ACTIONS: "true" })
    expect(env.artifactPaths).toContain("junit.xml")
  })
})

describe("readJUnitResults", () => {
  it("returns empty array for nonexistent file", async () => {
    const results = await readJUnitResults("/nonexistent/path/junit.xml")
    expect(results).toEqual([])
  })

  it("parses valid JUnit XML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bollard-junit-"))
    const xmlPath = join(dir, "results.xml")
    await writeFile(
      xmlPath,
      '<testsuite name="vitest" tests="5" failures="0" errors="0" skipped="1" timestamp="2026-05-15T04:00:00Z"></testsuite>',
      "utf-8",
    )

    const results = await readJUnitResults(xmlPath)
    expect(results).toHaveLength(1)
    expect(results[0]?.check).toBe("test")
    expect(results[0]?.passed).toBe(true)
    expect(results[0]?.source).toBe("junit-xml")
    expect(results[0]?.detail).toBe("4 passed, 0 failed, 1 skipped")
  })

  it("returns passed: false when failures > 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bollard-junit-"))
    const xmlPath = join(dir, "results.xml")
    await writeFile(
      xmlPath,
      '<testsuite name="vitest" tests="5" failures="2" errors="0" skipped="0" timestamp="2026-05-15T04:00:00Z"></testsuite>',
      "utf-8",
    )

    const results = await readJUnitResults(xmlPath)
    expect(results).toHaveLength(1)
    expect(results[0]?.passed).toBe(false)
    expect(results[0]?.detail).toBe("3 passed, 2 failed, 0 skipped")
  })
})
