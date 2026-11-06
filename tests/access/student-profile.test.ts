import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SHARE_KEYS } from '@/lib/students/fields'
import {
  completeOnboarding,
  savePrivacy,
  saveProfile,
  type SessionUser,
  setCv,
} from '@/lib/students/profile'
import type { StudentProfile, User } from '@/payload-types'

import { fileOf, makePdf } from '../helpers/files'
import {
  asUser,
  createWorld,
  graphql,
  login,
  PASSWORD,
  resetDatabase,
  rest,
  SENTINEL,
  sessionFor,
  type World,
} from '../helpers/world'

/**
 * The student profile card: the review status (only Konnected sets it), the sharing choices
 * (everything off until ticked, and only ticked items reach the company), and the onboarding and
 * profile Server Actions, each run as admin, student, company, a user without a role and
 * anonymous. Local API calls pass `overrideAccess: false` and a user.
 */

// The Server Actions read the session from the request headers. Tests set the cookie here; the
// Origin is what a browser sends with a Server Action call from our own pages.
const requestHeaders = vi.hoisted(() => ({ cookie: '' }))
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({
      origin: 'http://localhost:3000',
      ...(requestHeaders.cookie ? { cookie: requestHeaders.cookie } : {}),
    }),
}))

let w: World

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
  requestHeaders.cookie = ''
})

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User): SessionUser => asUser(user) as SessionUser

async function makeUser(email: string, role: User['role']): Promise<User> {
  return (await w.payload.create({
    collection: 'users',
    data: { email, password: PASSWORD, role, _verified: true } as never,
    overrideAccess: true,
    disableVerificationEmail: true,
  })) as User
}

