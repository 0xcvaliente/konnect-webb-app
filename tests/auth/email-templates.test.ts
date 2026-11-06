import { describe, expect, it } from 'vitest'

import { htmlToText } from '@/lib/email/adapter'
import {
  accountExistsEmail,
  magicLinkEmail,
  resetEmail,
  teamEmail,
  verifyEmail,
} from '@/lib/email/templates'

const LINK = 'http://localhost:3000/en/magic/abc'

describe('sign-in emails', () => {
  for (const locale of ['en', 'no'] as const) {
    it(`render completely in ${locale}`, () => {
      const emails = [
        verifyEmail(locale, LINK),
        magicLinkEmail(locale, LINK),
        accountExistsEmail(locale, LINK),
        resetEmail(locale, LINK),
        teamEmail(locale, 'link'),
        teamEmail(locale, 'signup'),
        teamEmail(locale, 'reset'),
      ]
      for (const email of emails) {
        expect(email.subject.length).toBeGreaterThan(5)
        for (const part of [email.subject, email.html, email.text]) {
          expect(part).not.toMatch(/undefined|\{\w+\}|\[object/)
        }
        // No tracking: no images, no pixels, no scripts.
        expect(email.html).not.toMatch(/<img|<script|<iframe/i)
      }
      // The link is in both the HTML and the plain text, and team emails have none.
      for (const email of emails.slice(0, 4)) {
        expect(email.html).toContain(`href="${LINK}"`)
        expect(email.text).toContain(LINK)
      }
      for (const email of emails.slice(4)) {
        expect(email.html).not.toContain('href')
        expect(email.text).not.toContain('http')
      }
    })
  }

  it('escapes what goes into the HTML', () => {
    const email = magicLinkEmail('en', 'http://localhost:3000/en/magic/a"><script>x</script>')
    expect(email.html).not.toContain('<script>')
  })

  it('turns Payload-built HTML into a readable plain-text part', () => {
    expect(htmlToText('<p>Hello &amp; welcome</p><p><a href="https://x.test/a">Open</a></p>')).toBe(
      'Hello & welcome\n\nOpen: https://x.test/a',
    )
  })
})
