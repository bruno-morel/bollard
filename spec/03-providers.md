# Bollard Cloud Abstraction Layer
## Run anywhere Docker runs — no Kubernetes required

*v0.1 — March 2026*

---

## 1. The Principle: Abstraction at the Narrowest Point

The classic mistake with "cloud agnostic" is to abstract everything: compute, storage, networking, databases, queuing, monitoring, IAM. You end up either building a mini-Kubernetes or writing to the lowest common denominator.

Bollard avoids this by asking: **what does Bollard actually need from a cloud?** The answer is surprisingly small:

| Need | What it means | Why |
|------|--------------|-----|
| **Run a container** | Start a Docker container with env vars, a mounted volume, collect stdout/exit code | Agent execution |
| **Inject secrets** | Pass API keys to the container without embedding them in the image | LLM keys, git tokens |
| **Store artifacts** | Persist run logs, results, and metrics somewhere durable | History, debugging, metrics |
| **Queue work** (optional) | Trigger container runs asynchronously, with retry | Parallel verification layers |

That's it. Four capabilities. Everything else — the blueprint engine, agents, verification layers, CLI — runs *inside* the container and is cloud-agnostic by definition (it's just TypeScript in Docker).

---

## 2. The Provider Interface

```typescript
// packages/providers/src/types.ts

export interface ContainerConfig {
  image: string;                    // e.g., "bollard-agent:latest"
  command: string[];                // e.g., ["node", "run.js"]
  env: Record<string, string>;     // non-secret env vars
  secrets: string[];                // secret names to inject (resolved by provider)
  mountRepo?: {
    hostPath: string;              // path to repo on host / in storage
    containerPath: string;         // where to mount in container
    readOnly: boolean;
  };
  resourceLimits?: {
    cpus: number;                  // e.g., 2
    memoryMb: number;              // e.g., 4096
    timeoutSeconds: number;        // hard kill after this
  };
  networkAccess?: "none" | "llm_only" | "full";
}

export interface ContainerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  costEstimateUsd?: number;        // provider-specific compute cost
}

export interface BollardProvider {
  readonly name: string;           // "local", "gcp", "github-actions", etc.

  // Core: run a container
  runContainer(config: ContainerConfig): Promise<ContainerResult>;

  // Secrets
  getSecret(name: string): Promise<string>;

  // Artifacts (run logs, results, metrics)
  storeArtifact(runId: string, key: string, data: Buffer): Promise<string>;
  retrieveArtifact(runId: string, key: string): Promise<Buffer>;
  listArtifacts(runId: string): Promise<string[]>;

  // Optional: async job queue
  enqueue?(config: ContainerConfig, callbackUrl?: string): Promise<string>;  // returns job ID
  getJobStatus?(jobId: string): Promise<"pending" | "running" | "done" | "failed">;

  // Optional: probe scheduling (Stage 3+)
  // If not implemented, probe runner falls back to local setInterval loop.
  scheduleProbe?(probe: ProbeDefinition, callbackUrl?: string): Promise<string>;

  // Lifecycle
  initialize(): Promise<void>;     // setup connections, validate credentials
  cleanup?(): Promise<void>;       // tear down temp resources
}
```

That's the entire cloud abstraction. ~35 lines of TypeScript. Every provider implements this interface, and the blueprint engine only talks to `BollardProvider` — never to cloud SDKs directly.

---

## 3. Provider Implementations

### Staging: What Ships When

| Stage | Providers Implemented | Why |
|-------|----------------------|-----|
| **0** | `local` only | Zero cloud dependencies. Everything runs on the developer's laptop. |
| **1** | + `github-actions` | Most teams already have GitHub. Unlocks CI integration with zero cloud setup. |
| **2-3** | + `gcp` | Cloud Run Jobs for teams that need parallel agents or persistent infrastructure. |
| **4+** | + others as demand materializes | `gitlab-ci`, `aws`, `azure`, `openstack` — each is an independent leaf package. See [ROADMAP.md](ROADMAP.md). |

