/**
 * Requests whose answer must not show whether an account exists (sign-in link, sign-up, reset
 * request) take at least this long. The real work differs per path (a new account is hashed, an
 * existing one is not), so the floor hides it. Tests lower it with AUTH_TIMING_FLOOR_MS.
 */
const DEFAULT_FLOOR_MS = 900

export const timingFloorMs = (): number => {
  const fromEnv = Number(process.env.AUTH_TIMING_FLOOR_MS)
  return Number.isFinite(fromEnv) && fromEnv >= 0 && process.env.AUTH_TIMING_FLOOR_MS
    ? fromEnv
    : DEFAULT_FLOOR_MS
}

/** Run `work`, then wait until at least the floor has passed since the start. */
export async function withTimingFloor<T>(work: () => Promise<T>): Promise<T> {
  const started = Date.now()
  try {
    return await work()
  } finally {
    const left = timingFloorMs() - (Date.now() - started)
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left))
  }
}
