import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { constants as fsConstants } from "node:fs"
import { access, mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { LocalModelsConfig } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import type {
  LLMContentBlock,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
} from "../types.js"

export type LocalProviderConfig = LocalModelsConfig

const DEFAULT_MIN_FREE_RAM_GB = 3
const DEFAULT_TIMEOUT_SEC = 60
const DEFAULT_CACHE_DIR = "/var/cache/bollard/models"
const DEFAULT_CACHE_SIZE_GB = 5
const DEFAULT_REGISTRY_URL =
  "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main"

export const DEFAULT_MODEL_ID = "qwen2.5-coder-1.5b-instruct-q4_k_m"
export const MODEL_FILENAME = "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"

const CHATML_IM_START = "<|im_start|>"
const CHATML_IM_END = "<|im_end|>"
const PROMPT_STDIN_THRESHOLD = 2000
const LOCK_MAX_AGE_MS = 5 * 60 * 1000
const LOCK_POLL_MS = 500
const LOCK_WAIT_MAX_MS = 10 * 60 * 1000
const STDERR_SNIP_LEN = 500

function mergeLocalConfig(partial?: Partial<LocalModelsConfig>): LocalModelsConfig {
  return {
    minFreeRamGb: partial?.minFreeRamGb ?? DEFAULT_MIN_FREE_RAM_GB,
    timeoutSec: partial?.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    cacheDir: partial?.cacheDir ?? DEFAULT_CACHE_DIR,
    cacheSizeGb: partial?.cacheSizeGb ?? DEFAULT_CACHE_SIZE_GB,
    registryUrl: partial?.registryUrl ?? DEFAULT_REGISTRY_URL,
  }
}

export function checkRamFloor(minFreeRamGb: number): boolean {
  const freeBytes = os.freemem()
  const freeGb = freeBytes / 1024 ** 3
  return freeGb >= minFreeRamGb
}

function blockToText(block: LLMContentBlock): string {
  if (block.type === "text") {
    return block.text ?? ""
  }
  return JSON.stringify({
    type: block.type,
    toolName: block.toolName,
    toolUseId: block.toolUseId,
    toolInput: block.toolInput,
    text: block.text,
  })
}

function messageContentToString(content: LLMRequest["messages"][number]["content"]): string {
  if (typeof content === "string") {
    return content
  }
  return content.map(blockToText).join("")
}

/** Serializes request into Qwen ChatML (single prompt for llama.cpp). */
export function serializePrompt(request: LLMRequest, warn: (msg: string) => void): string {
  if (request.tools?.length) {
    warn(
      "LocalProvider: request includes tools — proceeding without tool binding (local tier is not for agentic tool loops)",
    )
  }

  const parts: string[] = []
  parts.push(`${CHATML_IM_START}system\n${request.system}${CHATML_IM_END}\n`)

  for (const m of request.messages) {
    if (m.role !== "user" && m.role !== "assistant") {
      continue
    }
    parts.push(
      `${CHATML_IM_START}${m.role}\n${messageContentToString(m.content)}${CHATML_IM_END}\n`,
    )
  }

  parts.push(`${CHATML_IM_START}assistant\n`)
  return parts.join("")
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function findBinary(): Promise<string | null> {
  const names = ["llama-cli", "llama-cpp", "llama"] as const
  const pathDirs = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean)
  for (const dir of pathDirs) {
    for (const name of names) {
      const full = path.join(dir, name)
      try {
        await access(full, fsConstants.X_OK)
        return full
      } catch {
        try {
          await access(full, fsConstants.F_OK)
          return full
        } catch {
          /* continue */
        }
      }
    }
  }
  return null
}

/** Returns true if a llama.cpp binary is found on PATH. Never throws. */
export async function isBinaryAvailable(): Promise<boolean> {
  return (await findBinary()) !== null
}

function effectiveRegistryUrl(registryUrlFromConfig: string): string {
  const fromEnv = process.env["BOLLARD_MODEL_REGISTRY_URL"]
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv.trim().replace(/\/$/, "")
  }
  return registryUrlFromConfig.replace(/\/$/, "")
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function tryAcquireLock(lockPath: string): Promise<boolean> {
  try {
    const fh = await open(lockPath, "wx")
    await fh.writeFile(`${process.pid}\n`)
    await fh.close()
    return true
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : ""
    if (code === "EEXIST") {
      return false
    }
    throw err
  }
}

async function lockAgeMs(lockPath: string): Promise<number | null> {
  try {
    const s = await stat(lockPath)
    return Date.now() - s.mtimeMs
  } catch {
    return null
  }
}

export async function resolveModelPath(
  cacheDir: string,
  registryUrl: string,
  _warn: (msg: string) => void,
): Promise<string> {
  await mkdir(cacheDir, { recursive: true })
  const finalPath = path.join(cacheDir, MODEL_FILENAME)
  if (await pathExists(finalPath)) {
    return finalPath
  }

  const binary = await findBinary()
  if (!binary) {
    throw new BollardError({
      code: "LOCAL_MODEL_NOT_AVAILABLE",
      message: "Local model binary not found on PATH (llama-cli, llama-cpp, llama)",
      context: { reason: "binary_missing" as const },
    })
  }

  const lockPath = `${finalPath}.lock`
  const waitDeadline = Date.now() + LOCK_WAIT_MAX_MS

  while (Date.now() < waitDeadline) {
    if (await pathExists(finalPath)) {
      return finalPath
    }

    const lockAge = await lockAgeMs(lockPath)
    if (lockAge !== null && lockAge > LOCK_MAX_AGE_MS) {
      try {
        await unlink(lockPath)
      } catch {
        /* ignore */
      }
    }

    const acquired = await tryAcquireLock(lockPath)
    if (acquired) {
      try {
        if (await pathExists(finalPath)) {
          return finalPath
        }
        const base = effectiveRegistryUrl(registryUrl)
        const url = `${base}/${MODEL_FILENAME}`
        const partPath = path.join(cacheDir, `${MODEL_FILENAME}.${randomUUID()}.part`)

        const res = await fetch(url)
        if (!res.ok || !res.body) {
          throw new BollardError({
            code: "LOCAL_MODEL_PULL_FAILED",
            message: `Failed to download model: HTTP ${res.status} ${res.statusText}`,
            context: { url, status: res.status },
          })
        }

        const buf = Buffer.from(await res.arrayBuffer())
        await writeFile(partPath, buf)
        await rename(partPath, finalPath)
        return finalPath
      } catch (err: unknown) {
        if (BollardError.is(err)) {
          throw err
        }
        const message = err instanceof Error ? err.message : String(err)
        throw new BollardError({
          code: "LOCAL_MODEL_PULL_FAILED",
          message: `Model pull failed: ${message}`,
          ...(err instanceof Error ? { cause: err } : {}),
          context: { url: `${effectiveRegistryUrl(registryUrl)}/${MODEL_FILENAME}` },
        })
      } finally {
        try {
          await unlink(lockPath)
        } catch {
          /* ignore */
        }
      }
    }

    const age = await lockAgeMs(lockPath)
    if (age !== null && age < LOCK_MAX_AGE_MS) {
      await sleep(LOCK_POLL_MS)
      continue
    }
    await sleep(LOCK_POLL_MS)
  }

  throw new BollardError({
    code: "LOCAL_MODEL_PULL_FAILED",
    message: "Timed out waiting for concurrent model download or lock release",
    context: { lockPath, finalPath },
  })
}

function buildLlamaArgs(
  binaryPath: string,
  modelPath: string,
  prompt: string,
  request: LLMRequest,
  useStdinPrompt: boolean,
): { file: string; args: string[]; stdinPayload: string | null } {
  const baseArgs = [
    "--model",
    modelPath,
    "--n-predict",
    String(request.maxTokens),
    "--temp",
    String(request.temperature),
    "--ctx-size",
    "2048",
    "--threads",
    "4",
    "--no-display-prompt",
    "--log-disable",
    "-e",
  ] as const

  if (useStdinPrompt) {
    return {
      file: binaryPath,
      args: [...baseArgs, "--file", "-"],
      stdinPayload: prompt,
    }
  }
  return {
    file: binaryPath,
    args: [...baseArgs, "--prompt", prompt],
    stdinPayload: null,
  }
}

async function runInference(
  binaryPath: string,
  modelPath: string,
  prompt: string,
  request: LLMRequest,
  timeoutSec: number,
): Promise<string> {
  const useStdin = prompt.length > PROMPT_STDIN_THRESHOLD
  const { file, args, stdinPayload } = buildLlamaArgs(
    binaryPath,
    modelPath,
    prompt,
    request,
    useStdin,
  )

  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })

    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(
        new BollardError({
          code: "LOCAL_MODEL_TIMEOUT",
          message: `Local inference exceeded ${timeoutSec}s`,
          context: { timeoutSec },
        }),
      )
    }, timeoutSec * 1000)

    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      err += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    })

    child.on("error", (cause) => {
      clearTimeout(timer)
      reject(
        new BollardError({
          code: "LOCAL_MODEL_NOT_AVAILABLE",
          message: `Failed to spawn llama.cpp: ${cause.message}`,
          cause,
          context: { reason: "spawn_error" as const },
        }),
      )
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(out)
        return
      }
      const snip = err.slice(0, STDERR_SNIP_LEN)
      reject(
        new BollardError({
          code: "LOCAL_MODEL_NOT_AVAILABLE",
          message: `llama-cli exited with code ${code ?? "unknown"}`,
          context: { reason: "inference_failed" as const, exitCode: code, stderr: snip },
        }),
      )
    })

    if (stdinPayload !== null) {
      child.stdin?.write(stdinPayload, "utf8", () => {
        child.stdin?.end()
      })
    } else {
      child.stdin?.end()
    }
  })
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function defaultWarn(msg: string): void {
  console.warn(msg)
}