The `BollardProvider` interface ships at Stage 0 so the abstraction is ready. Only `LocalProvider` has an implementation. The rest are implemented incrementally.

### Local Provider (default — no cloud needed)

```
Provider: local
Container runtime: Docker CLI (docker run)
Secrets: .env file or environment variables
Artifacts: local filesystem (~/.bollard/runs/)
Queue: not needed (runs synchronously)
Dependencies: Docker
Cost: $0 (your laptop)
```

This is the default. A developer clones Bollard, runs `npx bollard run`, and agents execute in Docker containers on their machine. No cloud account, no credentials beyond an LLM API key.

```typescript
// packages/providers/src/local.ts

export class LocalProvider implements BollardProvider {
  readonly name = "local";

  async runContainer(config: ContainerConfig): Promise<ContainerResult> {
    // Builds a `docker run` command:
    // docker run --rm \
    //   -e KEY=VALUE \
    //   -v /repo:/workspace \
    //   --cpus 2 --memory 4g \
    //   --network none \
    //   bollard-agent:latest node run.js
    //
    // Captures stdout, stderr, exit code, duration.
  }

  async getSecret(name: string): Promise<string> {
    // Reads from process.env or .env file
    // No cloud secret manager needed
  }

  async storeArtifact(runId: string, key: string, data: Buffer): Promise<string> {
    // Writes to ~/.bollard/runs/{runId}/{key}
    const dir = path.join(os.homedir(), ".bollard", "runs", runId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, key);
    await fs.writeFile(filePath, data);
    return filePath;
  }

  // ... etc
}
```

### GitHub Actions Provider

This is potentially the **most practical provider for most teams**. GitHub Actions already gives you everything Bollard needs: Docker container execution, secret injection, artifact storage, and job queuing — bundled into CI minutes you're likely already paying for.

A Bollard blueprint maps almost 1:1 to a GitHub Actions workflow: nodes become steps, deterministic nodes become `run:` steps, agentic nodes become steps that call the LLM API, and artifacts flow between them natively.

```
Provider: github-actions
Container runtime: Workflow job containers (runs-on + container:) or docker run in steps
Secrets: GitHub Secrets (repo or org level)
Artifacts: GitHub Actions Artifacts (actions/upload-artifact)
Queue: workflow_dispatch + repository_dispatch events
Dependencies: none (runs IN GitHub Actions)
Cost: $0 for public repos, included in GitHub plan for private repos
      (2,000-50,000 free minutes/month depending on plan)
```

```typescript
// packages/providers/src/github-actions.ts

export class GitHubActionsProvider implements BollardProvider {
  readonly name = "github-actions";

  // Two operating modes:
  //
  // MODE A: "Generator mode" (recommended)
  //   Bollard runs locally (or in a trigger workflow) and GENERATES
  //   a GitHub Actions workflow YAML that executes the blueprint.
  //   Each node becomes a job or step.
  //
  // MODE B: "In-workflow mode"
  //   Bollard itself runs as a step inside an existing workflow.
  //   It uses the runner's Docker and GitHub's native secrets/artifacts.

  async runContainer(config: ContainerConfig): Promise<ContainerResult> {
    // In generator mode: emits a workflow job with `container:` image
    // In-workflow mode: runs `docker run` on the Actions runner
  }

  async getSecret(name: string): Promise<string> {
    // In generator mode: references ${{ secrets.NAME }} in YAML
    // In-workflow mode: reads process.env (GH injects secrets as env vars)
  }

  async storeArtifact(runId: string, key: string, data: Buffer): Promise<string> {
    // Uses @actions/artifact package or actions/upload-artifact
  }

  async enqueue(config: ContainerConfig): Promise<string> {
    // Triggers a workflow via repository_dispatch event
  }
}
```

#### Triggering Bollard from GitHub Issues

For the full "issue → agent → PR" flow, add a trigger workflow:

