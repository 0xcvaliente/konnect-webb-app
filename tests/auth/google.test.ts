import { createHash } from 'node:crypto'

import * as oidc from 'openid-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GET as callback } from '@/app/api/auth/google/callback/route'
import { GET as start } from '@/app/api/auth/google/start/route'
import { POST as logout } from '@/app/api/auth/logout/route'
import { POST as chooseRole } from '@/app/api/auth/role/route'
import { AuthFlowError, completeGoogleLogin } from '@/lib/auth/accounts'
import { signingSecret } from '@/lib/auth/env'
import { OIDC_COOKIE, openChecks, sealChecks } from '@/lib/auth/oidcCookie'
import { resetRateLimitsForTests } from '@/lib/auth/rateLimit'
import { createSessionCookie } from '@/lib/auth/session'
import type { User } from '@/payload-types'

import { getTestPayload, login, PASSWORD, resetDatabase, rest } from '../helpers/world'

// Only the network call to Google is replaced. Everything else (the sign-in address, the signed
// cookie, account rules, sessions, redirects) is the real code on a real database.
vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>()
  return { ...actual, authorizationCodeGrant: vi.fn() }
})
const grant = vi.mocked(oidc.authorizationCodeGrant)

const APP = 'http://localhost:3000'
const cookiePair = (setCookie: string) => setCookie.split(';')[0]!
const setCookies = (res: Response) => res.headers.getSetCookie()
const location = (res: Response) => res.headers.get('location') ?? ''

const claimsFor = (
  over: Partial<{ sub: string; email: string; email_verified: boolean }> = {},
) => ({
  sub: 'google-sub-1',
  email: 'new.person@example.test',
  email_verified: true,
  ...over,
})
const googleReturns = (claims: ReturnType<typeof claimsFor>) =>
  grant.mockResolvedValueOnce({ claims: () => claims } as never)

beforeEach(async () => {
  await resetDatabase()
  resetRateLimitsForTests()
  grant.mockReset()
})

/** Run start, then hand its cookie to the callback, like a browser would. */
async function signInThroughRoutes(
  claims: ReturnType<typeof claimsFor>,
  query = '?code=the-code&state=the-state',
) {
  const started = await start(new Request(`${APP}/api/auth/google/start`))
  const checksCookie = cookiePair(setCookies(started).find((c) => c.startsWith(OIDC_COOKIE))!)
  googleReturns(claims)
  return callback(
    new Request(`${APP}/api/auth/google/callback${query}`, { headers: { cookie: checksCookie } }),
  )
}

const usersNamed = async (email: string) =>
  (
    await (
      await getTestPayload()
    ).find({
      collection: 'users',
      where: { email: { equals: email } },
      overrideAccess: true,
    })
  ).docs

describe('start: the address we send the browser to', () => {
  it('asks Google with PKCE, state, nonce and only the three scopes', async () => {
    const res = await start(new Request(`${APP}/api/auth/google/start`))
    expect(res.status).toBe(307)
    const url = new URL(location(res))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const p = url.searchParams
    expect(p.get('client_id')).toBe(process.env.GOOGLE_CLIENT_ID)
    expect(p.get('redirect_uri')).toBe(`${APP}/api/auth/google/callback`)
    expect(p.get('response_type')).toBe('code')
    expect(p.get('scope')).toBe('openid email profile')
    expect(p.get('code_challenge_method')).toBe('S256')

    // The signed cookie carries the same checks, and the challenge really is S256(verifier).
    const cookie = setCookies(res).find((c) => c.startsWith(OIDC_COOKIE))!
    const checks = openChecks(cookiePair(cookie).split('=')[1], signingSecret())!
    expect(checks.state).toBe(p.get('state'))
    expect(checks.nonce).toBe(p.get('nonce'))
    expect(p.get('code_challenge')).toBe(
      createHash('sha256').update(checks.verifier).digest('base64url'),
    )
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toMatch(/Max-Age=600/)
    expect(JSON.stringify([...p.keys()])).not.toContain('client_secret')
  })

  it('uses a fresh state and nonce every time', async () => {
    const a = new URL(location(await start(new Request(`${APP}/api/auth/google/start`))))
    const b = new URL(location(await start(new Request(`${APP}/api/auth/google/start`))))
    expect(a.searchParams.get('state')).not.toBe(b.searchParams.get('state'))
    expect(a.searchParams.get('nonce')).not.toBe(b.searchParams.get('nonce'))
  })

  it('is rate limited', async () => {
    const hit = () =>
      start(
        new Request(`${APP}/api/auth/google/start`, {
          headers: { 'x-forwarded-for': '203.0.113.9' },
        }),
      )
    for (let i = 0; i < 20; i++) expect(location(await hit())).toContain('accounts.google.com')
    expect(location(await hit())).toBe(`${APP}/en?auth_error=too_many_requests`)
  })
})

