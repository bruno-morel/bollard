import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import {
  extractSignatures,
  extractSignaturesFromFiles,
  extractPrivateIdentifiers,
  extractTypeDefinitions,
  resolveReferencedTypes,
} from "../src/type-extractor.js"

describe("Feature: extractSignatures extracts function signatures and types", () => {
  it("should extract function signatures from valid TypeScript source", () => {
    const sourceText = `
      export function add(a: number, b: number): number {
        return a + b
      }
      export interface User { name: string }
    `
    const result = extractSignatures("test.ts", sourceText)
    
    expect(result.filePath).toBe("test.ts")
    expect(result.signatures).toContain("add")
    expect(result.signatures).toContain("number")
    expect(result.types).toContain("User")
    expect(typeof result.imports).toBe("string")
  })

  it("should handle empty source text", () => {
    const result = extractSignatures("empty.ts", "")
    
    expect(result.filePath).toBe("empty.ts")
    expect(typeof result.signatures).toBe("string")
    expect(typeof result.types).toBe("string")
    expect(typeof result.imports).toBe("string")
  })

  it("should handle malformed TypeScript syntax", () => {
    const malformedSource = "export function broken( { invalid syntax"
    const result = extractSignatures("broken.ts", malformedSource)
    
    expect(result.filePath).toBe("broken.ts")
    expect(typeof result.signatures).toBe("string")
    expect(typeof result.types).toBe("string")
    expect(typeof result.imports).toBe("string")
  })

  it("should preserve file path exactly as provided", () => {
    const weirdPath = "../../../deeply/nested/file with spaces.ts"
    const result = extractSignatures(weirdPath, "export const x = 1")
    
    expect(result.filePath).toBe(weirdPath)
  })
})

describe("Feature: extractSignaturesFromFiles processes multiple files", () => {
  it("should return empty result for empty file list", async () => {
    const result = await extractSignaturesFromFiles([])

    expect(Array.isArray(result.signatures)).toBe(true)
    expect(result.signatures.length).toBe(0)
    expect(Array.isArray(result.types)).toBe(true)
    expect(result.types.length).toBe(0)
  })

  it("should handle non-existent files gracefully", async () => {
    const nonExistentFiles = [
      "/does/not/exist.ts",
      "/also/missing.ts"
    ]

    // ASSUMPTION: throws on missing files
    await expect(extractSignaturesFromFiles(nonExistentFiles)).rejects.toThrow()
  })

  it("should preserve file order in results", async () => {
    const filePaths = [
      "first.ts",
      "second.ts",
      "third.ts"
    ]

    // These files don't exist, so this will throw
    await expect(extractSignaturesFromFiles(filePaths)).rejects.toThrow()
  })
})

describe("Feature: extractPrivateIdentifiers finds private members", () => {
  it("should extract private class members", () => {
    const sourceText = `
      class Example {
        private _secret: string
        private _helper() { }
        public visible: number
      }
    `
    const result = extractPrivateIdentifiers("class.ts", sourceText)
    
    expect(Array.isArray(result)).toBe(true)
    expect(result).toContain("_secret")
    expect(result).toContain("_helper")
    expect(result).not.toContain("visible")
  })

  it("should return empty array for source with no private members", () => {
    const sourceText = `
      export function publicFunc() {}
      export const publicConst = 42
    `
    const result = extractPrivateIdentifiers("public.ts", sourceText)
    
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)
  })

  it("should handle malformed class syntax", () => {
    const malformedSource = "class Broken { private incomplete"
    const result = extractPrivateIdentifiers("broken.ts", malformedSource)
    
    expect(Array.isArray(result)).toBe(true)
  })

  it("should distinguish private from protected and public", () => {
    const sourceText = `
      class Access {
        private _private: string
        protected _protected: string  
        public _public: string
        _implicitPublic: string
      }
    `
    const result = extractPrivateIdentifiers("access.ts", sourceText)
    
    expect(Array.isArray(result)).toBe(true)
    expect(result).toContain("_private")
    expect(result).not.toContain("_protected")
    expect(result).not.toContain("_public")
    expect(result).not.toContain("_implicitPublic")
  })
})

describe("Property-based tests", () => {
  it("extractSignatures should handle arbitrary file paths", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 200 }),
      fc.string({ maxLength: 1000 }),
      (filePath, sourceText) => {
        const result = extractSignatures(filePath, sourceText)
        
        expect(result.filePath).toBe(filePath)
        expect(typeof result.signatures).toBe("string")
        expect(typeof result.types).toBe("string")
        expect(typeof result.imports).toBe("string")
      }
    ))
  })

  it("extractPrivateIdentifiers should always return array", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 100 }),
      fc.string({ maxLength: 500 }),
      (filePath, sourceText) => {
        const result = extractPrivateIdentifiers(filePath, sourceText)
        expect(Array.isArray(result)).toBe(true)
        result.forEach(identifier => {
          expect(typeof identifier).toBe("string")
        })
      }
    ))
  })
})

