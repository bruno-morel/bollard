import type { PipelineContext } from "./context.js"
import { BollardError } from "./errors.js"

export class CostTracker {
  private _total = 0
  private _runCount = 0
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
    this._runCount++
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

  limitUsd(): number {
    return this._limit
  }

  total(): number {
    return this._total
  }

  peek(): number {
    return this._total
  }

  /** Returns `true` if the accumulated total exceeds the limit; always a `boolean`. */
  exceeded(): boolean {
    return this._total > this._limit
  }

  snapshotTotal(): number {
    return this._total
  }

  /** Returns the budget remaining (limit minus total). Always ≥ 0; never negative. */
  remaining(): number {
    return Math.max(0, this._limit - this._total)
  }

  reset(): number {
    const previousTotal = this._total
    this._total = 0
    this._runCount = 0
    return previousTotal
  }

  runCount(): number {
    return this._runCount
  }
  clamp(min: number, max: number): CostTracker {
    if (!Number.isFinite(min) || min < 0) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `min must be a non-negative finite number, got: ${min}`,
        context: { min },
      })
    }

    if (!Number.isFinite(max) || max < 0) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `max must be a non-negative finite number, got: ${max}`,
        context: { max },
      })
    }

    if (min > max) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `min must be <= max, got min: ${min}, max: ${max}`,
        context: { min, max },
      })
    }

    if (this._total < min) {
      this._total = min
    } else if (this._total > max) {
      this._total = max
    }

    return this
  }

  toJSON(): { totalCostUsd: number; limitUsd: number; runCount: number } {
    return {
      totalCostUsd: this.total(),
      limitUsd: this.limitUsd(),
      runCount: this.runCount(),
    }
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

  multiply(factor: number): CostTracker {
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `Factor must be a positive finite number, got: ${factor}`,
        context: { factor },
      })
    }
    this._total = this._total * factor
    return this
  }

  merge(other: CostTracker): CostTracker {
    if (other == null || !(other instanceof CostTracker)) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `other must be a CostTracker instance, got: ${other}`,
        context: { other },
      })
    }

    const newTracker = new CostTracker(this._limit)
    newTracker._total = this._total + other._total
    return newTracker
  }
  withLimit(newLimit: number): CostTracker {
    if (!Number.isFinite(newLimit) || newLimit < 0) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `newLimit must be a non-negative finite number, got: ${newLimit}`,
        context: { newLimit },
      })
    }

    const newTracker = new CostTracker(newLimit)
    newTracker._total = this._total
    return newTracker
  }

  snapshot(): Readonly<{ totalCostUsd: number }> {
    return Object.freeze({ totalCostUsd: this._total })
  }

  formatCost(decimalPlaces?: number): string {
    // Validate decimalPlaces parameter if provided
    if (decimalPlaces !== undefined) {
      if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0) {
        throw new BollardError({
          code: "CONTRACT_VIOLATION",
          message: `decimalPlaces must be a non-negative integer, got: ${decimalPlaces}`,
          context: { decimalPlaces },
        })
      }
    }

    // Use default of 2 decimal places if not specified
    const places = decimalPlaces ?? 2

    // Format the total using toFixed and prepend dollar sign
    return `$${this._total.toFixed(places)}`
  }
  percentUsed(): number {
    // Handle percentage calculation with edge case for zero limit
    let percentage: number
    if (this._limit === 0) {
      // When limit is 0, if total is also 0, percentage is 0%
      // If total > 0, we show it as exceeded (100% to avoid "Infinity")
      percentage = this._total === 0 ? 0 : 100
    } else {
      percentage = (this._total / this._limit) * 100
    }

    // Clamp result to [0, 100] to ensure no NaN, Infinity, or out-of-range values
    return Math.min(Math.max(percentage, 0), 100)
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
