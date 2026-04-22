import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export const WORKSPACE_ROOT_MARKERS = ["pnpm-workspace.yaml", "go.work", "Cargo.toml"] as const

export function findWorkspaceRoot(start: string): string {
  let dir = resolve(start)
  while (dir !== dirname(dir)) {
    for (const marker of WORKSPACE_ROOT_MARKERS) {
      if (existsSync(join(dir, marker))) return dir
    }
    dir = dirname(dir)
  }
  return start
}
