import pg from 'pg'
import { commitTransaction, createLocalReq, initTransaction, killTransaction } from 'payload'
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { findOwnApplication, ownSharedItems } from '@/lib/applications/student'
import { MATCH_IDLE } from '@/lib/matching/fields'
import { findSelectedStudent } from '@/lib/projects/project'
import { type SessionUser } from '@/lib/team/approvals'
import {
  listMatchingQueue,
  loadMatchingProject,
  selectApplication,
  shortlistApplication,
} from '@/lib/team/matching'
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
  PASSWORD,
  readyFields,
  resetDatabase,
  rest,
  selectStudent,
  SENTINEL,
  sessionFor,
  type World,
} from '../helpers/world'

/**
 * Kanban card "Admin applications queue and manual matching": the team's Matching screen, and the
 * selection behind it. Selecting one application creates the match (a copy of exactly what the
 * student ticked to share), marks the other open applications not selected, moves the project to
 * matched and emails the selected student, the others and the company, in one transaction. Only
 * the team selects; a company reads only the match's shared copy, at any depth, and never anything
 * about the other applicants; two team members selecting at once leave one match. Every rule as
 * each role (admin, student, company, anonymous) through the Local API with `overrideAccess:
 * false`, REST, GraphQL and the Server Actions.
 */

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
  requestHeaders.cookie = ''
  await resetDatabase()
  w = await createWorld()
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

type Sent = { to: string; subject: string; text: string; html: string }
const sentMessages = () => send.mock.calls.map((call) => call[0] as Sent)

