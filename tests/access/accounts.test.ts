import crypto from 'node:crypto'

import * as oidc from 'openid-client'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

import { isAdmin, isCompany, isStudent } from '@/access/roles'
import { TEAM_NAV } from '@/components/app/nav'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { AuthFlowError, completeGoogleLogin } from '@/lib/auth/accounts'
import {
  consumeMagicLink,
  requestMagicLink,
  requestPasswordReset,
  resetPasswordWithToken,
  signInWithPassword,
  signUpWithPassword,
} from '@/lib/auth/emailSignIn'
import { resetRateLimitsForTests } from '@/lib/auth/rateLimit'
import { createSessionCookie } from '@/lib/auth/session'
import { LEGACY_LOCALES, LEGACY_TEAM_REDIRECTS } from '@/lib/legacyRedirects'
import {
  dismissMethodNotice,
  fixRole,
  listAccounts,
  loadAccount,
  pauseAccount,
  reactivateAccount,
  signOutEverywhere,
} from '@/lib/team/accounts'
import type { User } from '@/payload-types'

import {
  ADMIN_EMAIL,
  asUser,
  companyDetails,
  createWorld,
  getTestPayload,
  graphql,
  login,
  PASSWORD,
  resetDatabase,
  rest,
  sessionFor,
  type World,
} from '../helpers/world'

/**
 * Accounts and the team's "User account" screen: names on accounts, fixing a wrong role, pausing
 * and reactivating, signing out everywhere, the "new way to sign in" notice and email, the admin
 * allowlist, and the move of the team workspace to /{locale}/team. Every rule is tried as each
 * role (admin, student, company, anonymous) through the functions the pages use, and the access
 * rules through REST and the Local API with access control on.
 */

vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>()
  return { ...actual, authorizationCodeGrant: vi.fn() }
})

const GOOD = 'a long and unusual pass phrase'
const IP = '203.0.113.40'

type Mail = { to: string; subject: string; html: string; text: string }
let send: MockInstance
const mails = (): Mail[] => send.mock.calls.map((c) => c[0] as Mail)

const form = (values: Record<string, string | number>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, String(value))
  return data
}

async function makeUser(email: string, role: User['role'], extra: Partial<User> = {}) {
  const payload = await getTestPayload()
  return (await payload.create({
    collection: 'users',
    data: {
      email,
      password: PASSWORD,
      role,
      _verified: true,
      emailVerifiedAt: new Date().toISOString(),
      ...extra,
    } as never,
    overrideAccess: true,
    disableVerificationEmail: true,
  })) as User
}

const reload = async (id: number) =>
  (await (
    await getTestPayload()
  ).findByID({ collection: 'users', id, depth: 0, overrideAccess: true })) as User

const userLog = async (id: number) =>
  (
    await (
      await getTestPayload()
    ).find({
      collection: 'activity-logs',
      where: {
        and: [{ targetCollection: { equals: 'users' } }, { targetId: { equals: String(id) } }],
      },
      sort: 'createdAt',
      depth: 0,
      overrideAccess: true,
    })
  ).docs

const me = async (cookie: string) =>
  (await rest.get('users/me', cookie)).json.user as Partial<User> | null