describe('the signed sign-in cookie', () => {
  const checks = { state: 's', nonce: 'n', verifier: 'v' }
  it('opens with the right secret and refuses everything else', () => {
    const sealed = sealChecks(checks, 'secret-a')
    expect(openChecks(sealed, 'secret-a')).toEqual(checks)
    expect(openChecks(sealed, 'secret-b')).toBeNull()
    expect(openChecks(`${sealed}x`, 'secret-a')).toBeNull()
    expect(openChecks(sealed.replace(/^./, 'Z'), 'secret-a')).toBeNull()
    expect(openChecks('garbage', 'secret-a')).toBeNull()
    expect(openChecks(undefined, 'secret-a')).toBeNull()
  })
})

describe('callback: errors end on the home page with a message code, never a 500', () => {
  const expectFail = (res: Response, code: string) => {
    expect(res.status).toBe(307)
    expect(location(res)).toBe(`${APP}/en?auth_error=${code}`)
    expect(setCookies(res).some((c) => c.startsWith(`${OIDC_COOKIE}=;`))).toBe(true)
    expect(setCookies(res).some((c) => c.startsWith('payload-token='))).toBe(false)
  }

  it('Cancel on Google (access_denied)', async () => {
    expectFail(
      await callback(new Request(`${APP}/api/auth/google/callback?error=access_denied`)),
      'cancelled',
    )
  })
  it('another Google error', async () => {
    expectFail(
      await callback(new Request(`${APP}/api/auth/google/callback?error=server_error`)),
      'google_error',
    )
  })
  it('no sign-in cookie, or a tampered one', async () => {
    expectFail(
      await callback(new Request(`${APP}/api/auth/google/callback?code=x&state=y`)),
      'session_expired',
    )
    expectFail(
      await callback(
        new Request(`${APP}/api/auth/google/callback?code=x&state=y`, {
          headers: { cookie: `${OIDC_COOKIE}=forged.value` },
        }),
      ),
      'session_expired',
    )
  })
  it('the library rejects the code (bad state, nonce, signature or expiry)', async () => {
    const started = await start(new Request(`${APP}/api/auth/google/start`))
    grant.mockRejectedValueOnce(new Error('unexpected state'))
    const res = await callback(
      new Request(`${APP}/api/auth/google/callback?code=x&state=wrong`, {
        headers: { cookie: cookiePair(setCookies(started)[0]!) },
      }),
    )
    expectFail(res, 'google_error')
    expect(await usersNamed('new.person@example.test')).toHaveLength(0)
  })
  it('hands the library the saved state, nonce and PKCE verifier and demands an ID token', async () => {
    const started = await start(new Request(`${APP}/api/auth/google/start`))
    const cookie = cookiePair(setCookies(started)[0]!)
    const checks = openChecks(cookie.split('=')[1], signingSecret())!
    googleReturns(claimsFor())
    await callback(
      new Request(`${APP}/api/auth/google/callback?code=c&state=${checks.state}`, {
        headers: { cookie },
      }),
    )
    const [, url, passed] = grant.mock.calls[0]!
    expect(String(url)).toBe(`${APP}/api/auth/google/callback?code=c&state=${checks.state}`)
    expect(passed).toMatchObject({
      pkceCodeVerifier: checks.verifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    })
  })
  it('an unverified Google email never signs in or creates an account', async () => {
    expectFail(await signInThroughRoutes(claimsFor({ email_verified: false })), 'unverified_email')
    expect(await usersNamed('new.person@example.test')).toHaveLength(0)
  })
  it('is rate limited', async () => {
    const hit = () =>
      callback(
        new Request(`${APP}/api/auth/google/callback?error=access_denied`, {
          headers: { 'x-forwarded-for': '203.0.113.7' },
        }),
      )
    for (let i = 0; i < 20; i++) expect(location(await hit())).toContain('cancelled')
    expect(location(await hit())).toContain('too_many_requests')
  })
})