```yaml
# .github/workflows/bollard-trigger.yml
name: Bollard Trigger
on:
  issues:
    types: [labeled]

jobs:
  run-bollard:
    if: github.event.label.name == 'bollard'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - name: Run Bollard
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          npx bollard run implement-feature \
            --task "${{ github.event.issue.title }}" \
            --provider github-actions
```

Label an issue with `bollard`, and the system plans, implements, tests, verifies, and opens a PR. No cloud account needed.

### GCP Provider

```
Provider: gcp
Container runtime: Cloud Run Jobs
Secrets: Secret Manager
Artifacts: Cloud Storage bucket
Queue: Cloud Tasks (optional)
Dependencies: gcloud CLI or @google-cloud/* SDK
Cost: ~$0.05-0.50 per agent run (pay-per-use, scales to zero)
```

```typescript
// packages/providers/src/gcp.ts

export class GcpProvider implements BollardProvider {
  readonly name = "gcp";
  private projectId: string;
  private region: string;

  async runContainer(config: ContainerConfig): Promise<ContainerResult> {
    // Uses Cloud Run Jobs API:
    // 1. Create/update a Job with the container config
    // 2. Execute the Job
    // 3. Wait for completion
    // 4. Collect logs from Cloud Logging
    //
    // Cloud Run Jobs are perfect for Bollard:
    // - Docker-native (just point at a container image)
    // - Pay only for execution time
    // - Scales to zero
    // - Built-in timeout
    // - No long-running infrastructure to manage
  }

  async getSecret(name: string): Promise<string> {
    // Secret Manager: projects/{id}/secrets/{name}/versions/latest
  }

  async storeArtifact(runId: string, key: string, data: Buffer): Promise<string> {
    // Cloud Storage: gs://bollard-runs/{runId}/{key}
  }

  async enqueue(config: ContainerConfig): Promise<string> {
    // Cloud Tasks: create a task that triggers a Cloud Run Job
  }
}
```

---

## 4. When to Use Which Provider

| Scenario | Best provider | Why |
|----------|--------------|-----|
| Solo dev or small team, starting out | **local** | Zero setup, immediate feedback |
| Team with GitHub, wants automation | **github-actions** | Free/included, no cloud setup, PR workflow is native |
| Need parallel agent runs (multiple tasks at once) | **gcp** | CI runners have concurrency limits; cloud scales elastically |
| Self-hosted/air-gapped environment | **local** | No external dependencies |
| Large team (20+ devs), high volume | **gcp** (or aws/azure when available) | Better cost control, dedicated infrastructure, monitoring |

For most teams, the progression will be: **local → github-actions → cloud** (if/when they need it). Many teams will never leave the CI provider tier.

---

## 5. Provider Selection

The provider is auto-detected from project environment (see [04-configuration.md](04-configuration.md)), or overridden via `BOLLARD_PROVIDER` env var or `.bollard.yml`:

```yaml
# Override in .bollard.yml (only if auto-detection doesn't work)
provider:
  name: gcp                     # local | github-actions | gcp
  # Provider-specific config:
  # project: my-project-id
  # region: us-central1
  # bucket: my-bollard-runs
```

The engine resolves the provider at startup:

```typescript
// packages/engine/src/provider-registry.ts

import { LocalProvider } from "@bollard/provider-local";

export function resolveProvider(config: BollardConfig): BollardProvider {
  switch (config.provider.name) {
    case "local":
      return new LocalProvider(config.provider);

    case "github-actions":
    case "gcp":
      // Cloud/CI providers are optional dependencies.
      // Loaded dynamically so you don't pull in SDKs you don't need.
      return loadCloudProvider(config.provider.name, config.provider);

    default:
      throw new Error(`Unknown provider: ${config.provider.name}`);
  }
}

async function loadCloudProvider(
  name: string,
  config: ProviderConfig
): Promise<BollardProvider> {
  try {
    const mod = await import(`@bollard/provider-${name}`);
    return new mod.default(config);
  } catch {
    throw new Error(
      `Provider "${name}" requires @bollard/provider-${name} to be installed.\n` +
      `Run: pnpm add -D @bollard/provider-${name}`
    );
  }
}
```

