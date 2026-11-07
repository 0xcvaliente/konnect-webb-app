import type { PayloadRequest } from 'payload'
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { loadStudentWork } from '@/lib/deliverables/student'
import { loadStudentProblem, reportProblem } from '@/lib/problems/student'
import type { SessionUser } from '@/lib/students/profile'
import {
  askCompanyForChanges,
  closeWithoutDelivery,
  endMatchAndReopen,
  listOpenProblems,
  listProjectsWithoutMatch,
  loadTeamProject,
  markReportHandled,
  moveDueDate,
  reopenApplications,
} from '@/lib/team/projects'
import type { Deliverable, User } from '@/payload-types'

import {
  asUser,
  createWorld,
  dayFromNow,
  graphql,
  login,
  readyFields,
  resetDatabase,
  rest,
  selectStudent,
  sessionFor,
  type World,
  workingMatch,
} from '../helpers/world'
import { signedAgreement, uploadTemplate } from '../helpers/agreements'
import { buildDocx } from '../helpers/docx'
import { fileOf, makePng } from '../helpers/files'
import { whileHeld } from '../helpers/locks'

/**
 * Kanban cards "Problem reports: more time, match again, close without delivery" and "Projects
 * without a match: reopen, ask for changes, close". A student tells Konnected they need more time
 * or cannot finish, with a note the company never sees; the team moves the due date (the old one
 * is kept), ends the match and reopens applications (nothing unreleased is ever released), or
 * closes the project without delivery. A project nobody fits is reopened, sent back to the company
 * or closed. Every move is tried as each role (the team, the matched student, another student,
 * the company, anonymous) through the Local API with access control on, and through REST and
 * GraphQL where a role could try it directly.
 */

let w: World
let work: Awaited<ReturnType<typeof workingMatch>>
let mail: MockInstance

const NOTE = 'Problem-Note-Beta-Exams-Next-Week'
const REASON = 'Team-Close-Reason-For-Both'

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User) => asUser(user) as unknown as SessionUser
const form = (values: Record<string, string | number>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(values)) f.set(k, String(v))
  return f
}
const day = (n: number) => dayFromNow(n).slice(0, 10)

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
  // beta works on a new project of company A, in progress, with a due date from the kick-off.
  work = await workingMatch(w.payload, w.admin, w.beta, w.companyA, 'Beta project')
  await w.payload.update({
    collection: 'matches',
    id: work.match.id,
    data: { startDate: dayFromNow(0), endDate: dayFromNow(10) },
    ...as(w.admin),
  })
  mail?.mockRestore()
  mail = vi.spyOn(w.payload.email, 'sendEmail')
})

const mailsTo = (email: string) =>
  mail.mock.calls
    .map((c) => c[0] as { to: string; subject: string; text: string; html: string })
    .filter((m) => m.to === email)
const allMail = () =>
  mail.mock.calls
    .map((c) => c[0] as { subject: string; text: string; html: string })
    .map((m) => `${m.subject}${m.text}${m.html}`)
    .join('\n')

const report = (user: User, kind = 'more_time', note = NOTE) =>
  w.payload.create({
    collection: 'problem-reports',
    data: { match: work.match.id, kind, note } as never,
    ...as(user),
  })

const stored = {
  project: (id = work.project.id) =>
    w.payload.findByID({ collection: 'projects', id, depth: 0, overrideAccess: true }),
  match: (id = work.match.id) =>
    w.payload.findByID({ collection: 'matches', id, depth: 0, overrideAccess: true }),
  application: (id = work.application.id) =>
    w.payload.findByID({ collection: 'applications', id, depth: 0, overrideAccess: true }),
}

const activity = async (collection: string, id: number) =>
  (
    await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [{ targetCollection: { equals: collection } }, { targetId: { equals: String(id) } }],
      },
      pagination: false,
      overrideAccess: true,
    })
  ).docs

const handIn = async () => {
  const d = await w.payload.create({
    collection: 'deliverables',
    data: {
      match: work.match.id,
      note: 'Unreleased-Before-The-End',
      links: [{ url: 'https://example.test/x' }],
      status: 'submitted',
    } as Deliverable,
    ...as(w.beta.user),
  })
  return d
}

/** A published project of company A whose applications closed, with alpha's open application. */
async function lonely() {
  const extra = await w.payload.create({
    collection: 'projects',
    data: {
      company: w.companyA.company.id,
      title: 'Nobody fits',
      description: 'x',
      deliverable: 'y',
      desiredSkills: ['Statistics'],
      workloadHours: 30,
      durationWeeks: 2,
      workMode: 'remote',
      paidOrUnpaid: 'paid',
      fee: 1000,
      deadline: dayFromNow(5),
      startDate: dayFromNow(10),
      status: 'draft',
    },
    overrideAccess: true,
  })
  for (const status of ['submitted', 'approved'] as const) {
    await w.payload.update({
      collection: 'projects',
      id: extra.id,
      data: { status },
      ...as(w.admin),
    })
  }
  await signedAgreement(w.payload, w.admin, w.companyA.user, {
    kind: 'company',
    projectId: extra.id,
  })
  await w.payload.update({
    collection: 'projects',
    id: extra.id,
    data: { status: 'published' },
    ...as(w.admin),
  })
  const application = await w.payload.create({
    collection: 'applications',
    data: { project: extra.id, note: 'Alpha tries' } as never,
    ...as(w.alpha.user),
  })
  // Applications closed two days ago (straight in the database: the form only takes days ahead).
  await w.payload.db.updateOne({
    collection: 'projects',
    where: { id: { equals: extra.id } },
    data: { deadline: dayFromNow(-2) },
    returning: false,
  })
  mail.mockClear()
  return { project: extra, application }
}

