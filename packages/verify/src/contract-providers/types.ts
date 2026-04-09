import { resolve } from "node:path"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import type { ExtractedSignature } from "../type-extractor.js"
import { GoContractProvider } from "./go.js"
import { PythonContractProvider } from "./python.js"
import { RustContractProvider } from "./rust.js"
import { TypeScriptContractProvider } from "./typescript.js"

export interface ModuleNode {
  id: string
  language: LanguageId
  rootPath: string
  publicExports: ExtractedSignature[]
  errorTypes: string[]
}

export interface ContractEdge {
  from: string
  to: string
  importedSymbols: string[]
  providerErrors: string[]
  /** Best-effort; TS try/catch narrowing is TODO for richer extraction */
  consumerCatches: string[]
}

export interface ContractContext {
  modules: ModuleNode[]
  edges: ContractEdge[]
  affectedEdges: ContractEdge[]
}

export interface ContractGraphProvider {
  readonly language: LanguageId
  build(
    affectedFiles: string[],
    profile: ToolchainProfile,
    workDir: string,
    warn?: (msg: string) => void,
  ): Promise<ContractContext>
}

export function filterByPublicSurface<T extends { filePath: string }>(
  items: T[],
  surface: Set<string> | undefined,
): T[] {
  if (!surface) return items
  return items.filter((x) => surface.has(resolve(x.filePath)))
}

const PROVIDERS: Partial<Record<LanguageId, ContractGraphProvider>> = {
  typescript: new TypeScriptContractProvider(),
  python: new PythonContractProvider(),
  go: new GoContractProvider(),
  rust: new RustContractProvider(),
}

export async function buildContractContext(
  affectedFiles: string[],
  profile: ToolchainProfile,
  workDir: string,
  warn?: (msg: string) => void,
): Promise<ContractContext> {
  const provider = PROVIDERS[profile.language]
  if (!provider) {
    warn?.(
      `buildContractContext: ${profile.language} provider not implemented — returning empty graph`,
    )
    return { modules: [], edges: [], affectedEdges: [] }
  }
  return provider.build(affectedFiles, profile, workDir, warn)
}
