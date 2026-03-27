export class CostTracker {
  private _limit: number
  private _total = 0

  constructor(limitUsd: number) {
    this._limit = limitUsd
  }

  add(_costUsd: number): void {}

  total(): number {
    return this._total
  }

  exceeded(): boolean {
    return false
  }

  remaining(): number {
    return this._limit
  }
}
