import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import type { ScopeResult } from "./run-history.js"

export interface TestFingerprint {
  scope: "boundary" | "contract" | "behavioral"
  targetModule: string
  assertionTypes: string[]
  inputPatterns: string[]
  hash: string
}

export interface PromotedTest {
  hash: string
  promotedAt: number
  sourcePath: string
  destPath: string
}

export interface PromotedManifest {
  schemaVersion: 1
  promoted: PromotedTest[]
}

const ASSERTION_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "expect(", regex: /\bexpect\s*\(/g },
  { label: ".toBe(", regex: /\.toBe\s*\(/g },
  { label: ".toThrow(", regex: /\.toThrow\s*\(/g },
  { label: ".rejects", regex: /\.rejects\b/g },
  { label: ".resolves", regex: /\.resolves\b/g },
  { label: "assert.", regex: /\bassert\./g },
  { label: "raises", regex: /\braises\b/g },
  { label: "pytest.raises", regex: /\bpytest\.raises\b/g },
]

const INPUT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "null", regex: /\bnull\b/g },
  { label: "undefined", regex: /\bundefined\b/g },
  { label: '""', regex: /""/g },
  { label: "[]", regex: /\[\s*\]/g },
  { label: "{}", regex: /\{\s*\}/g },
  { label: "-1", regex: /(?<![.\d])-1\b/g },
  { label: "0", regex: /(?<![.\d])0\b/g },
  { label: "NaN", regex: /\bNaN\b/g },
  { label: "Infinity", regex: /\bInfinity\b/g },
]

function collectMatches(
  content: string,
  patterns: Array<{ label: string; regex: RegExp }>,
): string[] {
  const found = new Set<string>()
  for (const { label, regex } of patterns) {
    regex.lastIndex = 0
    if (regex.test(content)) {
      found.add(label)
    }
  }
  return [...found].sort()
}

function hashFingerprintPayload(payload: {
  scope: TestFingerprint["scope"]
  targetModule: string
  assertionTypes: string[]
  inputPatterns: string[]
}): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

export function extractFingerprint(
  testFilePath: string,
  content: string,
  scope: ScopeResult["scope"],
): TestFingerprint {
  const targetModule = basename(testFilePath, extname(testFilePath))
  const assertionTypes = collectMatches(content, ASSERTION_PATTERNS)
  const inputPatterns = collectMatches(content, INPUT_PATTERNS)
  const hash = hashFingerprintPayload({ scope, targetModule, assertionTypes, inputPatterns })
  return { scope, targetModule, assertionTypes, inputPatterns, hash }
}

export async function readPromotedManifest(workDir: string): Promise<PromotedManifest> {
  const manifestPath = join(workDir, ".bollard", "promoted.json")
  try {
    const text = await readFile(manifestPath, "utf-8")
    const parsed = JSON.parse(text) as PromotedManifest
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.promoted)) {
      return { schemaVersion: 1, promoted: [] }
    }
    return parsed
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err ? (err as { code: string }).code : ""
    if (code === "ENOENT") {
      return { schemaVersion: 1, promoted: [] }
    }
    throw err
  }
}

export async function writePromotedManifest(
  workDir: string,
  manifest: PromotedManifest,
): Promise<void> {
  const dir = join(workDir, ".bollard")
  await mkdir(dir, { recursive: true })
  const manifestPath = join(dir, "promoted.json")
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8")
}

export function isAlreadyPromoted(manifest: PromotedManifest, hash: string): boolean {
  return manifest.promoted.some((p) => p.hash === hash)
}
