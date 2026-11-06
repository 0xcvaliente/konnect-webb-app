import { createHash } from 'node:crypto'

import { afterEach } from 'vitest'

/**
 * A stand-in for the Have I Been Pwned range API, so tests never call the real service. Only
 * requests to api.pwnedpasswords.com are answered here; anything else goes to the real fetch.
 *
 * - BREACHED_PASSWORDS are reported as breached (with padding lines, like the real service).
 * - `hibp.down = true` makes the service fail, to test the fail-open rule.
 * - `hibp.requests` records each request's URL and headers, to check that only the hash prefix
 *   leaves the server and that padding is asked for.
 */
export const BREACHED_PASSWORDS = ['password1234567890', 'correct horse battery staple']

type HibpState = { down: boolean; requests: { url: string; headers: Headers }[] }
const state: HibpState = { down: false, requests: [] }
;(globalThis as { __hibp?: HibpState }).__hibp = state

const sha1 = (value: string) => createHash('sha1').update(value).digest('hex').toUpperCase()
const realFetch = globalThis.fetch

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.hostname !== 'api.pwnedpasswords.com') return realFetch(input, init)
  state.requests.push({ url: url.toString(), headers: new Headers(init?.headers) })
  if (state.down) return new Response('unavailable', { status: 503 })
  const prefix = url.pathname.split('/').pop()!.toUpperCase()
  const lines = BREACHED_PASSWORDS.map(sha1)
    .filter((hash) => hash.startsWith(prefix))
    .map((hash) => `${hash.slice(5)}:42`)
  // Padding: lines with a count of 0 that match nothing.
  lines.push('0000000000000000000000000000000000A:0', '0000000000000000000000000000000000B:0')
  return new Response(lines.join('\r\n'), { status: 200 })
}) as typeof fetch

afterEach(() => {
  state.down = false
  state.requests = []
})
