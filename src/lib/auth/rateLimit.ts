/**
 * A small fixed-window rate limit for the sign-in routes, kept in memory.
 * Version 1 runs one app container, so one process sees every request. If the app is ever scaled
 * out, move this to PostgreSQL or a shared store. Behind Caddy the client address comes from
 * `x-forwarded-for`; trust that header only because Caddy is the single public entry point.
 */
const windows = new Map<string, { count: number; resetAt: number }>()

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

export function clientKey(request: Request, scope: string): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return `${scope}:${forwarded || 'unknown'}`
}

export function resetRateLimitsForTests(): void {
  windows.clear()
}
