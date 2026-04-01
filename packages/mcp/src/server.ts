import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { tools } from "./tools.js"

const server = new Server({ name: "bollard", version: "0.1.0" }, { capabilities: { tools: {} } })

const workDir = process.cwd()

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name
  const tool = tools.find((t) => t.name === toolName)

  if (!tool) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
        },
      ],
      isError: true,
    }
  }

  try {
    const input = (request.params.arguments ?? {}) as Record<string, unknown>
    const result = await tool.handler(input, workDir)
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: message }),
        },
      ],
      isError: true,
    }
  }
})

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write("Bollard MCP server running on stdio\n")
}

main().catch((err: unknown) => {
  process.stderr.write(`MCP server error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
