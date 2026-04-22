import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { IdeGeneratorResult } from "../init-ide.js"

export async function generateCodexConfig(
  _cwd: string,
  _profile: ToolchainProfile,
): Promise<IdeGeneratorResult> {
  const toml = [
    "[mcp_servers.bollard]",
    'command = "docker"',
    "args = [",
    '  "compose", "run", "--rm", "-T", "dev",',
    '  "--filter", "@bollard/mcp", "run", "start"',
    "]",
    "",
    "[mcp_servers.bollard.env]",
    'ANTHROPIC_API_KEY = "$ANTHROPIC_API_KEY"',
    "",
  ].join("\n")

  return {
    platform: "codex",
    files: [{ path: ".codex/config.toml", content: toml }],
    messages: ["MCP tools available to Codex agent"],
  }
}
