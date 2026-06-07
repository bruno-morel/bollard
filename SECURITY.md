# Security Policy

## Supported Versions

Bollard is pre-1.0 and under active development. Security fixes land on `main` only — there are no maintained release branches yet. Always run the latest commit.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/bruno-morel/bollard/security/advisories/new) ("Report a vulnerability"). You should receive an acknowledgement within a few days; this is a solo-maintained project, so triage is best-effort but taken seriously.

## Scope — what is security-relevant in Bollard

Bollard executes LLM-generated code and tests inside sandboxed environments. Reports in these areas are especially valuable:

- **Agent tool sandbox escapes** — path-traversal bypasses in `read_file` / `write_file` / `edit_file`, `run_command` allowlist bypasses, or writes escaping `allowedWritePaths`.
- **Docker isolation weaknesses** — adversarial test containers (`docker/Dockerfile.verify*`) reaching the host or the orchestrating process.
- **Prompt-injection paths** — repository content that can steer an agent into executing unintended commands despite the deterministic guards.
- **Secrets handling** — API keys (`.env`, `ANTHROPIC_API_KEY`, etc.) leaking into logs, run history, generated tests, or LLM prompts.
- **Dependency vulnerabilities** — including the helper-binary manifests (`scripts/extract_go/go.mod`, `scripts/extract_rs/Cargo.toml`, `scripts/extract_java/pom.xml`), which are not covered by `pnpm audit`.

## Disclosure

Coordinated disclosure preferred: report privately, allow a fix to land on `main`, then disclose. Credit is given in the advisory unless you ask otherwise.
