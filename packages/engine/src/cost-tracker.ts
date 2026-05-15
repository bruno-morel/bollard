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

  add(costUsd: number, ctx?: PipelineContext): CostTracker {
    ctx?.log?.debug?.("cost:add")
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `Cost must be a non-negative finite number, got: ${costUsd}`,
        context: { costUsd },
      })
    }
    this._total += costUsd
    return this
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

  peek(): number {
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

  divide(divisor: number): CostTracker {
    if (!Number.isFinite(divisor) || divisor <= 0) {
      throw new BollardError({
        code: "COST_LIMIT_EXCEEDED",
        message: `Divisor must be a positive finite number, got: ${divisor}`,
        context: { divisor },
      })
    }
    this._total = this._total / divisor
    return this
  }

  snapshot(): Readonly<{ totalCostUsd: number }> {
    return Object.freeze({ totalCostUsd: this._total })
  }

  summary(): string {
    const totalFormatted = this._total.toFixed(2)
    const limitFormatted = this._limit.toFixed(2)

    // Handle percentage calculation with edge case for zero limit
    let percentage: number
    if (this._limit === 0) {
      // When limit is 0, if total is also 0, percentage is 0%
      // If total > 0, we show it as exceeded (100% to avoid "Infinity")
      percentage = this._total === 0 ? 0 : 100
    } else {
      percentage = (this._total / this._limit) * 100
    }

    const percentageFormatted = percentage.toFixed(1)
    const baseString = `$${totalFormatted} / $${limitFormatted} (${percentageFormatted}% used)`

    return this.exceeded() ? `${baseString} [EXCEEDED]` : baseString
  }
}
