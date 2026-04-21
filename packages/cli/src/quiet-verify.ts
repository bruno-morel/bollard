export interface StaticCheckResultLike {
  check: string
  passed: boolean
  output: string
  durationMs: number
}

export interface QuietVerifyOutput {
  status: "fail"
  checks: Array<{ label: string; passed: boolean; message?: string }>
}

export function formatQuietVerifyResult(
  results: StaticCheckResultLike[],
  allPassed: boolean,
): QuietVerifyOutput | null {
  if (allPassed) return null
  return {
    status: "fail",
    checks: results.map((r) => ({
      label: r.check,
      passed: r.passed,
      ...(r.passed ? {} : { message: r.output.split("\n").slice(0, 3).join("; ") }),
    })),
  }
}
