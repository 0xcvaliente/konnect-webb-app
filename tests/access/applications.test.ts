import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { applyAction, withdrawAction } from '@/lib/applications/actions'
import { APPLY_IDLE, decisionDay, NOTE_MAX, WITHDRAW_IDLE } from '@/lib/applications/fields'
import {
  applyBoxFor,
  applyToProject,
  findOwnApplication,
  listOwnApplications,
  withdrawApplication,
} from '@/lib/applications/student'
import { applicationReceivedEmail } from '@/lib/email/templates'
import { todayInOslo } from '@/lib/projects/fields'
import { listQueue, type SessionUser } from '@/lib/team/approvals'
import en from '@/messages/en.json'
import no from '@/messages/no.json'
import type { Application, Project, User } from '@/payload-types'

import { signedAgreement } from '../helpers/agreements'
import {
  asUser,
  createWorld,
  dayFromNow,
  graphql,
  login,
  readyFields,
  resetDatabase,
  rest,
  SENTINEL,
  sessionFor,
  type World,
} from '../helpers/world'

/**
 * Kanban card "Apply to a project and track applications": applying with a note (a reviewed
 * profile, a profile still waiting for review, a profile sent back for changes), one application
 * per student and project (also under a race), no re-applying after withdrawing, at most 2 running
 * projects, withdrawing, My applications, the application received email, and that companies and
 * signed-out visitors never see an application. Every rule as each role (admin, student, company,
 * anonymous), through the Local API with `overrideAccess: false`, REST, GraphQL and the Server
 * Actions.
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

beforeEach(async () => {
  requestHeaders.cookie = ''
  await resetDatabase()
  w = await createWorld()
})

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User): SessionUser => asUser(user) as SessionUser

const form = (values: Record<string, string | number>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, String(value))
  return data
}

const apply = (user: User, project: number, note = 'I have done this kind of work before.') =>
  w.payload.create({
    collection: 'applications',
    data: { project, note } as never,
    ...as(user),
  })

/** A published project of company A (its agreement signed by both, the publishing gate). */
async function published(title: string, data: Partial<Project> = {}): Promise<Project> {
  let doc = await w.payload.create({
    collection: 'projects',
    data: {
      ...readyFields(),
      company: w.companyA.company.id,
      title,
      description: `${title} description`,
      fee: 1000,
      status: 'draft',
      ...data,
    } as never,
    overrideAccess: true,
  })
  for (const status of ['submitted', 'approved', 'published'] as const) {
    if (status === 'published') {
      await signedAgreement(w.payload, w.admin, w.companyA.user, {
        kind: 'company',
        projectId: doc.id,
      })
    }
    doc = await w.payload.update({
      collection: 'projects',
      id: doc.id,
      data: { status },
      ...as(w.admin),
    })
  }
  return doc
}

const setReview = (profileId: number, reviewStatus: 'reviewed' | 'changes_requested') =>
  w.payload.update({
    collection: 'student-profiles',
    id: profileId,
    data: { reviewStatus, ...(reviewStatus === 'changes_requested' ? { reviewNote: 'Fix' } : {}) },
    ...as(w.admin),
  })

/** Konnected picks beta for a new project and matches it: one more running project for beta. */
async function runningProjectForBeta(title: string) {
  const project = await published(title)
  const application = await apply(w.beta.user, project.id)
  for (const status of ['shortlisted', 'selected'] as const) {
    await w.payload.update({
      collection: 'applications',
      id: application.id,
      data: { status },
      ...as(w.admin),
    })
  }
  const match = await w.payload.create({
    collection: 'matches',
    data: { project: project.id, student: w.beta.profile.id, application: application.id },
    ...as(w.admin),
  })
  await w.payload.update({
    collection: 'projects',
    id: project.id,
    data: { status: 'matched' },
    ...as(w.admin),
  })
  return { project, match }
}

const stored = (id: number) =>
  w.payload.findByID({ collection: 'applications', id, depth: 0 }) as Promise<Application>

