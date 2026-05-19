# Cursor Prompt — Cleanup: Stale TODO(stage-3b) Comments

> **Context:** Stage 3b is fully shipped and validated. Two `TODO(stage-3b)` comments in the Go and Rust extractors flagged a `workDir` assertion that was never added. The concern they describe is real but low-priority and documented elsewhere — the comments are now just noise. This is a pure housekeeping change: update the comments to reflect reality, no logic changes.
>
> **Read CLAUDE.md briefly before starting.** Then read:
> - `packages/verify/src/extractors/go.ts` lines 44–60
> - `packages/verify/src/extractors/rust.ts` lines 44–60

---

## What to change — two files, two comment blocks

### `packages/verify/src/extractors/go.ts` — lines 52–53

Replace:
```typescript
      // TODO(stage-3b): assert workDir is always set, or compute a common
      // ancestor across `safe` instead of leaning on safe[0].
```

With:
```typescript
      // Note: workDir is preferred; the dirname(safe[0]) fallback only works
      // when all files share a parent directory. All callers in the pipeline
      // supply workDir, so this is safe in practice.
```

### `packages/verify/src/extractors/rust.ts` — lines 52–53

Replace:
```typescript
      // TODO(stage-3b): assert workDir is always set, or compute a common
      // ancestor across `safe` instead of leaning on safe[0].
```

With:
```typescript
      // Note: workDir is preferred; the dirname(safe[0]) fallback only works
      // when all files share a parent directory. All callers in the pipeline
      // supply workDir, so this is safe in practice.
```

---

## Validation

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
```

No test changes needed — this is comment-only. Test count stays at 1115 passed / 6 skipped.

---

## Constraints

- **No logic changes** — only the two comment lines change.
- **No new tests** — comment cleanup only.
- Do not touch any other files.
