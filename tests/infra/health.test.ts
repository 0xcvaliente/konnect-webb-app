import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/api/health/route'
import { config as proxyConfig } from '@/proxy'

import { getTestPayload } from '../helpers/world'

describe('/api/health', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('answers ok when the database answers, and is never cached', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('answers 503 without any detail when the database query fails', async () => {
    const payload = await getTestPayload()
    vi.spyOn(payload.db.pool, 'query').mockImplementation((() =>
      Promise.reject(
        new Error('connect ECONNREFUSED postgres://konnected:secret@db-host:5432/konnected'),
      )) as never)

    const response = await GET()
    expect(response.status).toBe(503)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ status: 'unavailable' })
    // Nothing from the error reaches the caller.
    expect(text).not.toMatch(/ECONNREFUSED|secret|db-host|postgres/)
  })

  it('answers 503 when the database does not answer in time', async () => {
    const payload = await getTestPayload()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(payload.db.pool, 'query').mockImplementation((() => new Promise(() => {})) as never)

    const pending = GET()
    await vi.advanceTimersByTimeAsync(3_000)
    const response = await pending
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'unavailable' })
  })

  it('is not rewritten or redirected by the locale proxy', () => {
    const matches = (path: string) =>
      unstable_doesMiddlewareMatch({ config: proxyConfig, url: `http://localhost:3000${path}` })
    expect(matches('/api/health')).toBe(false)
    // Control: a page without a language is handled by the proxy.
    expect(matches('/choose-role')).toBe(true)
  })
})