describe('callback: a successful sign-in', () => {
  it('creates a pending account, starts a real Payload session and asks for a role', async () => {
    const res = await signInThroughRoutes(claimsFor())
    expect(location(res)).toBe(`${APP}/en/choose-role`)
    const session = setCookies(res).find((c) => c.startsWith('payload-token='))!
    expect(session).toMatch(/HttpOnly/i)
    expect(session).toMatch(/SameSite=Lax/i)

    // Payload itself accepts the cookie on REST.
    const me = await rest.get('users/me', cookiePair(session))
    expect(me.json.user).toMatchObject({ email: 'new.person@example.test', role: 'pending' })
    expect(me.text).not.toMatch(/"hash"|"salt"|googleSub/)

    const [user] = await usersNamed('new.person@example.test')
    expect(user).toMatchObject({ googleSub: 'google-sub-1', role: 'pending' })
    expect(user!.emailVerifiedAt).toBeTruthy()
  })

  it('signing in again finds the same account', async () => {
    await signInThroughRoutes(claimsFor())
    await signInThroughRoutes(claimsFor())
    expect(await usersNamed('new.person@example.test')).toHaveLength(1)
  })

  it('a pending user can read nothing', async () => {
    const res = await signInThroughRoutes(claimsFor())
    const cookie = cookiePair(setCookies(res).find((c) => c.startsWith('payload-token='))!)
    for (const path of [
      'projects',
      'companies',
      'student-profiles',
      'applications',
      'matches',
      'payments',
    ]) {
      const out = await rest.get(path, cookie)
      expect(out.json.docs ?? []).toHaveLength(0)
    }
    expect((await rest.get('users', cookie)).json.docs).toHaveLength(1)
  })
})

