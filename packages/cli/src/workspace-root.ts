import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * Filenames whose presence marks a workspace / monorepo / project root.
 *
 * Intentionally omits `.git` — too generic; matches any repo even when cwd
 * is already the right place. Markers here must be specific to workspace
 * or project roots across polyglot ecosystems.
 */
const ROOT_MARKERS = [
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "rush.json",
  "go.work",
  "Cargo.toml",
  ".bollard.yml",
]

/**
 * Walk up from `start` looking for a workspace/project root marker.
 * Falls back to `start` when no marker is found.
 */
export function findWorkspaceRoot(start: string): string {
  let dir = resolve(start)
  while (dir !== dirname(dir)) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(join(dir, marker))) return dir
    }
    dir = dirname(dir)
  }
  return start
}
