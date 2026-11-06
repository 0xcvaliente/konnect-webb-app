import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { saveCompany } from '@/lib/companies/company'
import { saveProfile } from '@/lib/students/profile'
import {
  approvalCounts,
  approveCompany,
  approveProject,
  askCompanyInfo,
  askProfileChanges,
  listQueue,
  loadCompanyReview,
  loadProfileReview,
  loadProjectReview,
  markProfileReviewed,
  publishProject,
  rejectCompany,
  rejectProject,
  requestProjectChanges,
  type SessionUser,
} from '@/lib/team/approvals'
import en from '@/messages/en.json'
import type { ActivityLog, Company, Project, StudentProfile, User } from '@/payload-types'

import {
  asUser,
  companyDetails,
  createWorld,
  graphql,
  login,
  PASSWORD,
  readyFields,
  resetDatabase,
  rest,
  SENTINEL,
  sessionFor,
  type World,
} from '../helpers/world'

/**
 * Kanban card "Admin approval queue for companies and projects", plus profile review: the team's
 * queue, every decision (approve, reject, ask for information or changes, set the price, publish,
 * mark reviewed) as each role (admin, student, company, anonymous), every status move it makes,
 * the activity log rows, the emails, and what the company or student then sees. Local API calls
 * pass `overrideAccess: false` and a user; REST and GraphQL go through the real route handlers.
 */

// The Server Actions read the session from the request headers. Tests set the cookie here.
const requestHeaders = vi.hoisted(() => ({ cookie: '' }))
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({
      origin: 'http://localhost:3000',
      ...(requestHeaders.cookie ? { cookie: requestHeaders.cookie } : {}),
    }),
}))

let w: World
let send: MockInstance

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
  requestHeaders.cookie = ''
  send = vi.spyOn(w.payload.email, 'sendEmail')
  send.mockClear()
})

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User | null): SessionUser | null =>
  user ? (asUser(user) as SessionUser) : null

const form = (values: Record<string, string | number>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, String(value))
  return data
}

/** Everyone who is not on the team: student, company, and nobody signed in. */
const outsiders = () => [w.alpha.user, w.companyA.user, null] as const

let counter = 0
/** A company user who registered a company Konnected has not decided on yet. */
async function pendingCompany(name = `Pending ${counter + 1} AS`) {
  counter += 1
  const user = (await w.payload.create({
    collection: 'users',
    data: {
      email: `pending${counter}@company.test`,
      password: PASSWORD,
      role: 'company',
      _verified: true,
    } as never,
    overrideAccess: true,
    disableVerificationEmail: true,
  })) as User
  const company = await w.payload.create({
    collection: 'companies',
    data: { ...companyDetails(name), status: 'pending' },
    ...as(user),
  })
  const fresh = (await w.payload.findByID({ collection: 'users', id: user.id, depth: 0 })) as User
  return { user: fresh, company }
}

/** A project of company A that company A sent for review. */
async function submittedProject(data: Partial<Project> = {}) {
  const draft = await w.payload.create({
    collection: 'projects',
    data: { ...readyFields(), title: 'Queue project', ...data } as never,
    ...as(w.companyA.user),
  })
  return w.payload.update({
    collection: 'projects',
    id: draft.id,
    data: { status: 'submitted' },
    ...as(w.companyA.user),
  })
}

const company = (id: number) =>
  w.payload.findByID({ collection: 'companies', id, depth: 0 }) as Promise<Company>
const project = (id: number) =>
  w.payload.findByID({ collection: 'projects', id, depth: 0 }) as Promise<Project>
const profile = (id: number) =>
  w.payload.findByID({ collection: 'student-profiles', id, depth: 0 }) as Promise<StudentProfile>

/** The activity rows of one record, oldest first. */
async function activity(collection: string, id: number): Promise<ActivityLog[]> {
  const rows = await w.payload.find({
    collection: 'activity-logs',
    where: {
      and: [{ targetCollection: { equals: collection } }, { targetId: { equals: String(id) } }],
    },
    sort: 'createdAt',
    pagination: false,
    depth: 0,
  })
  return rows.docs
}

