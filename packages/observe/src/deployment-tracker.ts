import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { DeploymentMetadata, DeploymentTracker } from "./providers/types.js"

export class FileDeploymentTracker implements DeploymentTracker {
  private readonly path: string

  constructor(workDir: string) {
    this.path = join(workDir, ".bollard", "observe", "deployments.json")
  }

  private async readAll(): Promise<DeploymentMetadata[]> {
    try {
      const raw = await readFile(this.path, "utf-8")
      const data = JSON.parse(raw) as unknown
      if (!Array.isArray(data)) return []
      return data as DeploymentMetadata[]
    } catch {
      return []
    }
  }

  async record(metadata: DeploymentMetadata): Promise<void> {
    const prev = await this.readAll()
    const next = [...prev, metadata]
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, `${JSON.stringify(next, null, 2)}\n`, "utf-8")
  }

  async getCurrent(): Promise<DeploymentMetadata | undefined> {
    const all = await this.readAll()
    return all.length === 0 ? undefined : all[all.length - 1]
  }

  async getHistory(limit?: number): Promise<DeploymentMetadata[]> {
    const all = await this.readAll()
    const rev = [...all].reverse()
    return limit !== undefined ? rev.slice(0, limit) : rev
  }
}
