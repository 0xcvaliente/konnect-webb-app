import { describe, expect, it } from 'vitest'

import { htmlToText } from '@/lib/email/adapter'
import {
  accountExistsEmail,
  accountPausedEmail,
  accountReactivatedEmail,
  magicLinkEmail,
  methodAddedEmail,
  resetEmail,
  roleChangedEmail,
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

  for (const locale of ['en', 'no'] as const) {
    it(`account notices render completely in ${locale}, with the account footer`, () => {
      const home = `http://localhost:3000/${locale}`
      const emails = [
        methodAddedEmail(locale, 'google', home),
        methodAddedEmail(locale, 'password', home),
        accountPausedEmail(locale),
        accountReactivatedEmail(locale, home),
        roleChangedEmail(locale, 'student', home),
        roleChangedEmail(locale, 'company', home),
      ]
      for (const email of emails) {
        expect(email.subject.length).toBeGreaterThan(5)
        for (const part of [email.subject, email.html, email.text]) {
          expect(part).not.toMatch(/undefined|\{\w+\}|\[object/)
        }
        expect(email.html).not.toMatch(/<img|<script|<iframe/i)
        // Not the sign-in page footer: these go to people because they have an account.
        expect(email.text).not.toMatch(/sign-in page|innloggingssiden/)
      }
      // The two "new way" emails say which way was added.
      expect(emails[0]!.text).toContain('Google')
      expect(emails[0]!.text).not.toBe(emails[1]!.text)
      // The pause email has no link; the others link home.
      expect(emails[2]!.html).not.toContain('href')
      for (const email of [emails[0]!, emails[3]!, emails[4]!]) {
        expect(email.html).toContain(`href="${home}"`)
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
