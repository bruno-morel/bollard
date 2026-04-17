import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/**
 * Records the commit SHA that last passed the full adversarial pipeline (for drift detection).
 */
export async function writeLastVerifiedSha(workDir: string, sha: string): Promise<void> {
  const path = join(workDir, ".bollard", "observe", "last-verified.json")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ sha, updatedAt: Date.now() }, null, 2)}\n`, "utf-8")
}
