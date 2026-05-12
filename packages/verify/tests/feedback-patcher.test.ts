import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const execFileMock = vi.hoisted(() => vi.fn())
const spawnMock = vi.hoisted(() => vi.fn())
const isBinaryAvailableMock = vi.hoisted(() => vi.fn())
const checkRamFloorMock = vi.hoisted(() => vi.fn())
const localProviderChatMock = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    execFile: execFileMock,
    spawn: spawnMock,
  }
})

vi.mock("@bollard/llm/src/providers/local.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bollard/llm/src/providers/local.js")>()
  return {
    ...actual,
    isBinaryAvailable: isBinaryAvailableMock,
    checkRamFloor: checkRamFloorMock,
    LocalProvider: class {
      chat = localProviderChatMock
    },
  }
})

import { BollardError } from "@bollard/engine/src/errors.js"
import {
  buildPatcherFeedback,
  runDeterministicAutofix,
  runLocalPatcher,
} from "../src/feedback-patcher.js"

function execFileCallbackSuccess() {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    if (typeof cb === "function") {
      process.nextTick(() => cb(null, Buffer.from(""), Buffer.from("")))
    }
  })
}

describe("runDeterministicAutofix", () => {
  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns noop when failures is empty", async () => {
    const r = await runDeterministicAutofix("/tmp", [], undefined)
    expect(r).toEqual({ kind: "noop" })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it("returns noop when biome is not on PATH (ENOENT)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      if (typeof cb !== "function") return
      const err = Object.assign(new Error("spawn biome ENOENT"), { code: "ENOENT" })
      process.nextTick(() => cb(err))
    })
    const r = await runDeterministicAutofix("/tmp", ["## lint FAILED\nformat issue"], undefined)
    expect(r).toEqual({ kind: "noop" })
  })

  it("returns fixed with lint when biome exits 0", async () => {
    execFileCallbackSuccess()
    const r = await runDeterministicAutofix("/tmp", ["## lint FAILED\nsomething"], undefined)
    expect(r).toEqual({ kind: "fixed", fixedChecks: ["lint"] })
    expect(execFileMock).toHaveBeenCalled()
  })
})

describe("runLocalPatcher", () => {
  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
    isBinaryAvailableMock.mockReset()
    checkRamFloorMock.mockReset()
    localProviderChatMock.mockReset()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns skipped when llama-cli binary not found", async () => {
    isBinaryAvailableMock.mockResolvedValue(false)
    const r = await runLocalPatcher(
      "/tmp",
      ["## typecheck FAILED\nx"],
      { minFreeRamGb: 3, timeoutSec: 60, cacheDir: "/c", cacheSizeGb: 5, registryUrl: "https://x" },
      undefined,
    )
    expect(r).toEqual({ kind: "skipped", reason: "llama-cli binary not found" })
  })

  it("returns skipped when insufficient free RAM", async () => {
    isBinaryAvailableMock.mockResolvedValue(true)
    checkRamFloorMock.mockReturnValue(false)
    const r = await runLocalPatcher(
      "/tmp",
      ["## typecheck FAILED\nx"],
      { minFreeRamGb: 3, timeoutSec: 60, cacheDir: "/c", cacheSizeGb: 5, registryUrl: "https://x" },
      undefined,
    )
    expect(r).toMatchObject({ kind: "skipped", reason: expect.stringMatching(/RAM/i) })
  })

  it("returns failed with PATCHER_PATCH_INVALID when model returns plain text", async () => {
    isBinaryAvailableMock.mockResolvedValue(true)
    checkRamFloorMock.mockReturnValue(true)
    localProviderChatMock.mockResolvedValue({
      content: [{ type: "text", text: "here is prose, not a diff" }],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
    })
    const r = await runLocalPatcher(
      "/tmp",
      ["## lint FAILED\noops"],
      { minFreeRamGb: 3, timeoutSec: 60, cacheDir: "/c", cacheSizeGb: 5, registryUrl: "https://x" },
      undefined,
    )
    expect(r.kind).toBe("failed")
    if (r.kind === "failed") {
      expect(r.error.code).toBe("PATCHER_PATCH_INVALID")
    }
  })

  it("does not throw when LocalProvider.chat rejects", async () => {
    isBinaryAvailableMock.mockResolvedValue(true)
    checkRamFloorMock.mockReturnValue(true)
    localProviderChatMock.mockRejectedValue(new Error("inference exploded"))
    await expect(
      runLocalPatcher(
        "/tmp",
        ["## lint FAILED\noops"],
        {
          minFreeRamGb: 3,
          timeoutSec: 60,
          cacheDir: "/c",
          cacheSizeGb: 5,
          registryUrl: "https://x",
        },
        undefined,
      ),
    ).resolves.toMatchObject({
      kind: "failed",
      error: { code: "PATCHER_PATCH_INVALID" },
    })
  })
})

describe("buildPatcherFeedback", () => {
  it("includes auto-fixed note when autofix fixed checks", () => {
    const out = buildPatcherFeedback(
      ["## typecheck FAILED\nerr"],
      { kind: "fixed", fixedChecks: ["lint"] },
      { kind: "skipped", reason: "no local config" },
    )
    expect(out).toContain("auto-fixed")
    expect(out).toContain("## typecheck FAILED")
  })

  it("includes local model note when patcher patched", () => {
    const out = buildPatcherFeedback(
      ["## typecheck FAILED\nerr"],
      { kind: "noop" },
      { kind: "patched", appliedChecks: ["lint"] },
    )
    expect(out).toContain("local model")
    expect(out).toContain("lint")
  })

  it("includes partial patch note when patcher failed", () => {
    const out = buildPatcherFeedback(
      ["## typecheck FAILED\nerr"],
      { kind: "noop" },
      {
        kind: "failed",
        error: new BollardError({
          code: "PATCHER_NO_PROGRESS",
          message: "patch applied but check still fails",
        }),
      },
    )
    expect(out).toContain("partially patched")
  })

  it("lists only remaining failures in the issues section", () => {
    const out = buildPatcherFeedback(
      ["## typecheck FAILED\nonly"],
      { kind: "noop" },
      { kind: "skipped", reason: "x" },
    )
    expect(out).toContain("## typecheck FAILED")
    expect(out).not.toContain("## lint FAILED")
  })
})
