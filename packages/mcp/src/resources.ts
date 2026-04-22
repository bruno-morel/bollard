import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

export interface McpResourceDefinition {
  uri: string
  name: string
  description: string
  mimeType: string
  handler: (workDir: string) => Promise<string>
}

async function handleProfile(workDir: string): Promise<string> {
  const { detectToolchain } = await import("@bollard/detect/src/detect.js")
  const profile = await detectToolchain(workDir)
  return JSON.stringify(profile, null, 2)
}

async function handleConfig(workDir: string): Promise<string> {
  const yamlPath = join(workDir, ".bollard.yml")
  if (!existsSync(yamlPath)) {
    return JSON.stringify({ status: "no .bollard.yml found" })
  }
  return readFileSync(yamlPath, "utf-8")
}

async function handleContractGraph(workDir: string): Promise<string> {
  const { detectToolchain } = await import("@bollard/detect/src/detect.js")
  const { buildContractContext } = await import("@bollard/verify/src/contract-extractor.js")
  const profile = await detectToolchain(workDir)
  const ctx = await buildContractContext([], profile, workDir)
  return JSON.stringify(ctx, null, 2)
}

async function handleProbes(workDir: string): Promise<string> {
  const probeDir = join(workDir, ".bollard", "probes")
  if (!existsSync(probeDir)) {
    return JSON.stringify([])
  }
  const files = readdirSync(probeDir).filter((f: string) => f.endsWith(".json"))
  const probes = files.map((f: string) => {
    const content = readFileSync(join(probeDir, f), "utf-8")
    try {
      return JSON.parse(content) as unknown
    } catch {
      return { file: f, error: "invalid JSON" }
    }
  })
  return JSON.stringify(probes, null, 2)
}

async function handleFlags(workDir: string): Promise<string> {
  const flagFile = join(workDir, ".bollard", "flags", "flags.json")
  if (!existsSync(flagFile)) {
    return JSON.stringify({})
  }
  return readFileSync(flagFile, "utf-8")
}

async function handleLastVerified(workDir: string): Promise<string> {
  const verifiedFile = join(workDir, ".bollard", "observe", "last-verified.json")
  if (!existsSync(verifiedFile)) {
    return JSON.stringify({ status: "no verification recorded" })
  }
  return readFileSync(verifiedFile, "utf-8")
}

export const resources: McpResourceDefinition[] = [
  {
    uri: "bollard://profile",
    name: "Toolchain Profile",
    description: "Current detected ToolchainProfile — language, checks, adversarial config",
    mimeType: "application/json",
    handler: handleProfile,
  },
  {
    uri: "bollard://config",
    name: "Bollard Config",
    description: "Resolved .bollard.yml configuration",
    mimeType: "application/json",
    handler: handleConfig,
  },
  {
    uri: "bollard://contract-graph",
    name: "Contract Graph",
    description: "Module dependency graph with edges and public exports",
    mimeType: "application/json",
    handler: handleContractGraph,
  },
  {
    uri: "bollard://probes",
    name: "Probes",
    description: "List of defined HTTP probes from .bollard/probes/",
    mimeType: "application/json",
    handler: handleProbes,
  },
  {
    uri: "bollard://flags",
    name: "Feature Flags",
    description: "Current feature flag states from .bollard/flags/",
    mimeType: "application/json",
    handler: handleFlags,
  },
  {
    uri: "bollard://last-verified",
    name: "Last Verified",
    description: "Last verified deployment SHA and timestamp",
    mimeType: "application/json",
    handler: handleLastVerified,
  },
]