export class LocalProvider implements LLMProvider {
  readonly name = "local"

  constructor(private readonly partialConfig?: Partial<LocalModelsConfig>) {}

  private warn = defaultWarn

  private merged(): LocalModelsConfig {
    return mergeLocalConfig(this.partialConfig)
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const cfg = this.merged()
    if (!checkRamFloor(cfg.minFreeRamGb)) {
      const freeGb = os.freemem() / 1024 ** 3
      throw new BollardError({
        code: "LOCAL_MODEL_NOT_AVAILABLE",
        message: `Insufficient free RAM for local inference (need >= ${cfg.minFreeRamGb} GiB free)`,
        context: { reason: "ram_floor" as const, freeGb, minFreeRamGb: cfg.minFreeRamGb },
      })
    }

    const modelPath = await resolveModelPath(cfg.cacheDir, cfg.registryUrl, this.warn)
    const binaryPath = await findBinary()
    if (!binaryPath) {
      throw new BollardError({
        code: "LOCAL_MODEL_NOT_AVAILABLE",
        message: "Local model binary not found on PATH",
        context: { reason: "binary_missing" as const },
      })
    }

    const prompt = serializePrompt(request, this.warn)
    const raw = await runInference(binaryPath, modelPath, prompt, request, cfg.timeoutSec)
    const text = raw.trim()

    const inputTokens = estimateTokens(prompt)
    const outputTokens = estimateTokens(text)

    return {
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      usage: { inputTokens, outputTokens },
      costUsd: 0,
    }
  }