// ---------------------------------------------------------------------------------------------
describe('applying, as each role', () => {
  it('a student applies with a note; the student comes from the session', async () => {
    const res = await applyToProject(
      w.payload,
      session(w.beta.user),
      form({ projectId: w.projectOpen.id, note: '  Why I fit  ', student: w.alpha.profile.id }),
    )
    expect(res.status).toBe('done')
    const doc = await stored((res as { applicationId: number }).applicationId)
    expect(doc.student).toBe(w.beta.profile.id)
    expect(doc.status).toBe('applied')
    expect(doc.note).toBe('Why I fit')
    // What the student applied to is kept on the application.
    expect(doc.projectTitle).toBe('Project A open')
    expect(doc.companyName).toBe('Company A')
  })

  it('a student applies through REST too, and cannot set the server-only fields', async () => {
    const cookie = await login(w.beta.user.email)
    const res = await rest.post(
      'applications',
      {
        project: w.projectOpen.id,
        note: 'Through REST',
        student: w.alpha.profile.id,
        status: 'applied',
        profileWaiting: false,
        withdrawnAt: '2001-01-01T00:00:00.000Z',
        projectTitle: 'Forged',
      },
      cookie,
    )
    expect(res.status).toBe(201)
    const id = (res.json.doc as { id: number }).id
    const doc = await stored(id)
    expect(doc.student).toBe(w.beta.profile.id)
    expect(doc.profileWaiting).toBe(true)
    expect(doc.withdrawnAt ?? null).toBeNull()
    expect(doc.projectTitle).toBe('Project A open')
  })

  it('a company cannot apply, read or change applications through any API', async () => {
    await expect(apply(w.companyA.user, w.projectOpen.id)).rejects.toThrow()
    await expect(
      w.payload.find({ collection: 'applications', ...as(w.companyA.user) }),
    ).rejects.toThrow()
    const cookie = await login(w.companyA.user.email)
    expect(
      (await rest.post('applications', { project: w.projectOpen.id, note: 'x' }, cookie)).status,
    ).toBe(403)
    expect((await rest.get(`applications/${w.application.id}`, cookie)).status).toBe(403)
    expect(
      (await rest.patch(`applications/${w.application.id}`, { status: 'withdrawn' }, cookie))
        .status,
    ).toBe(403)
    const gql = await graphql('{ Applications { docs { id note status } } }', cookie)
    expect(gql.text).not.toContain(SENTINEL.alpha.applicationNote)
    expect(JSON.stringify(gql.json.data ?? {})).not.toContain('"docs":[{')
    // The Server Action refuses a company before anything else.
    expect(
      (await applyToProject(w.payload, session(w.companyA.user), form({ projectId: 1, note: 'x' })))
        .status,
    ).toBe('error')
  })

  it('a signed-out visitor cannot apply or read applications', async () => {
    expect((await rest.post('applications', { project: w.projectOpen.id, note: 'x' })).status).toBe(
      403,
    )
    expect((await rest.get('applications')).status).toBe(403)
    requestHeaders.cookie = ''
    const res = await applyAction(APPLY_IDLE, form({ projectId: w.projectOpen.id, note: 'x' }))
    expect(res).toMatchObject({ status: 'error', error: 'forbidden' })
  })

  it('the team reads every application, with the team-only marker', async () => {
    await apply(w.beta.user, w.projectOpen.id)
    const cookie = await sessionFor(w.admin.id)
    const res = await rest.get('applications?depth=0&limit=10', cookie)
    const docs = res.json.docs as Application[]
    expect(docs).toHaveLength(2)
    expect(docs.every((d) => typeof d.profileWaiting === 'boolean')).toBe(true)
    expect(JSON.stringify(docs)).toContain(SENTINEL.alpha.applicationNote)
  })

  it('the Server Action applies as the signed-in student', async () => {
    requestHeaders.cookie = await login(w.beta.user.email)
    const res = await applyAction(APPLY_IDLE, form({ projectId: w.projectOpen.id, note: 'Me' }))
    expect(res.status).toBe('done')
    requestHeaders.cookie = await login(w.companyA.user.email)
    const company = await applyAction(APPLY_IDLE, form({ projectId: w.projectOpen.id, note: 'x' }))
    expect(company).toMatchObject({ status: 'error', error: 'forbidden' })
  })
})