beforeEach(() => {
  resetRateLimitsForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------------------------
describe('the account name', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('is copied from the student profile name, on create and on every change', async () => {
    const payload = await getTestPayload()
    const student = await makeUser('student@example.test', 'student')
    const profile = await payload.create({
      collection: 'student-profiles',
      data: { name: 'Ingrid Solberg', school: 'NTNU', programme: 'Design', year: 2 } as never,
      user: asUser(student),
      overrideAccess: false,
    })
    expect((await reload(student.id)).name).toBe('Ingrid Solberg')
    await payload.update({
      collection: 'student-profiles',
      id: profile.id,
      data: { name: 'Ingrid S. Solberg' },
      user: asUser(student),
      overrideAccess: false,
    })
    expect((await reload(student.id)).name).toBe('Ingrid S. Solberg')
  })

  it('is the contact person for a company', async () => {
    const payload = await getTestPayload()
    const user = await makeUser('company@example.test', 'company')
    await payload.create({
      collection: 'companies',
      data: { ...companyDetails('Fjordfrukt AS'), contactName: 'Marte Haugen', status: 'pending' },
      user: asUser(user),
      overrideAccess: false,
    })
    expect((await reload(user.id)).name).toBe('Marte Haugen')
  })

  it('comes from Google for a team member, and never for anyone else', async () => {
    const payload = await getTestPayload()
    const admin = await completeGoogleLogin(payload, {
      sub: 'g-admin',
      email: ADMIN_EMAIL,
      emailVerified: true,
      name: 'Clifford Valiente',
    })
    expect(admin).toMatchObject({ role: 'admin', name: 'Clifford Valiente' })
    // A changed Google name follows on the next sign-in.
    const again = await completeGoogleLogin(payload, {
      sub: 'g-admin',
      email: ADMIN_EMAIL,
      emailVerified: true,
      name: 'Clifford V.',
    })
    expect(again.name).toBe('Clifford V.')

    const student = await completeGoogleLogin(payload, {
      sub: 'g-student',
      email: 'new.student@example.test',
      emailVerified: true,
      name: 'Google Name',
    })
    expect(student.name ?? null).toBeNull()
  })

  it('is what the account menu shows, with the email as the fallback', () => {
    expect(accountMenuUser({ name: 'Ingrid Solberg', email: 'i@example.test' }, 'Student')).toEqual(
      { name: 'Ingrid Solberg', detail: 'i@example.test' },
    )
    expect(accountMenuUser({ name: null, email: 'i@example.test' }, 'Student')).toEqual({
      name: 'i@example.test',
      detail: 'Student',
    })
  })

  it('a person can read their own name; a company cannot read a student account at all', async () => {
    const payload = await getTestPayload()
    const student = await makeUser('student@example.test', 'student', { name: 'Secret-Name-X' })
    const company = await makeUser('company@example.test', 'company')
    const studentCookie = await login(student.email)
    const companyCookie = await login(company.email)
    expect((await me(studentCookie))?.name).toBe('Secret-Name-X')

    const direct = await rest.get(`users/${student.id}`, companyCookie)
    expect([403, 404]).toContain(direct.status)
    expect(direct.text).not.toContain('Secret-Name-X')
    const list = await rest.get('users?limit=100', companyCookie)
    expect(list.text).not.toContain('Secret-Name-X')
    const gql = await graphql('{ Users(limit: 100) { docs { id name email } } }', companyCookie)
    expect(gql.text).not.toContain('Secret-Name-X')
    await expect(
      payload.findByID({
        collection: 'users',
        id: student.id,
        user: asUser(company),
        overrideAccess: false,
      }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------------------------
describe('fixing a wrong role', () => {
  let admin: User
  beforeEach(async () => {
    await resetDatabase()
    admin = await makeUser(ADMIN_EMAIL, 'admin')
    send = vi.spyOn((await getTestPayload()).email, 'sendEmail')
  })

  it('company to student: the company details go, the student questions come next', async () => {
    const payload = await getTestPayload()
    const user = await makeUser('tobias@example.test', 'company', { language: 'no' })
    const company = await payload.create({
      collection: 'companies',
      data: { ...companyDetails('Tobias AS'), status: 'pending' },
      user: asUser(user),
      overrideAccess: false,
    })

    expect(
      await fixRole(payload, asUser(admin), form({ userId: user.id, role: 'student' })),
    ).toMatchObject({ status: 'done' })

    const after = await reload(user.id)
    expect(after.role).toBe('student')
    expect(after.company ?? null).toBeNull()
    expect(
      await payload.findByID({
        collection: 'companies',
        id: company.id,
        overrideAccess: true,
        disableErrors: true,
      }),
    ).toBeNull()
    const log = await userLog(user.id)
    expect(log.at(-1)).toMatchObject({
      action: 'status_change',
      field: 'role',
      fromStatus: 'company',
      toStatus: 'student',
      actor: admin.id,
    })
    // The person gets an email in their own language.
    const mail = mails().find((m) => m.to === user.email)!
    expect(mail.subject).toBe('Kontotypen din hos Konnected ble endret')
  })

  it('student to company: the profile and CV go', async () => {
    const payload = await getTestPayload()
    const user = await makeUser('student@example.test', 'student')
    await payload.create({
      collection: 'student-profiles',
      data: { name: 'A Student', school: 'UiO', programme: 'Informatics', year: 1 } as never,
      user: asUser(user),
      overrideAccess: false,
    })
    expect(
      await fixRole(payload, asUser(admin), form({ userId: user.id, role: 'company' })),
    ).toMatchObject({ status: 'done' })
    expect((await reload(user.id)).role).toBe('company')
    const profiles = await payload.count({
      collection: 'student-profiles',
      where: { user: { equals: user.id } },
      overrideAccess: true,
    })
    expect(profiles.totalDocs).toBe(0)
  })

  it('never makes anyone admin, and never touches pending or team accounts', async () => {
    const payload = await getTestPayload()
    const student = await makeUser('student@example.test', 'student')
    const pending = await makeUser('pending@example.test', 'pending')
    const actor = asUser(admin)
    expect(
      await fixRole(payload, actor, form({ userId: student.id, role: 'admin' })),
    ).toMatchObject({ status: 'error', error: 'not_allowed' })
    expect(
      await fixRole(payload, actor, form({ userId: pending.id, role: 'student' })),
    ).toMatchObject({ status: 'error', error: 'not_allowed' })
    expect(
      await fixRole(payload, actor, form({ userId: admin.id, role: 'student' })),
    ).toMatchObject({ status: 'error', error: 'not_allowed' })

    // The same through the API, as an admin: the hook refuses it.
    const cookie = await sessionFor(admin.id)
    const res = await rest.patch(`users/${student.id}`, { role: 'admin' }, cookie)
    expect(res.status).toBeGreaterThanOrEqual(400)
    await expect(
      payload.update({
        collection: 'users',
        id: pending.id,
        data: { role: 'company' },
        user: actor,
        overrideAccess: false,
      }),
    ).rejects.toThrow()
    expect((await reload(student.id)).role).toBe('student')
    expect((await reload(pending.id)).role).toBe('pending')
    expect((await reload(admin.id)).role).toBe('admin')
  })

  it('a student, a company, a pending user and nobody cannot fix roles', async () => {
    const payload = await getTestPayload()
    const student = await makeUser('student@example.test', 'student')
    const company = await makeUser('company@example.test', 'company')
    const pending = await makeUser('pending@example.test', 'pending')
    for (const actor of [asUser(student), asUser(company), asUser(pending), null]) {
      expect(
        await fixRole(payload, actor, form({ userId: student.id, role: 'company' })),
      ).toMatchObject({ status: 'error', error: 'forbidden' })
    }
    // Their own role through REST: field access drops it.
    for (const who of [student, company]) {
      const cookie = await login(who.email)
      await rest.patch(
        `users/${who.id}`,
        { role: who.role === 'student' ? 'company' : 'student' },
        cookie,
      )
      expect((await reload(who.id)).role).toBe(who.role)
    }
    expect((await rest.patch(`users/${student.id}`, { role: 'company' })).status).toBe(403)
  })
})

describe('a role cannot change once there are applications or projects', () => {
  let w: World
  beforeAll(async () => {
    await resetDatabase()
    w = await createWorld()
  })

  it('a student with an application and a company with projects stay as they are', async () => {
    const actor = asUser(w.admin)
    expect(
      await fixRole(w.payload, actor, form({ userId: w.alpha.user.id, role: 'company' })),
    ).toMatchObject({ status: 'error', error: 'has_work' })
    expect(
      await fixRole(w.payload, actor, form({ userId: w.companyA.user.id, role: 'student' })),
    ).toMatchObject({ status: 'error', error: 'has_work' })
    // And through REST as an admin.
    const res = await rest.patch(
      `users/${w.companyA.user.id}`,
      { role: 'student' },
      await sessionFor(w.admin.id),
    )
    expect(res.status).toBe(409)
    expect((await reload(w.alpha.user.id)).role).toBe('student')
    expect((await reload(w.companyA.user.id)).role).toBe('company')
  })

  it('the account screen shows the work and who may change what', async () => {
    const alpha = await loadAccount(w.payload, asUser(w.admin), w.alpha.user.id)
    expect(alpha).toMatchObject({ work: 1, hasRoleData: true, isTeam: false })
    const company = await loadAccount(w.payload, asUser(w.admin), w.companyA.user.id)
    expect(company!.work).toBeGreaterThan(0)
    const admin = await loadAccount(w.payload, asUser(w.admin), w.admin.id)
    expect(admin).toMatchObject({ isTeam: true, methods: [] })
    // Nobody but the team can load it.
    for (const actor of [asUser(w.alpha.user), asUser(w.companyA.user), null]) {
      expect(await loadAccount(w.payload, actor, w.alpha.user.id)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe('pausing an account', () => {
  let admin: User
  let student: User
  beforeEach(async () => {
    await resetDatabase()
    admin = await makeUser(ADMIN_EMAIL, 'admin')
    student = await makeUser('student@example.test', 'student')
    send = vi.spyOn((await getTestPayload()).email, 'sendEmail')
  })

  const pause = async (reason = 'Shared the account with others') =>
    pauseAccount(await getTestPayload(), asUser(admin), form({ userId: student.id, reason }))

  it('ends every session, logs the reason and emails the person', async () => {
    const phone = await login(student.email)
    const laptop = await login(student.email)
    expect(await me(phone)).toBeTruthy()

    expect(await pause()).toMatchObject({ status: 'done' })
    const after = await reload(student.id)
    expect(after.accountStatus).toBe('paused')
    expect(await me(phone)).toBeNull()
    expect(await me(laptop)).toBeNull()

    expect((await userLog(student.id)).at(-1)).toMatchObject({
      action: 'status_change',
      field: 'accountStatus',
      fromStatus: 'active',
      toStatus: 'paused',
      note: 'Shared the account with others',
      actor: admin.id,
    })
    const mail = mails().find((m) => m.to === student.email)!
    expect(mail.subject).toBe('Your Konnected account is paused')
    // The reason stays with the team.
    expect(mail.html).not.toContain('Shared the account')
  })

  it('a paused account cannot sign in by any method', async () => {
    const payload = await getTestPayload()
    await pause()

    // Password: refused, and only after the right password does it say "paused".
    expect(
      await signInWithPassword(payload, {
        email: student.email,
        password: PASSWORD,
        locale: 'en',
        ip: IP,
      }),
    ).toEqual({ ok: false, error: 'paused' })
    expect(
      await signInWithPassword(payload, {
        email: student.email,
        password: 'not the right password',
        locale: 'en',
        ip: IP,
      }),
    ).toMatchObject({ ok: false, error: 'invalid_credentials' })
    const viaRest = await rest.post('users/login', { email: student.email, password: PASSWORD })
    expect(viaRest.status).toBe(403)
    expect(viaRest.headers.getSetCookie().some((c) => c.startsWith('payload-token=ey'))).toBe(false)

    // Email link: the link is sent as for anyone (no account enumeration), but does not sign in.
    await requestMagicLink(payload, { email: student.email, locale: 'en', ip: IP })
    const link = /\/magic\/([A-Za-z0-9_-]{43})/.exec(mails().at(-1)!.html)![1]!
    expect(await consumeMagicLink(payload, { token: link, locale: 'en', ip: IP })).toEqual({
      ok: false,
      error: 'paused',
    })

    // Google.
    await payload.update({
      collection: 'users',
      id: student.id,
      data: { googleSub: 'g-student' },
      overrideAccess: true,
    })
    await expect(
      completeGoogleLogin(payload, { sub: 'g-student', email: student.email, emailVerified: true }),
    ).rejects.toThrow(AuthFlowError)

    // Any server code that would start a session.
    await expect(createSessionCookie(payload, student.id)).rejects.toThrow(/paused/)
  })

  it('a paused user can do nothing, even with a user object in hand', async () => {
    const payload = await getTestPayload()
    await payload.create({
      collection: 'student-profiles',
      data: { name: 'S', school: 'S', programme: 'P', year: 1 } as never,
      user: asUser(student),
      overrideAccess: false,
    })
    await pause()
    const paused = asUser(await reload(student.id))
    expect(isStudent(paused)).toBe(false)
    expect(isCompany(paused)).toBe(false)
    await expect(
      payload.find({ collection: 'student-profiles', user: paused, overrideAccess: false }),
    ).rejects.toThrow()
  })

  it('needs a reason, and reactivating lets the person sign in again', async () => {
    const payload = await getTestPayload()
    expect(await pause('  ')).toMatchObject({ status: 'error', error: 'reason_required' })
    expect(await pause('x'.repeat(501))).toMatchObject({
      status: 'error',
      error: 'reason_too_long',
    })
    expect(await pause()).toMatchObject({ status: 'done' })
    expect(
      await reactivateAccount(payload, asUser(admin), form({ userId: student.id })),
    ).toMatchObject({ status: 'done' })
    expect((await reload(student.id)).accountStatus).toBe('active')
    await expect(login(student.email)).resolves.toContain('payload-token=')
    expect(mails().at(-1)!.subject).toBe('Your Konnected account is active again')
    expect((await userLog(student.id)).at(-1)).toMatchObject({
      field: 'accountStatus',
      fromStatus: 'paused',
      toStatus: 'active',
    })
  })

  it('a team account cannot be paused, from the screen or the API', async () => {
    const payload = await getTestPayload()
    expect(
      await pauseAccount(payload, asUser(admin), form({ userId: admin.id, reason: 'test' })),
    ).toMatchObject({ status: 'error', error: 'not_allowed' })
    const res = await rest.patch(
      `users/${admin.id}`,
      { accountStatus: 'paused' },
      await sessionFor(admin.id),
    )
    expect(res.status).toBe(403)
    expect((await reload(admin.id)).accountStatus).toBe('active')
  })

  it('a student, a company and nobody cannot pause or reactivate', async () => {
    const payload = await getTestPayload()
    const company = await makeUser('company@example.test', 'company')
    for (const actor of [asUser(student), asUser(company), null]) {
      expect(
        await pauseAccount(payload, actor, form({ userId: student.id, reason: 'x' })),
      ).toMatchObject({ status: 'error', error: 'forbidden' })
      expect(await reactivateAccount(payload, actor, form({ userId: student.id }))).toMatchObject({
        status: 'error',
        error: 'forbidden',
      })
    }
    // Their own status through REST: field access drops it.
    const cookie = await login(student.email)
    await rest.patch(`users/${student.id}`, { accountStatus: 'paused' }, cookie)
    expect((await reload(student.id)).accountStatus).toBe('active')
    expect((await rest.patch(`users/${student.id}`, { accountStatus: 'paused' })).status).toBe(403)
  })
})

// ---------------------------------------------------------------------------------------------
describe('signing out everywhere', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('ends every session of the account and is logged; the person can sign in again', async () => {
    const payload = await getTestPayload()
    const admin = await makeUser(ADMIN_EMAIL, 'admin')
    const company = await makeUser('company@example.test', 'company')
    const a = await login(company.email)
    const b = await login(company.email)

    expect(
      await signOutEverywhere(payload, asUser(admin), form({ userId: company.id })),
    ).toMatchObject({ status: 'done' })
    expect(await me(a)).toBeNull()
    expect(await me(b)).toBeNull()
    expect((await userLog(company.id)).at(-1)).toMatchObject({
      action: 'sign_out_everywhere',
      actor: admin.id,
    })
    expect((await reload(company.id)).accountStatus).toBe('active')
    await expect(login(company.email)).resolves.toContain('payload-token=')
  })

  it('only the team can do it', async () => {
    const payload = await getTestPayload()
    const student = await makeUser('student@example.test', 'student')
    const company = await makeUser('company@example.test', 'company')
    const cookie = await login(student.email)
    for (const actor of [asUser(student), asUser(company), null]) {
      expect(await signOutEverywhere(payload, actor, form({ userId: student.id }))).toMatchObject({
        status: 'error',
        error: 'forbidden',
      })
    }
    expect(await me(cookie)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
describe('a pause and sign out everywhere hold against writes that started before them', () => {
  // Payload writes the whole user row, sessions included, from the copy it read when an operation
  // began. These tests let the team act inside that window, the way a real race would.
  let admin: User
  let student: User
  beforeEach(async () => {
    await resetDatabase()
    admin = await makeUser(ADMIN_EMAIL, 'admin')
    student = await makeUser('student@example.test', 'student')
    send = vi.spyOn((await getTestPayload()).email, 'sendEmail')
  })

  const pause = async () =>
    pauseAccount(await getTestPayload(), asUser(admin), form({ userId: student.id, reason: 'x' }))
  const reactivate = async () =>
    reactivateAccount(await getTestPayload(), asUser(admin), form({ userId: student.id }))
  const signOutAll = async () =>
    signOutEverywhere(await getTestPayload(), asUser(admin), form({ userId: student.id }))

  /** The session rows as stored, read straight from the database. */
  const storedSessions = async (id: number) => {
    const row = await (
      await getTestPayload()
    ).db.findOne<{ id: number; sessions?: { id: string }[] }>({
      collection: 'users',
      where: { id: { equals: id } },
    })
    return row?.sessions ?? []
  }

  /**
   * Run `act` once, inside the next update of a user, after Payload has read the row it will
   * write back and before it writes it. `act` runs on its own connection and commits first.
   */
  const duringNextUserUpdate = async (act: () => Promise<unknown>) => {
    const hooks = (await getTestPayload()).collections.users.config.hooks.beforeChange
    let ran = false
    const hook = async ({ data }: { data: Record<string, unknown> }) => {
      if (!ran) {
        ran = true
        await act()
      }
      return data
    }
    hooks.push(hook as never)
    return {
      ran: () => ran,
      done: () => void hooks.splice(hooks.indexOf(hook as never), 1),
    }
  }

  it('a pause that lands while a password sign-in hashes the password holds', async () => {
    // Pause the account once the sign-in has read the user and is checking the password.
    const pbkdf2 = crypto.pbkdf2
    let ran = false
    vi.spyOn(crypto, 'pbkdf2').mockImplementation(((...args: unknown[]) => {
      const done = args.pop() as (error: Error | null, key?: Buffer) => void
      ;(pbkdf2 as (...a: unknown[]) => void)(...args, (error: Error | null, key?: Buffer) => {
        if (ran) return done(error, key)
        ran = true
        pause().then(
          () => done(error, key),
          (failure: Error) => done(failure),
        )
      })
    }) as never)

    const res = await rest.post('users/login', { email: student.email, password: PASSWORD })
    expect(ran).toBe(true)
    expect(res.status).toBe(403)
    expect(res.headers.getSetCookie().some((c) => c.startsWith('payload-token=ey'))).toBe(false)
    expect((await reload(student.id)).accountStatus).toBe('paused')
    expect(await storedSessions(student.id)).toEqual([])
  })

  it('a pause that lands while the person saves their own account holds', async () => {
    const cookie = await login(student.email)
    const race = await duringNextUserUpdate(pause)
    try {
      await rest.patch(`users/${student.id}`, { name: 'Still here' }, cookie)
    } finally {
      race.done()
    }
    expect(race.ran()).toBe(true)
    expect((await reload(student.id)).accountStatus).toBe('paused')
    expect(await storedSessions(student.id)).toEqual([])
    expect(await me(cookie)).toBeNull()
  })

  it('sign out everywhere that lands while the person saves their account holds', async () => {
    const cookie = await login(student.email)
    const race = await duringNextUserUpdate(signOutAll)
    try {
      const res = await rest.patch(`users/${student.id}`, { name: 'Still here' }, cookie)
      expect(res.status).toBe(200)
    } finally {
      race.done()
    }
    expect(race.ran()).toBe(true)
    // The rest of the save went through; the old session did not come back.
    const after = await reload(student.id)
    expect(after.name).toBe('Still here')
    expect(after.accountStatus).toBe('active')
    expect(await storedSessions(student.id)).toEqual([])
    expect(await me(cookie)).toBeNull()
    // A new sign-in works as usual.
    const fresh = await login(student.email)
    expect(await me(fresh)).toBeTruthy()
  })

  it('a whole-row write from an old copy puts back neither the status nor the sessions', async () => {
    const payload = await getTestPayload()
    const cookie = await login(student.email)
    // What sign-in and sign-out do: write back the row as read earlier.
    const stale = await payload.db.findOne<Record<string, unknown> & { id: number }>({
      collection: 'users',
      where: { id: { equals: student.id } },
    })
    expect(await signOutAll()).toMatchObject({ status: 'done' })
    expect(await pause()).toMatchObject({ status: 'done' })
    await payload.db.updateOne({
      collection: 'users',
      id: student.id,
      data: { ...stale!, updatedAt: null },
      returning: false,
    })
    expect((await reload(student.id)).accountStatus).toBe('paused')
    expect(await storedSessions(student.id)).toEqual([])
    expect(await me(cookie)).toBeNull()
  })

  it('the team can still pause and reactivate an account again and again', async () => {
    for (let round = 0; round < 2; round++) {
      expect(await pause()).toMatchObject({ status: 'done' })
      expect((await reload(student.id)).accountStatus).toBe('paused')
      expect(await reactivate()).toMatchObject({ status: 'done' })
      expect((await reload(student.id)).accountStatus).toBe('active')
      await expect(login(student.email)).resolves.toContain('payload-token=')
    }
  })

  it('the version and the sign-out time are not part of the API, for anyone', async () => {
    const studentCookie = await login(student.email)
    const adminCookie = await sessionFor(admin.id)
    for (const cookie of [studentCookie, adminCookie]) {
      const res = await rest.get(`users/${student.id}`, cookie)
      expect(res.status).toBe(200)
      expect(res.json).not.toHaveProperty('accountStatusVersion')
      expect(res.json).not.toHaveProperty('sessionsValidAfter')
    }
    // Nobody but the team moves the version, and nobody at all sets the sign-out time.
    await rest.patch(
      `users/${student.id}`,
      { accountStatusVersion: 99, sessionsValidAfter: new Date(0).toISOString() },
      studentCookie,
    )
    const row = await (
      await getTestPayload()
    ).db.findOne<{
      id: number
      accountStatusVersion?: number | null
      sessionsValidAfter?: string | null
    }>({
      collection: 'users',
      where: { id: { equals: student.id } },
    })
    expect(Number(row!.accountStatusVersion ?? 0)).toBe(0)
    expect(row!.sessionsValidAfter ?? null).toBeNull()
    expect(await me(studentCookie)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
describe('a new way to sign in', () => {
  const grant = vi.mocked(oidc.authorizationCodeGrant)
  beforeEach(async () => {
    await resetDatabase()
    grant.mockReset()
    send = vi.spyOn((await getTestPayload()).email, 'sendEmail')
  })

  it('Google linked to an email account: a notice, an email and a log row', async () => {
    const payload = await getTestPayload()
    // An account made with an email link: no Google, no password of its own.
    await requestMagicLink(payload, { email: 'ingrid@example.test', locale: 'no', ip: IP })
    const token = /\/magic\/([A-Za-z0-9_-]{43})/.exec(mails().at(-1)!.html)![1]!
    const linked = await consumeMagicLink(payload, { token, locale: 'no', ip: IP })
    expect(linked.ok).toBe(true)
    const id = (linked as { user: User }).user.id
    expect((await reload(id)).methodAddedNotice ?? null).toBeNull()

    await completeGoogleLogin(payload, {
      sub: 'g-ingrid',
      email: 'ingrid@example.test',
      emailVerified: true,
    })
    const user = await reload(id)
    expect(user.methodAddedNotice).toBe('google')
    const mail = mails().at(-1)!
    expect(mail.to).toBe('ingrid@example.test')
    expect(mail.subject).toBe('En ny måte å logge inn på ble lagt til')
    expect(mail.text).toContain('Google')
    expect((await userLog(id)).at(-1)).toMatchObject({
      action: 'sign_in_method_added',
      toStatus: 'google',
    })

    // Signing in with Google again adds nothing.
    const before = mails().length
    await completeGoogleLogin(payload, {
      sub: 'g-ingrid',
      email: 'ingrid@example.test',
      emailVerified: true,
    })
    expect(mails().length).toBe(before)
  })

  it('a password set with a reset link on a Google account adds a way; a new one does not', async () => {
    const payload = await getTestPayload()
    const google = await completeGoogleLogin(payload, {
      sub: 'g-1',
      email: 'g@example.test',
      emailVerified: true,
    })
    expect(google.methodAddedNotice ?? null).toBeNull()
    await requestPasswordReset(payload, { email: 'g@example.test', locale: 'en', ip: IP })
    const token = /\/reset-password\/([0-9a-f]{40})/.exec(mails().at(-1)!.html)![1]!
    expect(await resetPasswordWithToken(payload, { token, password: GOOD, ip: IP })).toEqual({
      ok: true,
    })
    const after = await reload(google.id)
    expect(after.methodAddedNotice).toBe('password')
    expect(after.passwordSetAt).toBeTruthy()
    expect(mails().at(-1)!.subject).toBe('A new way to sign in was added')
    expect((await userLog(google.id)).at(-1)).toMatchObject({ toStatus: 'password' })

    // A second reset changes the password, not the ways to sign in.
    await payload.update({
      collection: 'users',
      id: google.id,
      data: { methodAddedNotice: null },
      overrideAccess: true,
    })
    const count = mails().length
    await requestPasswordReset(payload, { email: 'g@example.test', locale: 'en', ip: IP })
    const second = /\/reset-password\/([0-9a-f]{40})/.exec(mails().at(-1)!.html)![1]!
    await resetPasswordWithToken(payload, { token: second, password: `${GOOD} two`, ip: IP })
    expect((await reload(google.id)).methodAddedNotice ?? null).toBeNull()
    expect(mails().length).toBe(count + 1) // only the reset email itself

    // Signing up with a password is the first way, not an added one.
    await signUpWithPassword(payload, {
      email: 'new@example.test',
      password: GOOD,
      locale: 'en',
      ip: IP,
    })
    const [fresh] = (
      await payload.find({
        collection: 'users',
        where: { email: { equals: 'new@example.test' } },
        overrideAccess: true,
      })
    ).docs as User[]
    expect(fresh!.methodAddedNotice ?? null).toBeNull()
    expect(fresh!.passwordSetAt).toBeTruthy()
  })

  it('the person clears their own notice; nobody can set one or clear someone else’s', async () => {
    const payload = await getTestPayload()
    const user = await makeUser('student@example.test', 'student', {
      methodAddedNotice: 'google',
    })
    const other = await makeUser('other@example.test', 'student')
    const otherCookie = await login(other.email)
    // Someone else cannot clear it.
    await rest.patch(`users/${user.id}`, { methodAddedNotice: null }, otherCookie)
    expect((await reload(user.id)).methodAddedNotice).toBe('google')
    // A person cannot give themselves one.
    await rest.patch(`users/${other.id}`, { methodAddedNotice: 'password' }, otherCookie)
    expect((await reload(other.id)).methodAddedNotice ?? null).toBeNull()

    expect(await dismissMethodNotice(payload, asUser(await reload(user.id)))).toBe(true)
    expect((await reload(user.id)).methodAddedNotice ?? null).toBeNull()
    expect(await dismissMethodNotice(payload, null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
describe('admin sign-in rules', () => {
  beforeEach(async () => {
    await resetDatabase()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('a team member taken off ADMIN_EMAILS loses access at once and cannot sign in', async () => {
    const payload = await getTestPayload()
    const admin = await completeGoogleLogin(payload, {
      sub: 'g-admin',
      email: ADMIN_EMAIL,
      emailVerified: true,
    })
    const cookie = await sessionFor(admin.id)
    expect((await rest.get('users?limit=5', cookie)).status).toBe(200)
    expect(isAdmin({ ...admin })).toBe(true)

    vi.stubEnv('ADMIN_EMAILS', 'someone.else@konnected.test')
    expect(isAdmin({ ...admin })).toBe(false)
    expect((await rest.get('users?limit=5', cookie)).json.docs).toHaveLength(1) // only itself
    expect((await rest.get('activity-logs', cookie)).status).toBe(403)
    await expect(
      completeGoogleLogin(payload, { sub: 'g-admin', email: ADMIN_EMAIL, emailVerified: true }),
    ).rejects.toMatchObject({ code: 'team_removed' })
  })

  it('a user object without an email is never admin', () => {
    expect(isAdmin({ id: 1, role: 'admin' })).toBe(false)
    expect(isAdmin({ id: 1, role: 'admin', email: ADMIN_EMAIL, accountStatus: 'active' })).toBe(
      true,
    )
  })

  it('an admin cannot use a password or an email link, and gets the generic answer', async () => {
    const payload = await getTestPayload()
    await makeUser(ADMIN_EMAIL, 'admin')
    expect(
      await signInWithPassword(payload, {
        email: ADMIN_EMAIL,
        password: PASSWORD,
        locale: 'en',
        ip: IP,
      }),
    ).toMatchObject({ ok: false, error: 'invalid_credentials' })
    send = vi.spyOn(payload.email, 'sendEmail')
    await requestMagicLink(payload, { email: ADMIN_EMAIL, locale: 'en', ip: IP })
    expect(mails().at(-1)!.html).not.toContain('href')
  })

  it('an unverified Google email on the list never becomes admin', async () => {
    const payload = await getTestPayload()
    await expect(
      completeGoogleLogin(payload, { sub: 'g-x', email: ADMIN_EMAIL, emailVerified: false }),
    ).rejects.toMatchObject({ code: 'unverified_email' })
    expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe('the team account list', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('finds accounts by name or email and filters by role or paused, for the team only', async () => {
    const payload = await getTestPayload()
    const admin = await makeUser(ADMIN_EMAIL, 'admin')
    const student = await makeUser('ingrid@example.test', 'student', { name: 'Ingrid Solberg' })
    const company = await makeUser('tobias@example.test', 'company', { name: 'Tobias Vik' })
    await makeUser('pending@example.test', 'pending')
    const actor = asUser(admin)

    expect((await listAccounts(payload, actor, {}))!.totalDocs).toBe(4)
    expect((await listAccounts(payload, actor, { q: 'solberg' }))!.docs.map((d) => d.id)).toEqual([
      student.id,
    ])
    expect((await listAccounts(payload, actor, { q: 'tobias@' }))!.docs.map((d) => d.id)).toEqual([
      company.id,
    ])
    expect(
      (await listAccounts(payload, actor, { filter: 'company' }))!.docs.map((d) => d.id),
    ).toEqual([company.id])
    await pauseAccount(payload, actor, form({ userId: student.id, reason: 'test' }))
    expect(
      (await listAccounts(payload, actor, { filter: 'paused' }))!.docs.map((d) => d.id),
    ).toEqual([student.id])

    for (const other of [asUser(student), asUser(company), null]) {
      expect(await listAccounts(payload, other, {})).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe('sign-in links', () => {
  beforeEach(async () => {
    await resetDatabase()
    send = vi.spyOn((await getTestPayload()).email, 'sendEmail')
  })

  it('only the newest link works', async () => {
    const payload = await getTestPayload()
    const tokens: string[] = []
    for (let i = 0; i < 2; i++) {
      await requestMagicLink(payload, { email: 'two@example.test', locale: 'en', ip: IP })
      tokens.push(/\/magic\/([A-Za-z0-9_-]{43})/.exec(mails().at(-1)!.html)![1]!)
    }
    expect(await consumeMagicLink(payload, { token: tokens[0]!, locale: 'en', ip: IP })).toEqual({
      ok: false,
      error: 'invalid_link',
    })
    expect((await consumeMagicLink(payload, { token: tokens[1]!, locale: 'en', ip: IP })).ok).toBe(
      true,
    )
  })
})

// ---------------------------------------------------------------------------------------------
describe('the team workspace lives at /{locale}/team', () => {
  it('every team menu entry is under /team', () => {
    for (const { items } of TEAM_NAV) {
      for (const item of items) expect(item.href).toMatch(/^\/team(\/|$)/)
    }
  })

  it('old /{locale}/admin addresses redirect to /{locale}/team, for every language', () => {
    expect([...LEGACY_LOCALES]).toEqual([...routing.locales])
    const toRegExp = (source: string) =>
      new RegExp(
        `^${source
          .replace(/:locale\(([^)]+)\)/, '(?<locale>$1)')
          .replace('/:path*', '(?:/(?<path>.*))?')}$`,
      )
    const resolve = (pathname: string) => {
      for (const rule of LEGACY_TEAM_REDIRECTS) {
        const match = toRegExp(rule.source).exec(pathname)
        if (!match) continue
        return rule.destination
          .replace(':locale', match.groups!.locale!)
          .replace('/:path*', match.groups!.path ? `/${match.groups!.path}` : '')
      }
      return null
    }
    expect(resolve('/en/admin')).toBe('/en/team')
    expect(resolve('/no/admin/approvals')).toBe('/no/team/approvals')
    // Payload's own panel at /admin is not touched.
    expect(resolve('/admin')).toBeNull()
    expect(LEGACY_TEAM_REDIRECTS.every((r) => r.permanent === false)).toBe(true)
  })
})
