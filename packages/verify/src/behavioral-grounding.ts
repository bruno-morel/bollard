import type { BehavioralContext } from "./behavioral-extractor.js"
import type { ContractCorpus } from "./contract-grounding.js"

/**
 * Flattens behavioral extraction into corpus strings for claim grounding
 * (substring match against quotes in claims).
 */
export function behavioralContextToCorpus(ctx: BehavioralContext): ContractCorpus {
  const entries: string[] = []

  for (const e of ctx.endpoints) {
    const auth = e.auth ? ` auth:${e.auth}` : ""
    entries.push(`endpoint:${e.method}:${e.path} handler:${e.handler} file:${e.sourceFile}${auth}`)
  }

  for (const c of ctx.config) {
    const def = c.defaultValue !== undefined ? ` default:${c.defaultValue}` : ""
    entries.push(`config:${c.key} source:${c.source}${def} file:${c.sourceFile}`)
  }

  for (const d of ctx.dependencies) {
    entries.push(
      `dependency:${d.name} type:${d.type} client:${d.clientLibrary} file:${d.sourceFile}`,
    )
  }

  for (const f of ctx.failureModes) {
    entries.push(`failure:${f.dependency} mode:${f.mode} severity:${f.severity}`)
  }

  return { entries }
}
