import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as logout } from '@/app/api/auth/logout/route'
import { requestLocale } from '@/i18n/locale'

import { ADMIN_EMAIL, getTestPayload, login, PASSWORD, resetDatabase, rest } from '../helpers/world'

const APP = 'http://localhost:3000'

async function makeUser(email: string, role: 'admin' | 'student') {
  const payload = await getTestPayload()
  return payload.create({
    collection: 'users',
    data: {
      email,
      password: PASSWORD,
      role,
      ...(role === 'admin' ? { emailVerifiedAt: new Date().toISOString() } : {}),
    } as never,
    overrideAccess: true,
  })
}

describe('admins sign in with Google only', () => {
  beforeEach(async () => {
    await resetDatabase()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('refuses the password login for an admin, with the same answer as a wrong password', async () => {
    await makeUser(ADMIN_EMAIL, 'admin')
    const right = await rest.post('users/login', { email: ADMIN_EMAIL, password: PASSWORD })
    const wrong = await rest.post('users/login', {
      email: ADMIN_EMAIL,
      password: 'not-the-password-1',
    })
    expect(right.status).toBe(401)
    expect(right.status).toBe(wrong.status)
    expect(right.json).toEqual(wrong.json)
    await expect(login(ADMIN_EMAIL)).rejects.toThrow()
  })

  it('still lets a student sign in with a password', async () => {
    await makeUser('student@example.test', 'student')
    await expect(login('student@example.test')).resolves.toContain('payload-token=')
  })

  it('gives an admin a reset email without a link, the same way as anyone else', async () => {
    const payload = await getTestPayload()
    await makeUser(ADMIN_EMAIL, 'admin')
    await makeUser('student@example.test', 'student')
    const send = vi.spyOn(payload.email, 'sendEmail')

    const forAdmin = await rest.post('users/forgot-password', { email: ADMIN_EMAIL })
    const forStudent = await rest.post('users/forgot-password', { email: 'student@example.test' })
    const forNobody = await rest.post('users/forgot-password', { email: 'nobody@example.test' })

    // Same answer whoever the address belongs to.
    expect(forAdmin.status).toBe(200)
    expect(forAdmin.json).toEqual(forStudent.json)
    expect(forAdmin.json).toEqual(forNobody.json)

    // Both real accounts get an email; only the student's has a reset link.
    expect(send).toHaveBeenCalledTimes(2)
    const [adminMail, studentMail] = send.mock.calls.map(
      (c) => c[0] as { to: string; html: string },
    )
    expect(adminMail!.to).toBe(ADMIN_EMAIL)
    expect(adminMail!.html).not.toContain('href')
    expect(adminMail!.html).toContain('Google')
    expect(studentMail!.to).toBe('student@example.test')
    expect(studentMail!.html).toMatch(
      /href="http:\/\/localhost:3000\/en\/reset-password\/[0-9a-f]+"/,
    )
  })

  it('gives no link to an address on the admin list that is not an admin yet', async () => {
    const payload = await getTestPayload()
    await payload.create({
      collection: 'users',
      data: { email: ADMIN_EMAIL, password: PASSWORD, role: 'pending' } as never,
      overrideAccess: true,
    })
    const send = vi.spyOn(payload.email, 'sendEmail')
    await rest.post('users/forgot-password', { email: ADMIN_EMAIL.toUpperCase() })
    expect(send).toHaveBeenCalledTimes(1)
    expect((send.mock.calls[0]![0] as { html: string }).html).not.toContain('href')
  })

  it('an admin cannot use a reset token to get a password session', async () => {
    const payload = await getTestPayload()
    await makeUser(ADMIN_EMAIL, 'admin')
    const token = await payload.forgotPassword({
      collection: 'users',
      data: { email: ADMIN_EMAIL },
      disableEmail: true,
    })
    const res = await rest.post('users/reset-password', {
      token,
      password: 'A-new-long-password-123',
    })
    expect(res.status).toBe(401)
    expect(res.json?.token).toBeUndefined()
    // The new password was rolled back with the refused sign-in.
    await expect(login(ADMIN_EMAIL, 'A-new-long-password-123')).rejects.toThrow()
  })
})

describe('redirects from the sign-in routes keep the language', () => {
  const req = (headers: Record<string, string>) => new Request(`${APP}/x`, { headers })

  it('uses the language the user chose, then the browser language, then English', () => {
    expect(requestLocale(req({ cookie: 'a=1; NEXT_LOCALE=no; b=2' }))).toBe('no')
    expect(requestLocale(req({ cookie: 'NEXT_LOCALE=no', 'accept-language': 'en-GB' }))).toBe('no')
    expect(requestLocale(req({ 'accept-language': 'nb-NO,nb;q=0.9,en;q=0.8' }))).toBe('no')
    expect(requestLocale(req({ 'accept-language': 'nn' }))).toBe('no')
    expect(requestLocale(req({ cookie: 'NEXT_LOCALE=de', 'accept-language': 'de-DE' }))).toBe('en')
    expect(requestLocale(req({}))).toBe('en')
  })

  it('sends a Norwegian user back to /no after signing out', async () => {
    const res = await logout(
      new Request(`${APP}/api/auth/logout`, {
        method: 'POST',
        headers: { origin: APP, cookie: 'NEXT_LOCALE=no' },
      }),
    )
    expect(res.headers.get('location')).toBe(`${APP}/no`)
  })
})
