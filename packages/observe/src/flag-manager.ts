import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { BollardError } from "@bollard/engine/src/errors.js"

import type { FlagProvider, FlagState } from "./providers/types.js"

interface FlagsFile {
  flags: FlagState[]
}

export class FileFlagProvider implements FlagProvider {
  private readonly path: string

  constructor(workDir: string) {
    this.path = join(workDir, ".bollard", "flags", "flags.json")
  }

  private async readFileParsed(): Promise<FlagsFile> {
    try {
      const raw = await readFile(this.path, "utf-8")
      const data = JSON.parse(raw) as FlagsFile
      if (!data.flags || !Array.isArray(data.flags)) return { flags: [] }
      return data
    } catch {
      return { flags: [] }
    }
  }

  private async writeAtomic(data: FlagsFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
    await rename(tmp, this.path)
  }

  async get(flagId: string): Promise<FlagState | undefined> {
    const { flags } = await this.readFileParsed()
    return flags.find((f) => f.id === flagId)
  }

  async set(flagId: string, state: FlagState): Promise<void> {
    const { flags } = await this.readFileParsed()
    const idx = flags.findIndex((f) => f.id === flagId)
    const next = { ...state, id: flagId }
    if (idx >= 0) {
      flags[idx] = next
    } else {
      flags.push(next)
    }
    await this.writeAtomic({ flags })
  }

  async list(): Promise<FlagState[]> {
    const { flags } = await this.readFileParsed()
    return flags
  }
}

export async function emergencyKillFlag(provider: FlagProvider, flagId: string): Promise<void> {
  const existing = await provider.get(flagId)
  if (!existing) {
    throw new BollardError({
      code: "FLAG_NOT_FOUND",
      message: `Flag ${flagId} not found`,
      context: { flagId },
    })
  }
  await provider.set(flagId, {
    ...existing,
    enabled: false,
    percent: 0,
    updatedAt: Date.now(),
    updatedBy: "bollard",
  })
}
