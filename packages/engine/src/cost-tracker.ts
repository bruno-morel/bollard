import type { PipelineContext } from "./context.js"
import { BollardError } from "./errors.js"

export class CostTracker {
  private _total = 0
  private readonly _limit: number

  constructor(limitUsd: number) {
    if (!Number.isFinite(limitUsd) || limitUsd < 0) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `Limit must be a non-negative finite number, got: ${limitUsd}`,
        context: { limitUsd },
      })
    }
    this._limit = limitUsd
  }

  add(costUsd: number, ctx?: PipelineContext): void {
    ctx?.log?.debug?.("cost:add")
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `Cost must be a non-negative finite number, got: ${costUsd}`,
        context: { costUsd },
      })
    }
    this._total += costUsd
  }

  subtract(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `Amount must be a non-negative finite number, got: ${usd}`,
        context: { usd },
      })
    }
    if (this._total - usd < 0) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `Cannot subtract ${usd} from total ${this._total}: result would be negative`,
        context: { usd, currentTotal: this._total },
      })
    }
    this._total -= usd
  }

  total(): number {
    return this._total
  }

  exceeded(): boolean {
    return this._total > this._limit
  }

  remaining(): number {
    return Math.max(0, this._limit - this._total)
  }

  reset(): number {
    const previousTotal = this._total
    this._total = 0
    return previousTotal
  }

  snapshot(): Readonly<{ totalCostUsd: number }> {
    return Object.freeze({ totalCostUsd: this._total })
  }
}
