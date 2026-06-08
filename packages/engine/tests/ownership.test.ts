import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { BollardError } from "../src/errors.js"
import {
  detectManagedFileConflicts,
  FileOwnershipStore,
  OWNERSHIP_SCHEMA_VERSION,
} from "../src/ownership.js"

const execFileAsync = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

async function withStore(
  fn: (store: FileOwnershipStore, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `bollard-own-${randomUUID()}-XXXXXX`))
  try {
    await fn(new FileOwnershipStore(dir), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("FileOwnershipStore", () => {
  it("read() returns DEFAULT_MANIFEST when file does not exist", async () => {
    await withStore(async (store) => {
      const manifest = await store.read()
      expect(manifest.schemaVersion).toBe(OWNERSHIP_SCHEMA_VERSION)
      expect(manifest.bollardManaged).toEqual([])
      expect(manifest.userOwned).toEqual([])
      expect(manifest.lastUpdated).toBe(0)
    })
  })

  it("write() + read() round-trips correctly", async () => {
    await withStore(async (store) => {
      const input = {
        schemaVersion: OWNERSHIP_SCHEMA_VERSION,
        bollardManaged: [
          {
            path: "packages/engine/src/cost-tracker.ts",
            domain: "tests" as const,
            lastCuratedRunId: "run-1",
            lastCommitSha: "abc123",
          },
        ],
        userOwned: ["packages/engine/tests/runner.test.ts"],
        lastUpdated: 0,
      }
      await store.write(input)
      const got = await store.read()
      expect(got.bollardManaged).toHaveLength(1)
      expect(got.bollardManaged[0]?.path).toBe("packages/engine/src/cost-tracker.ts")
      expect(got.userOwned).toEqual(["packages/engine/tests/runner.test.ts"])
      expect(got.lastUpdated).toBeGreaterThan(0)
    })
  })

  it("claim() adds entry to bollardManaged; calling twice upserts (not duplicates)", async () => {
    await withStore(async (store) => {
      await store.claim("src/foo.ts", "tests", "run-1", "sha1")
      await store.claim("src/foo.ts", "ci", "run-2", "sha2", 85.5)
      const manifest = await store.read()
      expect(manifest.bollardManaged).toHaveLength(1)
      expect(manifest.bollardManaged[0]).toMatchObject({
        path: "src/foo.ts",
        domain: "ci",
        lastCuratedRunId: "run-2",
        lastCommitSha: "sha2",
        mutationScore: 85.5,
      })
    })
  })

  it("claim() removes path from userOwned if present", async () => {
    await withStore(async (store) => {
      await store.write({
        schemaVersion: OWNERSHIP_SCHEMA_VERSION,
        bollardManaged: [],
        userOwned: ["src/foo.ts"],
        lastUpdated: 0,
      })
      await store.claim("src/foo.ts", "tests", "run-1", "sha1")
      const manifest = await store.read()
      expect(manifest.userOwned).not.toContain("src/foo.ts")
      expect(manifest.bollardManaged).toHaveLength(1)
    })
  })

  it("release() moves from bollardManaged to userOwned", async () => {
    await withStore(async (store) => {
      await store.claim("src/foo.ts", "tests", "run-1", "sha1")
      await store.release("src/foo.ts")
      const manifest = await store.read()
      expect(manifest.bollardManaged).toHaveLength(0)
      expect(manifest.userOwned).toContain("src/foo.ts")
    })
  })

  it("release() on unknown path adds to userOwned only (no error)", async () => {
    await withStore(async (store) => {
      await store.release("src/unknown.ts")
      const manifest = await store.read()
      expect(manifest.bollardManaged).toHaveLength(0)
      expect(manifest.userOwned).toContain("src/unknown.ts")
    })
  })

  it("validate() throws OWNERSHIP_MANIFEST_INVALID on missing bollardManaged array", async () => {
    await withStore(async (store, dir) => {
      await mkdir(join(dir, ".bollard"), { recursive: true })
      await writeFile(
        join(dir, ".bollard", "ownership.json"),
        JSON.stringify({ schemaVersion: 1, userOwned: [] }),
        "utf-8",
      )
      await expect(store.read()).rejects.toSatisfy((err: unknown) =>
        BollardError.hasCode(err, "OWNERSHIP_MANIFEST_INVALID"),
      )
    })
  })

  it("validate() throws OWNERSHIP_MANIFEST_INVALID on wrong schemaVersion", async () => {
    await withStore(async (store, dir) => {
      await mkdir(join(dir, ".bollard"), { recursive: true })
      await writeFile(
        join(dir, ".bollard", "ownership.json"),
        JSON.stringify({ schemaVersion: 99, bollardManaged: [], userOwned: [] }),
        "utf-8",
      )
      await expect(store.read()).rejects.toSatisfy((err: unknown) =>
        BollardError.hasCode(err, "OWNERSHIP_MANIFEST_INVALID"),
      )
    })
  })
})

describe("detectManagedFileConflicts", () => {
  it("returns empty array when bollardManaged is empty", async () => {
    const manifest = {
      schemaVersion: OWNERSHIP_SCHEMA_VERSION,
      bollardManaged: [],
      userOwned: [],
      lastUpdated: 0,
    }
    const conflicts = await detectManagedFileConflicts(manifest, REPO_ROOT)
    expect(conflicts).toEqual([])
  })

  it("returns empty array when SHA matches git log for managed file", async () => {
    const filePath = "packages/engine/src/cost-tracker.ts"
    let currentSha = ""
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", "--follow", "--format=%H", "-n", "1", "--", filePath],
        { cwd: REPO_ROOT, timeout: 10_000 },
      )
      currentSha = stdout.trim()
    } catch {
      const conflicts = await detectManagedFileConflicts(
        {
          schemaVersion: OWNERSHIP_SCHEMA_VERSION,
          bollardManaged: [
            {
              path: filePath,
              domain: "tests",
              lastCuratedRunId: "run-1",
              lastCommitSha: "fake-sha",
            },
          ],
          userOwned: [],
          lastUpdated: 0,
        },
        REPO_ROOT,
      )
      expect(conflicts).toEqual([])
      return
    }

    if (currentSha.length === 0) {
      const conflicts = await detectManagedFileConflicts(
        {
          schemaVersion: OWNERSHIP_SCHEMA_VERSION,
          bollardManaged: [
            {
              path: filePath,
              domain: "tests",
              lastCuratedRunId: "run-1",
              lastCommitSha: "fake-sha",
            },
          ],
          userOwned: [],
          lastUpdated: 0,
        },
        REPO_ROOT,
      )
      expect(conflicts).toEqual([])
      return
    }

    const manifest = {
      schemaVersion: OWNERSHIP_SCHEMA_VERSION,
      bollardManaged: [
        {
          path: filePath,
          domain: "tests" as const,
          lastCuratedRunId: "run-1",
          lastCommitSha: currentSha,
        },
      ],
      userOwned: [],
      lastUpdated: 0,
    }
    const conflicts = await detectManagedFileConflicts(manifest, REPO_ROOT)
    expect(conflicts).toEqual([])
  })
})
