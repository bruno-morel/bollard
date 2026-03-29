FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/engine/package.json packages/engine/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/agents/package.json packages/agents/package.json
COPY packages/verify/package.json packages/verify/package.json
COPY packages/blueprints/package.json packages/blueprints/package.json

RUN pnpm install --frozen-lockfile

COPY . .