Cloud provider packages are **optional peer dependencies**. If you're using GCP, you install `@bollard/provider-gcp`. If you're using local Docker, you install nothing extra.

---

## 6. Project Structure

```
bollard/
├── packages/
│   ├── engine/                    # core (no cloud dependencies)
│   ├── agents/                    # agent definitions (no cloud dependencies)
│   ├── verify/                    # verification layers (no cloud dependencies)
│   ├── cli/                       # CLI (depends on engine, loads providers dynamically)
│   ├── blueprints/                # blueprint definitions
│   │
│   ├── provider-local/            # Local Docker provider (included by default)
│   │   ├── package.json           # deps: none (just child_process for docker CLI)
│   │   └── src/
│   │       └── index.ts
│   │
│   ├── provider-github-actions/   # GitHub Actions provider (Stage 1)
│   │   ├── package.json           # deps: @actions/artifact (optional, for in-workflow mode)
│   │   └── src/
│   │       ├── index.ts
│   │       └── workflow-generator.ts
│   │
│   └── provider-gcp/              # GCP provider (Stage 2-3)
│       ├── package.json           # deps: @google-cloud/run, @google-cloud/storage,
│       │                          #        @google-cloud/secret-manager
│       └── src/
│           └── index.ts
│
└── docker/
    ├── Dockerfile.agent           # the universal agent container
    └── compose.yml                # local dev
```

### Dependency Footprint per Provider

| Provider | Extra npm packages | Cloud CLI needed? |
|----------|--------------------|-------------------|
| **local** | 0 | Docker only |
| **github-actions** | 0-1 (@actions/artifact) | gh (optional, for trigger) |
| **gcp** | 3 (@google-cloud/*) | gcloud (for auth) |

You only install the packages for the provider you use. The core Bollard packages (engine, agents, verify, cli) have **zero cloud dependencies**.

---

## 7. Network Isolation

Agent containers shouldn't have unrestricted network access. A hallucinating agent with network access could make arbitrary API calls, exfiltrate code, or hit rate limits on external services.

Bollard supports three network modes:

```typescript
networkAccess?: "none" | "llm_only" | "full";
```

| Mode | Local | GitHub Actions | GCP |
|------|-------|---------------|-----|
| **none** | `--network none` | Container service network (limited) | VPC: no egress |
| **llm_only** | `--network bollard-net` (proxy) | Proxy step in workflow | VPC + firewall: LLM IPs only |
| **full** | default Docker networking | default runner networking | default Cloud Run |

Default is `llm_only` — the agent can call the LLM API but nothing else. This is the safest default: agents can think but can't reach the internet.

For `llm_only` on local Docker, we run a lightweight HTTP proxy (a ~50-line Node.js script in the Bollard image) that only forwards requests to allowed domains (api.anthropic.com, api.openai.com, etc.).

---

## 8. IaC: Setup Scripts, Not Abstracted Infrastructure

Users need to create cloud resources (storage bucket, secret store, container registry) before Bollard can use them. We provide **setup scripts per provider**, not an IaC abstraction:

```bash
# GCP setup
npx @bollard/provider-gcp setup \
  --project my-project \
  --region us-central1
```

Each setup script creates the minimal resources needed (bucket, secret entries, IAM role/service account) using the cloud's CLI. It's idempotent, takes ~30 seconds, and auto-configures the provider. No manual config editing needed.

We deliberately don't use Terraform/Pulumi here. The resources are so few (a bucket, a secret store, maybe a container registry) that a shell script is simpler, more transparent, and doesn't add another tool to the dependency chain.

---

*Bollard: runs on your laptop. Ships from your CI. Scales to any cloud. Depends on none.*
