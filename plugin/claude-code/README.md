# Bollard Claude Code Plugin

This directory is the Claude Code plugin packaging for Bollard.

## Structure

The plugin bundles the same files that `bollard init --ide claude-code` generates:

- `.claude/commands/` — slash commands
- `.claude/agents/` — verification subagent
- `.mcp.json` — MCP server config

## Building

To build the plugin package from the generated files:

```bash
bollard init --ide claude-code
cp -r .claude/ plugin/claude-code/.claude/
cp .mcp.json plugin/claude-code/.mcp.json
```

## Installing

```bash
claude plugin add bollard
```
