import { afterEach } from 'vitest'

import { textPdf } from '@/lib/agreements/pdf'

import { docxText } from '../helpers/docx'

/**
 * A stand-in for Gotenberg, so tests never need the converter container. Only requests to the
 * GOTENBERG_URL host set in vitest.config.ts are answered here; anything else goes on to the
 * previous fetch (the breached-password stand-in, then the real fetch).
 *
 * It "converts" a .docx by taking the text of word/document.xml and drawing it on a one-page PDF,
 * so a test can check what was filled in. `gotenberg.down = true` makes it answer 503.
 * One real conversion is checked by tests/agreements/gotenberg-real.test.ts against a running
 * Gotenberg (set GOTENBERG_TEST_URL).
 */
type GotenbergState = { down: boolean; conversions: number; lastText: string }
const state: GotenbergState = { down: false, conversions: 0, lastText: '' }
;(globalThis as { __gotenberg?: GotenbergState }).__gotenberg = state

const previousFetch = globalThis.fetch

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const fake = process.env.GOTENBERG_URL ? new URL(process.env.GOTENBERG_URL) : null
  if (!fake || url.host !== fake.host) return previousFetch(input, init)
  if (state.down) return new Response('unavailable', { status: 503 })
  if (url.pathname !== '/forms/libreoffice/convert' || !(init?.body instanceof FormData)) {
    return new Response('not found', { status: 404 })
  }
  const file = init.body.get('files')
  if (!(file instanceof Blob)) return new Response('no file', { status: 400 })
  const lines = docxText(Buffer.from(await file.arrayBuffer()))
  state.conversions += 1
  state.lastText = lines.join('\n')
  const pdf = await textPdf(lines)
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  })
}) as typeof fetch

afterEach(() => {
  state.down = false
})
