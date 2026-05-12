import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LLMClient } from "../src/client.js"
import {
  LocalProvider,
  MODEL_FILENAME,
  checkRamFloor,
  resolveModelPath,
  serializePrompt,
} from "../src/providers/local.js"
import type { LLMRequest } from "../src/types.js"

const baseRequest: LLMRequest = {
  system: "You are helpful",
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 32,
  temperature: 0.1,
  model: "qwen2.5-coder-1.5b-instruct-q4_k_m",
}

function noopWarn(_msg: string): void {}

describe("LocalProvider", () => {
  describe("RAM floor check", () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it("throws LOCAL_MODEL_NOT_AVAILABLE when free RAM is below floor", async () => {
      vi.spyOn(os, "freemem").mockReturnValue(100)
      const provider = new LocalProvider({ minFreeRamGb: 3 })
      await expect(provider.chat(baseRequest)).rejects.toMatchObject({
        code: "LOCAL_MODEL_NOT_AVAILABLE",
      })
    })

    it("proceeds when free RAM meets floor (checkRamFloor)", () => {
      vi.spyOn(os, "freemem").mockReturnValue(8 * 1024 ** 3)
      expect(checkRamFloor(3)).toBe(true)
    })
  })

  describe("prompt serialization", () => {
    it("serializes system + user message into ChatML format", () => {
      const s = serializePrompt(baseRequest, noopWarn)
      expect(s).toContain("<|im_start|>system")
      expect(s).toContain("You are helpful")
      expect(s).toContain("<|im_start|>user")
      expect(s).toContain("Hello")
      expect(s).toContain("<|im_start|>assistant")
    })

    it("serializes multi-turn conversation correctly", () => {
      const req: LLMRequest = {
        ...baseRequest,
        messages: [
          { role: "user", content: "First" },
          { role: "assistant", content: "Second" },
          { role: "user", content: "Third" },
        ],
      }
      const s = serializePrompt(req, noopWarn)
      expect(s).toMatch(/First[\s\S]*Second[\s\S]*Third/)
    })

    it("includes assistant turns in serialized prompt", () => {
      const req: LLMRequest = {
        ...baseRequest,
        messages: [{ role: "assistant", content: "prior reply" }],
      }
      const s = serializePrompt(req, noopWarn)
      expect(s).toContain("<|im_start|>assistant")
      expect(s).toContain("prior reply")
    })

    it("logs warning when request includes tools", () => {
      const warn = vi.fn()
      serializePrompt(
        { ...baseRequest, tools: [{ name: "x", description: "d", inputSchema: {} }] },
        warn,
      )
      expect(warn).toHaveBeenCalled()
    })
  })

  describe("model path resolution", () => {
    it("returns existing model path without pulling", async () => {
      const dir = path.join(os.tmpdir(), `bollard-model-${Date.now()}`)
      await mkdir(dir, { recursive: true })
      const full = path.join(dir, MODEL_FILENAME)
      await writeFile(full, "stub", "utf8")
      const p = await resolveModelPath(dir, "https://example.com/ignored", noopWarn)
      expect(p).toBe(full)
    })

    it("throws LOCAL_MODEL_NOT_AVAILABLE when binary is missing and model is absent", async () => {
      const dir = path.join(os.tmpdir(), `bollard-nobin-${Date.now()}`)
      await mkdir(dir, { recursive: true })
      const prevPath = process.env["PATH"]
      process.env["PATH"] = ""
      try {
        await expect(
          resolveModelPath(dir, "https://example.com/x", noopWarn),
        ).rejects.toMatchObject({
          code: "LOCAL_MODEL_NOT_AVAILABLE",
        })
      } finally {
        process.env["PATH"] = prevPath
      }
    })
  })

  describe("LLMResponse shape (mocked llama-cli)", () => {
    let cacheDir = ""
    let fakeBinDir = ""
    let prevPath = ""

    beforeEach(async () => {
      cacheDir = path.join(os.tmpdir(), `bollard-llm-${Date.now()}`)
      fakeBinDir = path.join(os.tmpdir(), `bollard-bin-${Date.now()}`)
      await mkdir(cacheDir, { recursive: true })
      await mkdir(fakeBinDir, { recursive: true })
      const script = path.join(fakeBinDir, "llama-cli")
      await writeFile(
        script,
        "#!/bin/sh\n# ignore args; emit fixed completion\nprintf 'mock completion'",
        { mode: 0o755 },
      )
      prevPath = process.env["PATH"] ?? ""
      process.env["PATH"] = `${fakeBinDir}${path.delimiter}${prevPath}`
      await writeFile(path.join(cacheDir, MODEL_FILENAME), "gguf-stub", "utf8")
    })

    afterEach(() => {
      process.env["PATH"] = prevPath
      vi.restoreAllMocks()
    })

    it("returns costUsd: 0", async () => {
      vi.spyOn(os, "freemem").mockReturnValue(8 * 1024 ** 3)
      const provider = new LocalProvider({ cacheDir, minFreeRamGb: 0 })
      const r = await provider.chat(baseRequest)
      expect(r.costUsd).toBe(0)
    })

    it("returns stopReason: end_turn", async () => {
      vi.spyOn(os, "freemem").mockReturnValue(8 * 1024 ** 3)
      const provider = new LocalProvider({ cacheDir, minFreeRamGb: 0 })
      const r = await provider.chat(baseRequest)
      expect(r.stopReason).toBe("end_turn")
    })

    it("approximates token counts from char length", async () => {
      vi.spyOn(os, "freemem").mockReturnValue(8 * 1024 ** 3)
      const provider = new LocalProvider({ cacheDir, minFreeRamGb: 0 })
      const r = await provider.chat(baseRequest)
      expect(r.usage.inputTokens).toBeGreaterThan(0)
      expect(r.usage.outputTokens).toBeGreaterThan(0)
    })

    it("streams text_delta events via chatStream", async () => {
      vi.spyOn(os, "freemem").mockReturnValue(8 * 1024 ** 3)
      const provider = new LocalProvider({ cacheDir, minFreeRamGb: 0 })
      const deltas: string[] = []
      for await (const ev of provider.chatStream(baseRequest)) {
        if (ev.type === "text_delta") {
          deltas.push(ev.text)
        }
        if (ev.type === "message_complete") {
          expect(ev.response.costUsd).toBe(0)
        }
      }
      expect(deltas.join("")).toContain("mock")
    })
  })
})

