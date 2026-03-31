import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  deriveAllowedCommands,
  deriveIgnorePatterns,
  deriveSourcePatterns,
  deriveTestPatterns,
} from "../derive.js"
import type { ToolchainProfile } from "../types.js"

export async function detect(cwd: string): Promise<Partial<ToolchainProfile> | null> {
  if (!existsSync(join(cwd, "Cargo.toml"))) return null

  return {
    language: "rust",
    packageManager: "cargo",
    checks: {
      typecheck: {
        label: "cargo check",
        cmd: "cargo",
        args: ["check"],
        source: "auto-detected",
      },
      lint: {
        label: "cargo clippy",
        cmd: "cargo",
        args: ["clippy"],
        source: "auto-detected",
      },
      test: {
        label: "cargo test",
        cmd: "cargo",
        args: ["test"],
        source: "auto-detected",
      },
      audit: {
        label: "cargo audit",
        cmd: "cargo",
        args: ["audit"],
        source: "auto-detected",
      },
    },
    sourcePatterns: deriveSourcePatterns("rust"),
    testPatterns: deriveTestPatterns("rust"),
    ignorePatterns: deriveIgnorePatterns("rust"),
    allowedCommands: deriveAllowedCommands("rust", "cargo"),
    adversarial: { mode: "blackbox" },
  }
}
