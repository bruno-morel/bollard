# Stage 3b — Workstream 1b: Slim down `dev-full`

> Cursor/Claude Code prompt. Tuning pass on top of workstream 1. No new features, no TS changes, no test changes. The only success criterion is a smaller `dev-full` image that still passes the existing validation checklist.
>
> **Scope:** only the `dev-full` stage of the `Dockerfile`. Do not touch `dev`, the builder stages, `compose.yaml`, any TypeScript, any test file, or `CLAUDE.md` beyond the final test-count / image-size update.

## Context

Workstream 1 landed GREEN on 2026-04-08. Current image sizes:
- `dev`: **989 MB**
- `dev-full`: **2.43 GB**

Both images run the full test suite green (476 passed, 2 skipped). The `dev-full` delta over `dev` is **~1.44 GB** — noticeably heavier than expected. The original workstream 1 budget said "expect 1.0–1.3 GB *total*, stop and flag above 1.5 GB". That budget was written assuming a lighter `dev` base; the realistic target to evaluate against is the **delta over `dev`**, which today is 1.44 GB.

Your job is to find the best compromise: **how small can `dev-full` get without giving up any capability it needs for Stage 3b validation runs?** There is no hard target — we want the Pareto-optimal point where the next 100 MB of savings would cost real functionality.

## What `dev-full` MUST keep doing (capability floor — do not break any of these)

1. `go version` returns Go 1.22.x, `go test ./...` works against a Go module mounted into `/app`.
2. `rustc --version` and `cargo --version` both succeed; `cargo test --release` works against a Cargo project mounted into `/app`. `syn`-based and `cc`-using crates must still compile (so a C compiler + libc headers are mandatory).
3. `pytest --version` and `ruff --version` both succeed; `pytest` can run a test file mounted into `/app`.
4. `bollard-extract-go --version` and `bollard-extract-rs --version` still work (inherited from `dev`, should be automatic).
5. `docker compose --profile full run --rm dev-full run test` passes unchanged — 476 passed, 2 skipped. No regression in test count or pass rate.
6. `docker compose --profile full run --rm dev-full run typecheck` and `… run lint` both pass unchanged.
7. `dev` image is untouched — its size must stay at 989 MB (±5 MB). If you find yourself editing anything above the `FROM dev AS dev-full` line, stop.

If any change breaks any of the above, revert it.

## Non-negotiables

- Run **everything** through `docker compose …` — never bare `pnpm`/`node`/`cargo`/`go` on the host.
- One commit on `main` when done, commit message `Stage 3b: slim dev-full image (<old> → <new>)`.
- Do not change Go 1.22.6 → another version. Do not change the rust toolchain channel (stays `stable`, minimal profile). Do not drop pytest or ruff.
- Do not introduce a separate `dev-full-slim` target. The goal is to make `dev-full` itself smaller, not to add a third target.

## Investigation phase (do this first, before editing anything)

Run these commands and capture the output — you'll reference them in the commit message and in a short summary at the end:

```bash
# 1. Per-layer breakdown — find the biggest layers
docker history bollard-dev-full:latest --no-trunc --format "table {{.Size}}\t{{.CreatedBy}}"

# 2. Confirm rustup honored --profile minimal (no rust-docs, no extra components)
docker compose --profile full run --rm --entrypoint sh dev-full -c 'rustup component list --installed 2>&1'

# 3. Top 30 installed apt packages by size
docker compose --profile full run --rm --entrypoint sh dev-full -c \
  'dpkg-query -Wf "${Installed-Size}\t${Package}\n" | sort -rn | head -30'

# 4. Caches that should be empty
docker compose --profile full run --rm --entrypoint sh dev-full -c \
  'du -sh /root/.cache/pip /root/.cargo/registry /root/.rustup/toolchains/*/share/doc 2>/dev/null; \
   du -sh /var/cache/apt /var/lib/apt/lists /tmp 2>/dev/null; \
   du -sh /usr/local/go /root/.cargo /root/.rustup 2>/dev/null'

# 5. Overall filesystem — where is the space actually going?
docker compose --profile full run --rm --entrypoint sh dev-full -c \
  'du -sh /usr /opt /root /var /home 2>/dev/null'
```

