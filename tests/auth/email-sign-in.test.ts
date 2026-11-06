import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { POST as chooseRole } from '@/app/api/auth/role/route'
import { completeGoogleLogin } from '@/lib/auth/accounts'
import {
  confirmEmail,
  consumeMagicLink,
  magicLinkUsable,
  requestMagicLink,
  requestPasswordReset,
  resetPasswordWithToken,
  signInWithPassword,
  signUpWithPassword,
} from '@/lib/auth/emailSignIn'
import { PASSWORD_MAX } from '@/lib/auth/password'
import { resetRateLimitsForTests } from '@/lib/auth/rateLimit'
import type { SessionCookie } from '@/lib/auth/session'
import type { User } from '@/payload-types'

import { ADMIN_EMAIL, getTestPayload, login, PASSWORD, resetDatabase, rest } from '../helpers/world'
import { BREACHED_PASSWORDS } from '../setup/hibp'

const APP = 'http://localhost:3000'
const GOOD = 'a long and unusual pass phrase'
const IP = '203.0.113.20'
const hibp = (
  globalThis as { __hibp?: { down: boolean; requests: { url: string; headers: Headers }[] } }
).__hibp!

type Mail = { to: string; subject: string; html: string; text: string }
let send: MockInstance
const mails = (): Mail[] => send.mock.calls.map((c) => c[0] as Mail)
const lastMail = (): Mail => mails().at(-1)!
const linkIn = (mail: Mail, path: string): string => {
  const match = new RegExp(`href="(${APP}/(en|no)/${path}/[^"]+)"`).exec(mail.html)
  if (!match) throw new Error(`No ${path} link in the email`)
  return match[1]!
}
const tokenIn = (mail: Mail, path: string) => linkIn(mail, path).split('/').pop()!
const cookieHeader = (cookie: SessionCookie) => `${cookie.name}=${cookie.value}`

const usersNamed = async (email: string) =>
  (
    await (
      await getTestPayload()
    ).find({ collection: 'users', where: { email: { equals: email } }, overrideAccess: true })
  ).docs as User[]

async function makeUser(email: string, role: User['role'], extra: Partial<User> = {}) {
  const payload = await getTestPayload()
  return (await payload.create({
    collection: 'users',
    data: { email, password: PASSWORD, role, _verified: true, ...extra } as never,
    overrideAccess: true,
    disableVerificationEmail: true,
  })) as User
}

const req = (over: { ip?: string; locale?: 'en' | 'no' } = {}) => ({
  locale: over.locale ?? ('en' as const),
  ip: over.ip ?? IP,
})

