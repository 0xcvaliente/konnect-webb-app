import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

import en from '@/messages/en.json'
import no from '@/messages/no.json'
import proxy from '@/proxy'
import { contentSecurityPolicy } from '@/lib/csp'

const page = (path: string) => new NextRequest(new URL(path, 'http://localhost:3000'))

const directives = (csp: string) =>
  new Map(
    csp
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .map(([k, ...v]) => [k!, v]),
  )

describe('content security policy on our pages', () => {
  it('sends a nonce-based policy and passes the same policy on to the page render', () => {
    const response = proxy(page('/en'))
    const csp = response.headers.get('content-security-policy')
    expect(csp).toBeTruthy()

    const d = directives(csp!)
    const nonce = d.get('script-src')!.find((s) => s.startsWith("'nonce-"))
    expect(nonce).toMatch(/^'nonce-[A-Za-z0-9+/=]{20,}'$/)
    expect(d.get('script-src')).toContain("'strict-dynamic'")
    expect(d.get('script-src')).not.toContain("'unsafe-eval'")
    expect(d.get('script-src')).not.toContain("'unsafe-inline'")
    expect(d.get('style-src')).toEqual(["'self'", "'unsafe-inline'"])
    expect(d.get('img-src')).toEqual(["'self'", 'data:', 'blob:'])
    expect(d.get('font-src')).toEqual(["'self'"])
    expect(d.get('connect-src')).toEqual(["'self'"])
    expect(d.get('frame-ancestors')).toEqual(["'none'"])
    expect(d.get('base-uri')).toEqual(["'self'"])
    expect(d.get('form-action')).toEqual(["'self'"])
    expect(d.get('object-src')).toEqual(["'none'"])

    // Next.js reads the nonce from the request header the page is rendered with.
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp)
  })

  it('uses a new nonce for every request', () => {
    const a = proxy(page('/no/choose-role')).headers.get('content-security-policy')
    const b = proxy(page('/no/choose-role')).headers.get('content-security-policy')
    expect(a).not.toBe(b)
  })

  it("allows 'unsafe-eval' only in development", () => {
    expect(contentSecurityPolicy('abc', true)).toContain("'unsafe-eval'")
    expect(contentSecurityPolicy('abc', false)).not.toContain("'unsafe-eval'")
  })

  it('still redirects a path without a language, without a policy', () => {
    const response = proxy(page('/choose-role'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/en/choose-role')
  })
})

describe('message files', () => {
  const keys = (obj: object, prefix = ''): string[] =>
    Object.entries(obj).flatMap(([k, v]) =>
      v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
    )

  it('have the same strings in English and Norwegian', () => {
    expect(keys(no).sort()).toEqual(keys(en).sort())
  })

  it('have no empty strings', () => {
    for (const messages of [en, no]) {
      const empty = keys(messages).filter(
        (k) => !String(k.split('.').reduce<unknown>((o, p) => (o as never)[p], messages)).trim(),
      )
      expect(empty).toEqual([])
    }
  })
})