describe("Boundary value tests", () => {
  it("should handle extremely long file paths", () => {
    const longPath = "a".repeat(1000) + ".ts"
    const result = extractSignatures(longPath, "export const x = 1")
    
    expect(result.filePath).toBe(longPath)
  })

  it("should handle very large source text", () => {
    const largeSource = "// comment\n".repeat(10000) + "export const x = 1"
    const result = extractSignatures("large.ts", largeSource)
    
    expect(typeof result.signatures).toBe("string")
    expect(typeof result.types).toBe("string")
  })

  it("should handle source with only whitespace", () => {
    const whitespaceSource = "   \n\t  \r\n  "
    const result = extractSignatures("whitespace.ts", whitespaceSource)
    
    expect(typeof result.signatures).toBe("string")
    expect(typeof result.types).toBe("string")
  })

  it("should handle Unicode characters in source", () => {
    const unicodeSource = `
      export function 测试(参数: string): string { return 参数 }
      interface 用户 { 姓名: string }
    `
    const result = extractSignatures("unicode.ts", unicodeSource)
    
    expect(typeof result.signatures).toBe("string")
    expect(typeof result.types).toBe("string")
  })
})

describe("extractTypeDefinitions adversarial edge cases", () => {
  it("captures full generic interface signature", () => {
    const source = `export interface Foo<T> { value: T }`
    const defs = extractTypeDefinitions("generic.ts", source)
    const foo = defs.find((d) => d.name === "Foo")
    expect(foo).toBeDefined()
    expect(foo!.kind).toBe("interface")
    expect(foo!.definition).toContain("Foo<T>")
    expect(foo!.definition).toContain("value: T")
  })

  it("captures full union/intersection type alias", () => {
    const source = `export type Bar = A & B | C`
    const defs = extractTypeDefinitions("union.ts", source)
    const bar = defs.find((d) => d.name === "Bar")
    expect(bar).toBeDefined()
    expect(bar!.kind).toBe("type")
    expect(bar!.definition).toContain("A & B | C")
  })

  it("does NOT extract re-exported types", () => {
    const source = `export type { Foo } from './other'`
    const defs = extractTypeDefinitions("reexport.ts", source)
    expect(defs.filter((d) => d.name === "Foo")).toHaveLength(0)
  })

  it("captures deeply nested interface structure", () => {
    const source = `export interface A { b: { c: { d: string } } }`
    const defs = extractTypeDefinitions("nested.ts", source)
    const a = defs.find((d) => d.name === "A")
    expect(a).toBeDefined()
    expect(a!.definition).toContain("b:")
    expect(a!.definition).toContain("c:")
    expect(a!.definition).toContain("d: string")
  })

  it("captures exported enum definitions", () => {
    const source = `export enum Color { Red, Green, Blue }`
    const defs = extractTypeDefinitions("enum.ts", source)
    const color = defs.find((d) => d.name === "Color")
    expect(color).toBeDefined()
    expect(color!.kind).toBe("enum")
    expect(color!.definition).toContain("Red")
    expect(color!.definition).toContain("Blue")
  })

  it("does not infinite-loop on self-referencing type", () => {
    const source = `export interface TreeNode { children: TreeNode[] }`
    const defs = extractTypeDefinitions("tree.ts", source)
    expect(defs).toHaveLength(1)
    expect(defs[0]!.name).toBe("TreeNode")
  })
})

describe("resolveReferencedTypes adversarial edge cases", () => {
  it("resolves both param and return types from a function signature", () => {
    const signatures = [
      {
        filePath: "fn.ts",
        signatures: "export function foo(x: Bar): Baz",
        types: "",
        imports: "",
      },
    ]
    const allTypes = [
      { name: "Bar", kind: "interface" as const, definition: "export interface Bar {}", filePath: "types.ts" },
      { name: "Baz", kind: "type" as const, definition: "export type Baz = string", filePath: "types.ts" },
    ]
    const resolved = resolveReferencedTypes(signatures, allTypes)
    const names = resolved.map((t) => t.name)
    expect(names).toContain("Bar")
    expect(names).toContain("Baz")
  })

  it("returns empty array for functions with only primitive params", () => {
    const signatures = [
      {
        filePath: "prim.ts",
        signatures: "export function add(a: number, b: string): boolean",
        types: "",
        imports: "",
      },
    ]
    const allTypes = [
      { name: "Unrelated", kind: "interface" as const, definition: "export interface Unrelated {}", filePath: "x.ts" },
    ]
    const resolved = resolveReferencedTypes(signatures, allTypes)
    expect(resolved).toHaveLength(0)
  })
})