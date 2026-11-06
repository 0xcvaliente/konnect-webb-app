/**
 * A small fixed-window rate limit for the sign-in routes, kept in memory.
 * Version 1 runs one app container, so one process sees every request. If the app is ever scaled
 * out, move this to PostgreSQL or a shared store. Behind Caddy the client address comes from
 * `x-forwarded-for`; trust that header only because Caddy is the single public entry point.
 *
 * Keys may contain an email address. They live only in this process's memory and are never
 * logged.
 */
const windows = new Map<string, { count: number; resetAt: number }>()

/** Count one hit. True when this hit goes over the limit. */
export function rateLimited(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const current = windows.get(key)
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs })
    // Drop old entries now and then so the map cannot grow without bound.
    if (windows.size > 5000) {
      for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k)
    }
    return false
  }
  current.count += 1
  return current.count > limit
}

/** True when the key has already used up its limit. Does not count a hit. */
export function limitReached(key: string, limit: number, now = Date.now()): boolean {
  const current = windows.get(key)
  return Boolean(current && current.resetAt > now && current.count >= limit)
}

/** Forget a key, for example the failed sign-ins for an email after a successful sign-in. */
export function clearRateLimit(key: string): void {
  windows.delete(key)
}

/** The client address: the first `x-forwarded-for` entry, which Caddy sets. */
export function clientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

export function clientKey(request: Request, scope: string): string {
  return `${scope}:${clientIp(request.headers)}`
}

export function resetRateLimitsForTests(): void {
  windows.clear()
}
