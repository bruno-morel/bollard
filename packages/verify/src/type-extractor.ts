import { readFile } from "node:fs/promises"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import type { LLMProvider } from "@bollard/llm/src/types.js"
import ts from "typescript"
import { GoAstExtractor } from "./extractors/go.js"
import { JavaParserExtractor } from "./extractors/java.js"
import { PythonAstExtractor } from "./extractors/python.js"
import { RustSynExtractor } from "./extractors/rust.js"

export interface ExtractedSignature {
  filePath: string
  signatures: string
  types: string
  imports: string
}

export interface ExtractedTypeDefinition {
  name: string
  kind: "interface" | "type" | "enum" | "const"
  definition: string
  filePath: string
}

export interface ExtractionResult {
  signatures: ExtractedSignature[]
  types: ExtractedTypeDefinition[]
}

export interface SignatureExtractor {
  extract(files: string[], profile?: ToolchainProfile, workDir?: string): Promise<ExtractionResult>
}

function getNodeModifiers(node: ts.Node): readonly ts.Modifier[] | undefined {
  if (!ts.canHaveModifiers(node)) return undefined
  return ts.getModifiers(node)
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return getNodeModifiers(node)?.some((m) => m.kind === kind) ?? false
}

function isNodeExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword)
}

function isNodePrivate(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.PrivateKeyword)
}

function extractClassSignature(
  cls: ts.ClassDeclaration,
  sourceText: string,
  sourceFile: ts.SourceFile,
): string {
  const className = cls.name?.getText(sourceFile) ?? "Anonymous"

  let heritage = ""
  if (cls.heritageClauses && cls.heritageClauses.length > 0) {
    heritage = ` ${cls.heritageClauses.map((c) => sourceText.slice(c.pos, c.end).trim()).join(" ")}`
  }

  const members: string[] = []
  for (const member of cls.members) {
    if (isNodePrivate(member)) continue

    if (
      (ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member)) &&
      ts.isPrivateIdentifier(member.name)
    ) {
      continue
    }

    if (ts.isConstructorDeclaration(member)) {
      const params = member.parameters.map((p) => sourceText.slice(p.pos, p.end).trim()).join(", ")
      members.push(`  constructor(${params}) { ... }`)
    } else if (ts.isMethodDeclaration(member) && member.body) {
      const sig = sourceText.slice(member.pos, member.body.pos).trim()
      members.push(`  ${sig} { ... }`)
    } else if (ts.isGetAccessorDeclaration(member) && member.body) {
      const sig = sourceText.slice(member.pos, member.body.pos).trim()
      members.push(`  ${sig} { ... }`)
    } else if (ts.isSetAccessorDeclaration(member) && member.body) {
      const sig = sourceText.slice(member.pos, member.body.pos).trim()
      members.push(`  ${sig} { ... }`)
    } else if (ts.isPropertyDeclaration(member)) {
      members.push(`  ${sourceText.slice(member.pos, member.end).trim()}`)
    }
  }

  return `export class ${className}${heritage} {\n${members.join("\n")}\n}`
}

export function extractSignatures(filePath: string, sourceText: string): ExtractedSignature {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )

  const imports: string[] = []
  const types: string[] = []
  const signatures: string[] = []

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      imports.push(sourceText.slice(stmt.pos, stmt.end).trim())
      continue
    }

    if (ts.isExportDeclaration(stmt)) {
      types.push(sourceText.slice(stmt.pos, stmt.end).trim())
      continue
    }

    if (!isNodeExported(stmt)) continue

    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
      types.push(sourceText.slice(stmt.pos, stmt.end).trim())
      continue
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const sig = sourceText.slice(stmt.pos, stmt.body.pos).trim()
      signatures.push(`${sig} { ... }`)
      continue
    }

    if (ts.isClassDeclaration(stmt) && stmt.name) {
      signatures.push(extractClassSignature(stmt, sourceText, sourceFile))
      continue
    }

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isVariableDeclaration(decl) && decl.type) {
          const name = decl.name.getText(sourceFile)
          const typeText = decl.type.getText(sourceFile)
          signatures.push(`export const ${name}: ${typeText}`)
        }
      }
    }
  }

  return {
    filePath,
    imports: imports.join("\n"),
    types: types.join("\n\n"),
    signatures: signatures.join("\n\n"),
  }
}

export function extractTypeDefinitions(
  filePath: string,
  sourceText: string,
): ExtractedTypeDefinition[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )

  const defs: ExtractedTypeDefinition[] = []

  for (const stmt of sourceFile.statements) {
    if (!isNodeExported(stmt)) continue

    if (ts.isInterfaceDeclaration(stmt)) {
      defs.push({
        name: stmt.name.getText(sourceFile),
        kind: "interface",
        definition: sourceText.slice(stmt.pos, stmt.end).trim(),
        filePath,
      })
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      defs.push({
        name: stmt.name.getText(sourceFile),
        kind: "type",
        definition: sourceText.slice(stmt.pos, stmt.end).trim(),
        filePath,
      })
    } else if (ts.isEnumDeclaration(stmt)) {
      defs.push({
        name: stmt.name.getText(sourceFile),
        kind: "enum",
        definition: sourceText.slice(stmt.pos, stmt.end).trim(),
        filePath,
      })
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isVariableDeclaration(decl) && decl.type) {
          defs.push({
            name: decl.name.getText(sourceFile),
            kind: "const",
            definition: `export const ${decl.name.getText(sourceFile)}: ${decl.type.getText(sourceFile)}`,
            filePath,
          })
        }
      }
    }
  }

  return defs
}

