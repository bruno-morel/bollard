export type BollardErrorCode =
  | "LLM_TIMEOUT"
  | "LLM_RATE_LIMIT"
  | "LLM_AUTH"
  | "LLM_PROVIDER_ERROR"
  | "LLM_INVALID_RESPONSE"
  | "COST_LIMIT_EXCEEDED"
  | "TIME_LIMIT_EXCEEDED"
  | "NODE_EXECUTION_FAILED"
  | "POSTCONDITION_FAILED"
  | "STATIC_CHECK_FAILED"
  | "TEST_FAILED"
  | "MUTATION_THRESHOLD_NOT_MET"
  | "CONTRACT_VIOLATION"
  | "HUMAN_REJECTED"
  | "RISK_GATE_BLOCKED"
  | "CONFIG_INVALID"
  | "CONCERN_CONFIG_INVALID"
  | "DETECTION_FAILED"
  | "PROFILE_INVALID"
  | "PROVIDER_NOT_FOUND"
  | "MODEL_NOT_AVAILABLE"
  | "CONTRACT_TESTER_OUTPUT_INVALID"
  | "CONTRACT_TESTER_NO_GROUNDED_CLAIMS"
  | "REVIEW_OUTPUT_INVALID"

const RETRYABLE_CODES: ReadonlySet<BollardErrorCode> = new Set([
  "LLM_TIMEOUT",
  "LLM_RATE_LIMIT",
  "LLM_PROVIDER_ERROR",
])

interface BollardErrorOptions {
  code: BollardErrorCode
  message: string
  cause?: Error
  context?: Record<string, unknown>
}

export class BollardError extends Error {
  readonly code: BollardErrorCode
  readonly context: Record<string, unknown>

  constructor(options: BollardErrorOptions) {
    super(options.message, { cause: options.cause })
    Object.setPrototypeOf(this, BollardError.prototype)
    this.name = "BollardError"
    this.code = options.code
    this.context = options.context ?? {}
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code)
  }

  static is(err: unknown): err is BollardError {
    return err instanceof BollardError
  }

  static hasCode(err: unknown, code: BollardErrorCode): boolean {
    return BollardError.is(err) && err.code === code
  }
}