const profileOf = async (userId: number): Promise<StudentProfile | undefined> =>
  (
    await w.payload.find({
      collection: 'student-profiles',
      where: { user: { equals: userId } },
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0]

/** A complete onboarding form. `extra` adds or replaces fields; `null` leaves one out. */
function onboardingForm(extra: Record<string, string | string[] | null> = {}): FormData {
  const values: Record<string, string | string[] | null> = {
    name: 'Ingrid Solberg',
    school: 'NTNU',
    programme: 'Industrial design',
    year: '3',
    pitch: 'I turn messy interviews into clear next steps.',
    skills: 'Figma, user research, figma, , Copywriting',
    interests: ['design', 'research', 'not-a-real-key'],
    preferredProjectTypes: ['paid', 'remote'],
    cv: 'none',
    ...extra,
  }
  const form = new FormData()
  for (const [key, value] of Object.entries(values)) {
    if (value === null) continue
    for (const v of Array.isArray(value) ? value : [value]) form.append(key, v)
  }
  return form
}

async function newStudent(email = 'new.student@student.test') {
  const user = await makeUser(email, 'student')
  return { user, ctx: session(user) }
}

describe('review status: only Konnected sets it', () => {
  it('a new profile waits for review, whatever the student sends (Local API and REST)', async () => {
    const { user } = await newStudent()
    const created = await w.payload.create({
      collection: 'student-profiles',
      data: {
        name: 'Self Reviewed',
        reviewStatus: 'reviewed',
        reviewedAt: '2026-01-01T00:00:00.000Z',
      } as never,
      ...as(user),
    })
    expect(created.reviewStatus).toBe('waiting')
    expect(created.reviewedAt ?? null).toBeNull()

    const other = await newStudent('rest.student@student.test')
    const cookie = await login(other.user.email)
    const res = await rest.post(
      'student-profiles',
      { name: 'Rest Student', reviewStatus: 'reviewed', reviewedAt: '2026-01-01T00:00:00.000Z' },
      cookie,
    )
    expect(res.status).toBe(201)
    const stored = await profileOf(other.user.id)
    expect(stored?.reviewStatus).toBe('waiting')
    expect(stored?.reviewedAt ?? null).toBeNull()
  })

  it('a student cannot mark their own profile reviewed (Local API, REST, GraphQL)', async () => {
    await w.payload.update({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      data: { reviewStatus: 'reviewed', reviewedAt: new Date().toISOString(), pitch: 'x' },
      ...as(w.alpha.user),
    })
    const cookie = await login(w.alpha.user.email)
    await rest.patch(
      `student-profiles/${w.alpha.profile.id}`,
      { reviewStatus: 'reviewed', reviewedAt: new Date().toISOString() },
      cookie,
    )
    await graphql(
      `mutation { updateStudentProfile(id: ${w.alpha.profile.id}, data: { reviewStatus: reviewed }) { id } }`,
      cookie,
    )
    const after = await profileOf(w.alpha.user.id)
    expect(after?.pitch).toBe('x')
    expect(after?.reviewStatus).toBe('waiting')
    expect(after?.reviewedAt ?? null).toBeNull()
  })

  it('a student reads their own review status and date', async () => {
    const own = await w.payload.findByID({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      ...as(w.alpha.user),
    })
    expect(own.reviewStatus).toBe('waiting')
    expect(own).toHaveProperty('reviewedAt')
  })

  it('admin marks a profile reviewed: the date is set, logged, and cleared again on waiting', async () => {
    const reviewed = await w.payload.update({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      data: { reviewStatus: 'reviewed' },
      ...as(w.admin),
    })
    expect(reviewed.reviewStatus).toBe('reviewed')
    expect(reviewed.reviewedAt).toBeTruthy()
    expect(Date.now() - new Date(reviewed.reviewedAt!).getTime()).toBeLessThan(60_000)

    const logs = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [
          { targetCollection: { equals: 'student-profiles' } },
          { targetId: { equals: String(w.alpha.profile.id) } },
          { action: { equals: 'status_change' } },
        ],
      },
      overrideAccess: true,
    })
    expect(logs.docs.map((l) => [l.fromStatus, l.toStatus])).toEqual([['waiting', 'reviewed']])

    // An admin can set the date explicitly, and an unrelated edit keeps it.
    const date = '2026-11-04T09:00:00.000Z'
    await w.payload.update({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      data: { reviewedAt: date },
      ...as(w.admin),
    })
    await w.payload.update({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      data: { pitch: 'edited by the student' },
      ...as(w.alpha.user),
    })
    expect((await profileOf(w.alpha.user.id))?.reviewedAt).toBe(date)

    const back = await w.payload.update({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      data: { reviewStatus: 'waiting' },
      ...as(w.admin),
    })
    expect(back.reviewedAt ?? null).toBeNull()
  })

  it('admin can set it through REST too', async () => {
    const cookie = await sessionFor(w.admin.id)
    const res = await rest.patch(
      `student-profiles/${w.beta.profile.id}`,
      { reviewStatus: 'reviewed' },
      cookie,
    )
    expect(res.status).toBe(200)
    expect((await profileOf(w.beta.user.id))?.reviewStatus).toBe('reviewed')
  })

  it('a company and an anonymous visitor can neither read nor change it', async () => {
    const company = await login(w.companyA.user.email)
    for (const cookie of [company, undefined]) {
      const read = await rest.get(`student-profiles/${w.alpha.profile.id}`, cookie)
      expect([401, 403, 404]).toContain(read.status)
      expect(read.text).not.toContain('reviewStatus')
      const write = await rest.patch(
        `student-profiles/${w.alpha.profile.id}`,
        { reviewStatus: 'reviewed' },
        cookie,
      )
      expect([401, 403, 404]).toContain(write.status)
      const gql = await graphql(
        `
          {
            StudentProfiles {
              docs {
                id
                reviewStatus
                reviewedAt
              }
            }
          }
        `,
        cookie,
      )
      expect(gql.text).not.toContain('waiting')
    }
    await expect(
      w.payload.update({
        collection: 'student-profiles',
        id: w.alpha.profile.id,
        data: { reviewStatus: 'reviewed' },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()
    expect((await profileOf(w.alpha.user.id))?.reviewStatus).toBe('waiting')
  })
})

describe('sharing choices', () => {
  it('every item is off on a new profile', async () => {
    const { user } = await newStudent()
    const created = await w.payload.create({
      collection: 'student-profiles',
      data: { name: 'Fresh Student' } as never,
      ...as(user),
    })
    for (const key of SHARE_KEYS) expect(created.privacy?.[key], key).toBe(false)
  })

  it('the company sees exactly the ticked items on its match, and they go when unticked', async () => {
    const cookie = await login(w.companyA.user.email)
    const shared = async () =>
      (await rest.get(`matches/${w.match.id}?depth=2`, cookie)).json.sharedInfo as Record<
        string,
        unknown
      >

    await w.payload.update({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      data: {
        privacy: {
          shareSchool: true,
          shareContactEmail: true,
          sharePhone: false,
          shareSkills: false,
        },
      },
      ...as(w.alpha.user),
    })
    let info = await shared()
    expect(info.school).toBe(SENTINEL.alpha.school)
    expect(info.programme).toBe(SENTINEL.alpha.programme)
    expect(info.year).toBe(2)
    expect(info.contactEmail).toBe(SENTINEL.alpha.contactEmail)
    expect(info.phone).toBeNull()
    expect(info.name).toBeNull()
    expect(info.skills ?? []).toHaveLength(0)
    // Nothing that is not shareable, at any depth.
    const text = JSON.stringify(info)
    for (const secret of [
      SENTINEL.alpha.phone,
      SENTINEL.alpha.name,
      SENTINEL.alpha.highlights,
      SENTINEL.alpha.interest,
      SENTINEL.alpha.projectType,
      SENTINEL.alpha.userEmail,
    ]) {
      expect(text).not.toContain(secret)
    }

    await w.payload.update({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      data: { privacy: { shareSchool: false, shareContactEmail: false, sharePhone: true } },
      ...as(w.alpha.user),
    })
    info = await shared()
    expect(info.school).toBeNull()
    expect(info.programme).toBeNull()
    expect(info.contactEmail).toBeNull()
    expect(info.phone).toBe(SENTINEL.alpha.phone)

    // Another company sees none of it.
    const other = await login(w.companyB.user.email)
    const res = await rest.get(`matches?depth=2`, other)
    expect(res.text).not.toContain(SENTINEL.alpha.phone)
  })
})

describe('onboarding (completeOnboarding)', () => {
  it('a student without a profile creates one with every answer, waiting for review, sharing nothing', async () => {
    const { user, ctx } = await newStudent()
    const result = await completeOnboarding(w.payload, ctx, onboardingForm())
    expect(result.status).toBe('done')

    const profile = await profileOf(user.id)
    expect(profile).toMatchObject({
      user: user.id,
      name: 'Ingrid Solberg',
      school: 'NTNU',
      programme: 'Industrial design',
      year: 3,
      pitch: 'I turn messy interviews into clear next steps.',
      reviewStatus: 'waiting',
    })
    // Trimmed, without empties and repeats; unknown option keys dropped.
    expect(profile?.skills).toEqual(['Figma', 'user research', 'Copywriting'])
    expect(profile?.interests).toEqual(['design', 'research'])
    expect(profile?.preferredProjectTypes).toEqual(['paid', 'remote'])
    expect(profile?.cv ?? null).toBeNull()
    for (const key of SHARE_KEYS) expect(profile?.privacy?.[key], key).toBe(false)
  })

  it('saves only the ticked sharing items', async () => {
    const { user, ctx } = await newStudent()
    const form = onboardingForm()
    form.set('shareName', 'on')
    form.set('shareCv', 'on')
    form.set('sharePhone', 'yes') // only "on" counts
    await completeOnboarding(w.payload, ctx, form)
    const privacy = (await profileOf(user.id))?.privacy
    expect(privacy).toMatchObject({ shareName: true, shareCv: true, sharePhone: false })
    expect(privacy?.shareSchool).toBe(false)
  })

  it('takes the user from the session, never from the form, and ignores a review status', async () => {
    const { user, ctx } = await newStudent()
    const form = onboardingForm({
      user: String(w.beta.user.id),
      reviewStatus: 'reviewed',
      reviewedAt: '2026-01-01',
    })
    expect((await completeOnboarding(w.payload, ctx, form)).status).toBe('done')
    const profile = await profileOf(user.id)
    expect(profile?.reviewStatus).toBe('waiting')
    expect(profile?.reviewedAt ?? null).toBeNull()
    // beta's profile is untouched.
    expect((await profileOf(w.beta.user.id))?.name).toBe(SENTINEL.beta.name)
  })

  it('attaches a CV the student uploaded', async () => {
    const { user, ctx } = await newStudent()
    const cv = await w.payload.create({
      collection: 'cvs',
      data: {} as never,
      file: fileOf(makePdf('mine.pdf'), 'mine.pdf', 'application/pdf'),
      ...as(user),
    })
    const result = await completeOnboarding(w.payload, ctx, onboardingForm({ cv: String(cv.id) }))
    expect(result.status).toBe('done')
    expect((await profileOf(user.id))?.cv).toBe(cv.id)
  })

  it("refuses another student's CV and creates nothing", async () => {
    const { user, ctx } = await newStudent()
    const result = await completeOnboarding(
      w.payload,
      ctx,
      onboardingForm({ cv: String(w.alphaCv.id) }),
    )
    expect(result).toMatchObject({ status: 'error', fields: { cv: 'invalid' } })
    expect(await profileOf(user.id)).toBeUndefined()
  })

  it('checks every answer on the server', async () => {
    const { user, ctx } = await newStudent()
    const result = await completeOnboarding(
      w.payload,
      ctx,
      onboardingForm({
        name: '   ',
        school: null,
        programme: 'x'.repeat(121),
        year: '11',
        pitch: 'x'.repeat(601),
        skills: Array.from({ length: 21 }, (_, i) => `skill ${i}`).join(','),
        interests: ['not-a-real-key'],
        cv: 'abc',
      }),
    )
    expect(result).toEqual({
      status: 'error',
      fields: {
        name: 'required',
        school: 'required',
        programme: 'too_long',
        year: 'invalid',
        pitch: 'too_long',
        skills: 'too_many',
        interests: 'required',
        cv: 'invalid',
      },
    })
    expect(await profileOf(user.id)).toBeUndefined()
  })

  it('works once: a second try, even at the same moment, makes no second profile', async () => {
    const { user, ctx } = await newStudent()
    const results = await Promise.allSettled([
      completeOnboarding(w.payload, ctx, onboardingForm({ name: 'First' })),
      completeOnboarding(w.payload, ctx, onboardingForm({ name: 'Second' })),
    ])
    const done = results.filter((r) => r.status === 'fulfilled' && r.value.status === 'done')
    expect(done).toHaveLength(1)
    const all = await w.payload.find({
      collection: 'student-profiles',
      where: { user: { equals: user.id } },
      overrideAccess: true,
    })
    expect(all.docs).toHaveLength(1)

    const again = await completeOnboarding(w.payload, ctx, onboardingForm())
    expect(again).toEqual({ status: 'error', error: 'exists' })
  })

  it('admin, company, a user without a role and anonymous cannot use it', async () => {
    const pending = await makeUser('pending@x.test', 'pending')
    for (const user of [w.admin, w.companyA.user, pending]) {
      const result = await completeOnboarding(w.payload, session(user), onboardingForm())
      expect(result, user.role).toEqual({ status: 'error', error: 'forbidden' })
      expect(await profileOf(user.id)).toBeUndefined()
    }
    expect(await completeOnboarding(w.payload, null, onboardingForm())).toEqual({
      status: 'error',
      error: 'forbidden',
    })
  })
})

describe('profile page (saveProfile, savePrivacy, setCv)', () => {
  const profileForm = (extra: Record<string, string | string[] | null> = {}) =>
    onboardingForm({
      name: 'Alpha Renamed',
      experience: 'Two summers at a design studio.',
      highlights: 'Best thesis award.',
      contactEmail: 'alpha.contact@example.test',
      phone: '+47 912 34 567',
      ...extra,
    })

  it('a student edits their own profile; sharing, CV and review stay as they were', async () => {
    const before = await profileOf(w.alpha.user.id)
    const result = await saveProfile(
      w.payload,
      session(w.alpha.user),
      profileForm({ shareName: 'on', cv: 'none', reviewStatus: 'reviewed' }),
    )
    expect(result.status).toBe('done')
    const after = await profileOf(w.alpha.user.id)
    expect(after).toMatchObject({
      name: 'Alpha Renamed',
      experience: 'Two summers at a design studio.',
      highlights: 'Best thesis award.',
      contactEmail: 'alpha.contact@example.test',
      phone: '+47 912 34 567',
      year: 3,
      reviewStatus: 'waiting',
    })
    expect(after?.privacy).toEqual(before?.privacy)
    expect(after?.cv).toBe(before?.cv)
  })

  it('clears optional answers that are left empty', async () => {
    await saveProfile(
      w.payload,
      session(w.alpha.user),
      profileForm({ experience: '', phone: '', contactEmail: '', pitch: '', skills: '' }),
    )
    const after = await profileOf(w.alpha.user.id)
    expect(after?.experience ?? null).toBeNull()
    expect(after?.phone ?? null).toBeNull()
    expect(after?.contactEmail ?? null).toBeNull()
    expect(after?.pitch ?? null).toBeNull()
    expect(after?.skills ?? []).toEqual([])
  })

  it('checks the contact details on the server', async () => {
    const result = await saveProfile(
      w.payload,
      session(w.alpha.user),
      profileForm({ contactEmail: 'not an email', phone: 'call me maybe' }),
    )
    expect(result).toEqual({
      status: 'error',
      fields: { contactEmail: 'invalid', phone: 'invalid' },
    })
    expect((await profileOf(w.alpha.user.id))?.name).toBe(SENTINEL.alpha.name)
  })

  it('a student without a profile is sent to the onboarding', async () => {
    const { ctx } = await newStudent()
    expect(await saveProfile(w.payload, ctx, profileForm())).toEqual({
      status: 'error',
      error: 'no_profile',
    })
    expect(await savePrivacy(w.payload, ctx, new FormData())).toEqual({
      status: 'error',
      error: 'no_profile',
    })
  })

  it('saves the sharing choices: ticked on, everything else off', async () => {
    const form = new FormData()
    form.set('shareName', 'on')
    form.set('sharePhone', 'on')
    expect((await savePrivacy(w.payload, session(w.alpha.user), form)).status).toBe('done')
    const privacy = (await profileOf(w.alpha.user.id))?.privacy
    expect(privacy).toMatchObject({ shareName: true, sharePhone: true, shareSkills: false })
    const match = await w.payload.findByID({ collection: 'matches', id: w.match.id })
    expect(match.sharedInfo?.phone).toBe(SENTINEL.alpha.phone)
    expect(match.sharedInfo?.skills ?? []).toHaveLength(0)
  })

  it('replaces the CV and removes the old file; refuses a CV of another student', async () => {
    const ctx = session(w.alpha.user)
    const fresh = await w.payload.create({
      collection: 'cvs',
      data: {} as never,
      file: fileOf(makePdf('new.pdf'), 'new.pdf', 'application/pdf'),
      ...as(w.alpha.user),
    })
    const form = new FormData()
    form.set('cv', String(fresh.id))
    expect((await setCv(w.payload, ctx, form)).status).toBe('done')
    expect((await profileOf(w.alpha.user.id))?.cv).toBe(fresh.id)
    const old = await w.payload.find({
      collection: 'cvs',
      where: { id: { equals: w.alphaCv.id } },
      overrideAccess: true,
    })
    expect(old.docs).toHaveLength(0)

    form.set('cv', String(w.betaCv.id))
    expect(await setCv(w.payload, ctx, form)).toEqual({
      status: 'error',
      fields: { cv: 'invalid' },
    })
    expect((await profileOf(w.alpha.user.id))?.cv).toBe(fresh.id)

    form.set('cv', 'none')
    expect((await setCv(w.payload, ctx, form)).status).toBe('done')
    expect((await profileOf(w.alpha.user.id))?.cv ?? null).toBeNull()
  })

  it('admin, company, a user without a role and anonymous cannot use any of them', async () => {
    const pending = await makeUser('pending@x.test', 'pending')
    const cvForm = new FormData()
    cvForm.set('cv', String(w.alphaCv.id))
    const privacyForm = new FormData()
    privacyForm.set('shareName', 'on')
    for (const user of [w.admin, w.companyA.user, pending, null]) {
      const ctx = user ? session(user) : null
      expect(await saveProfile(w.payload, ctx, profileForm())).toEqual({
        status: 'error',
        error: 'forbidden',
      })
      expect(await savePrivacy(w.payload, ctx, privacyForm)).toEqual({
        status: 'error',
        error: 'forbidden',
      })
      expect(await setCv(w.payload, ctx, cvForm)).toEqual({ status: 'error', error: 'forbidden' })
    }
    const alpha = await profileOf(w.alpha.user.id)
    expect(alpha?.name).toBe(SENTINEL.alpha.name)
    expect(alpha?.privacy?.shareName).toBe(false)
  })
})

describe('the Server Actions read the session themselves', () => {
  it('anonymous and company sessions are refused; a student session works', async () => {
    const { completeOnboardingAction, saveProfileAction, savePrivacyAction } =
      await import('@/lib/students/actions')
    const idle = { status: 'idle' as const }

    requestHeaders.cookie = ''
    expect(await completeOnboardingAction(idle, onboardingForm())).toEqual({
      status: 'error',
      error: 'forbidden',
    })

    // A cookie from another site is not a session.
    requestHeaders.cookie = await login(w.alpha.user.email)
    const crossSite = await import('next/headers')
    vi.spyOn(crossSite, 'headers').mockResolvedValueOnce(
      new Headers({ origin: 'https://evil.example', cookie: requestHeaders.cookie }) as never,
    )
    expect(await saveProfileAction(idle, onboardingForm())).toEqual({
      status: 'error',
      error: 'forbidden',
    })
    expect((await profileOf(w.alpha.user.id))?.name).toBe(SENTINEL.alpha.name)

    requestHeaders.cookie = await login(w.companyA.user.email)
    expect(await saveProfileAction(idle, onboardingForm())).toEqual({
      status: 'error',
      error: 'forbidden',
    })

    requestHeaders.cookie = await sessionFor(w.admin.id)
    expect(await savePrivacyAction(idle, new FormData())).toEqual({
      status: 'error',
      error: 'forbidden',
    })

    const { user } = await newStudent()
    requestHeaders.cookie = await login(user.email)
    const result = await completeOnboardingAction(idle, onboardingForm())
    expect(result).toMatchObject({ status: 'done' })
    expect((await profileOf(user.id))?.user).toBe(user.id)
  })
})