Write the captured output to `.stage3b-slim-audit.log` in the repo root (gitignored — add a line to `.gitignore` if not already). You'll delete this file before the final commit, but keep it around during the iteration loop.

## Candidates to investigate (in rough priority order)

These are suspects, not instructions. **Try the ones where the audit confirms real bloat.** Skip the ones the audit proves are already small. Add new candidates if the audit surfaces them.

1. **`build-essential` vs. minimal gcc.** `build-essential` pulls gcc, g++, make, dpkg-dev, libc6-dev, libstdc++-dev, and a transitive chain. For `syn` + the occasional `cc`-rs crate we only need `gcc` + `libc6-dev`. Expected savings: 150–250 MB. Risk: some rust crate down the line needs `g++` or `make` — if so, add them back individually.

2. **`/usr/local/go` fat content.** The Go tarball ships with `/usr/local/go/api`, `/usr/local/go/doc`, `/usr/local/go/test`, `/usr/local/go/misc`, `/usr/local/go/pkg/tool/linux_*/api`, and compiled stdlib for cross-compilation targets we'll never use. The stdlib source (`src/`) and the host-arch compiled stdlib (`pkg/linux_amd64`) are mandatory. Candidates to `rm -rf` in the same RUN layer that extracts the tarball: `api/`, `doc/`, `test/`, `misc/`, anything under `pkg/linux_*` that is not the host arch. Expected savings: 100–250 MB. Risk: some `go test` invocation needs `test/` fixtures — validate with workstream 10's fixtures once they exist; for now validate with `go test ./...` on a toy module.

3. **Rustup extras beyond `minimal`.** Even with `--profile minimal`, rustup installs `rustc`, `cargo`, `rust-std`, and possibly `rust-docs` depending on rustup version. Confirm with `rustup component list --installed`. If `rust-docs` is present, `rustup component remove rust-docs` in the same RUN layer that installs rustup. Expected savings: 100–200 MB if present, 0 if already absent.

4. **`/root/.rustup/toolchains/stable-*/share/doc`.** Rustup also caches some doc tarballs under `share/doc` regardless of the component list. Safe to `rm -rf` in the same layer as the rustup install. Expected savings: 20–80 MB.

5. **`/root/.cargo/registry` after the helper build.** The helper binary is baked into `dev` at `/usr/local/bin/bollard-extract-rs`, but the dev-full stage might re-populate `/root/.cargo/registry` during its own install. Check with the audit. If non-empty after install, `cargo cache -a` or `rm -rf /root/.cargo/registry/cache` in the same layer. Expected savings: 50–150 MB.

6. **Pip wheel cache.** The original Dockerfile has `--no-cache-dir` on the `pip install` line, but pip can still leave ~10 MB of metadata in `/root/.cache/pip` or `/tmp/pip-*`. Audit confirms whether this matters.

7. **`curl` after install.** `curl` is used during the rustup install and Go tarball download, then never again at runtime. `apt-get remove -y curl && apt-get autoremove -y` in a later layer would trim ~15 MB but adds a layer — probably not worth it unless the audit shows curl dragged in fat deps.

8. **`python3-pip` size.** The workstream 1 Dockerfile installs `python3-pip` (needed to install pytest + ruff), but `python3-pip` pulls ~80 MB of Python build tooling. Alternatives:
   - Use `pipx` from apt (smaller): `apt install pipx && pipx install pytest ruff`.
   - Use the `ensurepip` bootstrap (comes with `python3`): `python3 -m ensurepip && python3 -m pip install --break-system-packages --no-cache-dir pytest ruff`, then `apt-get remove -y python3-pip` in the same layer.
   - Keep `python3-pip` and move on if the audit shows it's not the biggest lever.

