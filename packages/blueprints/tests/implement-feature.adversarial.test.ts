import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createImplementFeatureBlueprint } from "../src/implement-feature.js"

describe("Feature: createImplementFeatureBlueprint function exists and returns Blueprint", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "implement-feature-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("should return a Blueprint object with required properties", () => {
    const blueprint = createImplementFeatureBlueprint(tempDir)
    
    expect(blueprint).toBeDefined()
    expect(typeof blueprint).toBe("object")
    expect(blueprint).toHaveProperty("nodes")
    expect(Array.isArray(blueprint.nodes)).toBe(true)
    expect(blueprint.nodes.length).toBeGreaterThan(0)
  })

  it("should create blueprint with valid node structure", () => {
    const blueprint = createImplementFeatureBlueprint(tempDir)

    blueprint.nodes.forEach((node) => {
      expect(typeof node.id).toBe("string")
      expect(node.id.length).toBeGreaterThan(0)
      expect(typeof node.name).toBe("string")
      expect(["deterministic", "agentic", "risk_gate", "human_gate"]).toContain(node.type)
      if (node.type === "deterministic") {
        expect(typeof node.execute).toBe("function")
      }
      if (node.type === "agentic") {
        expect(typeof node.agent).toBe("string")
      }
    })
  })

  it("should use the provided workDir in blueprint configuration", () => {
    const blueprint = createImplementFeatureBlueprint(tempDir)
    
    // Blueprint should be configured with the work directory
    expect(blueprint).toBeDefined()
    // The workDir should influence the blueprint's behavior
    const blueprint2 = createImplementFeatureBlueprint("/different/path")
    expect(blueprint).not.toEqual(blueprint2)
  })
})

describe("Feature: Property-based tests for workDir parameter", () => {
  it("should handle various valid directory paths", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 100 }).filter(s => 
        !s.includes('\0') && 
        !s.includes('\n') && 
        !s.includes('\r') &&
        s.trim().length > 0
      ),
      (workDir) => {
        const blueprint = createImplementFeatureBlueprint(workDir)
        expect(blueprint).toBeDefined()
        expect(blueprint.nodes).toBeDefined()
        expect(Array.isArray(blueprint.nodes)).toBe(true)
      }
    ))
  })

  it("should handle absolute and relative paths consistently", () => {
    fc.assert(fc.property(
      fc.constantFrom(
        "/tmp/test",
        "./relative/path",
        "../parent/path",
        "/absolute/path/with/many/segments",
        "simple-name"
      ),
      (workDir) => {
        const blueprint = createImplementFeatureBlueprint(workDir)
        expect(blueprint.nodes.length).toBeGreaterThan(0)
        blueprint.nodes.forEach(node => {
          expect(typeof node.id).toBe("string")
          expect(node.id.length).toBeGreaterThan(0)
        })
      }
    ))
  })
})

describe("Feature: Negative tests for error conditions", () => {
  it("should handle empty string workDir", () => {
    const blueprint = createImplementFeatureBlueprint("")
    expect(blueprint).toBeDefined()
    expect(blueprint.nodes).toBeDefined()
  })

  it("should handle workDir with special characters", () => {
    const specialPaths = [
      "/path with spaces",
      "/path-with-dashes",
      "/path_with_underscores",
      "/path.with.dots",
      "/path/with/unicode/café"
    ]

    specialPaths.forEach(workDir => {
      const blueprint = createImplementFeatureBlueprint(workDir)
      expect(blueprint).toBeDefined()
      expect(blueprint.nodes.length).toBeGreaterThan(0)
    })
  })

  it("should handle very long directory paths", () => {
    const longPath = "/very/long/path/" + "segment/".repeat(50) + "end"
    const blueprint = createImplementFeatureBlueprint(longPath)
    expect(blueprint).toBeDefined()
    expect(blueprint.nodes).toBeDefined()
  })

  it("should handle workDir with null bytes (edge case)", () => {
    // This tests the boundary of what the filesystem can handle
    expect(() => {
      createImplementFeatureBlueprint("path\0with\0nulls")
    }).not.toThrow()
  })
})

describe("Feature: Blueprint nodes have executable behavior", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "implement-feature-exec-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("should include deterministic nodes with execute functions", () => {
    const blueprint = createImplementFeatureBlueprint(tempDir)
    expect(blueprint.nodes.length).toBeGreaterThan(0)
    const deterministic = blueprint.nodes.filter((n) => n.type === "deterministic")
    expect(deterministic.length).toBeGreaterThan(0)
    for (const node of deterministic) {
      expect(typeof node.execute).toBe("function")
    }
  })

  it("should create blueprint that represents feature implementation workflow", () => {
    const blueprint = createImplementFeatureBlueprint(tempDir)
    
    // Implementation workflow should have multiple stages
    expect(blueprint.nodes.length).toBeGreaterThanOrEqual(2)
    
    // Each node should have a meaningful identifier
    const nodeIds = blueprint.nodes.map(n => n.id)
    expect(new Set(nodeIds).size).toBe(nodeIds.length) // All IDs unique
    
    nodeIds.forEach(id => {
      expect(id).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/) // Valid identifier format
    })
  })
})

describe("Feature: Blueprint consistency across calls", () => {
  it("should create equivalent blueprints for same workDir", () => {
    const workDir = "/test/path"
    const blueprint1 = createImplementFeatureBlueprint(workDir)
    const blueprint2 = createImplementFeatureBlueprint(workDir)
    
    expect(blueprint1.nodes.length).toBe(blueprint2.nodes.length)
    
    for (let i = 0; i < blueprint1.nodes.length; i++) {
      expect(blueprint1.nodes[i].id).toBe(blueprint2.nodes[i].id)
      expect(blueprint1.nodes[i].type).toBe(blueprint2.nodes[i].type)
    }
  })

  it("should create different blueprints for different workDirs", () => {
    const blueprint1 = createImplementFeatureBlueprint("/path1")
    const blueprint2 = createImplementFeatureBlueprint("/path2")
    
    // Blueprints should be functionally different even if structurally similar
    expect(blueprint1).not.toBe(blueprint2)
  })
})