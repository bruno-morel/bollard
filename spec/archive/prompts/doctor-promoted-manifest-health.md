# Cursor Prompt — `bollard doctor`: Promoted Manifest Health

> **Context:** Stage 5a Phase 4b shipped `.bollard/promoted.json` — a manifest that tracks adversarial tests that have been promoted to the permanent test suite via `bollard promote-test`. `bollard doctor --history` already surfaces run history health. This prompt adds promoted manifest health to the same `--history` output so developers can see at a glance how many tests have been promoted and when the last promotion happened.
>
> **Read CLAUDE.md fully before writing any code.** Then read:
> - `packages/cli/src/doctor.ts` — full file (HistoryHealth, checkHistoryHealth, formatHistorySection, DoctorReport)
> - `packages/engine/src/test-fingerprint.ts` — readPromotedManifest, PromotedManifest, PromotedTest
> - `packages/cli/src/index.ts` — how `doctor --history` is invoked (search for "doctor")

---

## What to build — small, self-contained

### 1. Add `PromotedManifestHealth` to `packages/cli/src/doctor.ts`

New interface (add after `HistoryHealth`):

```typescript
export interface PromotedManifestHealth {
  manifestExists: boolean
  promotedCount: number
  lastPromotedAt?: number   // Date.now() timestamp of most recent entry
}
```

### 2. Add `checkPromotedManifestHealth(workDir: string): Promise<PromotedManifestHealth>`

New async function in `doctor.ts`:

```typescript
async function checkPromotedManifestHealth(workDir: string): Promise<PromotedManifestHealth> {
  const { readPromotedManifest } = await import("@bollard/engine/src/test-fingerprint.js")
  const manifest = await readPromotedManifest(workDir)
  const manifestExists = manifest.promoted.length > 0
  const promotedCount = manifest.promoted.length
  const timestamps = manifest.promoted.map((p) => p.promotedAt).filter((t) => t > 0)
  const lastPromotedAt = timestamps.length > 0 ? Math.max(...timestamps) : undefined
  return {
    manifestExists,
    promotedCount,
    ...(lastPromotedAt !== undefined ? { lastPromotedAt } : {}),
  }
}
```

Note: `readPromotedManifest` returns `{ schemaVersion: 1, promoted: [] }` on ENOENT — so `manifestExists: false` simply means `promotedCount === 0`.

### 3. Add `promotedManifestHealth?: PromotedManifestHealth` to `HistoryHealth`

Add the optional field at the end of `HistoryHealth`:

```typescript
export interface HistoryHealth {
  // ... existing fields unchanged ...
  promotedManifestHealth?: PromotedManifestHealth
}
```

### 4. Call it from `checkHistoryHealth`

At the end of `checkHistoryHealth`, before the return statement:

```typescript
  const promotedManifestHealth = await checkPromotedManifestHealth(workDir)
  return {
    // ...existing fields...
    promotedManifestHealth,
  }
```

### 5. Add display in `formatHistorySection`

After the mutation score block, add:

```typescript
  const pm = h.promotedManifestHealth
  if (pm !== undefined) {
    if (pm.promotedCount === 0) {
      lines.push(`    ${DIM}○${RESET} No promoted tests (use bollard promote-test to promote passing adversarial tests)`)
    } else {
      const lastStr = pm.lastPromotedAt !== undefined ? `, last ${formatRelativeShort(pm.lastPromotedAt)}` : ""
      lines.push(`    ${GREEN}✓${RESET} Promoted tests: ${pm.promotedCount}${lastStr}`)
    }
  }
```

---

## Tests to add

### `packages/cli/tests/doctor-promoted.test.ts` (new — 3 tests)

Use `os.tmpdir()` + `crypto.randomUUID()` for temp workspace.

1. `checkPromotedManifestHealth` returns `{ manifestExists: false, promotedCount: 0 }` when `.bollard/promoted.json` is absent
2. `checkPromotedManifestHealth` returns correct count and `lastPromotedAt` when manifest has entries
3. `formatHistorySection` includes the promoted-tests line when `promotedManifestHealth` is present

For test 3, construct a minimal `HistoryHealth` object with `promotedManifestHealth` set and call `formatHistorySection` directly — check that the output contains `"Promoted tests:"` or `"No promoted tests"`.

---

## Validation

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: clean typecheck + lint; test count goes from 1115 to **1118** (+3).

---

## Constraints

- Only `doctor.ts` changes for the main logic. No changes to `index.ts` (the `--history` flag wiring is already correct — it calls `checkHistoryHealth` which will now include promoted manifest data automatically).
- `exactOptionalPropertyTypes` — no explicit `undefined` assignments. Use spread with ternary.
- No new CLI flags — this data folds into the existing `--history` output.
- Follow existing no-class, named-export, kebab-case-files conventions.
