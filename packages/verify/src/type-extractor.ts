import { readFile } from "node:fs/promises"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import ts from "typescript"

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
  extract(files: string[], profile?: ToolchainProfile): Promise<ExtractionResult>
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
  async extract(files: string[]): Promise<ExtractionResult> {
    return extractSignaturesFromFiles(files)
  }
}

export class LlmFallbackExtractor implements SignatureExtractor {
  // TODO: Stage 2 -- implement LLM-based signature extraction
  async extract(_files: string[], _profile?: ToolchainProfile): Promise<ExtractionResult> {
    return { signatures: [], types: [] }
  }
}

export function getExtractor(lang: LanguageId): SignatureExtractor {
  if (lang === "typescript") {
    return new TsCompilerExtractor()
  }
  return new LlmFallbackExtractor()
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