// ---------------------------------------------------------------------------------------------
describe('the rules for applying', () => {
  const tryApply = (user: User, projectId: number, note = 'Why I fit') =>
    applyToProject(w.payload, session(user), form({ projectId, note }))

  it('needs a note, at most 1000 characters (also through the API)', async () => {
    expect(await tryApply(w.beta.user, w.projectOpen.id, '   ')).toMatchObject({
      error: 'note_required',
    })
    expect(await tryApply(w.beta.user, w.projectOpen.id, 'x'.repeat(NOTE_MAX + 1))).toMatchObject({
      error: 'note_too_long',
    })
    await expect(apply(w.beta.user, w.projectOpen.id, '')).rejects.toThrow(/note/i)
    await expect(apply(w.beta.user, w.projectOpen.id, 'x'.repeat(NOTE_MAX + 1))).rejects.toThrow()
    const rows = await w.payload.count({
      collection: 'applications',
      where: { student: { equals: w.beta.profile.id } },
    })
    expect(rows.totalDocs).toBe(0)
  })

  it('only to a published project whose applications are open', async () => {
    expect(await tryApply(w.beta.user, w.projectHidden.id)).toMatchObject({ error: 'not_open' })
    expect(await tryApply(w.beta.user, w.projectB.id)).toMatchObject({ error: 'not_open' })
    const late = await published('Closed yesterday', { deadline: dayFromNow(-1) })
    expect(await tryApply(w.beta.user, late.id)).toMatchObject({ error: 'closed' })
    const today = await published('Closes today', { deadline: dayFromNow(0) })
    expect((await tryApply(w.beta.user, today.id)).status).toBe('done')
  })

  it('a reviewed profile applies; the application is not marked', async () => {
    await setReview(w.beta.profile.id, 'reviewed')
    const res = await tryApply(w.beta.user, w.projectOpen.id)
    expect(res.status).toBe('done')
    const doc = await stored((res as { applicationId: number }).applicationId)
    expect(doc.profileWaiting).toBe(false)
  })

  it('a profile waiting for review applies, and the team sees it', async () => {
    const res = await tryApply(w.beta.user, w.projectOpen.id)
    expect(res.status).toBe('done')
    const doc = await stored((res as { applicationId: number }).applicationId)
    expect(doc.profileWaiting).toBe(true)
    // The team's profile queue shows that this waiting student has applied.
    const queue = await listQueue(w.payload, session(w.admin), 'students')
    const item = queue!.find((i) => i.id === w.beta.profile.id)!
    expect(item.applied).toBe(1)
    // The student never reads the marker, through any API.
    const own = await w.payload.findByID({
      collection: 'applications',
      id: doc.id,
      ...as(w.beta.user),
    })
    expect(own).not.toHaveProperty('profileWaiting')
    const cookie = await login(w.beta.user.email)
    expect((await rest.get(`applications/${doc.id}`, cookie)).json).not.toHaveProperty(
      'profileWaiting',
    )
    const gql = await graphql(`{ Application(id: ${doc.id}) { id profileWaiting } }`, cookie)
    expect(gql.text).not.toContain('"profileWaiting":true')
  })

  it('a profile Konnected sent back for changes cannot apply until the student fixes it', async () => {
    await setReview(w.beta.profile.id, 'changes_requested')
    expect(await tryApply(w.beta.user, w.projectOpen.id)).toMatchObject({
      error: 'changes_requested',
    })
    expect(
      await applyBoxFor(w.payload, session(w.beta.user), w.projectOpen.id, null),
    ).toMatchObject({ kind: 'changes_requested' })
    // The student's edit sends the profile back to waiting; then applying works.
    await w.payload.update({
      collection: 'student-profiles',
      id: w.beta.profile.id,
      data: { pitch: 'A better pitch' },
      ...as(w.beta.user),
    })
    expect((await tryApply(w.beta.user, w.projectOpen.id)).status).toBe('done')
  })

  it('one application per student and project, even with two requests at the same moment', async () => {
    const results = await Promise.all([
      tryApply(w.beta.user, w.projectOpen.id),
      tryApply(w.beta.user, w.projectOpen.id),
      tryApply(w.beta.user, w.projectOpen.id),
    ])
    expect(results.filter((r) => r.status === 'done')).toHaveLength(1)
    for (const r of results.filter((r) => r.status !== 'done')) {
      expect(r).toMatchObject({ status: 'error', error: 'already_applied' })
    }
    const rows = await w.payload.count({
      collection: 'applications',
      where: {
        and: [
          { student: { equals: w.beta.profile.id } },
          { project: { equals: w.projectOpen.id } },
        ],
      },
    })
    expect(rows.totalDocs).toBe(1)
    // And the same through REST at the same moment.
    const other = await published('Race over REST')
    const cookie = await login(w.beta.user.email)
    const both = await Promise.all([
      rest.post('applications', { project: other.id, note: 'a' }, cookie),
      rest.post('applications', { project: other.id, note: 'b' }, cookie),
    ])
    expect(both.filter((r) => r.status === 201)).toHaveLength(1)
    const restRows = await w.payload.count({
      collection: 'applications',
      where: {
        and: [{ student: { equals: w.beta.profile.id } }, { project: { equals: other.id } }],
      },
    })
    expect(restRows.totalDocs).toBe(1)
  })

  it('no re-applying after withdrawing, through any way in', async () => {
    const res = await tryApply(w.beta.user, w.projectOpen.id)
    const id = (res as { applicationId: number }).applicationId
    expect(
      (await withdrawApplication(w.payload, session(w.beta.user), form({ applicationId: id })))
        .status,
    ).toBe('done')
    expect(await tryApply(w.beta.user, w.projectOpen.id)).toMatchObject({
      error: 'withdrawn_before',
    })
    await expect(apply(w.beta.user, w.projectOpen.id)).rejects.toThrow(/withdrew/)
    const cookie = await login(w.beta.user.email)
    const again = await rest.post('applications', { project: w.projectOpen.id, note: 'x' }, cookie)
    expect(again.status).toBe(409)
    // The withdrawn application cannot be reopened either.
    await expect(
      w.payload.update({
        collection: 'applications',
        id,
        data: { status: 'applied' },
        ...as(w.beta.user),
      }),
    ).rejects.toThrow()
    await expect(
      w.payload.update({
        collection: 'applications',
        id,
        data: { status: 'applied' },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/not a valid change/)
    expect((await stored(id)).status).toBe('withdrawn')
    expect(
      await applyBoxFor(w.payload, session(w.beta.user), w.projectOpen.id, null),
    ).toMatchObject({ kind: 'withdrawn', applicationId: id })
  })

  it('a student with 2 running projects cannot apply; a delivered one no longer counts', async () => {
    const first = await runningProjectForBeta('Running one')
    const second = await runningProjectForBeta('Running two')
    const third = await published('A third project')

    expect(await tryApply(w.beta.user, third.id)).toMatchObject({ error: 'too_many' })
    await expect(apply(w.beta.user, third.id)).rejects.toThrow(/2 projects/)
    expect(await applyBoxFor(w.payload, session(w.beta.user), third.id, null)).toMatchObject({
      kind: 'too_many',
      running: 2,
    })
    // The team cannot add a third one either.
    await expect(
      w.payload.create({
        collection: 'applications',
        data: { project: third.id, student: w.beta.profile.id } as never,
        ...as(w.admin),
      }),
    ).rejects.toThrow(/2 projects/)

    // One project starts and is delivered: beta works on one project now.
    await signedAgreement(w.payload, w.admin, w.beta.user, {
      kind: 'student',
      matchId: second.match.id,
    })
    for (const status of ['in_progress', 'delivered'] as const) {
      await w.payload.update({
        collection: 'projects',
        id: second.project.id,
        data: { status },
        ...as(w.admin),
      })
    }
    expect((await tryApply(w.beta.user, third.id)).status).toBe('done')
    expect(first.project.id).toBeGreaterThan(0)
  })
})

describe('at most 2 projects when Konnected selects and matches', () => {
  const setStatus = (id: number, status: Application['status'], user: User = w.admin) =>
    w.payload.update({ collection: 'applications', id, data: { status }, ...as(user) })
  const matchBeta = (project: number, application?: number) =>
    w.payload.create({
      collection: 'matches',
      data: { project, student: w.beta.profile.id, ...(application ? { application } : {}) },
      ...as(w.admin),
    })

  it('selecting or matching a student who already has 2 running projects is refused', async () => {
    // beta applied to a third project before Konnected matched the other two.
    const third = await published('A third project')
    const late = await apply(w.beta.user, third.id)
    await setStatus(late.id, 'shortlisted')
    await runningProjectForBeta('Running one')
    await runningProjectForBeta('Running two')

    // The team (Local API and REST) cannot select beta for it, nor match beta on it.
    await expect(setStatus(late.id, 'selected')).rejects.toThrow(/2 projects/)
    const admin = await sessionFor(w.admin.id)
    expect(
      (await rest.patch(`applications/${late.id}`, { status: 'selected' }, admin)).status,
    ).toBe(403)
    await expect(matchBeta(third.id, late.id)).rejects.toThrow(/2 projects/)
    // Nor move another student's match to beta.
    await expect(
      w.payload.update({
        collection: 'matches',
        id: w.match.id,
        data: { student: w.beta.profile.id },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/2 projects/)
    // Selecting is the team's alone: the student and the company are refused anyway.
    await expect(setStatus(late.id, 'selected', w.beta.user)).rejects.toThrow()
    await expect(setStatus(late.id, 'selected', w.companyA.user)).rejects.toThrow()
    const anonymous = await rest.patch(`applications/${late.id}`, { status: 'selected' })
    expect([401, 403, 404]).toContain(anonymous.status)

    expect((await stored(late.id)).status).toBe('shortlisted')
    const matches = await w.payload.count({
      collection: 'matches',
      where: { student: { equals: w.beta.profile.id } },
    })
    expect(matches.totalDocs).toBe(2)
  })

  it('picks waiting for their match count too, so two picks cannot become three', async () => {
    const projects: Project[] = []
    for (const title of ['Pick one', 'Pick two', 'Pick three'])
      projects.push(await published(title))
    const applications: Application[] = []
    for (const project of projects) {
      const a = await apply(w.beta.user, project.id)
      await setStatus(a.id, 'shortlisted')
      applications.push(a)
    }
    const [one, two, three] = applications as [Application, Application, Application]

    // Two selections, no match yet: beta runs nothing, but a third pick is refused.
    await setStatus(one.id, 'selected')
    await setStatus(two.id, 'selected')
    await expect(setStatus(three.id, 'selected')).rejects.toThrow(/2 projects/)
    await expect(matchBeta(projects[2]!.id)).rejects.toThrow(/2 projects/)

    // The two picks still get their matches (a project is not counted against itself).
    await matchBeta(projects[0]!.id, one.id)
    await matchBeta(projects[1]!.id, two.id)
    await expect(setStatus(three.id, 'selected')).rejects.toThrow(/2 projects/)
    expect((await stored(three.id)).status).toBe('shortlisted')
  })
})

// ---------------------------------------------------------------------------------------------
describe('withdrawing', () => {
  it('the student withdraws from applied or shortlisted, and the date is kept', async () => {
    const a = await apply(w.beta.user, w.projectOpen.id)
    const done = await withdrawApplication(
      w.payload,
      session(w.beta.user),
      form({ applicationId: a.id }),
    )
    expect(done.status).toBe('done')
    const after = await stored(a.id)
    expect(after.status).toBe('withdrawn')
    expect(after.withdrawnAt).toBeTruthy()

    const other = await published('Shortlisted then withdrawn')
    const b = await apply(w.beta.user, other.id)
    await w.payload.update({
      collection: 'applications',
      id: b.id,
      data: { status: 'shortlisted' },
      ...as(w.admin),
    })
    expect((await stored(b.id)).shortlistedAt).toBeTruthy()
    requestHeaders.cookie = await login(w.beta.user.email)
    expect(await withdrawAction(WITHDRAW_IDLE, form({ applicationId: b.id }))).toMatchObject({
      status: 'done',
    })
  })

  it('not once Konnected has decided', async () => {
    // alpha's application in the world is selected.
    expect(
      await withdrawApplication(
        w.payload,
        session(w.alpha.user),
        form({ applicationId: w.application.id }),
      ),
    ).toMatchObject({ error: 'not_withdrawable' })
    await expect(
      w.payload.update({
        collection: 'applications',
        id: w.application.id,
        data: { status: 'withdrawn' },
        ...as(w.alpha.user),
      }),
    ).rejects.toThrow()
  })

  it("never another student's application, and never by a company or the team", async () => {
    const a = await apply(w.beta.user, w.projectOpen.id)
    expect(
      await withdrawApplication(w.payload, session(w.alpha.user), form({ applicationId: a.id })),
    ).toMatchObject({ error: 'not_found' })
    expect(
      await withdrawApplication(w.payload, session(w.companyA.user), form({ applicationId: a.id })),
    ).toMatchObject({ error: 'forbidden' })
    // Withdrawing is the student's own choice: the team cannot withdraw for them.
    await expect(
      w.payload.update({
        collection: 'applications',
        id: a.id,
        data: { status: 'withdrawn' },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/your role cannot/)
    const cookie = await login(w.alpha.user.email)
    const res = await rest.patch(`applications/${a.id}`, { status: 'withdrawn' }, cookie)
    expect([403, 404]).toContain(res.status)
    expect((await stored(a.id)).status).toBe('applied')
  })

  it('a student cannot change the note, the project or the dates after applying', async () => {
    const a = await apply(w.beta.user, w.projectOpen.id, 'First note')
    const cookie = await login(w.beta.user.email)
    await rest.patch(
      `applications/${a.id}`,
      {
        note: 'Changed',
        project: w.projectA.id,
        decidedAt: '2001-01-01T00:00:00.000Z',
        profileWaiting: false,
      },
      cookie,
    )
    const after = await stored(a.id)
    expect(after.note).toBe('First note')
    expect(after.project).toBe(w.projectOpen.id)
    expect(after.decidedAt ?? null).toBeNull()
    expect(after.profileWaiting).toBe(true)
  })

  it('applying and withdrawing are in the activity log', async () => {
    const a = await apply(w.beta.user, w.projectOpen.id)
    await withdrawApplication(w.payload, session(w.beta.user), form({ applicationId: a.id }))
    const rows = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [
          { targetCollection: { equals: 'applications' } },
          { targetId: { equals: String(a.id) } },
        ],
      },
      sort: 'createdAt',
    })
    expect(rows.docs.map((r) => r.action)).toEqual(['create', 'status_change'])
    expect(rows.docs[1]).toMatchObject({ fromStatus: 'applied', toStatus: 'withdrawn' })
    // Only ids and statuses: no note.
    expect(JSON.stringify(rows.docs)).not.toContain('I have done this kind of work')
  })
})

// ---------------------------------------------------------------------------------------------
describe('My applications', () => {
  it('lists only the signed-in student’s own applications, and nobody else gets a list', async () => {
    await apply(w.beta.user, w.projectOpen.id)
    const beta = await listOwnApplications(w.payload, session(w.beta.user))
    expect(beta!.map((a) => a.title)).toEqual(['Project A open'])
    const alpha = await listOwnApplications(w.payload, session(w.alpha.user))
    expect(alpha!.map((a) => a.id)).toEqual([w.application.id])
    expect(await listOwnApplications(w.payload, session(w.companyA.user))).toBeNull()
    expect(await listOwnApplications(w.payload, session(w.admin))).toBeNull()
  })

  it("another student's application is not found", async () => {
    expect(await findOwnApplication(w.payload, session(w.beta.user), w.application.id)).toBeNull()
    expect(
      await findOwnApplication(w.payload, session(w.companyA.user), w.application.id),
    ).toBeNull()
    expect(
      (await findOwnApplication(w.payload, session(w.alpha.user), w.application.id))!.status,
    ).toBe('selected')
  })

  it('keeps naming the project after Konnected matched it (no longer listed)', async () => {
    // alpha's project A is in progress, so alpha cannot read it any more.
    const own = await findOwnApplication(w.payload, session(w.alpha.user), w.application.id)
    expect(own!.title).toBe('Project A')
    expect(own!.companyName).toBe('Company A')
    expect(own!.listed).toBeNull()
    // And what alpha reads holds nothing about the project beyond the copies.
    expect(JSON.stringify(own)).not.toContain('Project A description')
  })

  it('shows the decision promise: 3 working days after applications close', async () => {
    const project = await published('Closes on a known day', { deadline: dayFromNow(5) })
    await apply(w.beta.user, project.id)
    const [own] = (await listOwnApplications(w.payload, session(w.beta.user)))!
    expect(own!.closingDay).toBe(dayFromNow(5).slice(0, 10))
    expect(own!.decideBy).toBe(decisionDay(own!.closingDay))
    expect(own!.decideBy! > own!.closingDay!).toBe(true)
    expect(own!.open).toBe(true)
  })

  it('sorts open applications first by default', async () => {
    const one = await published('First')
    const two = await published('Second')
    const a1 = await apply(w.beta.user, one.id)
    await apply(w.beta.user, two.id)
    await withdrawApplication(w.payload, session(w.beta.user), form({ applicationId: a1.id }))
    const list = await listOwnApplications(w.payload, session(w.beta.user), 'need')
    expect(list!.map((a) => a.status)).toEqual(['applied', 'withdrawn'])
    const recent = await listOwnApplications(w.payload, session(w.beta.user), 'recent')
    expect(recent![0]!.status).toBe('withdrawn')
  })
})

// ---------------------------------------------------------------------------------------------
describe('the decision day', () => {
  it('counts Norwegian working days after the closing day', () => {
    expect(decisionDay(null)).toBeNull()
    // Monday 9 Nov 2026 closes: Tue, Wed, Thu.
    expect(decisionDay('2026-11-09')).toBe('2026-11-12')
    // Friday: over the weekend.
    expect(decisionDay('2026-11-13')).toBe('2026-11-18')
    // Easter 2026: Maundy Thursday 2 Apr, Good Friday 3 Apr, Easter Monday 6 Apr.
    expect(decisionDay('2026-04-01')).toBe('2026-04-09')
    // 17 May 2027 is a Monday and Whit Monday too.
    expect(decisionDay('2027-05-14')).toBe('2027-05-20')
  })
})

// ---------------------------------------------------------------------------------------------
describe('the application received email', () => {
  let send: MockInstance
  beforeEach(() => {
    send = vi.spyOn(w.payload.email, 'sendEmail')
  })

  it('goes to the student only, in their language, with the decision day and a link', async () => {
    await w.payload.update({
      collection: 'users',
      id: w.beta.user.id,
      data: { language: 'no' },
      overrideAccess: true,
    })
    const project = await published('Sentinel-Free Project', { deadline: dayFromNow(5) })
    send.mockClear()
    const res = await applyToProject(
      w.payload,
      session(w.beta.user),
      form({ projectId: project.id, note: 'Private-Note-For-Konnected' }),
    )
    const id = (res as { applicationId: number }).applicationId
    expect(send).toHaveBeenCalledTimes(1)
    const message = send.mock.calls[0]![0] as {
      to: string
      subject: string
      html: string
      text: string
    }
    expect(message.to).toBe(w.beta.user.email)
    expect(message.subject).toBe(no.Email.applicationReceived.subject)
    expect(message.text).toContain(`http://localhost:3000/no/student/applications/${id}`)
    expect(message.text).toContain('Sentinel-Free Project')
    // The profile is still waiting for review: the email says so.
    expect(message.text).toContain(no.Email.applicationReceived.profileWaiting)
    // The note is the student's own words for Konnected; it is not repeated.
    expect(JSON.stringify(message)).not.toContain('Private-Note-For-Konnected')
    expect(message.html).not.toMatch(/<img|<script|<iframe/i)
  })

  it('a refused application sends nothing', async () => {
    await apply(w.beta.user, w.projectOpen.id)
    send.mockClear()
    await applyToProject(
      w.payload,
      session(w.beta.user),
      form({ projectId: w.projectOpen.id, note: 'again' }),
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('renders completely in English and Norwegian, and escapes the title', () => {
    for (const [locale, m] of [
      ['en', en],
      ['no', no],
    ] as const) {
      for (const decideBy of ['2026-11-12', null]) {
        for (const profileWaiting of [true, false]) {
          const href = `http://localhost:3000/${locale}/student/applications/7`
          const email = applicationReceivedEmail(locale, {
            title: '<b>Plan</b>',
            decideBy,
            profileWaiting,
            href,
          })
          expect(email.subject).toBe(m.Email.applicationReceived.subject)
          for (const part of [email.subject, email.html, email.text]) {
            expect(part).not.toMatch(/undefined|\{\w+\}|\[object/)
          }
          expect(email.html).toContain('&lt;b&gt;Plan&lt;/b&gt;')
          expect(email.html).not.toContain('<b>Plan</b>')
          expect(email.text).toContain(href)
          if (decideBy) expect(email.text).toMatch(/2026/)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe('the apply box on the project page', () => {
  it('says what the student may do', async () => {
    const box = await applyBoxFor(w.payload, session(w.beta.user), w.projectOpen.id, '2026-11-09')
    expect(box).toEqual({ kind: 'open', profileWaiting: true, decideBy: '2026-11-12' })
    const a = await apply(w.beta.user, w.projectOpen.id)
    expect(
      await applyBoxFor(w.payload, session(w.beta.user), w.projectOpen.id, null),
    ).toMatchObject({ kind: 'applied', applicationId: a.id, status: 'applied' })
    expect(await applyBoxFor(w.payload, session(w.companyA.user), w.projectOpen.id, null)).toBe(
      null,
    )
    expect(await applyBoxFor(w.payload, session(w.admin), w.projectOpen.id, null)).toBeNull()
    expect(todayInOslo()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