/** A published project of company A (its agreement signed by both, the publishing gate). */
async function published(title: string, data: Partial<Project> = {}): Promise<Project> {
  let doc = await w.payload.create({
    collection: 'projects',
    data: {
      ...readyFields(),
      company: w.companyA.company.id,
      title,
      description: `${title} description`,
      desiredSkills: ['Figma', 'Research', 'Copywriting'],
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

/** One more student, reviewed by Konnected, sharing `privacy`. */
async function student(key: string, privacy: Record<string, boolean> = {}) {
  const user = (await w.payload.create({
    collection: 'users',
    data: {
      email: `${key}@student.test`,
      password: PASSWORD,
      role: 'student',
      _verified: true,
    } as never,
    overrideAccess: true,
    disableVerificationEmail: true,
  })) as User
  const profile = await w.payload.create({
    collection: 'student-profiles',
    data: {
      user: user.id,
      name: `Student ${key}`,
      school: `School ${key}`,
      programme: `Programme ${key}`,
      skills: ['Figma'],
      contactEmail: `${key}.contact@student.test`,
      phone: `+47-${key}`,
      pitch: `Pitch ${key}`,
      privacy,
    },
    overrideAccess: true,
  })
  await review(profile.id)
  return { user, profile }
}

const review = (profileId: number) =>
  w.payload.update({
    collection: 'student-profiles',
    id: profileId,
    data: { reviewStatus: 'reviewed' },
    ...as(w.admin),
  })

const apply = (user: User, project: number, note = 'Why I fit') =>
  w.payload.create({
    collection: 'applications',
    data: { project, note } as never,
    ...as(user),
  }) as Promise<Application>

const setStatus = (id: number, status: Application['status'], user: User = w.admin) =>
  w.payload.update({ collection: 'applications', id, data: { status }, ...as(user) })

const stored = (id: number) =>
  w.payload.findByID({ collection: 'applications', id, depth: 0 }) as Promise<Application>
const projectStatus = async (id: number) =>
  (await w.payload.findByID({ collection: 'projects', id, depth: 0 })).status
const matchesOf = async (projectId: number) =>
  (
    await w.payload.find({
      collection: 'matches',
      where: { project: { equals: projectId } },
      depth: 0,
    })
  ).docs

/** A published project with three applicants: beta (shares nothing), gamma (shortlisted), delta. */
async function threeApplicants(title = 'Landing page copy') {
  const project = await published(title)
  await review(w.beta.profile.id)
  const gamma = await student('gamma', { shareName: true, shareCv: false, shareSkills: true })
  const delta = await student('delta', { shareName: true, shareContactEmail: true })
  const beta = await apply(w.beta.user, project.id, SENTINEL.beta.applicationNote)
  const g = await apply(gamma.user, project.id)
  const d = await apply(delta.user, project.id)
  await setStatus(g.id, 'shortlisted')
  return { project, gamma, delta, applications: { beta, gamma: g, delta: d } }
}

// ---------------------------------------------------------------------------------------------
describe('selecting one application', () => {
  it('creates the match with a copy of exactly what the student ticked, marks the others not selected and matches the project', async () => {
    const { project, gamma, delta, applications } = await threeApplicants()
    // delta withdrew before the decision: a withdrawal stays as it is.
    await w.payload.update({
      collection: 'applications',
      id: applications.delta.id,
      data: { status: 'withdrawn' },
      ...as(delta.user),
    })

    const result = await selectApplication(
      w.payload,
      session(w.admin),
      form({ id: applications.gamma.id }),
    )
    expect(result.status).toBe('done')

    expect((await stored(applications.gamma.id)).status).toBe('selected')
    expect((await stored(applications.gamma.id)).decidedAt).toBeTruthy()
    expect((await stored(applications.beta.id)).status).toBe('not_selected')
    expect((await stored(applications.beta.id)).decidedAt).toBeTruthy()
    expect((await stored(applications.delta.id)).status).toBe('withdrawn')
    expect(await projectStatus(project.id)).toBe('matched')

    const [match, ...more] = await matchesOf(project.id)
    expect(more).toHaveLength(0)
    expect(match).toMatchObject({
      student: gamma.profile.id,
      application: applications.gamma.id,
    })
    // gamma ticked name and skills: exactly those are in the copy, nothing else.
    expect(match!.sharedInfo).toMatchObject({
      name: 'Student gamma',
      skills: ['Figma'],
      school: null,
      programme: null,
      pitch: null,
      cv: null,
      contactEmail: null,
      phone: null,
    })
  })

  it('writes every step to the activity log, with the team member who decided', async () => {
    const { project, applications } = await threeApplicants()
    await setStatus(applications.gamma.id, 'selected')
    const rows = (
      await w.payload.find({
        collection: 'activity-logs',
        where: { createdAt: { greater_than: new Date(Date.now() - 60_000).toISOString() } },
        sort: 'createdAt',
        pagination: false,
        depth: 0,
      })
    ).docs
    const row = (collection: string, id: number, to?: string) =>
      rows.find(
        (r) =>
          r.targetCollection === collection &&
          r.targetId === String(id) &&
          (to === undefined ? r.action === 'create' : r.toStatus === to),
      )
    expect(row('applications', applications.gamma.id, 'selected')).toMatchObject({
      actor: w.admin.id,
      fromStatus: 'shortlisted',
    })
    expect(row('applications', applications.beta.id, 'not_selected')).toMatchObject({
      actor: w.admin.id,
      fromStatus: 'applied',
    })
    expect(row('projects', project.id, 'matched')).toMatchObject({
      actor: w.admin.id,
      fromStatus: 'published',
    })
    const match = (await matchesOf(project.id))[0]!
    expect(row('matches', match.id)).toMatchObject({ actor: w.admin.id, action: 'create' })
    // Only ids and statuses: no names or notes.
    expect(JSON.stringify(rows)).not.toContain(SENTINEL.beta.applicationNote)
    expect(JSON.stringify(rows)).not.toContain('Student gamma')
  })

  it('emails the selected student, a kind note to the others, and the company only the kinds shared', async () => {
    const { project, gamma, applications } = await threeApplicants()
    await w.payload.update({
      collection: 'users',
      id: w.beta.user.id,
      data: { language: 'no' },
      overrideAccess: true,
    })
    send.mockClear()
    await setStatus(applications.gamma.id, 'selected')
    const mails = sentMessages()

    const toGamma = mails.filter((m) => m.to === gamma.user.email)
    expect(toGamma).toHaveLength(1)
    expect(toGamma[0]!.subject).toBe(
      en.Email.matching.selected.subject.replace('{title}', project.title),
    )
    expect(toGamma[0]!.text).toContain('Company A')
    expect(toGamma[0]!.text).toContain(
      `http://localhost:3000/en/student/applications/${applications.gamma.id}`,
    )

    // beta reads Norwegian.
    const toBeta = mails.filter((m) => m.to === w.beta.user.email)
    expect(toBeta).toHaveLength(1)
    expect(toBeta[0]!.subject).toBe(
      no.Email.matching.notSelected.subject.replace('{title}', project.title),
    )
    const toDelta = mails.filter((m) => m.to === 'delta@student.test')
    expect(toDelta).toHaveLength(1)

    const toCompany = mails.filter((m) => m.to === w.companyA.user.email)
    expect(toCompany).toHaveLength(1)
    expect(toCompany[0]!.subject).toBe(
      en.Email.matching.found.subject.replace('{title}', project.title),
    )
    // The kinds gamma shares, never the values, and nothing about the others.
    expect(toCompany[0]!.text).toContain(en.SharedItems.inline.name)
    expect(toCompany[0]!.text).toContain(en.SharedItems.inline.skills)
    for (const secret of [
      'Student gamma',
      'gamma.contact@student.test',
      'Student delta',
      ...Object.values(SENTINEL.beta),
    ]) {
      expect(toCompany[0]!.text, secret).not.toContain(secret)
      expect(toCompany[0]!.html, secret).not.toContain(secret)
    }
    expect(toCompany[0]!.text).toContain(`http://localhost:3000/en/company/projects/${project.id}`)
  })

  it('the team may select straight from applied, and turning one down alone sends the kind note', async () => {
    const { project, applications } = await threeApplicants()
    send.mockClear()
    await setStatus(applications.delta.id, 'not_selected')
    expect(sentMessages().map((m) => m.to)).toEqual(['delta@student.test'])
    expect(await projectStatus(project.id)).toBe('published')

    await setStatus(applications.beta.id, 'selected')
    expect((await stored(applications.gamma.id)).status).toBe('not_selected')
    expect((await stored(applications.delta.id)).status).toBe('not_selected')
    expect(await projectStatus(project.id)).toBe('matched')
  })
})

// ---------------------------------------------------------------------------------------------
describe('only the team selects', () => {
  it('a student, a company and an anonymous visitor are refused on every API; nothing changes', async () => {
    const { project, gamma, applications } = await threeApplicants()
    const id = applications.gamma.id
    for (const user of [gamma.user, w.beta.user, w.companyA.user]) {
      await expect(setStatus(id, 'selected', user)).rejects.toThrow()
      await expect(setStatus(applications.beta.id, 'shortlisted', user)).rejects.toThrow()
    }
    expect((await stored(applications.beta.id)).status).toBe('applied')
    for (const cookie of [
      await login(gamma.user.email),
      await login(w.companyA.user.email),
      undefined,
    ]) {
      const res = await rest.patch(`applications/${id}`, { status: 'selected' }, cookie)
      expect([401, 403, 404]).toContain(res.status)
      const gql = await graphql(
        `mutation { updateApplication(id: ${id}, data: { status: selected }) { id status } }`,
        cookie,
      )
      expect(gql.text).not.toContain('"status":"selected"')
    }
    expect((await stored(id)).status).toBe('shortlisted')
    expect(await projectStatus(project.id)).toBe('published')
    expect(await matchesOf(project.id)).toHaveLength(0)
  })

  it('the Matching functions and Server Actions refuse anyone but the team', async () => {
    const { project, gamma, applications } = await threeApplicants()
    const actions = await import('@/lib/team/matchingActions')
    for (const user of [gamma.user, w.companyA.user, null]) {
      expect(
        await selectApplication(w.payload, session(user), form({ id: applications.gamma.id })),
      ).toMatchObject({ status: 'error', error: 'forbidden' })
      expect(
        await shortlistApplication(w.payload, session(user), form({ id: applications.beta.id })),
      ).toMatchObject({ status: 'error', error: 'forbidden' })
      expect(await listMatchingQueue(w.payload, session(user))).toBeNull()
      expect(await loadMatchingProject(w.payload, session(user), project.id)).toBeNull()
    }
    for (const cookie of ['', await login(gamma.user.email), await login(w.companyA.user.email)]) {
      requestHeaders.cookie = cookie
      expect(
        await actions.selectAction(MATCH_IDLE, form({ id: applications.gamma.id })),
      ).toMatchObject({ status: 'error', error: 'forbidden' })
    }
    expect(await matchesOf(project.id)).toHaveLength(0)

    requestHeaders.cookie = await sessionFor(w.admin.id)
    expect(
      await actions.shortlistAction(MATCH_IDLE, form({ id: applications.beta.id })),
    ).toMatchObject({ status: 'done' })
    expect((await stored(applications.beta.id)).status).toBe('shortlisted')
    expect(
      await actions.selectAction(MATCH_IDLE, form({ id: applications.gamma.id })),
    ).toMatchObject({ status: 'done' })
    expect(await projectStatus(project.id)).toBe('matched')
  })

  it('a match is never made any other way: not by creating it, not by moving the project', async () => {
    const { project, applications } = await threeApplicants()
    const admin = await sessionFor(w.admin.id)
    const created = await rest.post(
      'matches',
      { project: project.id, student: w.beta.profile.id, application: applications.beta.id },
      admin,
    )
    expect(created.status).toBe(400)
    const moved = await rest.patch(`projects/${project.id}`, { status: 'matched' }, admin)
    expect(moved.status).toBe(409)
    expect(await projectStatus(project.id)).toBe('published')
    expect(await matchesOf(project.id)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe('what a selection needs', () => {
  it('a reviewed profile', async () => {
    const project = await published('Needs a review')
    const app = await apply(w.beta.user, project.id)
    expect(
      await selectApplication(w.payload, session(w.admin), form({ id: app.id })),
    ).toMatchObject({ error: 'profile_not_reviewed' })
    // The queue says so too.
    const view = await loadMatchingProject(w.payload, session(w.admin), project.id)
    expect(view!.applicants[0]).toMatchObject({ reviewed: false, canSelect: false })
    await review(w.beta.profile.id)
    expect(
      await selectApplication(w.payload, session(w.admin), form({ id: app.id })),
    ).toMatchObject({ status: 'done' })
  })

  it('a published project without a match, and an open application', async () => {
    const { project, applications } = await threeApplicants()
    await setStatus(applications.gamma.id, 'selected')
    // Another applicant on the now matched project: no longer open.
    expect(
      await selectApplication(w.payload, session(w.admin), form({ id: applications.beta.id })),
    ).toMatchObject({ error: 'not_open' })
    // Even forced through the API from its old state, the project has its student.
    await expect(setStatus(applications.gamma.id, 'not_selected')).rejects.toThrow()
    expect(await matchesOf(project.id)).toHaveLength(1)
  })

  it('at most 2 running projects: the third selection is refused and changes nothing', async () => {
    const third = await published('Third')
    const late = await apply(w.beta.user, third.id)
    for (const title of ['Running one', 'Running two']) {
      await selectStudent(w.payload, w.admin, w.beta, (await published(title)).id)
    }
    expect(
      await selectApplication(w.payload, session(w.admin), form({ id: late.id })),
    ).toMatchObject({ error: 'too_many' })
    expect((await stored(late.id)).status).toBe('applied')
    expect(await projectStatus(third.id)).toBe('published')
    const view = await loadMatchingProject(w.payload, session(w.admin), third.id)
    expect(view!.applicants[0]).toMatchObject({ running: 2, canSelect: false })
  })
})

/** Wait until some database session is waiting for a row lock (the apply behind the selection). */
async function waitForLockWait() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  try {
    for (let i = 0; i < 200; i++) {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      )
      if (rows.length > 0) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('The apply never waited for the selection')
  } finally {
    await pool.end()
  }
}

/**
 * After a selection and an apply on one project: the apply was refused as not open, or it holds
 * as `not_selected`. Never an `applied` (or shortlisted) row on a matched project.
 */
async function expectNoOpenApplicationOnMatched(
  projectId: number,
  profileId: number,
  outcome: PromiseSettledResult<unknown>,
) {
  expect(await projectStatus(projectId)).toBe('matched')
  const open = await w.payload.count({
    collection: 'applications',
    where: {
      and: [{ project: { equals: projectId } }, { status: { in: ['applied', 'shortlisted'] } }],
    },
  })
  expect(open.totalDocs).toBe(0)
  const own = await w.payload.find({
    collection: 'applications',
    where: { and: [{ project: { equals: projectId } }, { student: { equals: profileId } }] },
    depth: 0,
  })
  if (outcome.status === 'rejected') {
    expect((outcome as PromiseRejectedResult).reason).toMatchObject({ data: { code: 'not_open' } })
    expect(own.docs).toHaveLength(0)
  } else {
    expect(own.docs[0]?.status).toBe('not_selected')
  }
}

// ---------------------------------------------------------------------------------------------
describe('two decisions at the same moment', () => {
  it('two team members select different students on one project: one match, one selected', async () => {
    const { project, applications } = await threeApplicants('Race')
    const results = await Promise.allSettled([
      setStatus(applications.gamma.id, 'selected'),
      setStatus(applications.beta.id, 'selected'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const matches = await matchesOf(project.id)
    expect(matches).toHaveLength(1)
    const statuses = await Promise.all(
      [applications.gamma.id, applications.beta.id, applications.delta.id].map(stored),
    )
    expect(statuses.filter((a) => a.status === 'selected')).toHaveLength(1)
    expect(statuses.filter((a) => a.status === 'not_selected')).toHaveLength(2)
    const winner = statuses.find((a) => a.status === 'selected')!
    expect(matches[0]!.application).toBe(winner.id)
    expect(await projectStatus(project.id)).toBe('matched')
  })

  it('the same race through the Matching screen answers the loser clearly', async () => {
    const { project, applications } = await threeApplicants('Race on screen')
    const [a, b] = await Promise.all([
      selectApplication(w.payload, session(w.admin), form({ id: applications.gamma.id })),
      selectApplication(w.payload, session(w.admin), form({ id: applications.delta.id })),
    ])
    const outcomes = [a.status, b.status].sort()
    expect(outcomes).toEqual(['done', 'error'])
    const loser = a.status === 'error' ? a : b
    expect(['not_open', 'project_not_open', 'already_matched']).toContain(
      (loser as { error: string }).error,
    )
    expect(await matchesOf(project.id)).toHaveLength(1)
  })

  it('one student picked for two projects at once with room for one: only one pick holds', async () => {
    await review(w.beta.profile.id)
    await selectStudent(w.payload, w.admin, w.beta, (await published('Already running')).id)
    const one = await published('Pick one')
    const two = await published('Pick two')
    const a1 = await apply(w.beta.user, one.id)
    const a2 = await apply(w.beta.user, two.id)
    const results = await Promise.allSettled([
      setStatus(a1.id, 'selected'),
      setStatus(a2.id, 'selected'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const running = await w.payload.count({
      collection: 'matches',
      where: { student: { equals: w.beta.profile.id } },
    })
    expect(running.totalDocs).toBe(2)
  })

  it('a student applies while the team selects: never an open application on a matched project', async () => {
    const { project, applications } = await threeApplicants('Apply race')
    const late = await student('late')
    const results = await Promise.allSettled([
      setStatus(applications.gamma.id, 'selected'),
      apply(late.user, project.id),
    ])
    expect(results[0].status).toBe('fulfilled')
    await expectNoOpenApplicationOnMatched(project.id, late.profile.id, results[1])
  })

  it('an apply that starts while a selection holds the project waits, then is refused', async () => {
    const { project, applications } = await threeApplicants('Apply waits')
    const late = await student('late2')
    // The selection runs in its own transaction, held open until the apply is waiting on it.
    const req = await createLocalReq({ user: asUser(w.admin) as never }, w.payload)
    await initTransaction(req)
    let applying: Promise<Application> | undefined
    try {
      await w.payload.update({
        collection: 'applications',
        id: applications.gamma.id,
        data: { status: 'selected' },
        overrideAccess: false,
        req,
      })
      applying = apply(late.user, project.id)
      applying.catch(() => {})
      await waitForLockWait()
      await commitTransaction(req)
    } catch (error) {
      await killTransaction(req)
      throw error
    }
    const [outcome] = await Promise.allSettled([applying])
    expect(outcome.status).toBe('rejected')
    expect((outcome as PromiseRejectedResult).reason).toMatchObject({ data: { code: 'not_open' } })
    await expectNoOpenApplicationOnMatched(project.id, late.profile.id, outcome)
  })

  it('the student withdraws while the team selects: never both', async () => {
    const { project, gamma, applications } = await threeApplicants('Withdraw race')
    const results = await Promise.allSettled([
      setStatus(applications.gamma.id, 'selected'),
      setStatus(applications.gamma.id, 'withdrawn', gamma.user),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const after = await stored(applications.gamma.id)
    const matches = await matchesOf(project.id)
    if (after.status === 'selected') {
      expect(matches).toHaveLength(1)
      expect(await projectStatus(project.id)).toBe('matched')
    } else {
      expect(after.status).toBe('withdrawn')
      expect(matches).toHaveLength(0)
      expect(await projectStatus(project.id)).toBe('published')
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe.each(['local', 'rest', 'graphql'] as const)(
  'the company reads only the shared copy (%s)',
  (transport) => {
    const sweep = async (user: User) => {
      if (transport === 'local') {
        const parts: string[] = []
        for (const depth of [0, 1, 2, 5]) {
          for (const collection of ['matches', 'projects', 'applications', 'cvs'] as const) {
            try {
              parts.push(
                JSON.stringify(
                  await w.payload.find({ collection, depth, limit: 100, ...as(user) }),
                ),
              )
            } catch {
              parts.push('')
            }
          }
        }
        return parts.join('\n')
      }
      const cookie = await login(user.email)
      if (transport === 'rest') {
        const parts: string[] = []
        for (const depth of [0, 1, 2, 5]) {
          for (const path of ['matches', 'projects', 'applications', 'cvs']) {
            parts.push((await rest.get(`${path}?depth=${depth}&limit=100`, cookie)).text)
          }
        }
        return parts.join('\n')
      }
      return (
        await graphql(
          `
            {
              Matches(limit: 100) {
                docs {
                  id
                  sharedInfo {
                    name
                    school
                    programme
                    year
                    pitch
                    skills
                    experience
                    contactEmail
                    phone
                    cv {
                      id
                      originalName
                      url
                      owner {
                        id
                        email
                      }
                    }
                  }
                  student {
                    id
                    name
                    contactEmail
                    phone
                    user {
                      id
                      email
                    }
                  }
                  application {
                    id
                    note
                    student {
                      id
                      name
                    }
                  }
                  project {
                    id
                    title
                  }
                }
              }
              Applications(limit: 100) {
                docs {
                  id
                  note
                  student {
                    id
                    name
                  }
                }
              }
            }
          `,
          cookie,
        )
      ).text
    }

    it('the selected student only as ticked; nothing about the applicants not selected', async () => {
      const { project, applications } = await threeApplicants('Shared copy check')
      await setStatus(applications.gamma.id, 'selected')
      const all = await sweep(w.companyA.user)
      // Positive control: the company does read its match and what gamma shares.
      expect(all).toContain('Shared copy check')
      expect(all).toContain('Student gamma')
      // Not what gamma did not tick.
      for (const secret of ['School gamma', 'Programme gamma', 'Pitch gamma', 'gamma.contact']) {
        expect(all, secret).not.toContain(secret)
      }
      // Nothing about beta or delta, who were not selected, and no application note.
      for (const secret of [
        ...Object.values(SENTINEL.beta),
        'Student delta',
        'delta.contact',
        'Why I fit',
      ]) {
        expect(all, secret).not.toContain(secret)
      }
      expect(project.id).toBeGreaterThan(0)
    })

    it('another company sees nothing of the match at all', async () => {
      const { applications } = await threeApplicants('Not for company B')
      await setStatus(applications.gamma.id, 'selected')
      const all = await sweep(w.companyB.user)
      expect(all).not.toContain('Student gamma')
      expect(all).not.toContain('Not for company B')
    })
  },
)

describe('the pages read through the same rules', () => {
  it("the company's project page gets only the shared copy, and only for its own project", async () => {
    const { project, applications } = await threeApplicants('Company page')
    expect(await findSelectedStudent(w.payload, session(w.companyA.user)!, project.id)).toBeNull()
    await setStatus(applications.gamma.id, 'selected')
    const seen = await findSelectedStudent(w.payload, session(w.companyA.user)!, project.id)
    expect(seen!.shared).toMatchObject({ name: 'Student gamma', school: null, contactEmail: null })
    expect(JSON.stringify(seen)).not.toContain('gamma.contact')
    expect(seen).not.toHaveProperty('student')
    expect(await findSelectedStudent(w.payload, session(w.companyB.user)!, project.id)).toBeNull()
    expect(await findSelectedStudent(w.payload, session(w.beta.user)!, project.id)).toBeNull()
  })

  it('each student sees their own result, and what is shared only on their own match', async () => {
    const { project, gamma, applications } = await threeApplicants('Results')
    await setStatus(applications.gamma.id, 'selected')
    const mine = await findOwnApplication(w.payload, session(gamma.user), applications.gamma.id)
    expect(mine!.status).toBe('selected')
    expect(await ownSharedItems(w.payload, session(gamma.user), project.id)).toEqual([
      'name',
      'skills',
    ])
    const beta = await findOwnApplication(w.payload, session(w.beta.user), applications.beta.id)
    expect(beta!.status).toBe('not_selected')
    expect(await ownSharedItems(w.payload, session(w.beta.user), project.id)).toBeNull()
    expect(
      await findOwnApplication(w.payload, session(w.beta.user), applications.gamma.id),
    ).toBeNull()
    expect(await ownSharedItems(w.payload, session(w.companyA.user), project.id)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
describe('the Matching queue', () => {
  it('lists published projects with open applications, closed ones first, with the decide-by day', async () => {
    const open = await published('Still open', { deadline: dayFromNow(5) })
    const closed = await published('Closes soon', { deadline: dayFromNow(1) })
    await review(w.beta.profile.id)
    await apply(w.beta.user, open.id)
    await apply(w.beta.user, closed.id)
    // Applications close: move the closing day into the past, as time would.
    await w.payload.db.updateOne({
      collection: 'projects',
      where: { id: { equals: closed.id } },
      data: { deadline: dayFromNow(-1) },
      returning: false,
    })
    const queue = (await listMatchingQueue(w.payload, session(w.admin)))!
    const titles = queue.map((item) => item.title)
    expect(titles.indexOf('Closes soon')).toBeLessThan(titles.indexOf('Still open'))
    const item = queue.find((i) => i.title === 'Closes soon')!
    expect(item).toMatchObject({ section: 'decide', open: 1 })
    expect(item.decideBy! > item.closesOn!).toBe(true)
    expect(item.due).not.toBeNull()
    expect(queue.find((i) => i.title === 'Still open')).toMatchObject({
      section: 'open',
      due: null,
    })
    // Projects without open applications are not in the queue.
    expect(titles).not.toContain('Project A open')
  })

  it('compares the applicants: skills hit or missed, running projects, first project', async () => {
    const { project, applications } = await threeApplicants('Compare')
    // beta works on one project already.
    await selectStudent(w.payload, w.admin, w.beta, (await published('Beta runs this')).id)
    const view = (await loadMatchingProject(w.payload, session(w.admin), project.id))!
    expect(view.applicants.map((a) => a.applicationId)[0]).toBe(applications.gamma.id)
    const beta = view.applicants.find((a) => a.applicationId === applications.beta.id)!
    expect(beta).toMatchObject({
      running: 1,
      runningHours: 20,
      firstProject: false,
      canSelect: true,
    })
    expect(beta.skills).toContain(SENTINEL.beta.skill)
    const gamma = view.applicants.find((a) => a.applicationId === applications.gamma.id)!
    expect(gamma).toMatchObject({ running: 0, firstProject: true, shares: ['name', 'skills'] })
    expect(view.decideBy).toBeTruthy()
  })
})
