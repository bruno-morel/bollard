import type { ProbeAssertion, ProbeDefinition } from "@bollard/engine/src/blueprint.js"
import { BollardError } from "@bollard/engine/src/errors.js"

import type { AssertionResult, ProbeExecutor, ProbeResult } from "./providers/types.js"

const DEFAULT_TIMEOUT_MS = 30_000

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/$/, "")
  const p = path.startsWith("/") ? path : `/${path}`
  return `${b}${p}`
}

function getAtPath(obj: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean)
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function evaluateAssertion(
  assertion: ProbeAssertion,
  status: number,
  latencyMs: number,
  bodyText: string,
  parsedJson: unknown,
  headers: Headers,
): AssertionResult {
  switch (assertion.type) {
    case "status": {
      const ok = status === Number(assertion.expected)
      return {
        assertion,
        passed: ok,
        actual: status,
        ...(ok ? {} : { error: `expected status ${String(assertion.expected)}, got ${status}` }),
      }
    }
    case "latency": {
      const max = assertion.maxMs ?? 5000
      const ok = latencyMs <= max
      return {
        assertion,
        passed: ok,
        actual: latencyMs,
        ...(ok ? {} : { error: `latency ${latencyMs}ms exceeds ${max}ms` }),
      }
    }
    case "json_field": {
      const path = assertion.path ?? ""
      const actual = getAtPath(parsedJson, path)
      const ok =
        JSON.stringify(actual) === JSON.stringify(assertion.expected) ||
        actual === assertion.expected
      return {
        assertion,
        passed: ok,
        actual,
        ...(ok ? {} : { error: `json_field ${path} mismatch` }),
      }
    }
    case "body_contains": {
      const sub = String(assertion.expected)
      const ok = bodyText.includes(sub)
      return {
        assertion,
        passed: ok,
        ...(ok ? {} : { error: `body does not contain ${sub}` }),
      }
    }
    case "body_matches": {
      let re: RegExp
      try {
        re = new RegExp(String(assertion.expected))
      } catch {
        return { assertion, passed: false, error: "invalid body_matches regex" }
      }
      const ok = re.test(bodyText)
      return {
        assertion,
        passed: ok,
        ...(ok ? {} : { error: "body does not match regex" }),
      }
    }
    case "header": {
      const name = assertion.name ?? ""
      const actual = headers.get(name)
      const ok = actual === String(assertion.expected)
      return {
        assertion,
        passed: ok,
        actual,
        ...(ok
          ? {}
          : {
              error: `header ${name} expected ${String(assertion.expected)}, got ${actual ?? ""}`,
            }),
      }
    }
  }
}

export interface HttpProbeExecutorOptions {
  timeoutMs?: number
}

export class HttpProbeExecutor implements ProbeExecutor {
  constructor(private readonly opts: HttpProbeExecutorOptions = {}) {}

  async execute(probe: ProbeDefinition, baseUrl: string): Promise<ProbeResult> {
    const url = joinUrl(baseUrl, probe.endpoint)
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()
    const hdrs: Record<string, string> = { ...(probe.headers ?? {}) }
    if (probe.method === "POST" && probe.body !== undefined) {
      hdrs["content-type"] = hdrs["content-type"] ?? "application/json"
    }
    let res: Response
    try {
      const init: RequestInit = {
        method: probe.method,
        headers: hdrs,
        signal: controller.signal,
        ...(probe.method === "POST" && probe.body !== undefined
          ? { body: JSON.stringify(probe.body) }
          : {}),
      }
      res = await fetch(url, init)
    } catch (err: unknown) {
      clearTimeout(t)
      const msg = err instanceof Error ? err.message : String(err)
      throw new BollardError({
        code: "PROBE_EXECUTION_FAILED",
        message: `Probe ${probe.id} request failed: ${msg}`,
        context: { probeId: probe.id, url },
      })
    }
    clearTimeout(t)
    const latencyMs = Date.now() - started
    const bodyText = await res.text()
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(bodyText) as unknown
    } catch {
      parsedJson = undefined
    }
    const assertions: AssertionResult[] = []
    for (const a of probe.assertions) {
      assertions.push(
        evaluateAssertion(a, res.status, latencyMs, bodyText, parsedJson, res.headers),
      )
    }
    const allPass = assertions.every((x) => x.passed)
    return {
      probeId: probe.id,
      timestamp: Date.now(),
      status: allPass ? "pass" : "fail",
      assertions,
      latencyMs,
      ...(probe.sourceRunId !== undefined ? { sourceRunId: probe.sourceRunId } : {}),
    }
  }
}
