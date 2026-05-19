import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, relative, resolve } from "node:path"
import type { ScopeResult } from "@bollard/engine/src/run-history.js"
import {
  extractFingerprint,
  isAlreadyPromoted,
  readPromotedManifest,
  writePromotedManifest,
} from "@bollard/engine/src/test-fingerprint.js"

const IMPORT_FROM_RE = /(?:import\s+[\s\S]*?from\s+|}\s+from\s+)(['"])([^'"]+)\1/g

function toPosixPath(p: string): string {
  return p.split("\\").join("/")
}

function formatRelativeImport(fromDir: string, toTarget: string): string {
  let rel = toPosixPath(relative(fromDir, toTarget))
  if (!rel.startsWith(".")) {
    rel = `./${rel}`
  }
  return rel
}

export function rewriteImportsForPromotion(
  content: string,
  fromPath: string,
  toPath: string,
): string {
  const fromDir = dirname(resolve(fromPath))
  const toDir = dirname(resolve(toPath))

  return content.replace(IMPORT_FROM_RE, (full, quote: string, specifier: string) => {
    if (!specifier.startsWith(".")) {
      return full
    }
    const target = resolve(fromDir, specifier)
    const newSpecifier = formatRelativeImport(toDir, target)
    return full.replace(specifier, newSpecifier)
  })
}

function detectScopeFromPath(testPath: string): ScopeResult["scope"] {
  if (testPath.includes("boundary")) return "boundary"
  if (testPath.includes("contract")) return "contract"
  if (testPath.includes("behavioral")) return "behavioral"
  return "boundary"
}

function stripBollardTestPrefix(relPath: string): string {
  const prefixes = [
    ".bollard/tests/boundary/",
    ".bollard/tests/contract/",
    ".bollard/tests/behavioral/",
  ]
  for (const prefix of prefixes) {
    if (relPath.startsWith(prefix)) {
      return relPath.slice(prefix.length)
    }
  }
  return basename(relPath)
}

function stripBollardGeneratedMarkers(content: string): string {
  return content
    .replace(/\/\/\s*@bollard-generated.*\n?/g, "")
    .replace(/#\s*@bollard-generated.*\n?/g, "")
}

function isTypeScriptTestFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts"
}

export interface PromoteTestResult {
  alreadyPromoted: boolean
  fingerprintHash: string
  sourcePath: string
  destPath: string
  destRel: string
  nonTypeScriptNote?: string
}

export async function promoteTest(workDir: string, testPath: string): Promise<PromoteTestResult> {
  const fullSource = resolve(workDir, testPath)
  await access(fullSource)

  let content = await readFile(fullSource, "utf-8")
  const scope = detectScopeFromPath(testPath)
  const fingerprint = extractFingerprint(testPath, content, scope)

  const manifest = await readPromotedManifest(workDir)
  if (isAlreadyPromoted(manifest, fingerprint.hash)) {
    return {
      alreadyPromoted: true,
      fingerprintHash: fingerprint.hash,
      sourcePath: testPath,
      destPath: "",
      destRel: "",
    }
  }

  const fileName = basename(testPath)
  const stripped = stripBollardTestPrefix(testPath.replace(/\\/g, "/"))
  const destRel = join("tests", stripped === fileName ? fileName : stripped)
  const destPath = join(workDir, destRel)
  const fullDest = resolve(destPath)

  let nonTypeScriptNote: string | undefined
  if (isTypeScriptTestFile(testPath)) {
    content = rewriteImportsForPromotion(content, fullSource, fullDest)
  } else {
    nonTypeScriptNote = "Import paths may need manual adjustment for non-TypeScript files."
  }

  content = stripBollardGeneratedMarkers(content)

  await mkdir(dirname(fullDest), { recursive: true })
  await writeFile(fullDest, content, "utf-8")

  manifest.promoted.push({
    hash: fingerprint.hash,
    promotedAt: Date.now(),
    sourcePath: testPath,
    destPath: destRel,
  })
  await writePromotedManifest(workDir, manifest)

  return {
    alreadyPromoted: false,
    fingerprintHash: fingerprint.hash,
    sourcePath: testPath,
    destPath: fullDest,
    destRel,
    ...(nonTypeScriptNote !== undefined ? { nonTypeScriptNote } : {}),
  }
}
