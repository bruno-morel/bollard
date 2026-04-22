import { findWorkspaceRoot } from "@bollard/cli/src/workspace-root.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { prompts } from "./prompts.js"
import { resources } from "./resources.js"
import { tools } from "./tools.js"

const server = new Server(
  { name: "bollard", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
)

const workDir = findWorkspaceRoot(process.cwd())

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

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: resources.map((r) => ({
    uri: r.uri,
    name: r.name,
    description: r.description,
    mimeType: r.mimeType,
  })),
}))

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resource = resources.find((r) => r.uri === request.params.uri)
  if (!resource) {
    throw new Error(`Unknown resource: ${request.params.uri}`)
  }
  const content = await resource.handler(workDir)
  return {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: content,
      },
    ],
  }
})

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: prompts.map((p) => ({
    name: p.name,
    description: p.description,
    ...(p.arguments ? { arguments: p.arguments } : {}),
  })),
}))

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const prompt = prompts.find((p) => p.name === request.params.name)
  if (!prompt) {
    throw new Error(`Unknown prompt: ${request.params.name}`)
  }
  return {
    description: prompt.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: prompt.template,
        },
      },
    ],
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
