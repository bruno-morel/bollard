import { BollardError } from "./errors.js"

export class CostTracker {
  private _total = 0
  private readonly _limit: number

  constructor(limitUsd: number) {
    this._limit = limitUsd
  }

  add(costUsd: number): void {
    if (costUsd < 0) {
      throw new BollardError({
        code: "CONTRACT_VIOLATION",
        message: `Cost cannot be negative: ${costUsd}`,
        context: { costUsd },
      })
    }
    this._total += costUsd
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
}