describe("LLMClient with local provider", () => {
  it("resolves 'local' provider name without throwing", () => {
    const config: BollardConfig = {
      llm: { default: { provider: "local", model: "qwen2.5-coder-1.5b-instruct-q4_k_m" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    }
    const client = new LLMClient(config)
    const { provider } = client.forAgent("any")
    expect(provider.name).toBe("local")
    expect(provider).toBeInstanceOf(LocalProvider)
  })

  it("passes localModels config to LocalProvider", async () => {
    vi.spyOn(os, "freemem").mockReturnValue(100)
    const config: BollardConfig = {
      llm: { default: { provider: "local", model: "x" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
      localModels: { minFreeRamGb: 4000 },
    }
    const client = new LLMClient(config)
    const { provider } = client.forAgent("a")
    await expect(provider.chat(baseRequest)).rejects.toMatchObject({
      code: "LOCAL_MODEL_NOT_AVAILABLE",
    })
    vi.restoreAllMocks()
  })

  it("uses LocalProvider defaults when localModels is undefined", async () => {
    vi.spyOn(os, "freemem").mockReturnValue(100)
    const config: BollardConfig = {
      llm: { default: { provider: "local", model: "x" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    }
    const client = new LLMClient(config)
    const { provider } = client.forAgent("b")
    await expect(provider.chat(baseRequest)).rejects.toMatchObject({
      code: "LOCAL_MODEL_NOT_AVAILABLE",
    })
    vi.restoreAllMocks()
  })

  it("caches LocalProvider instance", () => {
    const config: BollardConfig = {
      llm: { default: { provider: "local", model: "x" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    }
    const client = new LLMClient(config)
    expect(client.forAgent("a").provider).toBe(client.forAgent("b").provider)
  })
})

describe.skipIf(!process.env["BOLLARD_LOCAL_RUNTIME"])("LocalProvider live", () => {
  it("generates a short completion from a real model", async () => {
    const provider = new LocalProvider()
    const r = await provider.chat({
      system: "Reply with exactly: OK",
      messages: [{ role: "user", content: "Go." }],
      maxTokens: 16,
      temperature: 0,
      model: "qwen2.5-coder-1.5b-instruct-q4_k_m",
    })
    expect(r.content[0]?.type).toBe("text")
    expect(r.costUsd).toBe(0)
  })

  it("streams text_delta events via chatStream", async () => {
    const provider = new LocalProvider()
    let sawDelta = false
    let sawComplete = false
    for await (const ev of provider.chatStream({
      system: "Say hi in one word.",
      messages: [{ role: "user", content: "Hi" }],
      maxTokens: 8,
      temperature: 0,
      model: "qwen2.5-coder-1.5b-instruct-q4_k_m",
    })) {
      if (ev.type === "text_delta") {
        sawDelta = true
      }
      if (ev.type === "message_complete") {
        sawComplete = true
      }
    }
    expect(sawDelta).toBe(true)
    expect(sawComplete).toBe(true)
  })
})