describe('accounts: who gets which role and which account', () => {
  const login$ = async (over = {}) =>
    completeGoogleLogin(await getTestPayload(), {
      sub: 'g-1',
      email: 'someone@example.test',
      emailVerified: true,
      ...over,
    })

  it('a new account is pending, with the email lower-cased', async () => {
    const user = await login$({ email: 'Someone@Example.TEST' })
    expect(user).toMatchObject({ email: 'someone@example.test', role: 'pending' })
  })

  it('admin only for a verified email on the ADMIN_EMAILS list', async () => {
    const admin = await login$({ sub: 'g-admin', email: 'Admin@Konnected.test' })
    expect(admin.role).toBe('admin')
    expect(admin.emailVerifiedAt).toBeTruthy()
    const other = await login$({ sub: 'g-other', email: 'not.listed@example.test' })
    expect(other.role).toBe('pending')
  })

  it('an unverified or missing email is refused', async () => {
    const payload = await getTestPayload()
    for (const claims of [
      { sub: 'x', email: 'a@example.test', emailVerified: false },
      { sub: 'x', emailVerified: true },
    ]) {
      await expect(completeGoogleLogin(payload, claims)).rejects.toBeInstanceOf(AuthFlowError)
    }
    expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(0)
  })

  it('a returning user is matched by Google id, even if their Google email changed', async () => {
    const first = await login$()
    const again = await login$({ email: 'changed@example.test' })
    expect(again.id).toBe(first.id)
    expect(again.email).toBe('someone@example.test')
  })

  it('links an existing account that already proved its email, and keeps its password', async () => {
    const payload = await getTestPayload()
    await payload.create({
      collection: 'users',
      data: {
        email: 'someone@example.test',
        password: PASSWORD,
        role: 'student',
        emailVerifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const user = await login$()
    expect(user.googleSub).toBe('g-1')
    expect(user.role).toBe('student')
    await expect(login('someone@example.test')).resolves.toContain('payload-token=')
  })

  it('takes over an account whose email was never proved: old password dead, old sessions ended', async () => {
    const payload = await getTestPayload()
    // Someone registers the address with a password they chose, without proving they own it.
    await payload.create({
      collection: 'users',
      data: { email: 'someone@example.test', password: PASSWORD, role: 'student' },
      overrideAccess: true,
    })
    const attackerCookie = await login('someone@example.test')
    expect((await rest.get('users/me', attackerCookie)).json.user).toBeTruthy()

    await login$() // the real owner signs in with Google

    await expect(login('someone@example.test')).rejects.toThrow()
    expect((await rest.get('users/me', attackerCookie)).json.user).toBeNull()
  })

  it('refuses an email already linked to a different Google account', async () => {
    await login$({ sub: 'g-owner' })
    await expect(login$({ sub: 'g-intruder' })).rejects.toMatchObject({ code: 'account_conflict' })
  })

  it('an existing pending user who is on the admin list becomes admin on a verified sign-in', async () => {
    const payload = await getTestPayload()
    await payload.create({
      collection: 'users',
      data: { email: 'admin@konnected.test', password: PASSWORD, role: 'pending' },
      overrideAccess: true,
    })
    const user = await login$({ sub: 'g-admin', email: 'admin@konnected.test' })
    expect(user.role).toBe('admin')
  })

  it('two sign-ins at the same moment make one account', async () => {
    const [a, b] = await Promise.all([login$({ sub: 'g-race' }), login$({ sub: 'g-race' })])
    expect(a.id).toBe(b.id)
    expect(await usersNamed('someone@example.test')).toHaveLength(1)
  })
})

describe('the session', () => {
  it('works on REST and GraphQL-style cookie auth, and a forged token does not', async () => {
    const payload = await getTestPayload()
    const user = (await payload.create({
      collection: 'users',
      data: { email: 'student.one@example.test', password: PASSWORD, role: 'student' },
      overrideAccess: true,
    })) as User
    const cookie = cookiePair(await createSessionCookie(payload, user.id))
    expect((await rest.get('users/me', cookie)).json.user).toMatchObject({ id: user.id })

    const forged = `payload-token=${cookie.split('=')[1]!.slice(0, -4)}AAAA`
    expect((await rest.get('users/me', forged)).json.user).toBeNull()
  })

  it('ignores the cookie when the request comes from another site', async () => {
    const payload = await getTestPayload()
    const user = (await payload.create({
      collection: 'users',
      data: { email: 'student.two@example.test', password: PASSWORD, role: 'student' },
      overrideAccess: true,
    })) as User
    const cookie = cookiePair(await createSessionCookie(payload, user.id))
    const res = await fetchMeFrom('https://evil.example', cookie)
    expect(res.user).toBeNull()
  })
})

async function fetchMeFrom(origin: string, cookie: string) {
  const { REST_GET } = await import('@payloadcms/next/routes')
  const config = (await import('@payload-config')).default
  const res = await REST_GET(config)(
    new Request(`${APP}/api/users/me`, { headers: { cookie, origin } }),
    { params: Promise.resolve({ slug: ['users', 'me'] }) },
  )
  return (await res.json()) as { user: unknown }
}

describe('choosing a role', () => {
  const pendingSession = async () => {
    const res = await signInThroughRoutes(claimsFor())
    return cookiePair(setCookies(res).find((c) => c.startsWith('payload-token='))!)
  }
  const post = (cookie: string | undefined, role: string, origin?: string) => {
    const body = new FormData()
    body.set('role', role)
    return chooseRole(
      new Request(`${APP}/api/auth/role`, {
        method: 'POST',
        body,
        headers: { ...(cookie ? { cookie } : {}), origin: origin ?? APP },
      }),
    )
  }
  const roleOf = async () => (await usersNamed('new.person@example.test'))[0]?.role

  it('a pending user becomes a student or a company, once', async () => {
    const cookie = await pendingSession()
    const res = await post(cookie, 'company')
    expect(res.status).toBe(303)
    expect(await roleOf()).toBe('company')
    expect((await post(cookie, 'student')).status).toBe(403)
    expect(await roleOf()).toBe('company')
  })

  it('admin can never be chosen', async () => {
    const cookie = await pendingSession()
    expect((await post(cookie, 'admin')).status).toBe(403)
    expect(await roleOf()).toBe('pending')
  })

  it('needs a session and refuses another site', async () => {
    const cookie = await pendingSession()
    expect(location(await post(undefined, 'student'))).toContain('session_expired')
    expect((await post(cookie, 'student', 'https://evil.example')).status).toBe(403)
    expect(await roleOf()).toBe('pending')
  })

  it('records the change in the activity log', async () => {
    const cookie = await pendingSession()
    await post(cookie, 'student')
    const payload = await getTestPayload()
    const logs = await payload.find({
      collection: 'activity-logs',
      where: {
        and: [{ targetCollection: { equals: 'users' } }, { toStatus: { equals: 'student' } }],
      },
      overrideAccess: true,
    })
    expect(logs.docs[0]).toMatchObject({ action: 'status_change', fromStatus: 'pending' })
  })
})

describe('signing out', () => {
  it('ends the session and clears the cookie', async () => {
    const res = await signInThroughRoutes(claimsFor())
    const cookie = cookiePair(setCookies(res).find((c) => c.startsWith('payload-token='))!)
    expect((await rest.get('users/me', cookie)).json.user).toBeTruthy()

    const out = await logout(
      new Request(`${APP}/api/auth/logout`, { method: 'POST', headers: { cookie, origin: APP } }),
    )
    expect(out.status).toBe(303)
    expect(setCookies(out).some((c) => c.startsWith('payload-token=;'))).toBe(true)
    expect((await rest.get('users/me', cookie)).json.user).toBeNull()
  })

  it('refuses a sign-out request from another site', async () => {
    const out = await logout(
      new Request(`${APP}/api/auth/logout`, {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
    )
    expect(out.status).toBe(403)
  })
})