9. **Layer consolidation.** Every `RUN` line in `dev-full` creates a new layer. Combining the apt install + Go tarball extraction + rustup install + pip install + all cleanup into a single `RUN` (separated by `&&`) lets the cleanup actually reclaim space, because cleanup in a later layer doesn't shrink the image. This is the biggest "free" win if any of the above candidates need `rm -rf` after the install. **If you consolidate, do it carefully** — keep the stage structurally readable and put a comment block above the mega-RUN explaining why.

## Iteration loop (do this until you plateau)

```
1. Audit (commands above) → save to .stage3b-slim-audit.log
2. Pick the biggest confirmed lever from the candidates
3. Edit ONLY the dev-full stage of the Dockerfile
4. docker compose --profile full build dev-full
5. docker images | grep bollard          # record new size
6. docker compose --profile full run --rm dev-full run test           # must stay 476/2
7. docker compose --profile full run --rm dev-full run typecheck
8. docker compose --profile full run --rm dev-full run lint
9. docker compose --profile full run --rm --entrypoint sh dev-full -c \
     'go version && cargo --version && rustc --version && pytest --version && ruff --version && \
      bollard-extract-go --version && bollard-extract-rs --version'
10. If anything regresses → revert the last change
11. If size dropped meaningfully → goto 1
12. If size drop <30 MB for 2 consecutive iterations → stop, you have hit diminishing returns
```

Stop at the **first** of these conditions:
- Size drop in the last iteration was under 30 MB AND the one before it was also under 30 MB (diminishing returns)
- `dev-full` is at or below **1.7 GB** (total, not delta) — good enough, no need to keep squeezing
- You've exhausted the candidate list and further cuts would touch `go stdlib / cargo / pytest` core files

There is **no hard lower bound**. 1.7 GB is a target-of-opportunity, not a requirement. If the honest floor for Go 1.22 + Rust stable + Python + pytest + gcc + libc + node is 1.9 GB, land at 1.9 GB and write that up in the summary.

## Validation (before committing)

Run the full checklist one more time on a freshly-built image:

```bash
docker compose build dev
docker compose --profile full build dev-full --no-cache   # full rebuild, no stale layers
docker compose run --rm dev run test                        # 476/2, 989 MB
docker compose --profile full run --rm dev-full run test    # 476/2
docker compose --profile full run --rm dev-full run typecheck
docker compose --profile full run --rm dev-full run lint
docker compose --profile full run --rm --entrypoint sh dev-full -c \
  'go version && cargo --version && rustc --version && pytest --version && ruff --version && \
   bollard-extract-go --version && bollard-extract-rs --version'
docker images | grep bollard
```

All of the above must pass. `dev` stays at 989 MB (±5 MB). `dev-full` is smaller than 2.43 GB.

## Deliverables

1. One commit on `main` with message `Stage 3b: slim dev-full image (2.43GB → <new>GB)`.
2. Dockerfile changes confined to the `dev-full` stage (below `FROM dev AS dev-full`).
3. `CLAUDE.md` update: "Two images: `dev` and `dev-full`" subsection mentions the new `dev-full` size. Test-count line stays 476/2.
4. `.gitignore` includes `.stage3b-slim-audit.log` (the audit file is not committed).
5. Short summary in the commit body (max ~15 lines) covering:
   - Before / after image sizes
   - Top 3 levers that actually moved the needle (with MB saved per lever)
   - Any capability you considered cutting and decided to keep, and why
   - Any candidate from the list that turned out to be a non-issue

## Open questions to flag if you hit them

1. If a rust crate later in Stage 3b needs `g++` or `make` (not `gcc` alone), add them back individually with a comment, don't revert to `build-essential`.
2. If trimming `/usr/local/go` breaks any `go test` fixture during validation, revert just the `rm -rf` of the offending directory — don't revert the whole Go-trim change.
3. If `rustup component list --installed` already shows only `cargo`, `clippy`, `rust-std`, `rustc`, `rustfmt` (no `rust-docs`), candidate 3 is a no-op — skip it and say so in the summary.
4. If the final size is still above 2.0 GB after exhausting the candidate list, stop and flag — I want to see the `docker history` output to decide whether to accept it or dig further together.

When you're done, report: before size, after size, top 3 levers with MB each, final capability smoke-check output. That's it.