beforeEach(async () => {
  await resetDatabase()
  resetRateLimitsForTests()
  send = vi.spyOn((await getTestPayload()).email, 'sendEmail')
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------------------------
describe('sign-in link: asking for one', () => {
  it('gives the same answer for a new address, an existing account and an admin address', async () => {
    const payload = await getTestPayload()
    await makeUser('student@example.test', 'student')
    await makeUser(ADMIN_EMAIL, 'admin')

    const results = []
    for (const email of ['student@example.test', 'new.person@example.test', ADMIN_EMAIL]) {
      const started = Date.now()
      results.push({
        result: await requestMagicLink(payload, { email, ...req() }),
        ms: Date.now() - started,
      })
    }
    for (const { result, ms } of results) {
      expect(result).toEqual({ ok: true })
      // The answer waits for the timing floor whatever the path did.
      expect(ms).toBeGreaterThanOrEqual(110)
    }

    // Every address got exactly one email; only the admin's has no link.
    expect(mails().map((m) => m.to)).toEqual([
      'student@example.test',
      'new.person@example.test',
      ADMIN_EMAIL,
    ])
    expect(linkIn(mails()[0]!, 'magic')).toMatch(/^http:\/\/localhost:3000\/en\/magic\/[\w-]{43}$/)
    expect(linkIn(mails()[1]!, 'magic')).toBeTruthy()
    expect(mails()[2]!.html).not.toContain('href')
    expect(mails()[2]!.text).not.toContain('http')
    expect(mails()[2]!.html).toContain('Google')
    // Same subject for the admin, so even the inbox looks the same.
    expect(mails()[2]!.subject).toBe(mails()[0]!.subject)

    // No account is made for the new address until the link is used.
    expect(await usersNamed('new.person@example.test')).toHaveLength(0)
  })

  it('stores only a SHA-256 of the token, the address and a 15-minute expiry', async () => {
    const payload = await getTestPayload()
    const before = Date.now()
    await requestMagicLink(payload, { email: 'New.Person@Example.test ', ...req() })
    const token = tokenIn(lastMail(), 'magic')
    const rows = await payload.find({ collection: 'magic-links', overrideAccess: true })
    expect(rows.docs).toHaveLength(1)
    const row = rows.docs[0]!
    expect(row.email).toBe('new.person@example.test')
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(token)
    const ttl = new Date(row.expiresAt).getTime() - before
    expect(ttl).toBeGreaterThan(14.9 * 60_000)
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 5_000)
    expect(row.usedAt).toBeFalsy()
  })

  it('sends the email in the language of the page', async () => {
    const payload = await getTestPayload()
    await requestMagicLink(payload, { email: 'person@example.test', ...req({ locale: 'no' }) })
    expect(lastMail().subject).toBe('Innloggingslenken din til Konnected')
    expect(linkIn(lastMail(), 'magic')).toContain('/no/magic/')
    expect(lastMail().text).toContain('/no/magic/')
  })

  it('an address on the admin list, or an admin whose address left the list, never gets a link', async () => {
    const payload = await getTestPayload()
    await makeUser('former.admin@konnected.test', 'pending', {
      emailVerifiedAt: new Date().toISOString(),
    })
    // A user with the admin role whose address is no longer on ADMIN_EMAILS.
    process.env.ADMIN_EMAILS = `${ADMIN_EMAIL},former.admin@konnected.test`
    try {
      await payload.update({
        collection: 'users',
        where: { email: { equals: 'former.admin@konnected.test' } },
        data: { role: 'admin' },
        overrideAccess: true,
      })
    } finally {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL
    }
    for (const email of [ADMIN_EMAIL, 'former.admin@konnected.test']) {
      expect(await requestMagicLink(payload, { email, ...req() })).toEqual({ ok: true })
      expect(lastMail().html).not.toContain('href')
    }
    expect(
      (await payload.count({ collection: 'magic-links', overrideAccess: true })).totalDocs,
    ).toBe(0)
  })

  it('refuses something that is not an email address, tied to the email field', async () => {
    const payload = await getTestPayload()
    expect(await requestMagicLink(payload, { email: 'not-an-email', ...req() })).toEqual({
      ok: false,
      fields: { email: 'invalid' },
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('is rate limited per address and per client', async () => {
    const payload = await getTestPayload()
    for (let i = 0; i < 3; i++) {
      expect(await requestMagicLink(payload, { email: 'a@example.test', ...req() })).toEqual({
        ok: true,
      })
    }
    expect(
      await requestMagicLink(payload, { email: 'a@example.test', ...req({ ip: '198.51.100.1' }) }),
    ).toEqual({
      ok: false,
      error: 'too_many',
    })

    resetRateLimitsForTests()
    for (let i = 0; i < 10; i++) {
      await requestMagicLink(payload, {
        email: `p${i}@example.test`,
        ...req({ ip: '198.51.100.2' }),
      })
    }
    expect(
      await requestMagicLink(payload, {
        email: 'fresh@example.test',
        ...req({ ip: '198.51.100.2' }),
      }),
    ).toEqual({ ok: false, error: 'too_many' })
  })
})

// ---------------------------------------------------------------------------------------------
describe('sign-in link: using it', () => {
  const linkFor = async (email: string) => {
    await requestMagicLink(await getTestPayload(), { email, ...req() })
    return tokenIn(lastMail(), 'magic')
  }

  it('a new address gets a pending, verified account and a real Payload session', async () => {
    const payload = await getTestPayload()
    const token = await linkFor('new.person@example.test')
    expect(await magicLinkUsable(payload, token)).toBe(true)

    const result = await consumeMagicLink(payload, { token, ...req({ locale: 'no' }) })
    if (!result.ok) throw new Error(`expected success, got ${result.error}`)
    expect(result.user).toMatchObject({ email: 'new.person@example.test', role: 'pending' })
    expect(result.cookie).toMatchObject({ name: 'payload-token', httpOnly: true, sameSite: 'lax' })

    const me = await rest.get('users/me', cookieHeader(result.cookie))
    expect(me.json.user).toMatchObject({ email: 'new.person@example.test', role: 'pending' })
    const [user] = await usersNamed('new.person@example.test')
    expect(user!.emailVerifiedAt).toBeTruthy()
    expect(user!._verified).toBe(true)
    expect(user!.language).toBe('no')
    // A new account gets no verification email: the link already proved the address.
    expect(mails()).toHaveLength(1)
  })

  it('works once', async () => {
    const payload = await getTestPayload()
    const token = await linkFor('person@example.test')
    expect((await consumeMagicLink(payload, { token, ...req() })).ok).toBe(true)
    expect(await consumeMagicLink(payload, { token, ...req() })).toEqual({
      ok: false,
      error: 'invalid_link',
    })
    expect(await magicLinkUsable(payload, token)).toBe(false)
  })

  it('works once even when used twice at the same moment', async () => {
    const payload = await getTestPayload()
    const token = await linkFor('person@example.test')
    const results = await Promise.all([
      consumeMagicLink(payload, { token, ...req() }),
      consumeMagicLink(payload, { token, ...req() }),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await usersNamed('person@example.test')).toHaveLength(1)
  })

  it('does not work after 15 minutes', async () => {
    const payload = await getTestPayload()
    const token = await linkFor('person@example.test')
    await payload.update({
      collection: 'magic-links',
      where: { email: { equals: 'person@example.test' } },
      data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
      overrideAccess: true,
    })
    expect(await magicLinkUsable(payload, token)).toBe(false)
    expect(await consumeMagicLink(payload, { token, ...req() })).toEqual({
      ok: false,
      error: 'invalid_link',
    })
    expect(await usersNamed('person@example.test')).toHaveLength(0)
  })

  it('refuses a made-up or altered token', async () => {
    const payload = await getTestPayload()
    const token = await linkFor('person@example.test')
    const altered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
    for (const bad of [altered, 'short', '', `${token}x`]) {
      expect(await consumeMagicLink(payload, { token: bad, ...req() })).toEqual({
        ok: false,
        error: 'invalid_link',
      })
    }
  })

  it('links to an existing account by its email and keeps its role', async () => {
    const payload = await getTestPayload()
    const student = await makeUser('student@example.test', 'student', {
      emailVerifiedAt: new Date().toISOString(),
    })
    const result = await consumeMagicLink(payload, {
      token: await linkFor('student@example.test'),
      ...req(),
    })
    expect(result).toMatchObject({ ok: true, user: { id: student.id, role: 'student' } })
    // The password still works: the account had already proved its email.
    await expect(login('student@example.test')).resolves.toContain('payload-token=')
  })

  it('takes over an account that never proved its email: its password and sessions end', async () => {
    const payload = await getTestPayload()
    // Someone signed up with this address and a password, but never confirmed it.
    await signUpWithPassword(payload, { email: 'owner@example.test', password: GOOD, ...req() })
    const [squatter] = await usersNamed('owner@example.test')
    expect(squatter!._verified).toBe(false)

    // The real owner uses a sign-in link.
    const result = await consumeMagicLink(payload, {
      token: await linkFor('owner@example.test'),
      ...req(),
    })
    expect(result).toMatchObject({ ok: true, user: { id: squatter!.id } })
    // The squatter's password no longer works, though the account is verified now.
    expect(
      await signInWithPassword(payload, { email: 'owner@example.test', password: GOOD, ...req() }),
    ).toEqual({
      ok: false,
      error: 'invalid_credentials',
    })
  })

  it('an account linked to Google can also use a link, and a link account can later use Google', async () => {
    const payload = await getTestPayload()
    const viaLink = await consumeMagicLink(payload, {
      token: await linkFor('both@example.test'),
      ...req(),
    })
    if (!viaLink.ok) throw new Error('link failed')
    const viaGoogle = await completeGoogleLogin(payload, {
      sub: 'g-both',
      email: 'both@example.test',
      emailVerified: true,
    })
    expect(viaGoogle.id).toBe(viaLink.user.id)
    expect(await usersNamed('both@example.test')).toHaveLength(1)
  })

  it('never signs in an admin, even with a link made before they became admin', async () => {
    const payload = await getTestPayload()
    const token = await linkFor('soon.admin@example.test')
    await makeUser('soon.admin@example.test', 'pending')
    process.env.ADMIN_EMAILS = `${ADMIN_EMAIL},soon.admin@example.test`
    try {
      expect(await consumeMagicLink(payload, { token, ...req() })).toEqual({
        ok: false,
        error: 'invalid_link',
      })
    } finally {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL
    }
  })

  it('is rate limited per client', async () => {
    const payload = await getTestPayload()
    for (let i = 0; i < 20; i++) {
      await consumeMagicLink(payload, { token: 'x'.repeat(43), ...req({ ip: '198.51.100.9' }) })
    }
    expect(
      await consumeMagicLink(payload, { token: 'x'.repeat(43), ...req({ ip: '198.51.100.9' }) }),
    ).toEqual({
      ok: false,
      error: 'too_many',
    })
  })

  it('a new account from a link can still choose student or company', async () => {
    const payload = await getTestPayload()
    const result = await consumeMagicLink(payload, {
      token: await linkFor('chooser@example.test'),
      ...req(),
    })
    if (!result.ok) throw new Error('link failed')
    const body = new FormData()
    body.set('role', 'student')
    const res = await chooseRole(
      new Request(`${APP}/api/auth/role`, {
        method: 'POST',
        body,
        headers: { cookie: cookieHeader(result.cookie), origin: APP },
      }),
    )
    expect(res.status).toBe(303)
    expect((await usersNamed('chooser@example.test'))[0]!.role).toBe('student')
  })
})

// ---------------------------------------------------------------------------------------------
describe('sign-in link: only the newest one works', () => {
  const EMAIL = 'newest@example.test'
  const ask = async (ip = IP) => {
    const result = await requestMagicLink(await getTestPayload(), { email: EMAIL, ...req({ ip }) })
    expect(result).toEqual({ ok: true })
    return tokenIn(lastMail(), 'magic')
  }
  /** Links for EMAIL that are unused and unexpired, read straight from the table. */
  const validLinks = async () =>
    (
      await (
        await getTestPayload()
      ).find({
        collection: 'magic-links',
        where: {
          and: [
            { email: { equals: EMAIL } },
            { usedAt: { exists: false } },
            { expiresAt: { greater_than: new Date().toISOString() } },
          ],
        },
        overrideAccess: true,
      })
    ).docs

  it('an earlier link stops working as soon as a new one is asked for', async () => {
    const payload = await getTestPayload()
    const first = await ask()
    expect(await magicLinkUsable(payload, first)).toBe(true)
    const second = await ask()

    expect(await magicLinkUsable(payload, first)).toBe(false)
    expect(await consumeMagicLink(payload, { token: first, ...req() })).toEqual({
      ok: false,
      error: 'invalid_link',
    })
    expect(await usersNamed(EMAIL)).toHaveLength(0)
    // Marked expired, not removed: the row stays until the daily clean-up.
    const rows = await payload.find({
      collection: 'magic-links',
      where: { email: { equals: EMAIL } },
      overrideAccess: true,
    })
    expect(rows.docs).toHaveLength(2)
    expect(await validLinks()).toHaveLength(1)
    expect(await magicLinkUsable(payload, second)).toBe(true)
  })

  it('the new link works once', async () => {
    const payload = await getTestPayload()
    await ask()
    const second = await ask()
    expect((await consumeMagicLink(payload, { token: second, ...req() })).ok).toBe(true)
    expect(await consumeMagicLink(payload, { token: second, ...req() })).toEqual({
      ok: false,
      error: 'invalid_link',
    })
    expect(await validLinks()).toHaveLength(0)
  })

  it('a used link stays used, and a new link after it works', async () => {
    const payload = await getTestPayload()
    const first = await ask()
    expect((await consumeMagicLink(payload, { token: first, ...req() })).ok).toBe(true)
    const second = await ask()
    expect((await consumeMagicLink(payload, { token: second, ...req() })).ok).toBe(true)
    expect(await usersNamed(EMAIL)).toHaveLength(1)
  })

  it('requests at the same moment leave exactly one valid link', async () => {
    const payload = await getTestPayload()
    for (let round = 0; round < 3; round++) {
      resetRateLimitsForTests()
      send.mockClear()
      // Three at once, from different clients, as far as the per-address limit allows.
      const results = await Promise.all(
        ['198.51.100.31', '198.51.100.32', '198.51.100.33'].map((ip) =>
          requestMagicLink(payload, { email: EMAIL, ...req({ ip }) }),
        ),
      )
      for (const result of results) expect(result).toEqual({ ok: true })
      expect(mails()).toHaveLength(3)
      expect(await validLinks()).toHaveLength(1)

      const tokens = mails().map((mail) => tokenIn(mail, 'magic'))
      const usable = []
      for (const token of tokens) usable.push(await magicLinkUsable(payload, token))
      expect(usable.filter(Boolean)).toHaveLength(1)
    }
    // And that one link signs in once.
    const tokens = mails().map((mail) => tokenIn(mail, 'magic'))
    const outcomes = await Promise.all(
      tokens.map((token) => consumeMagicLink(payload, { token, ...req() })),
    )
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1)
    expect(await validLinks()).toHaveLength(0)
  })

  it('an address that joins the admin list gets no link, and its older link stops working', async () => {
    const payload = await getTestPayload()
    const email = 'soon.admin@example.test'
    await requestMagicLink(payload, { email, ...req() })
    const old = tokenIn(lastMail(), 'magic')
    process.env.ADMIN_EMAILS = `${ADMIN_EMAIL},${email}`
    try {
      expect(await requestMagicLink(payload, { email, ...req() })).toEqual({ ok: true })
      expect(lastMail().html).not.toContain('/magic/')
      expect(await magicLinkUsable(payload, old)).toBe(false)
    } finally {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe('password rules', () => {
  it('needs at least 15 characters and allows 256, counted as characters', async () => {
    const payload = await getTestPayload()
    const signUp = (password: string, email = 'p@example.test') =>
      signUpWithPassword(payload, { email, password, ...req() })

    expect(await signUp('fourteen chars')).toEqual({ ok: false, fields: { password: 'too_short' } })
    // 14 emoji are 28 UTF-16 units, but 14 characters.
    expect(await signUp('🙂'.repeat(14))).toEqual({ ok: false, fields: { password: 'too_short' } })
    expect(await signUp('fifteen chars!!', 'a@example.test')).toEqual({ ok: true })
    expect(await signUp('x'.repeat(PASSWORD_MAX), 'b@example.test')).toEqual({ ok: true })
    expect(await signUp('x'.repeat(PASSWORD_MAX + 1))).toEqual({
      ok: false,
      fields: { password: 'too_long' },
    })
    expect(await signUp('')).toEqual({ ok: false, fields: { password: 'required' } })
  })

  it('refuses a breached password, sending only a 5-character hash prefix with padding', async () => {
    const payload = await getTestPayload()
    const breached = BREACHED_PASSWORDS[0]!
    expect(
      await signUpWithPassword(payload, { email: 'p@example.test', password: breached, ...req() }),
    ).toEqual({
      ok: false,
      fields: { password: 'breached' },
    })
    expect(hibp.requests).toHaveLength(1)
    const { url, headers } = hibp.requests[0]!
    expect(url).toMatch(/^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/)
    expect(url).not.toContain(breached)
    expect(headers.get('add-padding')).toBe('true')
    expect(await usersNamed('p@example.test')).toHaveLength(0)
  })

  it('allows the password when the breach service is down, and logs no personal data', async () => {
    const payload = await getTestPayload()
    hibp.down = true
    const warn = vi.spyOn(payload.logger, 'warn')
    expect(
      await signUpWithPassword(payload, { email: 'p@example.test', password: GOOD, ...req() }),
    ).toEqual({
      ok: true,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('Breached-password check unavailable')
    expect(logged).not.toContain(GOOD)
    expect(logged).not.toContain('p@example.test')
  })

  it('the same rules hold for every other way of setting a password (REST, Local API, admin)', async () => {
    const payload = await getTestPayload()
    const user = await makeUser('student@example.test', 'student')
    await expect(
      payload.update({
        collection: 'users',
        id: user.id,
        data: { password: 'too short' },
        overrideAccess: true,
      }),
    ).rejects.toThrow()
    await expect(
      payload.update({
        collection: 'users',
        id: user.id,
        data: { password: BREACHED_PASSWORDS[1]! },
        overrideAccess: true,
      }),
    ).rejects.toThrow()
    const cookie = await login('student@example.test')
    const res = await rest.patch(`users/${user.id}`, { password: 'too short' }, cookie)
    expect(res.status).toBe(400)
    await expect(login('student@example.test')).resolves.toContain('payload-token=')
  })
})

// ---------------------------------------------------------------------------------------------
describe('sign-up with a password', () => {
  it('makes a pending, unverified account and sends a confirmation link', async () => {
    const payload = await getTestPayload()
    expect(
      await signUpWithPassword(payload, { email: 'New@Example.test', password: GOOD, ...req() }),
    ).toEqual({
      ok: true,
    })
    const [user] = await usersNamed('new@example.test')
    expect(user).toMatchObject({ role: 'pending', _verified: false, language: 'en' })
    expect(user!.emailVerifiedAt).toBeFalsy()
    expect(mails()).toHaveLength(1)
    expect(lastMail().subject).toBe('Confirm your email for Konnected')
    expect(linkIn(lastMail(), 'verify')).toMatch(
      /^http:\/\/localhost:3000\/en\/verify\/[0-9a-f]{40}$/,
    )
  })

  it('needs the email confirmed before the first password sign-in', async () => {
    const payload = await getTestPayload()
    await signUpWithPassword(payload, { email: 'new@example.test', password: GOOD, ...req() })
    const firstToken = tokenIn(lastMail(), 'verify')

    // Right password, unconfirmed address: refused, and a fresh link is sent.
    expect(
      await signInWithPassword(payload, { email: 'new@example.test', password: GOOD, ...req() }),
    ).toEqual({
      ok: false,
      error: 'unverified',
    })
    expect(mails()).toHaveLength(2)
    const token = tokenIn(lastMail(), 'verify')
    expect(token).not.toBe(firstToken)
    // The REST login refuses too.
    expect(
      (await rest.post('users/login', { email: 'new@example.test', password: GOOD })).status,
    ).toBe(403)

    // The old link no longer works; the new one does, once.
    expect(await confirmEmail(payload, { token: firstToken, ip: IP })).toEqual({
      ok: false,
      error: 'invalid_link',
    })
    expect(await confirmEmail(payload, { token, ip: IP })).toEqual({ ok: true })
    expect(await confirmEmail(payload, { token, ip: IP })).toEqual({
      ok: false,
      error: 'invalid_link',
    })

    const [user] = await usersNamed('new@example.test')
    expect(user!._verified).toBe(true)
    expect(user!.emailVerifiedAt).toBeTruthy()

    const result = await signInWithPassword(payload, {
      email: 'new@example.test',
      password: GOOD,
      ...req(),
    })
    if (!result.ok) throw new Error(`expected success, got ${result.error}`)
    expect((await rest.get('users/me', cookieHeader(result.cookie))).json.user).toMatchObject({
      email: 'new@example.test',
      role: 'pending',
    })
  })

  it("Payload's own verify endpoint also records emailVerifiedAt", async () => {
    const payload = await getTestPayload()
    await signUpWithPassword(payload, { email: 'new@example.test', password: GOOD, ...req() })
    const token = tokenIn(lastMail(), 'verify')
    expect((await rest.post(`users/verify/${token}`, {})).status).toBe(200)
    expect((await rest.post(`users/verify/${token}`, {})).status).toBe(403)
    const [user] = await usersNamed('new@example.test')
    expect(user).toMatchObject({ _verified: true })
    expect(user!.emailVerifiedAt).toBeTruthy()
  })

  it('an address that has an account: same answer, nothing changes, the owner gets an email', async () => {
    const payload = await getTestPayload()
    const student = await makeUser('student@example.test', 'student')
    expect(
      await signUpWithPassword(payload, {
        email: 'student@example.test',
        password: GOOD,
        ...req(),
      }),
    ).toEqual({ ok: true })
    expect(await usersNamed('student@example.test')).toEqual([
      expect.objectContaining({ id: student.id, role: 'student' }),
    ])
    // The old password still works and the new one does not.
    await expect(login('student@example.test')).resolves.toContain('payload-token=')
    await expect(login('student@example.test', GOOD)).rejects.toThrow()
    expect(lastMail().subject).toBe('You already have a Konnected account')
    expect(lastMail().html).toContain(`href="${APP}/en"`)
  })

  it('an admin address: same answer, no account, an email without a link', async () => {
    const payload = await getTestPayload()
    expect(
      await signUpWithPassword(payload, { email: ADMIN_EMAIL, password: GOOD, ...req() }),
    ).toEqual({ ok: true })
    expect(await usersNamed(ADMIN_EMAIL)).toHaveLength(0)
    expect(lastMail().to).toBe(ADMIN_EMAIL)
    expect(lastMail().html).not.toContain('href')
  })

  it('is rate limited per address', async () => {
    const payload = await getTestPayload()
    for (let i = 0; i < 3; i++) {
      await signUpWithPassword(payload, { email: 'x@example.test', password: GOOD, ...req() })
    }
    expect(
      await signUpWithPassword(payload, {
        email: 'x@example.test',
        password: GOOD,
        ...req({ ip: '198.51.100.3' }),
      }),
    ).toEqual({ ok: false, error: 'too_many' })
  })
})

// ---------------------------------------------------------------------------------------------
describe('sign-in with a password', () => {
  it('signs in a verified student, company or pending user', async () => {
    const payload = await getTestPayload()
    for (const role of ['student', 'company', 'pending'] as const) {
      await makeUser(`${role}@example.test`, role)
      const result = await signInWithPassword(payload, {
        email: `${role}@example.test`,
        password: PASSWORD,
        ...req(),
      })
      if (!result.ok) throw new Error(`expected success, got ${result.error}`)
      expect((await rest.get('users/me', cookieHeader(result.cookie))).json.user).toMatchObject({
        role,
      })
    }
  })

  it('a wrong password, an unknown address and an admin all get the same answer', async () => {
    const payload = await getTestPayload()
    await makeUser('student@example.test', 'student')
    await makeUser(ADMIN_EMAIL, 'admin', { emailVerifiedAt: new Date().toISOString() })
    const attempts = [
      { email: 'student@example.test', password: 'not the right password' },
      { email: 'nobody@example.test', password: 'not the right password' },
      { email: ADMIN_EMAIL, password: PASSWORD },
    ]
    for (const attempt of attempts) {
      expect(await signInWithPassword(payload, { ...attempt, ...req() })).toEqual({
        ok: false,
        error: 'invalid_credentials',
      })
    }
  })

  it('an unknown address takes about as long as a wrong password (a hash runs either way)', async () => {
    const payload = await getTestPayload()
    await makeUser('student@example.test', 'student')
    const time = async (email: string) => {
      const started = performance.now()
      await signInWithPassword(payload, { email, password: 'not the right password', ...req() })
      return performance.now() - started
    }
    await time('warm.up@example.test')
    const known = await time('student@example.test')
    const unknown = await time('nobody@example.test')
    // Both include one full password hash; without the dummy hash "unknown" is far faster.
    expect(unknown).toBeGreaterThan(known * 0.5)
  })

  it('after 5 wrong tries the address is paused, whether or not it has an account', async () => {
    const payload = await getTestPayload()
    await makeUser('student@example.test', 'student')
    for (const email of ['student@example.test', 'nobody@example.test']) {
      const tries = []
      for (let i = 0; i < 5; i++) {
        tries.push(
          await signInWithPassword(payload, { email, password: 'wrong password!!', ...req() }),
        )
      }
      expect(tries.map((t) => (t.ok ? 'ok' : t.error))).toEqual([
        'invalid_credentials',
        'invalid_credentials',
        'invalid_credentials',
        'invalid_credentials',
        'invalid_credentials',
      ])
      // Even the right password is refused now, with the same "paused" answer for both.
      expect(await signInWithPassword(payload, { email, password: PASSWORD, ...req() })).toEqual({
        ok: false,
        error: 'locked',
      })
    }
  })

  it('Payload locks the account itself for 15 minutes, and its REST answer looks like a wrong password', async () => {
    const payload = await getTestPayload()
    await makeUser('student@example.test', 'student')
    const wrong = () =>
      rest.post('users/login', { email: 'student@example.test', password: 'wrong password!!' })
    const first = await wrong()
    for (let i = 0; i < 4; i++) await wrong()
    const raw = await payload.db.findOne<{ id: number; lockUntil?: string }>({
      collection: 'users',
      where: { email: { equals: 'student@example.test' } },
    })
    const lockMs = new Date(raw!.lockUntil!).getTime() - Date.now()
    expect(lockMs).toBeGreaterThan(14 * 60_000)
    expect(lockMs).toBeLessThanOrEqual(15 * 60_000)

    const right = await rest.post('users/login', {
      email: 'student@example.test',
      password: PASSWORD,
    })
    const unknown = await rest.post('users/login', {
      email: 'nobody@example.test',
      password: PASSWORD,
    })
    expect(right.status).toBe(first.status)
    expect(right.json).toEqual(first.json)
    expect(unknown.json).toEqual(first.json)
    expect(right.text).not.toMatch(/lock/i)
  })

  it('reports missing input on the right field', async () => {
    const payload = await getTestPayload()
    expect(await signInWithPassword(payload, { email: 'nope', password: '', ...req() })).toEqual({
      ok: false,
      fields: { email: 'invalid', password: 'required' },
    })
  })
})

// ---------------------------------------------------------------------------------------------
describe('password reset', () => {
  it('same answer for every address; only a real non-admin account gets a link', async () => {
    const payload = await getTestPayload()
    await makeUser('student@example.test', 'student')
    await makeUser(ADMIN_EMAIL, 'admin', { emailVerifiedAt: new Date().toISOString() })
    for (const email of ['student@example.test', 'nobody@example.test', ADMIN_EMAIL]) {
      expect(await requestPasswordReset(payload, { email, ...req() })).toEqual({ ok: true })
    }
    expect(mails().map((m) => m.to)).toEqual(['student@example.test', ADMIN_EMAIL])
    expect(linkIn(mails()[0]!, 'reset-password')).toMatch(/\/en\/reset-password\/[0-9a-f]{40}$/)
    expect(mails()[1]!.html).not.toContain('href')
  })

  it('sets a new password once, ends other sessions and confirms the email', async () => {
    const payload = await getTestPayload()
    // An account that signed up but never confirmed: a reset link proves the address too.
    await signUpWithPassword(payload, { email: 'forgetful@example.test', password: GOOD, ...req() })
    await payload.update({
      collection: 'users',
      where: { email: { equals: 'forgetful@example.test' } },
      data: { _verified: true },
      overrideAccess: true,
    })
    const otherDevice = await login('forgetful@example.test', GOOD)
    await payload.update({
      collection: 'users',
      where: { email: { equals: 'forgetful@example.test' } },
      data: { _verified: false, emailVerifiedAt: null },
      overrideAccess: true,
    })

    await requestPasswordReset(payload, { email: 'forgetful@example.test', ...req() })
    const token = tokenIn(lastMail(), 'reset-password')
    const newPassword = 'another long pass phrase'

    expect(await resetPasswordWithToken(payload, { token, password: 'too short', ip: IP })).toEqual(
      {
        ok: false,
        fields: { password: 'too_short' },
      },
    )
    expect(
      await resetPasswordWithToken(payload, { token, password: BREACHED_PASSWORDS[0]!, ip: IP }),
    ).toEqual({ ok: false, fields: { password: 'breached' } })
    expect(await resetPasswordWithToken(payload, { token, password: newPassword, ip: IP })).toEqual(
      { ok: true },
    )
    // Once only.
    expect(await resetPasswordWithToken(payload, { token, password: newPassword, ip: IP })).toEqual(
      {
        ok: false,
        error: 'invalid_link',
      },
    )

    const [user] = await usersNamed('forgetful@example.test')
    expect(user).toMatchObject({ _verified: true })
    expect(user!.emailVerifiedAt).toBeTruthy()
    expect((await rest.get('users/me', otherDevice)).json.user).toBeNull()
    await expect(login('forgetful@example.test', GOOD)).rejects.toThrow()
    await expect(login('forgetful@example.test', newPassword)).resolves.toContain('payload-token=')
  })

  it('an expired link does not work', async () => {
    const payload = await getTestPayload()
    await makeUser('student@example.test', 'student')
    await requestPasswordReset(payload, { email: 'student@example.test', ...req() })
    const token = tokenIn(lastMail(), 'reset-password')
    await payload.db.updateOne({
      collection: 'users',
      where: { email: { equals: 'student@example.test' } },
      data: { resetPasswordExpiration: new Date(Date.now() - 1000).toISOString() },
    })
    expect(await resetPasswordWithToken(payload, { token, password: GOOD, ip: IP })).toEqual({
      ok: false,
      error: 'invalid_link',
    })
  })

  it('an admin cannot set a password, even with a token made by the Local API', async () => {
    const payload = await getTestPayload()
    await makeUser(ADMIN_EMAIL, 'admin', { emailVerifiedAt: new Date().toISOString() })
    const token = await payload.forgotPassword({
      collection: 'users',
      data: { email: ADMIN_EMAIL },
      disableEmail: true,
    })
    expect(
      await resetPasswordWithToken(payload, { token: token!, password: GOOD, ip: IP }),
    ).toEqual({
      ok: false,
      error: 'invalid_link',
    })
    await expect(login(ADMIN_EMAIL, GOOD)).rejects.toThrow()
  })

  it('is rate limited per address', async () => {
    const payload = await getTestPayload()
    for (let i = 0; i < 3; i++)
      await requestPasswordReset(payload, { email: 'x@example.test', ...req() })
    expect(
      await requestPasswordReset(payload, {
        email: 'x@example.test',
        ...req({ ip: '198.51.100.4' }),
      }),
    ).toEqual({
      ok: false,
      error: 'too_many',
    })
  })
})

// ---------------------------------------------------------------------------------------------
describe('access as each role', () => {
  const roles = ['admin', 'student', 'company', 'anonymous'] as const

  const setup = async () => {
    const payload = await getTestPayload()
    const admin = await makeUser(ADMIN_EMAIL, 'admin', {
      emailVerifiedAt: new Date().toISOString(),
    })
    const student = await makeUser('student@example.test', 'student')
    const company = await makeUser('company@example.test', 'company')
    await requestMagicLink(payload, { email: 'someone@example.test', ...req() })
    const link = (await payload.find({ collection: 'magic-links', overrideAccess: true })).docs[0]!
    const { sessionFor } = await import('../helpers/world')
    const cookies = {
      admin: await sessionFor(admin.id),
      student: await login(student.email),
      company: await login(company.email),
      anonymous: undefined,
    }
    const users = { admin, student, company, anonymous: undefined }
    return { payload, link, cookies, users }
  }

  it('magic-links: only admins read or delete, nobody creates or changes through the API', async () => {
    const { payload, link, cookies, users } = await setup()
    for (const role of roles) {
      const cookie = cookies[role]
      const list = await rest.get('magic-links', cookie)
      const created = await rest.post(
        'magic-links',
        { tokenHash: 'f'.repeat(64), email: 'x@example.test', expiresAt: new Date().toISOString() },
        cookie,
      )
      const patched = await rest.patch(`magic-links/${link.id}`, { usedAt: null }, cookie)
      expect(created.status, role).toBe(403)
      expect(patched.status, role).toBe(403)
      if (role === 'admin') {
        expect(list.json.docs, role).toHaveLength(1)
      } else {
        expect(list.status, role).toBe(403)
      }

      // The Local API on behalf of the same user.
      const user = users[role] ? { ...users[role], collection: 'users' as const } : undefined
      const local = payload.find({ collection: 'magic-links', overrideAccess: false, user })
      if (role === 'admin') await expect(local).resolves.toMatchObject({ totalDocs: 1 })
      else await expect(local).rejects.toThrow()
    }
    // Delete: refused for everyone but admin.
    for (const role of ['student', 'company', 'anonymous'] as const) {
      expect((await rest.delete(`magic-links/${link.id}`, cookies[role])).status, role).toBe(403)
    }
    expect((await rest.delete(`magic-links/${link.id}`, cookies.admin)).status).toBe(200)
  })

  it('magic-links are not in GraphQL', async () => {
    const { graphql } = await import('../helpers/world')
    const { cookies } = await setup()
    const res = await graphql('{ MagicLinks { docs { id } } }', cookies.admin)
    expect(res.text).toMatch(/Cannot query field/)
  })

  it('nobody but an admin can mark an email as verified', async () => {
    const { payload, cookies, users } = await setup()
    // A fresh, unconfirmed sign-up to try it on.
    await signUpWithPassword(payload, { email: 'new@example.test', password: GOOD, ...req() })
    const [target] = await usersNamed('new@example.test')

    for (const role of ['student', 'company', 'anonymous'] as const) {
      const res = await rest.patch(
        `users/${target!.id}`,
        { _verified: true, emailVerifiedAt: new Date().toISOString() },
        cookies[role],
      )
      expect([401, 403, 404], role).toContain(res.status)
      // Their own record: the fields are dropped.
      if (users[role]) {
        await rest.patch(
          `users/${users[role]!.id}`,
          { _verified: false, emailVerifiedAt: null },
          cookies[role],
        )
        const [self] = await usersNamed(users[role]!.email)
        expect(self!._verified, role).toBe(true)
      }
    }
    expect((await usersNamed('new@example.test'))[0]!._verified).toBe(false)

    // An admin can (the admin panel is the fallback for the team).
    const res = await rest.patch(`users/${target!.id}`, { _verified: true }, cookies.admin)
    expect(res.status).toBe(200)
    const [after] = await usersNamed('new@example.test')
    expect(after!._verified).toBe(true)
    expect(after!.emailVerifiedAt).toBeTruthy()
  })

  it('nobody can create an account through the REST API without being admin', async () => {
    const { cookies } = await setup()
    for (const role of ['student', 'company', 'anonymous'] as const) {
      const res = await rest.post(
        'users',
        { email: `made.by.${role}@example.test`, password: GOOD, role: 'admin', _verified: true },
        cookies[role],
      )
      expect(res.status, role).toBe(403)
    }
    expect(await usersNamed('made.by.anonymous@example.test')).toHaveLength(0)
  })
})