  async *chatStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const cfg = this.merged()
    if (!checkRamFloor(cfg.minFreeRamGb)) {
      const freeGb = os.freemem() / 1024 ** 3
      throw new BollardError({
        code: "LOCAL_MODEL_NOT_AVAILABLE",
        message: `Insufficient free RAM for local inference (need >= ${cfg.minFreeRamGb} GiB free)`,
        context: { reason: "ram_floor" as const, freeGb, minFreeRamGb: cfg.minFreeRamGb },
      })
    }

    const modelPath = await resolveModelPath(cfg.cacheDir, cfg.registryUrl, this.warn)
    const binaryPath = await findBinary()
    if (!binaryPath) {
      throw new BollardError({
        code: "LOCAL_MODEL_NOT_AVAILABLE",
        message: "Local model binary not found on PATH",
        context: { reason: "binary_missing" as const },
      })
    }

    const prompt = serializePrompt(request, this.warn)
    const useStdin = prompt.length > PROMPT_STDIN_THRESHOLD
    const { file, args, stdinPayload } = buildLlamaArgs(
      binaryPath,
      modelPath,
      prompt,
      request,
      useStdin,
    )

    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })

    const closePromise = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>

    let stderrBuf = ""
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, cfg.timeoutSec * 1000)

    try {
      if (stdinPayload !== null) {
        child.stdin?.write(stdinPayload, "utf8")
        child.stdin?.end()
      } else {
        child.stdin?.end()
      }

      const stdout = child.stdout
      if (!stdout) {
        throw new BollardError({
          code: "LOCAL_MODEL_NOT_AVAILABLE",
          message: "llama-cli has no stdout pipe",
          context: { reason: "spawn_error" as const },
        })
      }

      let assembled = ""
      for await (const chunk of stdout) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
        assembled += text
        if (text.length > 0) {
          yield { type: "text_delta", text }
        }
      }

      const [exitCode] = await closePromise

      if (timedOut) {
        throw new BollardError({
          code: "LOCAL_MODEL_TIMEOUT",
          message: `Local inference exceeded ${cfg.timeoutSec}s`,
          context: { timeoutSec: cfg.timeoutSec },
        })
      }

      if (exitCode !== 0) {
        throw new BollardError({
          code: "LOCAL_MODEL_NOT_AVAILABLE",
          message: `llama-cli exited with code ${exitCode ?? "unknown"}`,
          context: {
            reason: "inference_failed" as const,
            exitCode,
            stderr: stderrBuf.slice(0, STDERR_SNIP_LEN),
          },
        })
      }

      const trimmed = assembled.trim()
      yield {
        type: "message_complete",
        response: {
          content: [{ type: "text", text: trimmed }],
          stopReason: "end_turn",
          usage: {
            inputTokens: estimateTokens(prompt),
            outputTokens: estimateTokens(trimmed),
          },
          costUsd: 0,
        },
      }
    } catch (err: unknown) {
      if (BollardError.is(err)) {
        throw err
      }
      clearTimeout(timer)
      throw new BollardError({
        code: "LOCAL_MODEL_NOT_AVAILABLE",
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error ? { cause: err } : {}),
        context: { reason: "stream_error" as const },
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
