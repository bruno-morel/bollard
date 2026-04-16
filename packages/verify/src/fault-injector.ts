import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { BollardError } from "@bollard/engine/src/errors.js"

const execFileAsync = promisify(execFile)

export type FaultType = "service_stop"

export interface FaultSpec {
  type: FaultType
  target: string
  duration_ms?: number
  params?: Record<string, unknown>
}

export interface FaultHandle {
  id: string
  spec: FaultSpec
  remove: () => Promise<void>
}

export interface FaultInjector {
  inject(spec: FaultSpec): Promise<FaultHandle>
  cleanup: () => Promise<void>
}

let handleSeq = 0

function createNoOpFaultInjector(log?: (msg: string) => void): FaultInjector {
  const noop = async (): Promise<void> => {
    /* no-op */
  }
  return {
    async inject(spec: FaultSpec): Promise<FaultHandle> {
      log?.(`fault-injector: docker unavailable — skipping fault ${spec.type} on ${spec.target}`)
      const id = `noop-${++handleSeq}`
      return {
        id,
        spec,
        remove: noop,
      }
    },
    cleanup: noop,
  }
}

function createDockerFaultInjector(composeFile: string, workDir: string): FaultInjector {
  const active = new Map<string, FaultSpec>()

  async function compose(args: string[]): Promise<void> {
    await execFileAsync("docker", ["compose", "-f", composeFile, ...args], {
      cwd: workDir,
      maxBuffer: 2 * 1024 * 1024,
    })
  }

  return {
    async inject(spec: FaultSpec): Promise<FaultHandle> {
      if (spec.type !== "service_stop") {
        throw new BollardError({
          code: "FAULT_INJECTION_FAILED",
          message: `Fault type ${spec.type} is not supported yet`,
          context: { spec },
        })
      }
      const id = `fault-${++handleSeq}`
      active.set(id, spec)
      await compose(["stop", spec.target])
      return {
        id,
        spec,
        remove: async () => {
          active.delete(id)
          await compose(["start", spec.target])
        },
      }
    },
    async cleanup(): Promise<void> {
      const specs = [...active.values()]
      active.clear()
      for (const s of specs) {
        try {
          await compose(["start", s.target])
        } catch {
          /* best-effort */
        }
      }
    },
  }
}

export async function createFaultInjector(
  composeFile: string,
  workDir: string,
  log?: (msg: string) => void,
): Promise<FaultInjector> {
  try {
    await execFileAsync("docker", ["compose", "version"], { cwd: workDir })
  } catch {
    return createNoOpFaultInjector(log)
  }
  return createDockerFaultInjector(composeFile, workDir)
}
