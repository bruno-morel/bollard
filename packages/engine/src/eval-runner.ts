export interface EvalMessage {
  role: "user" | "assistant"
  content: string
}

export interface EvalTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface EvalResponse {
  content: { type: string; text?: string }[]
  usage: { inputTokens: number; outputTokens: number }
  costUsd: number
}

export interface EvalProvider {
  chat(request: {
    system: string
    messages: EvalMessage[]
    tools?: EvalTool[]
    maxTokens: number
    temperature: number
    model: string
  }): Promise<EvalResponse>
}

export interface EvalCase {
  id: string
  description: string
  systemPrompt: string
  messages: EvalMessage[]
  assertions: EvalAssertion[]
  tools?: EvalTool[]
  model?: string
  temperature?: number
}

export type EvalAssertionType =
  | "contains"
  | "not_contains"
  | "json_field"
  | "max_tokens"
  | "max_cost"
  | "matches_regex"

export interface EvalAssertion {
  type: EvalAssertionType
  value: string | number
  path?: string
  description?: string
}

export interface EvalAssertionResult {
  assertion: EvalAssertion
  passed: boolean
  actual?: string | number
  message?: string
}

export interface EvalRunDetail {
  runIndex: number
  allPassed: boolean
  assertions: EvalAssertionResult[]
  response: EvalResponse
  costUsd: number
  durationMs: number
}

export interface EvalRunResult {
  caseId: string
  runs: number
  passed: number
  passRate: number
  ok: boolean
  details: EvalRunDetail[]
}

export interface EvalOptions {
  runs?: number
  threshold?: number
  model: string
  maxTokens?: number
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc != null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      obj,
    )
}

function extractText(response: EvalResponse): string {
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
}

function checkAssertion(assertion: EvalAssertion, response: EvalResponse): EvalAssertionResult {
  const text = extractText(response)

  switch (assertion.type) {
    case "contains":
      return {
        assertion,
        passed: text.includes(String(assertion.value)),
        actual: text.slice(0, 200),
        message: `Expected response to contain "${assertion.value}"`,
      }

    case "not_contains":
      return {
        assertion,
        passed: !text.includes(String(assertion.value)),
        actual: text.slice(0, 200),
        message: `Expected response to NOT contain "${assertion.value}"`,
      }

    case "matches_regex": {
      try {
        const regex = new RegExp(String(assertion.value))
        return {
          assertion,
          passed: regex.test(text),
          actual: text.slice(0, 200),
          message: `Expected response to match regex /${assertion.value}/`,
        }
      } catch {
        return {
          assertion,
          passed: false,
          actual: text.slice(0, 200),
          message: `Invalid regex: ${assertion.value}`,
        }
      }
    }

    case "json_field": {
      try {
        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
        const jsonStr = jsonMatch ? (jsonMatch[1] ?? text) : text
        const parsed: unknown = JSON.parse(jsonStr.trim())
        const actual = getNestedValue(parsed, assertion.path ?? "")
        return {
          assertion,
          passed: String(actual) === String(assertion.value),
          actual: String(actual),
          message: `Expected ${assertion.path} to equal "${assertion.value}", got "${actual}"`,
        }
      } catch {
        return {
          assertion,
          passed: false,
          message: "Response is not valid JSON",
        }
      }
    }

    case "max_tokens":
      return {
        assertion,
        passed: response.usage.outputTokens <= Number(assertion.value),
        actual: response.usage.outputTokens,
        message: `Expected <= ${assertion.value} output tokens, got ${response.usage.outputTokens}`,
      }

    case "max_cost":
      return {
        assertion,
        passed: response.costUsd <= Number(assertion.value),
        actual: response.costUsd,
        message: `Expected cost <= $${assertion.value}, got $${response.costUsd}`,
      }
  }
}

export async function runEvals(
  cases: EvalCase[],
  provider: EvalProvider,
  options: EvalOptions,
): Promise<EvalRunResult[]> {
  const runs = options.runs ?? 3
  const threshold = options.threshold ?? 2 / 3
  const results: EvalRunResult[] = []

  for (const evalCase of cases) {
    const details: EvalRunDetail[] = []

    for (let i = 0; i < runs; i++) {
      const startMs = Date.now()
      const request: Parameters<EvalProvider["chat"]>[0] = {
        system: evalCase.systemPrompt,
        messages: evalCase.messages,
        maxTokens: options.maxTokens ?? 2048,
        temperature: evalCase.temperature ?? 0,
        model: evalCase.model ?? options.model,
      }
      if (evalCase.tools) {
        request.tools = evalCase.tools
      }
      const response = await provider.chat(request)
      const durationMs = Date.now() - startMs

      const assertionResults = evalCase.assertions.map((a) => checkAssertion(a, response))

      details.push({
        runIndex: i,
        allPassed: assertionResults.every((r) => r.passed),
        assertions: assertionResults,
        response,
        costUsd: response.costUsd,
        durationMs,
      })
    }

    const passed = details.filter((d) => d.allPassed).length
    const passRate = runs > 0 ? passed / runs : 0

    results.push({
      caseId: evalCase.id,
      runs,
      passed,
      passRate,
      ok: passRate >= threshold,
      details,
    })
  }

  return results
}
