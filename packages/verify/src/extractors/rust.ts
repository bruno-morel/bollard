import { readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { ExtractionResult, SignatureExtractor } from "../type-extractor.js"

/**
 * Option B (stable Rust): line-oriented scan for pub items.
 * TODO (Stage 3b): prefer `cargo +nightly rustdoc -- --output-format json` for accuracy.
 */
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
      warn?.(`RustExtractor: skipping path outside workDir: ${f}`)
      continue
    }
    out.push(abs)
  }
  return out
}

const PUB_ITEM = /^\s*pub\s+(?:\([^)]*\)\s+)?(?:async\s+)?fn\s+(\w+)/
const PUB_STRUCT = /^\s*pub\s+struct\s+(\w+)/
const PUB_ENUM = /^\s*pub\s+enum\s+(\w+)/
const PUB_TRAIT = /^\s*pub\s+trait\s+(\w+)/
const PUB_TYPE = /^\s*pub\s+type\s+(\w+)/

export class RustExtractor implements SignatureExtractor {
  constructor(private readonly warn?: (msg: string) => void) {}

  async extract(
    files: string[],
    _profile?: ToolchainProfile,
    workDir?: string,
  ): Promise<ExtractionResult> {
    const safe = filterUnderWorkDir(files, workDir, this.warn)
    const signatures = []
    for (const fp of safe) {
      try {
        const text = await readFile(fp, "utf-8")
        const lines: string[] = []
        for (const line of text.split("\n")) {
          let m = PUB_ITEM.exec(line)
          if (m) {
            lines.push(`pub fn ${m[1]}(...) -> ...`)
            continue
          }
          m = PUB_STRUCT.exec(line)
          if (m) {
            lines.push(`pub struct ${m[1]} { ... }`)
            continue
          }
          m = PUB_ENUM.exec(line)
          if (m) {
            lines.push(`pub enum ${m[1]} { ... }`)
            continue
          }
          m = PUB_TRAIT.exec(line)
          if (m) {
            lines.push(`pub trait ${m[1]} { ... }`)
            continue
          }
          m = PUB_TYPE.exec(line)
          if (m) {
            lines.push(`pub type ${m[1]} = ...`)
          }
        }
        signatures.push({
          filePath: fp,
          signatures: lines.join("\n"),
          types: "",
          imports: "",
        })
      } catch (err) {
        this.warn?.(`RustExtractor: ${fp}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { signatures, types: [] }
  }
}
