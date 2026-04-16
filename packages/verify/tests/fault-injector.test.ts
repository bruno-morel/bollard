import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    execFile: execFileMock,
  }
})

import { type FaultSpec, createFaultInjector } from "../src/fault-injector.js"

describe("createFaultInjector", () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns no-op injector when docker compose is unavailable", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      if (typeof cb === "function") {
        process.nextTick(() => (cb as (err: Error | null) => void)(new Error("docker not found")))
      }
    })
    const log: string[] = []
    const inj = await createFaultInjector("/tmp/c.yml", "/tmp", (m) => log.push(m))
    const h = await inj.inject({ type: "service_stop", target: "db" })
    await h.remove()
    await inj.cleanup()
    expect(log.some((l) => l.includes("docker unavailable"))).toBe(true)
  })

  it("injects service_stop and remove restarts service", async () => {
    const calls: string[][] = []
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      if (typeof cb !== "function") return
      calls.push([String(cmd), ...args.map(String)])
      if (args[0] === "compose" && args[1] === "version") {
        process.nextTick(() => cb(null, Buffer.from("v2"), Buffer.from("")))
      } else {
        process.nextTick(() => cb(null, Buffer.from(""), Buffer.from("")))
      }
    })

    const inj = await createFaultInjector("/app/compose.yml", "/app")
    const h = await inj.inject({ type: "service_stop", target: "redis" })
    expect(calls.some((c) => c.includes("stop") && c.includes("redis"))).toBe(true)
    await h.remove()
    expect(calls.some((c) => c.includes("start") && c.includes("redis"))).toBe(true)
  })

  it("cleanup starts all stopped services", async () => {
    const calls: string[][] = []
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      if (typeof cb !== "function") return
      calls.push([String(cmd), ...args.map(String)])
      if (args[0] === "compose" && args[1] === "version") {
        process.nextTick(() => cb(null, Buffer.from("v2"), Buffer.from("")))
      } else {
        process.nextTick(() => cb(null, Buffer.from(""), Buffer.from("")))
      }
    })

    const inj = await createFaultInjector("/app/compose.yml", "/app")
    await inj.inject({ type: "service_stop", target: "a" })
    await inj.inject({ type: "service_stop", target: "b" })
    await inj.cleanup()
    const starts = calls.filter((c) => c.includes("start"))
    expect(starts.length).toBeGreaterThanOrEqual(2)
  })

  it("throws FAULT_INJECTION_FAILED for unsupported fault types", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (typeof cb !== "function") return
      if (args[0] === "compose" && args[1] === "version") {
        process.nextTick(() => cb(null, Buffer.from("v2"), Buffer.from("")))
      } else {
        process.nextTick(() => cb(null, Buffer.from(""), Buffer.from("")))
      }
    })

    const inj = await createFaultInjector("/app/compose.yml", "/app")
    const unsupported = { type: "network_delay", target: "x" } as unknown as FaultSpec
    await expect(inj.inject(unsupported)).rejects.toMatchObject({ code: "FAULT_INJECTION_FAILED" })
  })
})
