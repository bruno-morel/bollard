import { execFile } from "node:child_process"
import { dirname, relative, resolve } from "node:path"
import { promisify } from "node:util"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { ExtractionResult, SignatureExtractor } from "../type-extractor.js"

const execFileAsync = promisify(execFile)

function filterUnderWorkDir(
  files: string[],
  workDir: string | undefined,
  warn?: (m: string) => void,
): string[] {
  if (!workDir) return files
  const root = resolve(workDir)
  const out: string[] = []
  for (const f of files) {
    const abs = resolve(f)
    const rel = relative(root, abs)
    if (rel.startsWith("..")) {
      warn?.(`GoAstExtractor: skipping path outside workDir: ${f}`)
      continue
    }
    out.push(abs)
  }
  return out
}

/**
 * Best-effort public API dump via `go doc`. Requires `go` on PATH and in profile.allowedCommands.
 * TODO: richer parsing and same-module type resolution (Stage 3b).
 */
export class GoAstExtractor implements SignatureExtractor {
  constructor(private readonly warn?: (msg: string) => void) {}

  async extract(
    files: string[],
    profile?: ToolchainProfile,
    workDir?: string,
  ): Promise<ExtractionResult> {
    const safe = filterUnderWorkDir(files, workDir, this.warn)
    if (safe.length === 0) return { signatures: [], types: [] }
    if (!profile?.allowedCommands.includes("go")) {
      this.warn?.("GoAstExtractor: `go` not in profile.allowedCommands, skipping")
      return { signatures: [], types: [] }
    }
    const wd = workDir ?? dirname(safe[0] ?? ".")
    try {
      const { stdout } = await execFileAsync("go", ["doc", "-all", "-short", "."], {
        cwd: wd,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
      })
      const joined = safe.join("\n")
      return {
        signatures: [
          {
            filePath: joined,
            signatures: stdout.slice(0, 50_000),
            types: "",
            imports: "",
          },
        ],
        types: [],
      }
    } catch (err) {
      this.warn?.(`GoAstExtractor: ${err instanceof Error ? err.message : String(err)}`)
      return { signatures: [], types: [] }
    }
  }
}