const PASCAL_CASE_RE = /\b([A-Z][a-zA-Z0-9]+)\b/g

export function resolveReferencedTypes(
  signatures: ExtractedSignature[],
  allTypes: ExtractedTypeDefinition[],
): ExtractedTypeDefinition[] {
  const typeMap = new Map<string, ExtractedTypeDefinition>()
  for (const t of allTypes) {
    typeMap.set(t.name, t)
  }

  const referenced = new Set<string>()
  for (const sig of signatures) {
    const text = `${sig.signatures}\n${sig.types}`
    const matches = text.match(PASCAL_CASE_RE) ?? []
    for (const name of matches) {
      if (typeMap.has(name)) {
        referenced.add(name)
      }
    }
  }

  const result: ExtractedTypeDefinition[] = []
  const seen = new Set<string>()
  for (const name of referenced) {
    if (seen.has(name)) continue
    seen.add(name)
    const def = typeMap.get(name)
    if (def) result.push(def)
  }

  return result
}

export async function extractSignaturesFromFiles(filePaths: string[]): Promise<ExtractionResult> {
  const signatures: ExtractedSignature[] = []
  const allTypes: ExtractedTypeDefinition[] = []
  for (const fp of filePaths) {
    const sourceText = await readFile(fp, "utf-8")
    signatures.push(extractSignatures(fp, sourceText))
    allTypes.push(...extractTypeDefinitions(fp, sourceText))
  }
  return { signatures, types: allTypes }
}

export class TsCompilerExtractor implements SignatureExtractor {
  async extract(
    files: string[],
    _profile?: ToolchainProfile,
    _workDir?: string,
  ): Promise<ExtractionResult> {
    return extractSignaturesFromFiles(files)
  }
}

const LLM_EXTRACTION_PROMPT = `You extract public API signatures from source code. You receive source files and output ONLY a JSON object with the extracted signatures.

For each file, extract:
1. All exported function/method signatures (replace bodies with "{ ... }" or "...")
2. All exported type definitions (interfaces, types, enums, constants with type annotations)
3. Import statements

Output format (strict JSON, no markdown fences):
{
  "signatures": [
    {
      "filePath": "path/to/file",
      "signatures": "function signatures here, newline separated",
      "types": "type definitions here, newline separated",
      "imports": "import statements here, newline separated"
    }
  ],
  "types": [
    {
      "name": "TypeName",
      "kind": "interface",
      "definition": "full type definition",
      "filePath": "path/to/file"
    }
  ]
}`

interface LlmExtractionResponse {
  signatures?: Array<{
    filePath?: string
    signatures?: string
    types?: string
    imports?: string
  }>
  types?: Array<{
    name?: string
    kind?: string
    definition?: string
    filePath?: string
  }>
}

function parseLlmResponse(text: string): LlmExtractionResponse | null {
  try {
    return JSON.parse(text) as LlmExtractionResponse
  } catch {
    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]) as LlmExtractionResponse
      } catch {
        return null
      }
    }
    return null
  }
}

const VALID_KINDS = new Set(["interface", "type", "enum", "const"])

export class LlmFallbackExtractor implements SignatureExtractor {
  constructor(
    private readonly provider: LLMProvider,
    private readonly model: string,
    private readonly warn?: (msg: string) => void,
  ) {}

