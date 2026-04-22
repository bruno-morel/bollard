import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { GeneratedFile, IdeGeneratorResult } from "../init-ide.js"

export async function generateAntigravityConfig(
  _cwd: string,
  _profile: ToolchainProfile,
): Promise<IdeGeneratorResult> {
  const files: GeneratedFile[] = [
    {
      path: "mcp_config.json",
      content: JSON.stringify(
        {
          mcpServers: {
            bollard: {
              command: "docker",
              args: [
                "compose",
                "run",
                "--rm",
                "-T",
                "dev",
                "--filter",
                "@bollard/mcp",
                "run",
                "start",
              ],
              env: {
                ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
              },
            },
          },
        },
        null,
        2,
      ),
      merge: true,
    },
  ]

  return {
    platform: "antigravity",
    files,
    messages: [
      "MCP tools available in Antigravity Agent Manager",
      "No rules or hooks integration (Antigravity does not support these yet)",
    ],
  }
}