type Sent = { to: string; subject: string; text: string; html: string }
const sentMessages = () => send.mock.calls.map((call) => call[0] as Sent)

// ---------------------------------------------------------------------------------------------
describe('the queue is for the team only', () => {
  it('students, companies and anonymous visitors get nothing from any queue function', async () => {
    const { company: pending } = await pendingCompany()
    for (const user of outsiders()) {
      const as = session(user)
      expect(await approvalCounts(w.payload, as)).toBeNull()
      for (const tab of ['companies', 'projects', 'students'] as const) {
        expect(await listQueue(w.payload, as, tab)).toBeNull()
      }
      expect(await loadCompanyReview(w.payload, as, pending.id)).toBeNull()
      expect(await loadProjectReview(w.payload, as, w.projectHidden.id)).toBeNull()
      expect(await loadProfileReview(w.payload, as, w.alpha.profile.id)).toBeNull()
    }
  })

  it('lists each tab oldest first, with counts that leave out items waiting on someone else', async () => {
    await pendingCompany('First AS')
    const second = await pendingCompany('Second AS')
    const admin = session(w.admin)
    const companies = (await listQueue(w.payload, admin, 'companies'))!
    expect(companies.map((c) => c.title)).toEqual(['First AS', 'Second AS'])
    expect(companies.every((c) => c.section === 'review' && c.owner === null)).toBe(true)

    // Konnected asks the second for more information: it waits on the company, not counted.
    await askCompanyInfo(
      w.payload,
      admin,
      form({ id: second.company.id, note: 'Check the number' }),
    )
    const after = (await listQueue(w.payload, admin, 'companies'))!
    expect(after.map((c) => [c.title, c.section])).toEqual([
      ['First AS', 'review'],
      ['Second AS', 'waiting'],
    ])

    // Projects: company A's submitted project is in review. Students: both wait for review.
    const counts = (await approvalCounts(w.payload, admin))!
    expect(counts).toEqual({ companies: 1, projects: 1, students: 2 })
    const students = (await listQueue(w.payload, admin, 'students'))!
    expect(students.map((s) => s.section)).toEqual(['review', 'review'])
    // Profiles carry the 2 working day promise.
    expect(students[0]!.due?.dueDay).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('shows the company owner on the team, and "mine" keeps only my items', async () => {
    const { company: pending } = await pendingCompany('Owned AS')
    await w.payload.update({
      collection: 'companies',
      id: pending.id,
      data: { teamOwner: w.admin.id },
      ...as(w.admin),
    })
    const admin = session(w.admin)
    const all = (await listQueue(w.payload, admin, 'companies'))!
    expect(all.find((c) => c.id === pending.id)?.owner).toMatchObject({ id: w.admin.id })
    const mine = (await listQueue(w.payload, admin, 'companies', { mine: true }))!
    expect(mine.map((c) => c.id)).toEqual([pending.id])
    // Profiles sit in the shared pool: none is "mine".
    expect(await listQueue(w.payload, admin, 'students', { mine: true })).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
describe('company review', () => {
  it('only the team approves; the company gets an email in its language; it is logged', async () => {
    const { user, company: pending } = await pendingCompany()
    for (const outsider of outsiders()) {
      expect(await approveCompany(w.payload, session(outsider), form({ id: pending.id }))).toEqual({
        status: 'error',
        error: 'forbidden',
      })
    }
    // Not through the API either: the company cannot approve itself.
    const cookie = await login(user.email)
    await rest.patch(`companies/${pending.id}`, { status: 'approved' }, cookie)
    expect((await company(pending.id)).status).toBe('pending')
    expect(send).not.toHaveBeenCalled()

    await w.payload.update({
      collection: 'users',
      id: user.id,
      data: { language: 'no' },
      overrideAccess: true,
    })
    const result = await approveCompany(w.payload, session(w.admin), form({ id: pending.id }))
    expect(result.status).toBe('done')
    const approved = await company(pending.id)
    expect(approved.status).toBe('approved')
    expect(approved.approvedAt).toBeTruthy()
    const rows = await activity('companies', pending.id)
    expect(rows.at(-1)).toMatchObject({
      action: 'status_change',
      fromStatus: 'pending',
      toStatus: 'approved',
      actor: w.admin.id,
    })
    const [mail] = sentMessages()
    expect(mail?.to).toBe(user.email)
    const { no } = await import('@/messages/no.json').then((m) => ({ no: m.default }))
    expect(mail?.subject).toBe(no.Email.companyApproved.subject)
    expect(mail?.text).toContain('http://localhost:3000/no/company/projects/new')

    // A decision is made once.
    expect(await approveCompany(w.payload, session(w.admin), form({ id: pending.id }))).toEqual({
      status: 'error',
      error: 'not_allowed',
    })
  })

  it('a rejection needs a reason; the company reads it, gets it by email, and may resend once', async () => {
    const { user, company: pending } = await pendingCompany()
    const admin = session(w.admin)
    expect(await rejectCompany(w.payload, admin, form({ id: pending.id, note: '  ' }))).toEqual({
      status: 'error',
      error: 'note_required',
    })
    expect(
      await rejectCompany(w.payload, admin, form({ id: pending.id, note: 'x'.repeat(2001) })),
    ).toEqual({ status: 'error', error: 'note_too_long' })
    const reason = 'We could not find the organisation number.'
    expect(
      (await rejectCompany(w.payload, admin, form({ id: pending.id, note: reason }))).status,
    ).toBe('done')
    const rejected = await company(pending.id)
    expect(rejected).toMatchObject({ status: 'rejected', noteToCompany: reason })
    expect(rejected.noteToCompanyAt).toBeTruthy()
    expect((await activity('companies', pending.id)).at(-1)).toMatchObject({
      toStatus: 'rejected',
      note: reason,
    })
    const mail = sentMessages().at(-1)!
    expect(mail.subject).toBe(en.Email.companyRejected.subject.replace('{name}', pending.name))
    expect(mail.text).toContain(reason)
    expect(mail.text).toContain(en.Email.companyRejected.resend)

    // The company reads the reason on its own company (REST, as itself).
    const cookie = await login(user.email)
    const own = await rest.get(`companies/${pending.id}`, cookie)
    expect(own.json).toMatchObject({ noteToCompany: reason, status: 'rejected' })

    // It corrects its details and sends them again: back in the queue.
    const resend = await rest.patch(`companies/${pending.id}`, { description: 'Corrected' }, cookie)
    expect(resend.status).toBe(200)
    expect(await company(pending.id)).toMatchObject({ status: 'pending', description: 'Corrected' })
    const queue = (await listQueue(w.payload, admin, 'companies'))!
    expect(queue.find((c) => c.id === pending.id)?.section).toBe('review')
    const view = (await loadCompanyReview(w.payload, admin, pending.id))!
    expect(view.company.resentAt).toBeTruthy()

    // Rejected again: the email says this was the last chance, and no second correction.
    await rejectCompany(w.payload, admin, form({ id: pending.id, note: 'Still not found.' }))
    expect(sentMessages().at(-1)!.text).toContain(en.Email.companyRejected.final)
    const again = await rest.patch(`companies/${pending.id}`, { description: 'Again' }, cookie)
    expect([403, 404]).toContain(again.status)
    expect((await company(pending.id)).status).toBe('rejected')
  })

  it('asking for more information keeps it pending; the company’s save is the answer', async () => {
    const { user, company: pending } = await pendingCompany()
    const admin = session(w.admin)
    for (const outsider of outsiders()) {
      expect(
        (await askCompanyInfo(w.payload, session(outsider), form({ id: pending.id, note: 'x' })))
          .error,
      ).toBe('forbidden')
    }
    expect((await askCompanyInfo(w.payload, admin, form({ id: pending.id }))).error).toBe(
      'note_required',
    )
    const note = 'Please add a website.'
    expect((await askCompanyInfo(w.payload, admin, form({ id: pending.id, note }))).status).toBe(
      'done',
    )
    const asked = await company(pending.id)
    expect(asked).toMatchObject({ status: 'pending', noteToCompany: note })
    expect(asked.infoRequestedAt).toBeTruthy()
    expect((await activity('companies', pending.id)).at(-1)).toMatchObject({
      action: 'info_requested',
      note,
    })
    expect(sentMessages().at(-1)!.text).toContain(note)
    // Asked once; not again until it answers.
    expect((await askCompanyInfo(w.payload, admin, form({ id: pending.id, note }))).error).toBe(
      'not_allowed',
    )

    // The company cannot clear the request or change the note through the API.
    const cookie = await login(user.email)
    await rest.patch(`companies/${pending.id}`, { noteToCompany: 'mine now' }, cookie)
    expect((await company(pending.id)).noteToCompany).toBe(note)

    // Its next save of the profile is the answer (the patch above counted as one too). Ask again
    // and answer through the profile form.
    await askCompanyInfo(w.payload, admin, form({ id: pending.id, note }))
    const answer = new FormData()
    for (const [key, value] of Object.entries({
      ...companyDetails(pending.name),
      website: 'https://pending.example',
      logo: 'none',
    }))
      answer.set(key, String(value))
    expect((await saveCompany(w.payload, session(user) as never, answer)).status).toBe('done')
    const answered = await company(pending.id)
    expect(answered.infoRequestedAt ?? null).toBeNull()
    expect(answered.status).toBe('pending')
    expect((await activity('companies', pending.id)).at(-1)).toMatchObject({
      action: 'info_answered',
    })
    expect(
      (await listQueue(w.payload, admin, 'companies'))!.find((c) => c.id === pending.id),
    ).toMatchObject({ section: 'review' })
  })

  it('one company account per organisation number: a second one cannot be approved', async () => {
    const first = await pendingCompany('Twin One AS')
    const second = await pendingCompany('Twin Two AS')
    await w.payload.update({
      collection: 'companies',
      id: second.company.id,
      data: { orgNumber: first.company.orgNumber },
      ...as(w.admin),
    })
    const admin = session(w.admin)
    expect((await approveCompany(w.payload, admin, form({ id: first.company.id }))).status).toBe(
      'done',
    )
    const view = (await loadCompanyReview(w.payload, admin, second.company.id))!
    expect(view.sameNumber.map((c) => c.name)).toEqual(['Twin One AS'])
    expect(await approveCompany(w.payload, admin, form({ id: second.company.id }))).toEqual({
      status: 'error',
      error: 'duplicate_org',
    })
    expect((await company(second.company.id)).status).toBe('pending')
  })
})

// ---------------------------------------------------------------------------------------------
describe('project review', () => {
  it('approving needs the team, a paid or unpaid decision and, when paid, a whole-krone price', async () => {
    const p = await submittedProject()
    for (const outsider of outsiders()) {
      expect(
        (
          await approveProject(
            w.payload,
            session(outsider),
            form({ id: p.id, pay: 'paid', price: 5000 }),
          )
        ).error,
      ).toBe('forbidden')
    }
    const admin = session(w.admin)
    expect((await approveProject(w.payload, admin, form({ id: p.id }))).error).toBe('pay_choice')
    expect((await approveProject(w.payload, admin, form({ id: p.id, pay: 'paid' }))).error).toBe(
      'price_required',
    )
    for (const bad of ['12.5', '-3', '0', 'abc']) {
      expect(
        (await approveProject(w.payload, admin, form({ id: p.id, pay: 'paid', price: bad }))).error,
        bad,
      ).toBe('price_invalid')
    }
    expect((await project(p.id)).status).toBe('submitted')

    // The hook holds the same rule for every API: no approval of a paid project without a price.
    await expect(
      w.payload.update({
        collection: 'projects',
        id: p.id,
        data: { status: 'approved' },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/price/)

    const result = await approveProject(
      w.payload,
      admin,
      form({ id: p.id, pay: 'paid', price: '12 500' }),
    )
    expect(result.status).toBe('done')
    expect(await project(p.id)).toMatchObject({
      status: 'approved',
      fee: 12_500,
      paidOrUnpaid: 'paid',
    })
    const rows = await activity('projects', p.id)
    expect(rows.map((r) => [r.action, r.field ?? null, r.toStatus])).toEqual(
      expect.arrayContaining([
        ['status_change', null, 'approved'],
        ['review_change', 'fee', '12500'],
      ]),
    )
    const mail = sentMessages().at(-1)!
    expect(mail.to).toBe(w.companyA.user.email)
    expect(mail.subject).toBe(en.Email.projectApproved.subject)
    expect(mail.text).toContain('12,500 kr')
    expect(mail.text).toContain('15,625 kr')
  })

  it('Konnected decides unpaid: no price is kept, whatever was there', async () => {
    const p = await submittedProject()
    await w.payload.update({ collection: 'projects', id: p.id, data: { fee: 900 }, ...as(w.admin) })
    const result = await approveProject(
      w.payload,
      session(w.admin),
      form({ id: p.id, pay: 'unpaid', price: 4000 }),
    )
    expect(result.status).toBe('done')
    const stored = await project(p.id)
    expect(stored).toMatchObject({ status: 'approved', paidOrUnpaid: 'unpaid' })
    expect(stored.fee ?? null).toBeNull()
    expect((await activity('projects', p.id)).some((r) => r.field === 'paidOrUnpaid')).toBe(true)
  })

  it('a company can neither set the price nor approve, through any way in', async () => {
    const p = await submittedProject()
    const cookie = await login(w.companyA.user.email)
    const res = await rest.patch(`projects/${p.id}`, { status: 'approved', fee: 1 }, cookie)
    expect(res.status).not.toBe(200)
    const gql = await graphql(
      `mutation { updateProject(id: ${p.id}, data: { status: approved, fee: 1 }) { id status } }`,
      cookie,
    )
    expect(gql.text).not.toContain('"status":"approved"')
    expect(await project(p.id)).toMatchObject({ status: 'submitted' })
    expect((await project(p.id)).fee ?? null).toBeNull()
  })

  it('requesting changes and rejecting need a note; the company reads it and gets it by email', async () => {
    const admin = session(w.admin)
    const p = await submittedProject()
    expect((await requestProjectChanges(w.payload, admin, form({ id: p.id }))).error).toBe(
      'note_required',
    )
    for (const outsider of outsiders()) {
      expect(
        (await requestProjectChanges(w.payload, session(outsider), form({ id: p.id, note: 'x' })))
          .error,
      ).toBe('forbidden')
    }
    const note = 'Describe the deliverable.'
    expect((await requestProjectChanges(w.payload, admin, form({ id: p.id, note }))).status).toBe(
      'done',
    )
    expect(await project(p.id)).toMatchObject({ status: 'changes_requested', noteToCompany: note })
    expect((await activity('projects', p.id)).at(-1)).toMatchObject({
      toStatus: 'changes_requested',
      note,
    })
    const mail = sentMessages().at(-1)!
    expect(mail.subject).toBe(en.Email.projectChanges.subject)
    expect(mail.text).toContain(note)
    expect(mail.text).toContain(`/en/company/projects/${p.id}/edit`)
    // In the queue it waits on the company and does not count.
    const queue = (await listQueue(w.payload, admin, 'projects'))!
    expect(queue.find((q) => q.id === p.id)?.section).toBe('waiting')

    const q = await submittedProject({ title: 'To reject' })
    expect((await rejectProject(w.payload, admin, form({ id: q.id }))).error).toBe('note_required')
    const reason = 'This reads like a job.'
    expect((await rejectProject(w.payload, admin, form({ id: q.id, note: reason }))).status).toBe(
      'done',
    )
    expect(await project(q.id)).toMatchObject({ status: 'rejected', noteToCompany: reason })
    expect(sentMessages().at(-1)!.text).toContain(reason)
    // A decision on a project that is not in review is refused.
    expect((await rejectProject(w.payload, admin, form({ id: q.id, note: reason }))).error).toBe(
      'not_allowed',
    )
  })

  it('publishing: only the team, only an approved project, and only through the gate', async () => {
    const admin = session(w.admin)
    const p = await submittedProject()
    expect((await publishProject(w.payload, admin, form({ id: p.id }))).error).toBe('not_allowed')
    await approveProject(w.payload, admin, form({ id: p.id, pay: 'paid', price: 6500 }))
    expect(
      (await listQueue(w.payload, admin, 'projects'))!.find((q) => q.id === p.id)?.section,
    ).toBe('publish')
    for (const outsider of outsiders()) {
      expect((await publishProject(w.payload, session(outsider), form({ id: p.id }))).error).toBe(
        'forbidden',
      )
    }
    const cookie = await login(w.companyA.user.email)
    expect((await rest.patch(`projects/${p.id}`, { status: 'published' }, cookie)).status).not.toBe(
      200,
    )
    // Students do not see it yet.
    const seen = async () =>
      (
        await w.payload.find({
          collection: 'projects',
          where: { id: { equals: p.id } },
          ...as(w.alpha.user),
        })
      ).totalDocs
    expect(await seen()).toBe(0)

    // The gate: a paid project whose price was removed cannot be published.
    await w.payload.update({
      collection: 'projects',
      id: p.id,
      data: { fee: null },
      ...as(w.admin),
    })
    expect((await publishProject(w.payload, admin, form({ id: p.id }))).error).toBe('not_allowed')
    await w.payload.update({
      collection: 'projects',
      id: p.id,
      data: { fee: 6500 },
      ...as(w.admin),
    })

    expect((await publishProject(w.payload, admin, form({ id: p.id }))).status).toBe('done')
    expect((await project(p.id)).status).toBe('published')
    expect(await seen()).toBe(1)
    expect((await activity('projects', p.id)).at(-1)).toMatchObject({
      fromStatus: 'approved',
      toStatus: 'published',
    })
    expect(sentMessages().at(-1)!.subject).toBe(en.Email.projectPublished.subject)
    // A student still never reads the price.
    const asStudent = await w.payload.findByID({
      collection: 'projects',
      id: p.id,
      ...as(w.alpha.user),
    })
    expect(asStudent).not.toHaveProperty('fee')
  })

  it('no email about a project ever names a student', async () => {
    const admin = session(w.admin)
    const p = await submittedProject()
    await requestProjectChanges(w.payload, admin, form({ id: p.id, note: 'Shorter, please.' }))
    const all = JSON.stringify(sentMessages())
    for (const value of [...Object.values(SENTINEL.alpha), ...Object.values(SENTINEL.beta)])
      expect(all).not.toContain(value)
  })
})

// ---------------------------------------------------------------------------------------------
describe('student profile review', () => {
  /** The profile page's "About you" form, as the browser sends it. */
  const aboutForm = (extra: Record<string, string> = {}) => {
    const data = new FormData()
    const values: Record<string, string | string[]> = {
      name: 'Alpha Student',
      school: 'NTNU',
      programme: 'Design',
      year: '3',
      pitch: 'I like research.',
      skills: 'Figma',
      interests: ['design'],
      ...extra,
    }
    for (const [key, value] of Object.entries(values))
      for (const v of Array.isArray(value) ? value : [value]) data.append(key, v)
    return data
  }

  it('only the team marks a profile reviewed; the student is told; a copy of what was reviewed is kept', async () => {
    const id = w.alpha.profile.id
    for (const outsider of outsiders()) {
      expect((await markProfileReviewed(w.payload, session(outsider), form({ id }))).error).toBe(
        'forbidden',
      )
    }
    expect((await markProfileReviewed(w.payload, session(w.admin), form({ id }))).status).toBe(
      'done',
    )
    const reviewed = await profile(id)
    expect(reviewed.reviewStatus).toBe('reviewed')
    expect(reviewed.reviewedAt).toBeTruthy()
    expect(reviewed.reviewedSnapshot).toMatchObject({ name: SENTINEL.alpha.name })
    expect((await activity('student-profiles', id)).at(-1)).toMatchObject({
      fromStatus: 'waiting',
      toStatus: 'reviewed',
    })
    const mail = sentMessages().at(-1)!
    expect(mail.to).toBe(w.alpha.user.email)
    expect(mail.subject).toBe(en.Email.profileReviewed.subject)
    // Nothing changed since: nothing to mark again.
    expect((await markProfileReviewed(w.payload, session(w.admin), form({ id }))).error).toBe(
      'not_allowed',
    )
  })

  it('asking for changes needs a note; the student reads it; their save sends it back for review', async () => {
    const id = w.alpha.profile.id
    const admin = session(w.admin)
    expect((await askProfileChanges(w.payload, admin, form({ id }))).error).toBe('note_required')
    for (const outsider of outsiders()) {
      expect(
        (await askProfileChanges(w.payload, session(outsider), form({ id, note: 'x' }))).error,
      ).toBe('forbidden')
    }
    // The hook holds the rule for every API too.
    await expect(
      w.payload.update({
        collection: 'student-profiles',
        id,
        data: { reviewStatus: 'changes_requested' },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/change/)

    const note = 'Please upload your CV as a PDF.'
    expect((await askProfileChanges(w.payload, admin, form({ id, note }))).status).toBe('done')
    expect(await profile(id)).toMatchObject({ reviewStatus: 'changes_requested', reviewNote: note })
    expect((await activity('student-profiles', id)).at(-1)).toMatchObject({
      toStatus: 'changes_requested',
      note,
    })
    const mail = sentMessages().at(-1)!
    expect(mail.to).toBe(w.alpha.user.email)
    expect(mail.text).toContain(note)

    // The student reads the note and the state, through REST as themselves.
    const cookie = await login(w.alpha.user.email)
    const own = await rest.get(`student-profiles/${id}`, cookie)
    expect(own.json).toMatchObject({ reviewStatus: 'changes_requested', reviewNote: note })
    // The team's copy and change marker are not the student's to read.
    expect(own.json).not.toHaveProperty('reviewedSnapshot')
    expect(own.json).not.toHaveProperty('changedSinceReviewAt')
    // The student cannot clear the note or mark it reviewed.
    await rest.patch(
      `student-profiles/${id}`,
      { reviewNote: null, reviewStatus: 'reviewed' },
      cookie,
    )
    expect(await profile(id)).toMatchObject({ reviewStatus: 'changes_requested', reviewNote: note })

    // Their next save of the profile sends it back to the queue.
    const before = (await profile(id)).reviewRequestedAt
    expect((await saveProfile(w.payload, session(w.alpha.user) as never, aboutForm())).status).toBe(
      'done',
    )
    const back = await profile(id)
    expect(back.reviewStatus).toBe('waiting')
    expect(new Date(back.reviewRequestedAt!).getTime()).toBeGreaterThan(new Date(before!).getTime())
    expect((await activity('student-profiles', id)).at(-1)).toMatchObject({
      fromStatus: 'changes_requested',
      toStatus: 'waiting',
      actor: w.alpha.user.id,
    })
    expect((await listQueue(w.payload, admin, 'students'))!.find((s) => s.id === id)?.section).toBe(
      'review',
    )
  })

  it('editing a reviewed profile keeps it reviewed, and the team sees what changed', async () => {
    const id = w.alpha.profile.id
    const admin = session(w.admin)
    await markProfileReviewed(w.payload, admin, form({ id }))
    expect((await saveProfile(w.payload, session(w.alpha.user) as never, aboutForm())).status).toBe(
      'done',
    )
    const changed = await profile(id)
    expect(changed.reviewStatus).toBe('reviewed')
    expect(changed.changedSinceReviewAt).toBeTruthy()
    const queue = (await listQueue(w.payload, admin, 'students'))!
    expect(queue.find((s) => s.id === id)?.section).toBe('changed')
    expect((await approvalCounts(w.payload, admin))!.students).toBe(2)

    const view = (await loadProfileReview(w.payload, admin, id))!
    const name = view.changes.find((c) => c.field === 'name')
    expect(name).toEqual({ field: 'name', before: SENTINEL.alpha.name, after: 'Alpha Student' })

    // Reviewed again: the change marker goes, the copy is renewed, and it is logged.
    expect((await markProfileReviewed(w.payload, admin, form({ id }))).status).toBe('done')
    const again = await profile(id)
    expect(again.changedSinceReviewAt ?? null).toBeNull()
    expect((await loadProfileReview(w.payload, admin, id))!.changes).toEqual([])
    expect((await activity('student-profiles', id)).at(-1)).toMatchObject({
      action: 'review_change',
      field: 'reviewedAt',
    })

    // Changing it back to exactly what was reviewed clears the marker by itself.
    await saveProfile(w.payload, session(w.alpha.user) as never, aboutForm({ pitch: 'New pitch' }))
    expect((await profile(id)).changedSinceReviewAt).toBeTruthy()
    await saveProfile(w.payload, session(w.alpha.user) as never, aboutForm())
    expect((await profile(id)).changedSinceReviewAt ?? null).toBeNull()
  })

  it('a company never reaches the review note, the copy or the change marker', async () => {
    const id = w.alpha.profile.id
    await askProfileChanges(
      w.payload,
      session(w.admin),
      form({ id, note: 'Leak-Check-Review-Note' }),
    )
    const cookie = await login(w.companyA.user.email)
    const res = await rest.get(`student-profiles/${id}`, cookie)
    expect([403, 404]).toContain(res.status)
    expect(res.text).not.toContain('Leak-Check-Review-Note')
    const gql = await graphql(
      `
        {
          StudentProfiles {
            docs {
              reviewNote
              reviewedSnapshot
              changedSinceReviewAt
            }
          }
        }
      `,
      cookie,
    )
    expect(gql.text).not.toContain('Leak-Check-Review-Note')
  })
})

// ---------------------------------------------------------------------------------------------
describe('the Server Actions read the session themselves', () => {
  it('anonymous, student and company sessions are refused; a team session decides', async () => {
    const actions = await import('@/lib/team/approvalActions')
    const idle = { status: 'idle' as const }
    const { company: pending } = await pendingCompany()

    for (const cookie of [
      '',
      await login(w.alpha.user.email),
      await login(w.companyA.user.email),
    ]) {
      requestHeaders.cookie = cookie
      expect(await actions.approveCompanyAction(idle, form({ id: pending.id }))).toEqual({
        status: 'error',
        error: 'forbidden',
      })
      expect(
        await actions.markProfileReviewedAction(idle, form({ id: w.alpha.profile.id })),
      ).toEqual({ status: 'error', error: 'forbidden' })
    }
    expect((await company(pending.id)).status).toBe('pending')

    requestHeaders.cookie = await sessionFor(w.admin.id)
    expect((await actions.approveCompanyAction(idle, form({ id: pending.id }))).status).toBe('done')
    expect((await company(pending.id)).status).toBe('approved')
  })
})
