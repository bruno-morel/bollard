declare module "proper-lockfile" {
  export interface RetryOptions {
    retries?: number
    factor?: number
    minTimeout?: number
    maxTimeout?: number
  }

  export interface LockOptions {
    retries?: number | RetryOptions
  }

  export type Release = () => Promise<void>

  export function lock(path: string, options?: LockOptions): Promise<Release>
}
