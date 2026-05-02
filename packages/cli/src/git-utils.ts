import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function getHeadSha(workDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workDir, "rev-parse", "HEAD"], {
      maxBuffer: 64 * 1024,
    })
    const sha = stdout.trim()
    return sha.length > 0 ? sha : undefined
  } catch {
    return undefined
  }
}
