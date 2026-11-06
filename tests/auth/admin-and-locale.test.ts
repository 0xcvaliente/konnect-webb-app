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

  it('sends no password reset email to an admin, and answers exactly as for anyone else', async () => {
    const payload = await getTestPayload()
    await makeUser(ADMIN_EMAIL, 'admin')
    await makeUser('student@example.test', 'student')
    const send = vi.spyOn(payload.email, 'sendEmail')

    const forAdmin = await rest.post('users/forgot-password', { email: ADMIN_EMAIL })
    expect(send).not.toHaveBeenCalled()

    const forStudent = await rest.post('users/forgot-password', { email: 'student@example.test' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toMatchObject({ to: 'student@example.test' })

    const forNobody = await rest.post('users/forgot-password', { email: 'nobody@example.test' })
    expect(forAdmin.status).toBe(200)
    expect(forAdmin.json).toEqual(forStudent.json)
    expect(forAdmin.json).toEqual(forNobody.json)
  })

  it('also refuses a reset for an address on the admin list that is not an admin yet', async () => {
    const payload = await getTestPayload()
    await payload.create({
      collection: 'users',
      data: { email: ADMIN_EMAIL, password: PASSWORD, role: 'pending' } as never,
      overrideAccess: true,
    })
    const send = vi.spyOn(payload.email, 'sendEmail')
    await rest.post('users/forgot-password', { email: ADMIN_EMAIL.toUpperCase() })
    expect(send).not.toHaveBeenCalled()
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