/** Konnected reviewed alpha's profile (selecting needs a reviewed profile). */
async function reviewAlpha() {
  const profile = await w.payload.findByID({
    collection: 'student-profiles',
    id: w.alpha.profile.id,
    depth: 0,
    overrideAccess: true,
  })
  if (profile.reviewStatus === 'reviewed') return
  await w.payload.update({
    collection: 'student-profiles',
    id: w.alpha.profile.id,
    data: { reviewStatus: 'reviewed' },
    ...as(w.admin),
  })
}

/** A project of company A where the team selected alpha: matched, the work not started. */
async function matchedProject() {
  const { project, application } = await lonely()
  await reviewAlpha()
  await w.payload.update({
    collection: 'applications',
    id: application.id,
    data: { status: 'selected' },
    ...as(w.admin),
  })
  const match = (
    await w.payload.find({
      collection: 'matches',
      where: { project: { equals: project.id } },
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0]!
  mail.mockClear()
  return { project, application, match }
}

describe('a student reports a problem', () => {
  it('the matched student reports; the server fills in the match, project and student', async () => {
    const r = await report(w.beta.user)
    expect(r.status).toBe('open')
    expect(r.kind).toBe('more_time')
    const row = await w.payload.findByID({
      collection: 'problem-reports',
      id: r.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(row.project).toBe(work.project.id)
    expect(row.student).toBe(w.beta.profile.id)
    expect((await activity('problem-reports', r.id)).map((a) => a.action)).toContain('create')
    // The student gets a receipt without the note; the company is told nothing yet.
    expect(mailsTo(w.beta.user.email)).toHaveLength(1)
    expect(mailsTo(w.companyA.user.email)).toHaveLength(0)
    expect(allMail()).not.toContain(NOTE)
  })

  it('another student, the company, the team and an anonymous visitor cannot report', async () => {
    for (const user of [w.alpha.user, w.companyA.user, w.admin]) {
      await expect(report(user)).rejects.toThrow()
    }
    await expect(
      w.payload.create({
        collection: 'problem-reports',
        data: { match: work.match.id, kind: 'more_time', note: NOTE } as never,
        overrideAccess: false,
      }),
    ).rejects.toThrow()
    for (const cookie of [await login(w.companyA.user.email), undefined]) {
      const res = await rest.post(
        'problem-reports',
        { match: work.match.id, kind: 'more_time', note: NOTE },
        cookie,
      )
      expect([401, 403]).toContain(res.status)
    }
    const count = await w.payload.count({ collection: 'problem-reports', overrideAccess: true })
    expect(count.totalDocs).toBe(0)
  })

  it('one open report at a time; it starts open whatever the request says', async () => {
    await report(w.beta.user)
    await expect(report(w.beta.user, 'cannot_finish')).rejects.toThrow(/already/)
    const cookie = await login(w.beta.user.email)
    const forged = await rest.post(
      'problem-reports',
      { match: work.match.id, kind: 'more_time', note: NOTE, status: 'resolved' },
      cookie,
    )
    expect(forged.status).toBe(400)
  })

  it('only while the work runs: not on a delivered project', async () => {
    await w.payload.update({
      collection: 'projects',
      id: work.project.id,
      data: { status: 'delivered' },
      ...as(w.admin),
    })
    const res = await reportProblem(
      w.payload,
      session(w.beta.user),
      form({ projectId: work.project.id, kind: 'cannot_finish', note: NOTE }),
    )
    expect(res).toMatchObject({ status: 'error', error: 'not_open' })
  })

  it('the student card shows the open report; another student gets nothing', async () => {
    const before = await loadStudentProblem(w.payload, session(w.beta.user), work.project.id)
    expect(before).toMatchObject({ canReport: true, open: null, dueDay: day(10) })
    const sent = await reportProblem(
      w.payload,
      session(w.beta.user),
      form({ projectId: work.project.id, kind: 'cannot_finish', note: NOTE }),
    )
    expect(sent.status).toBe('done')
    const after = await loadStudentProblem(w.payload, session(w.beta.user), work.project.id)
    expect(after?.open?.kind).toBe('cannot_finish')
    expect(await loadStudentProblem(w.payload, session(w.alpha.user), work.project.id)).toBeNull()
  })
})

describe('the note never reaches the company', () => {
  it('REST, GraphQL and the Local API return no report to a company, another student or anonymous', async () => {
    const r = await report(w.beta.user)
    const companyCookie = await login(w.companyA.user.email)
    const alphaCookie = await login(w.alpha.user.email)
    for (const cookie of [companyCookie, alphaCookie, undefined]) {
      const list = await rest.get('problem-reports?depth=5', cookie)
      expect(list.text).not.toContain(NOTE)
      const one = await rest.get(`problem-reports/${r.id}?depth=5`, cookie)
      expect([401, 403, 404]).toContain(one.status)
      expect(one.text).not.toContain(NOTE)
      const gql = await graphql(
        '{ ProblemReports(limit: 50) { docs { id note kind student { name } match { id } } } }',
        cookie,
      )
      expect(gql.text).not.toContain(NOTE)
      // Not through the project or the match either, at any depth.
      for (const path of [`projects?depth=5&limit=50`, `matches?depth=5&limit=50`]) {
        expect((await rest.get(path, cookie)).text).not.toContain(NOTE)
      }
    }
    for (const user of [w.companyA.user, w.alpha.user]) {
      const local = await w.payload
        .find({ collection: 'problem-reports', depth: 5, ...as(user) })
        .catch(() => ({ docs: [] }))
      expect(JSON.stringify(local)).not.toContain(NOTE)
    }
    // Positive controls: the student reads their own note, and so does the team.
    const own = await rest.get('problem-reports?depth=0', await login(w.beta.user.email))
    expect(own.text).toContain(NOTE)
    const team = await rest.get('problem-reports?depth=0', await sessionFor(w.admin.id))
    expect(team.text).toContain(NOTE)
  })

  it('a student cannot change or settle their report; the company cannot either', async () => {
    const r = await report(w.beta.user)
    for (const user of [w.beta.user, w.companyA.user, w.alpha.user]) {
      await expect(
        w.payload.update({
          collection: 'problem-reports',
          id: r.id,
          data: { status: 'resolved', resolution: 'no_change', note: 'changed' } as never,
          ...as(user),
        }),
      ).rejects.toThrow()
    }
    const res = await markReportHandled(w.payload, session(w.beta.user), form({ reportId: r.id }))
    expect(res).toMatchObject({ status: 'error', error: 'forbidden' })
    expect(
      (await w.payload.findByID({ collection: 'problem-reports', id: r.id, overrideAccess: true }))
        .status,
    ).toBe('open')
  })

  it('the team marks a report handled; the note stays as the student wrote it', async () => {
    const r = await report(w.beta.user)
    const res = await markReportHandled(
      w.payload,
      session(w.admin),
      form({ reportId: r.id, note: 'Talked on the phone' }),
    )
    expect(res.status).toBe('done')
    const row = await w.payload.findByID({
      collection: 'problem-reports',
      id: r.id,
      overrideAccess: true,
    })
    expect(row).toMatchObject({ status: 'resolved', resolution: 'no_change', note: NOTE })
    const log = await activity('problem-reports', r.id)
    expect(log.some((a) => a.toStatus === 'resolved' && a.note === 'Talked on the phone')).toBe(
      true,
    )
    expect(
      await markReportHandled(w.payload, session(w.admin), form({ reportId: r.id })),
    ).toMatchObject({ status: 'error', error: 'changed' })
  })
})

describe('the team moves the due date', () => {
  it('keeps the old date, logs it, settles the report and tells both without the note', async () => {
    await report(w.beta.user)
    mail.mockClear()
    const res = await moveDueDate(
      w.payload,
      session(w.admin),
      form({ id: work.project.id, date: day(17), note: 'Agreed with the student' }),
    )
    expect(res.status).toBe('done')
    const match = await stored.match()
    expect(match.endDate?.slice(0, 10)).toBe(day(17))
    expect(match.dueDateHistory).toHaveLength(1)
    expect(match.dueDateHistory![0]!.from?.slice(0, 10)).toBe(day(10))
    expect(match.dueDateHistory![0]!.to?.slice(0, 10)).toBe(day(17))
    const reports = await w.payload.find({ collection: 'problem-reports', overrideAccess: true })
    expect(reports.docs[0]).toMatchObject({ status: 'resolved', resolution: 'date_moved' })
    const log = await activity('matches', work.match.id)
    expect(log.some((a) => a.field === 'endDate' && a.note === 'Agreed with the student')).toBe(
      true,
    )
    expect(mailsTo(w.beta.user.email)).toHaveLength(1)
    expect(mailsTo(w.companyA.user.email)).toHaveLength(1)
    expect(allMail()).not.toContain(NOTE)
    // The company reads the new date and the old one on its match, nothing about why.
    const seen = await rest.get(
      `matches/${work.match.id}?depth=2`,
      await login(w.companyA.user.email),
    )
    expect(seen.status).toBe(200)
    expect(seen.json.endDate as string).toContain(day(17))
    expect(JSON.stringify(seen.json.dueDateHistory)).toContain(day(10))
    expect(seen.text).not.toContain('Agreed with the student')
  })

  it('a day in the past is refused; the company and the student cannot move it', async () => {
    expect(
      await moveDueDate(w.payload, session(w.admin), form({ id: work.project.id, date: day(-1) })),
    ).toMatchObject({ status: 'error', error: 'date_invalid' })
    for (const user of [w.beta.user, w.companyA.user]) {
      expect(
        await moveDueDate(w.payload, session(user), form({ id: work.project.id, date: day(20) })),
      ).toMatchObject({ status: 'error', error: 'forbidden' })
      await expect(
        w.payload.update({
          collection: 'matches',
          id: work.match.id,
          data: { endDate: dayFromNow(20) },
          ...as(user),
        }),
      ).rejects.toThrow()
    }
    for (const cookie of [await login(w.companyA.user.email), await login(w.beta.user.email)]) {
      const res = await rest.patch(`matches/${work.match.id}`, { endDate: dayFromNow(20) }, cookie)
      expect([401, 403, 404]).toContain(res.status)
    }
    expect((await stored.match()).endDate?.slice(0, 10)).toBe(day(10))
  })

  it('the history is the server’s: the team cannot write it through the API', async () => {
    const res = await rest.patch(
      `matches/${work.match.id}`,
      { dueDateHistory: [{ from: dayFromNow(-30), to: dayFromNow(-20) }] },
      await sessionFor(w.admin.id),
    )
    expect(res.status).toBe(200)
    expect((await stored.match()).dueDateHistory ?? []).toHaveLength(0)
  })
})

describe('the team ends the match and reopens applications', () => {
  it('ends the match, keeps the hand-in unreleased, settles the report and tells both', async () => {
    const hidden = await handIn()
    await report(w.beta.user, 'cannot_finish')
    mail.mockClear()
    const res = await endMatchAndReopen(
      w.payload,
      session(w.admin),
      form({ id: work.project.id, date: day(8), note: 'Student stopped' }),
    )
    expect(res.status).toBe('done')
    const project = await stored.project()
    expect(project.status).toBe('published')
    expect(project.deadline?.slice(0, 10)).toBe(day(8))
    expect(project.reopenReason).toBe('match_ended')
    expect(project.reopenedAt).toBeTruthy()
    const match = await stored.match()
    expect(match.endedAt).toBeTruthy()
    expect(match.sharedInfo?.name ?? null).toBeNull()
    expect((await stored.application()).status).toBe('match_ended')
    const reports = await w.payload.find({ collection: 'problem-reports', overrideAccess: true })
    expect(reports.docs[0]).toMatchObject({ status: 'resolved', resolution: 'match_ended' })
    expect(
      (
        await w.payload.findByID({
          collection: 'deliverables',
          id: hidden.id,
          overrideAccess: true,
        })
      ).status,
    ).toBe('submitted')
    // The status change is logged with the team's note; the match end too.
    const log = await activity('projects', work.project.id)
    expect(log.some((a) => a.toStatus === 'published' && a.note === 'Student stopped')).toBe(true)
    expect((await activity('matches', work.match.id)).some((a) => a.toStatus === 'ended')).toBe(
      true,
    )
    // One email each: the student's ended, the company's "finding a new student". No "published".
    expect(mailsTo(w.beta.user.email)).toHaveLength(1)
    const toCompany = mailsTo(w.companyA.user.email)
    expect(toCompany).toHaveLength(1)
    expect(toCompany[0]!.subject).toMatch(/new student/i)
    expect(allMail()).not.toContain(NOTE)
  })

  it('the company no longer reads the ended match or its hand-ins, on any API', async () => {
    await handIn()
    await endMatchAndReopen(
      w.payload,
      session(w.admin),
      form({ id: work.project.id, date: day(8) }),
    )
    const cookie = await login(w.companyA.user.email)
    const list = await rest.get('matches?depth=3&limit=100', cookie)
    expect((list.json.docs as { id: number }[]).map((d) => d.id)).not.toContain(work.match.id)
    const one = await rest.get(`matches/${work.match.id}`, cookie)
    expect([403, 404]).toContain(one.status)
    const gql = await graphql(
      `
        {
          Matches(limit: 100) {
            docs {
              id
            }
          }
        }
      `,
      cookie,
    )
    expect(gql.text).not.toContain(`"id":${work.match.id}`)
    const local = await w.payload.find({ collection: 'matches', ...as(w.companyA.user) })
    expect(local.docs.map((d) => d.id)).not.toContain(work.match.id)
    expect((await rest.get('deliverables?depth=3', cookie)).text).not.toContain(
      'Unreleased-Before-The-End',
    )
    // The company reads the new plan on its project.
    const project = await rest.get(`projects/${work.project.id}`, cookie)
    expect(project.json.reopenReason).toBe('match_ended')
  })

  it('nothing more happens on the ended match: no hand-in, no release, no upload', async () => {
    const hidden = await handIn()
    await endMatchAndReopen(
      w.payload,
      session(w.admin),
      form({ id: work.project.id, date: day(8) }),
    )
    await expect(handIn()).rejects.toThrow()
    await expect(
      w.payload.update({
        collection: 'deliverables',
        id: hidden.id,
        data: { status: 'released' },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/ended/)
    expect(await loadStudentWork(w.payload, session(w.beta.user), work.project.id)).toBeNull()
    expect(await loadStudentProblem(w.payload, session(w.beta.user), work.project.id)).toBeNull()
  })

  it('the team can match the project again with another student', async () => {
    await endMatchAndReopen(
      w.payload,
      session(w.admin),
      form({ id: work.project.id, date: day(8) }),
    )
    const again = await selectStudent(w.payload, w.admin, w.alpha, work.project.id)
    expect(again.match.id).not.toBe(work.match.id)
    expect((await stored.project()).status).toBe('matched')
    const matches = await w.payload.find({
      collection: 'matches',
      where: { project: { equals: work.project.id } },
      overrideAccess: true,
    })
    expect(matches.docs).toHaveLength(2)
    // The new student's agreement is needed before the work starts again.
    await expect(
      w.payload.update({
        collection: 'projects',
        id: work.project.id,
        data: { status: 'in_progress' },
        ...as(w.admin),
      }),
    ).rejects.toThrow()
    await signedAgreement(w.payload, w.admin, w.alpha.user, {
      kind: 'student',
      matchId: again.match.id,
    })
    const started = await w.payload.update({
      collection: 'projects',
      id: work.project.id,
      data: { status: 'in_progress' },
      ...as(w.admin),
    })
    expect(started.status).toBe('in_progress')
  })

  it('only the team may end a match; reopening needs a closing day today or later', async () => {
    for (const user of [w.beta.user, w.companyA.user]) {
      expect(
        await endMatchAndReopen(
          w.payload,
          session(user),
          form({ id: work.project.id, date: day(8) }),
        ),
      ).toMatchObject({ status: 'error', error: 'forbidden' })
      await expect(
        w.payload.update({
          collection: 'projects',
          id: work.project.id,
          data: { status: 'published', deadline: dayFromNow(8) },
          ...as(user),
        }),
      ).rejects.toThrow()
    }
    for (const cookie of [
      await login(w.beta.user.email),
      await login(w.companyA.user.email),
      undefined,
    ]) {
      const res = await rest.patch(`projects/${work.project.id}`, { status: 'published' }, cookie)
      expect([401, 403, 404]).toContain(res.status)
    }
    // The team: through REST with a closing day in the past is refused.
    const admin = await sessionFor(w.admin.id)
    const late = await rest.patch(
      `projects/${work.project.id}`,
      { status: 'published', deadline: dayFromNow(-1) },
      admin,
    )
    expect(late.status).toBe(400)
    expect((await stored.project()).status).toBe('in_progress')
    expect((await stored.match()).endedAt ?? null).toBeNull()
  })

  it('a match is never ended directly, and an application is not marked ended while it runs', async () => {
    const admin = await sessionFor(w.admin.id)
    const res = await rest.patch(
      `matches/${work.match.id}`,
      { endedAt: new Date().toISOString() },
      admin,
    )
    expect(res.status).toBe(400)
    expect((await stored.match()).endedAt ?? null).toBeNull()
    await expect(
      w.payload.update({
        collection: 'applications',
        id: work.application.id,
        data: { status: 'match_ended' },
        ...as(w.admin),
      }),
    ).rejects.toThrow()
  })
})

describe('the team closes a running project without delivery', () => {
  it('needs a reason; ends the match; both get the reason, never the note', async () => {
    await report(w.beta.user, 'cannot_finish')
    expect(
      await closeWithoutDelivery(w.payload, session(w.admin), form({ id: work.project.id })),
    ).toMatchObject({ status: 'error', error: 'reason_required' })
    const viaRest = await rest.patch(
      `projects/${work.project.id}`,
      { status: 'closed' },
      await sessionFor(w.admin.id),
    )
    expect(viaRest.status).toBe(400)
    mail.mockClear()
    const res = await closeWithoutDelivery(
      w.payload,
      session(w.admin),
      form({ id: work.project.id, reason: REASON }),
    )
    expect(res.status).toBe('done')
    const project = await stored.project()
    expect(project).toMatchObject({ status: 'closed', closeOutcome: 'no_delivery' })
    expect(project.closeReason).toBe(REASON)
    expect((await stored.match()).endedAt).toBeTruthy()
    expect((await stored.application()).status).toBe('match_ended')
    const reports = await w.payload.find({ collection: 'problem-reports', overrideAccess: true })
    expect(reports.docs[0]).toMatchObject({ status: 'resolved', resolution: 'closed' })
    for (const email of [w.beta.user.email, w.companyA.user.email]) {
      const mails = mailsTo(email)
      expect(mails).toHaveLength(1)
      expect(mails[0]!.text).toContain(REASON)
    }
    expect(allMail()).not.toContain(NOTE)
    // The company reads the reason; a student does not read the closed project.
    const seen = await rest.get(`projects/${work.project.id}`, await login(w.companyA.user.email))
    expect(seen.json.closeReason).toBe(REASON)
    const studentView = await rest.get(
      `projects/${work.project.id}`,
      await login(w.beta.user.email),
    )
    expect(studentView.text).not.toContain(REASON)
  })

  it('a company or a student cannot close; nothing changes', async () => {
    for (const user of [w.companyA.user, w.beta.user]) {
      expect(
        await closeWithoutDelivery(
          w.payload,
          session(user),
          form({ id: work.project.id, reason: REASON }),
        ),
      ).toMatchObject({ status: 'error', error: 'forbidden' })
      await expect(
        w.payload.update({
          collection: 'projects',
          id: work.project.id,
          data: { status: 'closed', closeReason: REASON },
          ...as(user),
        }),
      ).rejects.toThrow()
    }
    expect((await stored.project()).status).toBe('in_progress')
  })
})

describe('a project without a match', () => {
  it('Today lists it for the team only, and the team page offers the choices', async () => {
    const { project } = await lonely()
    const items = await listProjectsWithoutMatch(w.payload, session(w.admin))
    expect(items?.map((i) => i.projectId)).toContain(project.id)
    expect(items?.find((i) => i.projectId === project.id)?.open).toBe(1)
    expect(await listProjectsWithoutMatch(w.payload, session(w.companyA.user))).toBeNull()
    expect(await listProjectsWithoutMatch(w.payload, session(w.beta.user))).toBeNull()
    const page = await loadTeamProject(w.payload, session(w.admin), project.id)
    expect(page?.noMatch).toBe(true)
    expect(await loadTeamProject(w.payload, session(w.companyA.user), project.id)).toBeNull()
  })

  it('reopen: a new closing day, logged, and the company is told', async () => {
    const { project } = await lonely()
    const res = await reopenApplications(
      w.payload,
      session(w.admin),
      form({ id: project.id, date: day(9) }),
    )
    expect(res.status).toBe('done')
    const now = await stored.project(project.id)
    expect(now).toMatchObject({ status: 'published', reopenReason: 'no_match' })
    expect(now.deadline?.slice(0, 10)).toBe(day(9))
    expect((await activity('projects', project.id)).some((a) => a.field === 'deadline')).toBe(true)
    expect(mailsTo(w.companyA.user.email)).toHaveLength(1)
    // Applications are open again: reopening an open project is refused.
    expect(
      await reopenApplications(
        w.payload,
        session(w.admin),
        form({ id: project.id, date: day(12) }),
      ),
    ).toMatchObject({ status: 'error', error: 'not_open' })
    expect(
      await reopenApplications(
        w.payload,
        session(w.companyA.user),
        form({ id: project.id, date: day(12) }),
      ),
    ).toMatchObject({ status: 'error', error: 'forbidden' })
  })

  it('ask the company for changes: it may edit and send the project again', async () => {
    const { project } = await lonely()
    expect(
      await askCompanyForChanges(
        w.payload,
        session(w.companyA.user),
        form({ id: project.id, note: 'Longer timeframe' }),
      ),
    ).toMatchObject({ status: 'error', error: 'forbidden' })
    await expect(
      w.payload.update({
        collection: 'projects',
        id: project.id,
        data: { status: 'changes_requested' },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()
    const res = await askCompanyForChanges(
      w.payload,
      session(w.admin),
      form({ id: project.id, note: 'Longer timeframe' }),
    )
    expect(res.status).toBe('done')
    const now = await stored.project(project.id)
    expect(now).toMatchObject({ status: 'changes_requested', noteToCompany: 'Longer timeframe' })
    expect(mailsTo(w.companyA.user.email)).toHaveLength(1)
    // The company edits its project now (the usual changes-requested rule).
    const edited = await w.payload.update({
      collection: 'projects',
      id: project.id,
      data: { durationWeeks: 4, deadline: dayFromNow(7), startDate: dayFromNow(14) },
      ...as(w.companyA.user),
    })
    expect(edited.durationWeeks).toBe(4)
  })

  it('close without a match: a reason; the open applications are not selected', async () => {
    const { project, application } = await lonely()
    expect(
      await closeWithoutDelivery(w.payload, session(w.admin), form({ id: project.id })),
    ).toMatchObject({ status: 'error', error: 'reason_required' })
    const res = await closeWithoutDelivery(
      w.payload,
      session(w.admin),
      form({ id: project.id, reason: REASON }),
    )
    expect(res.status).toBe('done')
    expect(await stored.project(project.id)).toMatchObject({
      status: 'closed',
      closeOutcome: 'no_match',
    })
    expect((await stored.application(application.id)).status).toBe('not_selected')
    expect(mailsTo(w.alpha.user.email)).toHaveLength(1)
    const toCompany = mailsTo(w.companyA.user.email)
    expect(toCompany).toHaveLength(1)
    expect(toCompany[0]!.text).toContain(REASON)
    // No student's name in the company's email.
    expect(toCompany[0]!.text).not.toMatch(/Sentinel/)
  })
})

/**
 * Every role but the team tries `data` on the project through the Local API (access control on),
 * REST and GraphQL. Nothing may change.
 */
async function refusedForEveryoneButTheTeam(
  projectId: number,
  data: Record<string, unknown>,
  gqlData: string,
  users: User[],
) {
  const before = await stored.project(projectId)
  for (const user of users) {
    await expect(
      w.payload.update({ collection: 'projects', id: projectId, data, ...as(user) }),
    ).rejects.toThrow()
  }
  await expect(
    w.payload.update({ collection: 'projects', id: projectId, data, overrideAccess: false }),
  ).rejects.toThrow()
  const cookies = [...(await Promise.all(users.map((u) => login(u.email)))), undefined]
  for (const cookie of cookies) {
    const res = await rest.patch(`projects/${projectId}`, data, cookie)
    expect([401, 403, 404]).toContain(res.status)
    const gql = await graphql(
      `mutation { updateProject(id: ${projectId}, data: { ${gqlData} }) { id status } }`,
      cookie,
    )
    expect(gql.text).toContain('"errors"')
  }
  const after = await stored.project(projectId)
  expect(after.status).toBe(before.status)
  expect(after.closeOutcome ?? null).toBe(before.closeOutcome ?? null)
  expect(after.reopenedAt ?? null).toBe(before.reopenedAt ?? null)
}

describe('a matched project (the work has not started yet)', () => {
  it('the team ends the match and reopens: matched to published', async () => {
    const { project, application, match } = await matchedProject()
    expect((await stored.project(project.id)).status).toBe('matched')
    const res = await endMatchAndReopen(
      w.payload,
      session(w.admin),
      form({ id: project.id, date: day(8) }),
    )
    expect(res.status).toBe('done')
    expect(await stored.project(project.id)).toMatchObject({
      status: 'published',
      reopenReason: 'match_ended',
    })
    expect((await stored.match(match.id)).endedAt).toBeTruthy()
    expect((await stored.application(application.id)).status).toBe('match_ended')
    expect(mailsTo(w.alpha.user.email)).toHaveLength(1)
    expect(mailsTo(w.companyA.user.email)).toHaveLength(1)
  })

  it('the team closes without delivery: matched to closed', async () => {
    const { project, application, match } = await matchedProject()
    const res = await closeWithoutDelivery(
      w.payload,
      session(w.admin),
      form({ id: project.id, reason: REASON }),
    )
    expect(res.status).toBe('done')
    expect(await stored.project(project.id)).toMatchObject({
      status: 'closed',
      closeOutcome: 'no_delivery',
      closeReason: REASON,
    })
    expect((await stored.match(match.id)).endedAt).toBeTruthy()
    expect((await stored.application(application.id)).status).toBe('match_ended')
  })

  it('the matched student, another student, the company and anonymous can do neither', async () => {
    const { project, match } = await matchedProject()
    const users = [w.alpha.user, w.beta.user, w.companyA.user]
    for (const user of users) {
      for (const decide of [endMatchAndReopen, closeWithoutDelivery]) {
        expect(
          await decide(
            w.payload,
            session(user),
            form({ id: project.id, date: day(8), reason: REASON }),
          ),
        ).toMatchObject({ status: 'error', error: 'forbidden' })
      }
    }
    await refusedForEveryoneButTheTeam(
      project.id,
      { status: 'published', deadline: dayFromNow(8) },
      `status: published, deadline: "${dayFromNow(8)}"`,
      users,
    )
    await refusedForEveryoneButTheTeam(
      project.id,
      { status: 'closed', closeReason: REASON },
      `status: closed, closeReason: "${REASON}"`,
      users,
    )
    expect((await stored.project(project.id)).status).toBe('matched')
    expect((await stored.match(match.id)).endedAt ?? null).toBeNull()
  })
})

describe('a published project: only the team closes it or sends it back', () => {
  it('as the applicant, another student, the company and anonymous: refused on every API', async () => {
    const { project, application } = await lonely()
    const users = [w.alpha.user, w.beta.user, w.companyA.user]
    for (const user of users) {
      expect(
        await closeWithoutDelivery(
          w.payload,
          session(user),
          form({ id: project.id, reason: REASON }),
        ),
      ).toMatchObject({ status: 'error', error: 'forbidden' })
      expect(
        await askCompanyForChanges(
          w.payload,
          session(user),
          form({ id: project.id, note: 'Longer timeframe' }),
        ),
      ).toMatchObject({ status: 'error', error: 'forbidden' })
    }
    await refusedForEveryoneButTheTeam(
      project.id,
      { status: 'closed', closeReason: REASON },
      `status: closed, closeReason: "${REASON}"`,
      users,
    )
    await refusedForEveryoneButTheTeam(
      project.id,
      { status: 'changes_requested', noteToCompany: 'x' },
      `status: changes_requested`,
      users,
    )
    expect((await stored.application(application.id)).status).toBe('applied')
    expect(mailsTo(w.companyA.user.email)).toHaveLength(0)
    // Positive control: the same REST call as the team works.
    const ok = await rest.patch(
      `projects/${project.id}`,
      { status: 'closed', closeReason: REASON },
      await sessionFor(w.admin.id),
    )
    expect(ok.status).toBe(200)
    expect((await stored.project(project.id)).closeOutcome).toBe('no_match')
  })
})

describe('a selected application is marked ended only by the team ending the match', () => {
  it('the student, another student, the company and anonymous cannot mark it', async () => {
    for (const user of [w.beta.user, w.alpha.user, w.companyA.user]) {
      await expect(
        w.payload.update({
          collection: 'applications',
          id: work.application.id,
          data: { status: 'match_ended' },
          ...as(user),
        }),
      ).rejects.toThrow()
    }
    await expect(
      w.payload.update({
        collection: 'applications',
        id: work.application.id,
        data: { status: 'match_ended' },
        overrideAccess: false,
      }),
    ).rejects.toThrow()
    for (const cookie of [
      await login(w.beta.user.email),
      await login(w.alpha.user.email),
      await login(w.companyA.user.email),
      undefined,
    ]) {
      const res = await rest.patch(
        `applications/${work.application.id}`,
        { status: 'match_ended' },
        cookie,
      )
      expect([401, 403, 404]).toContain(res.status)
    }
    expect((await stored.application()).status).toBe('selected')
    expect((await stored.match()).endedAt ?? null).toBeNull()
  })
})

describe('after a match ends, its files close', () => {
  it('the company loses the student’s CV and the student loses the brief', async () => {
    // beta (running on the work project) shares the CV; the project has a brief attachment.
    await w.payload.update({
      collection: 'student-profiles',
      id: w.beta.profile.id,
      data: { privacy: { shareCv: true } } as never,
      ...as(w.beta.user),
    })
    const brief = await w.payload.create({
      collection: 'brief-files',
      data: {} as never,
      file: fileOf(await makePng(), 'brief-work.png', 'image/png'),
      ...as(w.companyA.user),
    })
    await w.payload.update({
      collection: 'projects',
      id: work.project.id,
      data: { attachments: [brief.id] },
      ...as(w.admin),
    })
    const company = await login(w.companyA.user.email)
    const beta = await login(w.beta.user.email)
    const admin = await sessionFor(w.admin.id)
    const cvFile = `cvs/file/${w.betaCv.filename}`
    const briefFile = `brief-files/file/${brief.filename}`
    // While the match runs: both open (so the checks below can fail).
    expect((await rest.get(cvFile, company)).status).toBe(200)
    expect((await rest.get(briefFile, beta)).status).toBe(200)

    const res = await endMatchAndReopen(
      w.payload,
      session(w.admin),
      form({ id: work.project.id, date: day(8) }),
    )
    expect(res.status).toBe('done')

    expect([403, 404]).toContain((await rest.get(cvFile, company)).status)
    expect([403, 404]).toContain((await rest.get(`cvs/${w.betaCv.id}`, company)).status)
    const cvs = await rest.get('cvs?depth=0&limit=100', company)
    expect(cvs.text).not.toContain(w.betaCv.filename!)
    const localCvs = await w.payload
      .find({ collection: 'cvs', depth: 0, ...as(w.companyA.user) })
      .catch(() => ({ docs: [] as { id: number }[] }))
    expect(localCvs.docs.map((d) => d.id)).not.toContain(w.betaCv.id)

    expect([403, 404]).toContain((await rest.get(briefFile, beta)).status)
    expect([403, 404]).toContain((await rest.get(`brief-files/${brief.id}`, beta)).status)
    const briefs = await rest.get('brief-files?depth=0&limit=100', beta)
    expect(briefs.text).not.toContain(brief.filename!)
    const localBriefs = await w.payload
      .find({ collection: 'brief-files', depth: 0, ...as(w.beta.user) })
      .catch(() => ({ docs: [] as { id: number }[] }))
    expect(localBriefs.docs.map((d) => d.id)).not.toContain(brief.id)

    // Positive control: the team still opens both.
    expect((await rest.get(cvFile, admin)).status).toBe(200)
    expect((await rest.get(briefFile, admin)).status).toBe(200)
  })
})

describe('two team members at the same moment', () => {
  /** alpha's application on a published project, selected in a transaction held open. */
  const select = (applicationId: number) => (req: PayloadRequest) =>
    w.payload.update({
      collection: 'applications',
      id: applicationId,
      data: { status: 'selected' },
      overrideAccess: false,
      req,
    })

  const expectMatchedAndRunning = async (projectId: number, applicationId: number) => {
    const project = await stored.project(projectId)
    expect(project.status).toBe('matched')
    expect(project.closeOutcome ?? null).toBeNull()
    expect((await stored.application(applicationId)).status).toBe('selected')
    const matches = await w.payload.find({
      collection: 'matches',
      where: { project: { equals: projectId } },
      depth: 0,
      overrideAccess: true,
    })
    expect(matches.docs).toHaveLength(1)
    expect(matches.docs[0]!.endedAt ?? null).toBeNull()
  }

  it('close without a match while another selects: the close waits, then is refused', async () => {
    const { project, application } = await lonely()
    await reviewAlpha()
    const outcome = await whileHeld(w.payload, w.admin, select(application.id), () =>
      closeWithoutDelivery(w.payload, session(w.admin), form({ id: project.id, reason: REASON })),
    )
    expect(outcome).toMatchObject({ status: 'fulfilled', value: { error: 'changed' } })
    await expectMatchedAndRunning(project.id, application.id)
    const toCompany = mailsTo(w.companyA.user.email)
    expect(toCompany.some((m) => m.text.includes(REASON))).toBe(false)
  })

  it('ask for changes while another selects: the request waits, then is refused', async () => {
    const { project, application } = await lonely()
    await reviewAlpha()
    const outcome = await whileHeld(w.payload, w.admin, select(application.id), () =>
      askCompanyForChanges(
        w.payload,
        session(w.admin),
        form({ id: project.id, note: 'Longer timeframe' }),
      ),
    )
    expect(outcome).toMatchObject({ status: 'fulfilled', value: { error: 'changed' } })
    await expectMatchedAndRunning(project.id, application.id)
    expect((await stored.project(project.id)).noteToCompany ?? null).toBeNull()
  })

  it('end and reopen while another closes without delivery: one decision, one set of emails', async () => {
    mail.mockClear()
    const outcome = await whileHeld(
      w.payload,
      w.admin,
      (req) =>
        w.payload.update({
          collection: 'projects',
          id: work.project.id,
          data: { status: 'published', deadline: dayFromNow(8) },
          overrideAccess: false,
          req,
        }),
      () =>
        closeWithoutDelivery(
          w.payload,
          session(w.admin),
          form({ id: work.project.id, reason: REASON }),
        ),
    )
    expect(outcome).toMatchObject({ status: 'fulfilled', value: { error: 'changed' } })
    const project = await stored.project()
    expect(project).toMatchObject({ status: 'published', reopenReason: 'match_ended' })
    expect(project.closeOutcome ?? null).toBeNull()
    expect((await stored.match()).endedAt).toBeTruthy()
    expect(mailsTo(w.beta.user.email)).toHaveLength(1)
    expect(mailsTo(w.companyA.user.email)).toHaveLength(1)
    expect(allMail()).not.toContain(REASON)
  })
})

describe('reopening never asks the company for a new agreement', () => {
  /** A company template that uses the closing day, published before the projects below. */
  beforeEach(async () => {
    const docx = buildDocx([
      'Company agreement with closing day (TEST)',
      'Reference {{agreement.reference}}. {{company.name}}.',
      'Project: {{project.title}}. Applications close {{project.deadline}}.',
      'Price {{price.exclVat}}.',
    ])
    const draft = await uploadTemplate(w.payload, w.admin, 'company', docx, 'deadline.docx')
    await w.payload.update({
      collection: 'agreement-templates',
      id: draft.id,
      data: { status: 'published' },
      ...as(w.admin),
    })
  })

  const signedDeadline = async (projectId: number) => {
    const found = await w.payload.find({
      collection: 'agreements',
      where: { and: [{ project: { equals: projectId } }, { kind: { equals: 'company' } }] },
      depth: 0,
      overrideAccess: true,
    })
    return (found.docs[0]!.values as Record<string, string | null>)['project.deadline']
  }

  it('end the match and reopen twice', async () => {
    const run = await workingMatch(w.payload, w.admin, w.beta, w.companyB, 'Closing day project')
    // The company signed the closing day (so the checks below can fail).
    expect(await signedDeadline(run.project.id)).toBeTruthy()
    const first = await endMatchAndReopen(
      w.payload,
      session(w.admin),
      form({ id: run.project.id, date: day(8) }),
    )
    expect(first.status).toBe('done')
    await reviewAlpha()
    await selectStudent(w.payload, w.admin, w.alpha, run.project.id)
    const second = await endMatchAndReopen(
      w.payload,
      session(w.admin),
      form({ id: run.project.id, date: day(12) }),
    )
    expect(second.status).toBe('done')
    const project = await stored.project(run.project.id)
    expect(project.status).toBe('published')
    expect(project.deadline?.slice(0, 10)).toBe(day(12))
  })

  it('reopen without a match, then end a match and reopen', async () => {
    const { project, application } = await lonely()
    expect(await signedDeadline(project.id)).toBeTruthy()
    expect(
      (
        await reopenApplications(
          w.payload,
          session(w.admin),
          form({ id: project.id, date: day(9) }),
        )
      ).status,
    ).toBe('done')
    await reviewAlpha()
    await w.payload.update({
      collection: 'applications',
      id: application.id,
      data: { status: 'selected' },
      ...as(w.admin),
    })
    expect((await stored.project(project.id)).status).toBe('matched')
    const res = await endMatchAndReopen(
      w.payload,
      session(w.admin),
      form({ id: project.id, date: day(11) }),
    )
    expect(res.status).toBe('done')
    expect((await stored.project(project.id)).status).toBe('published')
  })

  it('the first publish still compares the closing day the company signed', async () => {
    const draft = await w.payload.create({
      collection: 'projects',
      data: {
        ...readyFields(),
        company: w.companyA.company.id,
        title: 'Gate',
        fee: 1000,
        status: 'draft',
      },
      overrideAccess: true,
    })
    for (const status of ['submitted', 'approved'] as const) {
      await w.payload.update({
        collection: 'projects',
        id: draft.id,
        data: { status },
        ...as(w.admin),
      })
    }
    await signedAgreement(w.payload, w.admin, w.companyA.user, {
      kind: 'company',
      projectId: draft.id,
    })
    await expect(
      w.payload.update({
        collection: 'projects',
        id: draft.id,
        data: { status: 'published', deadline: dayFromNow(30) },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/no longer matches/)
  })
})

describe('Today: problems reported', () => {
  it('lists open reports for the team only', async () => {
    const r = await report(w.beta.user)
    const items = await listOpenProblems(w.payload, session(w.admin))
    expect(items?.map((i) => i.id)).toEqual([r.id])
    expect(items?.[0]).toMatchObject({ projectId: work.project.id, kind: 'more_time' })
    expect(JSON.stringify(items)).not.toContain(NOTE)
    expect(await listOpenProblems(w.payload, session(w.companyA.user))).toBeNull()
    expect(await listOpenProblems(w.payload, session(w.beta.user))).toBeNull()
    const page = await loadTeamProject(w.payload, session(w.admin), work.project.id)
    expect(page?.openReport?.note).toBe(NOTE)
  })
})

describe('the problem-path emails', () => {
  it('render in English and Norwegian with every placeholder filled', async () => {
    const { problemPathEmail } = await import('@/lib/email/templates')
    const kinds = [
      'received',
      'dueDateStudent',
      'dueDateCompany',
      'endedStudent',
      'closedStudent',
      'rematchCompany',
      'closedNoDeliveryCompany',
      'closedNoMatchCompany',
      'reopenedCompany',
    ] as const
    for (const locale of ['en', 'no'] as const) {
      for (const kind of kinds) {
        for (const from of ['2026-11-10', null]) {
          const mail = problemPathEmail(locale, kind, {
            title: 'T',
            company: 'C',
            date: '2026-11-20',
            from,
            reason: kind.startsWith('closed') ? 'R' : null,
            href: 'http://localhost:3000/x',
          })
          const all = `${mail.subject}${mail.text}${mail.html}`
          expect(all, `${locale} ${kind}`).not.toMatch(/\{\w+\}/)
          expect(mail.subject.length).toBeGreaterThan(0)
        }
      }
    }
  })
})