  async extract(
    files: string[],
    _profile?: ToolchainProfile,
    _workDir?: string,
  ): Promise<ExtractionResult> {
    if (files.length === 0) {
      return { signatures: [], types: [] }
    }

    const fileContents: string[] = []
    for (const fp of files) {
      try {
        const content = await readFile(fp, "utf-8")
        fileContents.push(`### ${fp}\n\`\`\`\n${content}\n\`\`\``)
      } catch {
        // File might not exist — skip
      }
    }

    if (fileContents.length === 0) {
      return { signatures: [], types: [] }
    }

    try {
      const response = await this.provider.chat({
        system: LLM_EXTRACTION_PROMPT,
        messages: [
          {
            role: "user",
            content: `Extract signatures from these files:\n\n${fileContents.join("\n\n")}`,
          },
        ],
        maxTokens: 4096,
        temperature: 0,
        model: this.model,
      })

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")

      const parsed = parseLlmResponse(text)
      if (!parsed) {
        this.warn?.(`LlmFallbackExtractor: failed to parse LLM response (${text.length} chars)`)
        return { signatures: [], types: [] }
      }

      const rawSigs = parsed.signatures ?? []
      const signatures: ExtractedSignature[] = rawSigs
        .filter((s) => s.filePath)
        .map((s) => ({
          filePath: s.filePath ?? "",
          signatures: s.signatures ?? "",
          types: s.types ?? "",
          imports: s.imports ?? "",
        }))

      const droppedSigs = rawSigs.length - signatures.length
      if (droppedSigs > 0) {
        this.warn?.(`LlmFallbackExtractor: dropped ${droppedSigs} signatures with missing filePath`)
      }

      const rawTypes = parsed.types ?? []
      const types: ExtractedTypeDefinition[] = rawTypes
        .filter((t) => t.name && t.kind && VALID_KINDS.has(t.kind))
        .map((t) => ({
          name: t.name ?? "",
          kind: t.kind as ExtractedTypeDefinition["kind"],
          definition: t.definition ?? "",
          filePath: t.filePath ?? "",
        }))

      const droppedTypes = rawTypes.length - types.length
      if (droppedTypes > 0) {
        this.warn?.(`LlmFallbackExtractor: dropped ${droppedTypes} types with invalid kind`)
      }

      return { signatures, types }
    } catch (err) {
      this.warn?.(
        `LlmFallbackExtractor: extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return { signatures: [], types: [] }
    }
  }
}

export function getExtractor(
  lang: LanguageId,
  provider?: LLMProvider,
  model?: string,
  warn?: (msg: string) => void,
): SignatureExtractor {
  switch (lang) {
    case "typescript":
      return new TsCompilerExtractor()
    case "python":
      return new PythonAstExtractor(warn)
    case "go":
      return new GoAstExtractor(warn)
    case "rust":
      return new RustSynExtractor(warn)
    case "java":
    case "kotlin":
      return new JavaParserExtractor(warn)
    default:
      if (!provider || !model) {
        throw new BollardError({
          code: "PROVIDER_NOT_FOUND",
          message: `No deterministic extractor for ${lang} and no LLM provider supplied`,
        })
      }
      return new LlmFallbackExtractor(provider, model, warn)
  }
}

// ---- Leak detection support ----

const NOISE_IDENTIFIERS = new Set([
  "err",
  "ctx",
  "msg",
  "res",
  "req",
  "args",
  "opts",
  "val",
  "key",
  "idx",
  "tmp",
  "buf",
  "len",
  "max",
  "min",
  "str",
  "num",
  "obj",
  "fn",
  "cb",
  "el",
  "pos",
  "end",
  "src",
  "out",
  "ret",
  "acc",
  "cur",
  "pre",
  "ref",
  "log",
  "this",
  "new",
  "return",
  "if",
  "else",
  "for",
  "while",
  "break",
  "continue",
  "switch",
  "case",
  "default",
  "throw",
  "try",
  "catch",
  "finally",
  "class",
  "function",
  "const",
  "let",
  "var",
  "import",
  "export",
  "from",
  "of",
  "in",
  "typeof",
  "instanceof",
  "void",
  "null",
  "undefined",
  "true",
  "false",
  "async",
  "await",
  "yield",
  "super",
  "extends",
  "implements",
  "interface",
  "type",
  "enum",
  "readonly",
  "static",
  "abstract",
  "declare",
  "module",
  "namespace",
  "require",
  "delete",
  "with",
  "debugger",
  "do",
])

export function extractPrivateIdentifiers(filePath: string, sourceText: string): string[] {
  // The TypeScript AST cannot model Java/Kotlin. Feeding `.java` / `.kt` through
  // `createSourceFile` mis-parses modifiers (e.g. `final` in `private final Type x`) as
  // bogus "private" identifiers and trips the adversarial leak scan with false positives.
  if (filePath.endsWith(".java") || filePath.endsWith(".kt")) {
    return []
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )

  const privateIds = new Set<string>()

  for (const stmt of sourceFile.statements) {
    const exported = isNodeExported(stmt)

    if (!exported && ts.isFunctionDeclaration(stmt) && stmt.name) {
      privateIds.add(stmt.name.getText(sourceFile))
    }

    if (!exported && ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          privateIds.add(decl.name.getText(sourceFile))
        }
      }
    }

    if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (isNodePrivate(member)) {
          if (
            (ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member)) &&
            ts.isIdentifier(member.name)
          ) {
            privateIds.add(member.name.getText(sourceFile))
          }
        }

        if (
          (ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member)) &&
          ts.isPrivateIdentifier(member.name)
        ) {
          privateIds.add(member.name.getText(sourceFile))
        }

        if (ts.isConstructorDeclaration(member)) {
          for (const param of member.parameters) {
            if (isNodePrivate(param) && ts.isIdentifier(param.name)) {
              privateIds.add(param.name.getText(sourceFile))
            }
          }
        }
      }
    }
  }

  return [...privateIds].filter((id) => id.length > 1 && !NOISE_IDENTIFIERS.has(id))
}
