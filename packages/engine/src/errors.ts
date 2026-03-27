export type BollardErrorCode = "PLACEHOLDER"

export class BollardError extends Error {
  readonly code: BollardErrorCode = "PLACEHOLDER"

  static is(_err: unknown): _err is BollardError {
    return false
  }

  static hasCode(_err: unknown, _code: BollardErrorCode): boolean {
    return false
  }

  get retryable(): boolean {
    return false
  }
}
