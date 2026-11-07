import { beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest'

import { decisionDay } from '@/lib/applications/fields'
import { listOwnApplications } from '@/lib/applications/student'
import { requestAgreement, voidAgreement } from '@/lib/agreements/generate'
import {
  loadTeamKickoff,
  noteHistory,
  recordKickoff,
  saveNoteToCompany,
  startWork,
} from '@/lib/kickoff/team'
import { loadCompanyKickoff, loadStudentKickoff } from '@/lib/kickoff/views'
import { storedToDay } from '@/lib/projects/fields'
import type { SessionUser } from '@/lib/team/approvals'
import { recipientsFor, reminderDue, sendDecisionReminders } from '@/lib/team/decisionReminder'
import { listMatchingQueue } from '@/lib/team/matching'
import { loadToday } from '@/lib/team/today'
import { addDays, addWorkingDays, isWorkingDay, osloDay } from '@/lib/workingDays'
import type { Match, User } from '@/payload-types'

import { makeAgreement, signedAgreement } from '../helpers/agreements'
import {
  asUser,
  createWorld,
  dayFromNow,
  graphql,
  login,
  resetDatabase,
  rest,
  selectStudent,
  sessionFor,
  SENTINEL,
  type World,
} from '../helpers/world'

/**
 * Kanban cards "Kick-off form and kick-off cards (student and company)", "Decision dates on
 * applications and projects" and "Latest note to the company on the project page", plus the brief
 * attachments after matching. Every rule is tried as each role: the team, the selected student,
 * the student who was not selected, the project's company, another company and anonymous, through
 * the Local API with access control on, REST and GraphQL.
 */

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User) => asUser(user) as unknown as SessionUser
const day = (n: number) => dayFromNow(n).slice(0, 10)
const form = (values: Record<string, string | number | string[]>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(values)) {
    for (const one of Array.isArray(v) ? v : [v]) f.append(k, String(one))
  }
  return f
}

let w: World
let cookies: Record<'admin' | 'alpha' | 'beta' | 'companyA' | 'companyB', string>
let match: Match

const kickoffForm = (extra: Record<string, string | number | string[]> = {}) =>
  form({
    id: w.projectOpen.id,
    scope: 'Kickoff-Scope-Sentinel: a guide of 6 pages',
    delivery: 'Kickoff-Delivery: one PDF in Konnected',
    start: day(1),
    due: day(15),
    checkIn: [day(5), day(10)],
    contact: w.admin.id,
    ...extra,
  })

/**
 * Company A's open project (with its brief attachment): alpha applies, then Konnected selects
 * beta. The project is matched; alpha is not selected.
 */
async function matchOpenProject() {
  await w.payload.create({
    collection: 'applications',
    data: { project: w.projectOpen.id, note: 'Alpha would like this too.' } as never,
    ...as(w.alpha.user),
  })
  const selected = await selectStudent(w.payload, w.admin, w.beta, w.projectOpen.id)
  return selected.match as Match
}

async function setup() {
  await resetDatabase()
  w = await createWorld()
  cookies = {
    admin: await sessionFor(w.admin.id),
    alpha: await login(w.alpha.user.email),
    beta: await login(w.beta.user.email),
    companyA: await login(w.companyA.user.email),
    companyB: await login(w.companyB.user.email),
  }
  match = await matchOpenProject()
}

const storedMatch = async () =>
  (await w.payload.findByID({
    collection: 'matches',
    id: match.id,
    depth: 0,
    overrideAccess: true,
  })) as Match

describe('kick-off: only the team records it, after selection, before the work starts', () => {
  beforeAll(setup)

  it('the student agreement cannot be made before the kick-off', async () => {
    const res = await requestAgreement(w.payload, w.admin, { kind: 'student', matchId: match.id })
    expect(res).toMatchObject({ ok: false, error: 'no_kickoff' })
  })

  it('nobody but the team can record a kick-off, through any API', async () => {
    const data = { kickoff: { scope: 'Not yours', contact: w.admin.id }, endDate: dayFromNow(3) }
    for (const user of [w.beta.user, w.alpha.user, w.companyA.user, w.companyB.user]) {
      expect((await recordKickoff(w.payload, session(user), kickoffForm())).status).toBe('error')
      await expect(
        w.payload.update({ collection: 'matches', id: match.id, data, ...as(user) }),
      ).rejects.toThrow()
    }
    for (const who of ['beta', 'alpha', 'companyA', 'companyB'] as const) {
      const res = await rest.patch(`matches/${match.id}`, data, cookies[who])
      expect(res.status, who).toBe(403)
      const gql = await graphql(
        `mutation { updateMatch(id: ${match.id}, data: { kickoff: { scope: "x" } }) { id } }`,
        cookies[who],
      )
      expect(gql.text, who).toMatch(/not allowed|Forbidden|errors/i)
    }
    expect((await rest.patch(`matches/${match.id}`, data)).status).toBe(403)
    expect((await storedMatch()).kickoff?.recordedAt ?? null).toBeNull()
  })

  it('the form refuses a missing scope, dates out of order, a check-in outside the work and a contact off the team', async () => {
    const team = session(w.admin)
    const cases: [Record<string, string | string[] | number>, string][] = [
      [{ scope: '' }, 'scope_required'],
      [{ delivery: '' }, 'delivery_required'],
      [{ due: day(0) }, 'due_before_start'],
      [{ checkIn: [day(20)] }, 'check_in_invalid'],
      [{ contact: '' }, 'contact_required'],
    ]
    for (const [extra, error] of cases) {
      expect(await recordKickoff(w.payload, team, kickoffForm(extra))).toMatchObject({ error })
    }
    // A student as the "Konnected contact" is refused by the hook too (for every API).
    expect(
      await recordKickoff(w.payload, team, kickoffForm({ contact: w.beta.user.id })),
    ).toMatchObject({ error: 'contact_required' })
    expect((await storedMatch()).kickoff?.recordedAt ?? null).toBeNull()
  })

  it('the team records it: the plan, the dates, the contact name, an activity row, no email', async () => {
    const mail = vi.spyOn(w.payload.email, 'sendEmail')
    try {
      expect(await recordKickoff(w.payload, session(w.admin), kickoffForm())).toMatchObject({
        status: 'done',
      })
      expect(mail).not.toHaveBeenCalled()
    } finally {
      mail.mockRestore()
    }
    const stored = await storedMatch()
    expect(stored.kickoff).toMatchObject({
      scope: 'Kickoff-Scope-Sentinel: a guide of 6 pages',
      delivery: 'Kickoff-Delivery: one PDF in Konnected',
      contact: w.admin.id,
    })
    expect(stored.kickoff?.contactName).toBeTruthy()
    expect(stored.kickoff?.recordedAt).toBeTruthy()
    expect(storedToDay(stored.startDate)).toBe(day(1))
    expect(storedToDay(stored.endDate)).toBe(day(15))
    expect(stored.kickoff?.checkIns?.map((c) => storedToDay(c.day))).toEqual([day(5), day(10)])
    expect(stored.dueDateHistory ?? []).toHaveLength(0)
    const log = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [{ targetCollection: { equals: 'matches' } }, { field: { equals: 'kickoff' } }],
      },
      overrideAccess: true,
    })
    expect(log.docs[0]).toMatchObject({ actor: expect.anything(), toStatus: 'recorded' })
    // Correcting it before the agreement is made is not a move of the due date either.
    expect(
      await recordKickoff(w.payload, session(w.admin), kickoffForm({ due: day(16) })),
    ).toMatchObject({ status: 'done' })
    expect((await storedMatch()).dueDateHistory ?? []).toHaveLength(0)
    // Today no longer lists a kick-off to record for this project.
    const today = await loadToday(w.payload, session(w.admin))
    expect(today!.items.some((i) => i.key === `kickoff-${match.id}`)).toBe(false)
  })

  it('the selected student and the company read it; nobody else does, at any depth', async () => {
    const student = await loadStudentKickoff(w.payload, asUser(w.beta.user), w.projectOpen.id)
    expect(student?.kickoff?.scope).toContain('Kickoff-Scope-Sentinel')
    expect(student?.agreement.stage).toBe('none')
    const company = await loadCompanyKickoff(w.payload, asUser(w.companyA.user), w.projectOpen.id)
    expect(company?.scope).toContain('Kickoff-Scope-Sentinel')
    expect(company?.contactName).toBeTruthy()

    // The company reads the plan but not the team's contact relation, nor the student.
    for (const depth of [0, 1, 3]) {
      const res = await rest.get(`matches/${match.id}?depth=${depth}`, cookies.companyA)
      expect(res.status).toBe(200)
      const kickoff = res.json.kickoff as Record<string, unknown>
      expect(kickoff.scope).toContain('Kickoff-Scope-Sentinel')
      expect(kickoff).not.toHaveProperty('contact')
      expect(res.json).not.toHaveProperty('student')
      expect(res.text).not.toContain(SENTINEL.beta.name)
      expect(res.text).not.toContain(w.admin.email)
    }
    const gql = await graphql(
      `{ Match(id: ${match.id}) { kickoff { scope contactName contact { id email } } } }`,
      cookies.companyA,
    )
    expect(gql.text).toContain('Kickoff-Scope-Sentinel')
    expect(gql.text).not.toContain(w.admin.email)

    // The student who was not selected, the other company and anonymous read nothing.
    for (const cookie of [cookies.alpha, cookies.companyB, undefined]) {
      expect([403, 404]).toContain((await rest.get(`matches/${match.id}`, cookie)).status)
      const list = await rest.get('matches?depth=2&limit=100', cookie)
      expect(list.text).not.toContain('Kickoff-Scope-Sentinel')
    }
    expect(await loadStudentKickoff(w.payload, asUser(w.alpha.user), w.projectOpen.id)).toBeNull()
    expect(
      await loadCompanyKickoff(w.payload, asUser(w.companyB.user), w.projectOpen.id),
    ).toBeNull()
  })

  it('the work cannot start before the student agreement is signed; the plan is locked once it is made', async () => {
    expect(
      await startWork(w.payload, session(w.admin), form({ id: w.projectOpen.id })),
    ).toMatchObject({ error: 'not_signed' })
    for (const user of [w.beta.user, w.companyA.user]) {
      expect(
        await startWork(w.payload, session(user), form({ id: w.projectOpen.id })),
      ).toMatchObject({ error: 'forbidden' })
    }

    const agreement = await makeAgreement(w.payload, w.admin, {
      kind: 'student',
      matchId: match.id,
    })
    expect(agreement.match).toBe(match.id)
    expect(
      await recordKickoff(w.payload, session(w.admin), kickoffForm({ scope: 'Changed' })),
    ).toMatchObject({ error: 'agreement_in_use' })
    const kick = await loadTeamKickoff(w.payload, session(w.admin), {
      id: w.projectOpen.id,
      startDay: null,
      ownerId: null,
    })
    expect(kick?.agreement.stage).toBe('awaiting_party')

    // Withdrawn: the plan may change again, and a new agreement is made from it.
    expect((await voidAgreement(w.payload, w.admin, agreement.id)).ok).toBe(true)
    expect(
      await recordKickoff(w.payload, session(w.admin), kickoffForm({ scope: 'Changed scope' })),
    ).toMatchObject({ status: 'done' })

    const signed = await signedAgreement(w.payload, w.admin, w.beta.user, {
      kind: 'student',
      matchId: match.id,
    })
    expect(signed.status).toBe('signed')
    expect(
      await startWork(w.payload, session(w.admin), form({ id: w.projectOpen.id })),
    ).toMatchObject({ status: 'done' })
    const project = await w.payload.findByID({
      collection: 'projects',
      id: w.projectOpen.id,
      overrideAccess: true,
    })
    expect(project.status).toBe('in_progress')
  })

  it('once the work runs, the kick-off is fixed for every API', async () => {
    expect(
      await recordKickoff(w.payload, session(w.admin), kickoffForm({ scope: 'Too late' })),
    ).toMatchObject({ error: 'not_open' })
    await expect(
      w.payload.update({
        collection: 'matches',
        id: match.id,
        data: { kickoff: { scope: 'Too late', contact: w.admin.id } },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/fixed/)
    expect(
      (await rest.patch(`matches/${match.id}`, { kickoff: { scope: 'Too late' } }, cookies.admin))
        .status,
    ).toBe(409)
    expect((await storedMatch()).kickoff?.scope).toBe('Changed scope')
  })
})

describe('brief attachments after matching: the selected student only', () => {
  beforeAll(setup)

  const opens = async (cookie: string | undefined) => {
    const doc = await rest.get(`brief-files/${w.briefOpen.id}?depth=0`, cookie)
    const file = await rest.get(`brief-files/file/${w.briefOpen.filename}`, cookie)
    return doc.status === 200 && file.status === 200
  }

  it('right after the selection (before the kick-off), the selected student opens them', async () => {
    expect(await opens(cookies.beta)).toBe(true)
    const local = await w.payload.findByID({
      collection: 'brief-files',
      id: w.briefOpen.id,
      ...as(w.beta.user),
    })
    expect(local.id).toBe(w.briefOpen.id)
    const card = await loadStudentKickoff(w.payload, asUser(w.beta.user), w.projectOpen.id)
    expect(card?.kickoff).toBeNull()
    expect(card?.files.map((f) => f.name)).toEqual(['brief-open.png'])
  })

  it('the student who was not selected, another company and anonymous never do', async () => {
    for (const cookie of [cookies.alpha, cookies.companyB, undefined]) {
      expect(await opens(cookie)).toBe(false)
    }
    await expect(
      w.payload.findByID({ collection: 'brief-files', id: w.briefOpen.id, ...as(w.alpha.user) }),
    ).rejects.toThrow()
    const gql = await graphql(`{ BriefFile(id: ${w.briefOpen.id}) { id } }`, cookies.alpha)
    expect(gql.text).not.toMatch(new RegExp(`"id":${w.briefOpen.id}`))
    // The owning company and the team still do.
    expect(await opens(cookies.companyA)).toBe(true)
    expect(await opens(cookies.admin)).toBe(true)
  })

  it('once Konnected ends the match, the former student no longer does', async () => {
    await w.payload.update({
      collection: 'projects',
      id: w.projectOpen.id,
      data: { status: 'published', deadline: dayFromNow(10) },
      ...as(w.admin),
    })
    expect(await opens(cookies.beta)).toBe(false)
    expect(await loadStudentKickoff(w.payload, asUser(w.beta.user), w.projectOpen.id)).toBeNull()
  })
})

describe('decision dates: 3 working days after applications close', () => {
  let mail: MockInstance

  beforeAll(async () => {
    await resetDatabase()
    w = await createWorld()
    cookies = {
      admin: await sessionFor(w.admin.id),
      alpha: await login(w.alpha.user.email),
      beta: await login(w.beta.user.email),
      companyA: await login(w.companyA.user.email),
      companyB: await login(w.companyB.user.email),
    }
    await w.payload.create({
      collection: 'applications',
      data: { project: w.projectOpen.id, note: 'Beta applies.' } as never,
      ...as(w.beta.user),
    })
  })

  it('the server sets decisionBy from the closing day, and follows a new closing day', async () => {
    const p = await w.payload.findByID({
      collection: 'projects',
      id: w.projectOpen.id,
      overrideAccess: true,
    })
    expect(storedToDay(p.decisionBy)).toBe(decisionDay(storedToDay(p.deadline)))
    const moved = await w.payload.update({
      collection: 'projects',
      id: w.projectOpen.id,
      data: { deadline: dayFromNow(9) },
      ...as(w.admin),
    })
    expect(storedToDay(moved.decisionBy)).toBe(addWorkingDays(day(9), 3))
  })

  it('no client sets it: not a company on its draft, not the team', async () => {
    await rest.patch(
      `projects/${w.projectB.id}`,
      { decisionBy: dayFromNow(1), deadline: dayFromNow(8) },
      cookies.companyB,
    )
    const draft = await w.payload.findByID({
      collection: 'projects',
      id: w.projectB.id,
      overrideAccess: true,
    })
    expect(storedToDay(draft.decisionBy)).toBe(addWorkingDays(day(8), 3))
    const team = await w.payload.update({
      collection: 'projects',
      id: w.projectOpen.id,
      data: { decisionBy: dayFromNow(1) },
      ...as(w.admin),
    })
    expect(storedToDay(team.decisionBy)).toBe(addWorkingDays(day(9), 3))
  })

  it('students see it on My applications; the team counts down to it on Matching', async () => {
    const mine = await listOwnApplications(w.payload, asUser(w.beta.user) as never)
    const own = mine!.find((a) => a.projectId === w.projectOpen.id)
    expect(own?.decideBy).toBe(addWorkingDays(day(9), 3))
    const queue = await listMatchingQueue(w.payload, session(w.admin))
    const item = queue!.find((q) => q.id === w.projectOpen.id)
    expect(item?.decideBy).toBe(addWorkingDays(day(9), 3))
    // Still open for applications: no countdown yet.
    expect(item?.due).toBeNull()
    // Nobody but the team reads the queue.
    for (const user of [w.beta.user, w.companyA.user]) {
      expect(await listMatchingQueue(w.payload, session(user))).toBeNull()
    }
  })

  it('the owner gets one reminder the working day before, with no student named', async () => {
    const decide = addWorkingDays(day(9), 3)
    let before = addDays(decide, -1)
    while (!isWorkingDay(before)) before = addDays(before, -1)
    expect(reminderDue(decide, before)).toBe(true)
    expect(reminderDue(decide, addDays(decide, 1))).toBe(false)
    const morning = new Date(`${before}T08:00:00Z`)

    mail = vi.spyOn(w.payload.email, 'sendEmail')
    try {
      // Outside the morning window: nothing.
      expect(await sendDecisionReminders(w.payload, new Date(`${before}T20:00:00Z`))).toBe(0)
      expect(await sendDecisionReminders(w.payload, morning)).toBe(1)
      const sent = mail.mock.calls.map((c) => c[0] as { to: string; subject: string; text: string })
      expect(sent).toHaveLength(1)
      expect(sent[0]!.to).toBe(w.admin.email)
      expect(sent[0]!.subject).toContain('Project A open')
      expect(sent[0]!.text).toContain('1 application is waiting')
      for (const secret of Object.values(SENTINEL.beta)) expect(sent[0]!.text).not.toContain(secret)
      // Once per decision day.
      expect(await sendDecisionReminders(w.payload, morning)).toBe(0)
    } finally {
      mail.mockRestore()
    }
    const p = await w.payload.findByID({
      collection: 'projects',
      id: w.projectOpen.id,
      overrideAccess: true,
    })
    expect(storedToDay(p.decisionReminderFor)).toBe(decide)
    // The day is the team's: a company never reads it.
    const own = await rest.get(`projects/${w.projectOpen.id}`, cookies.companyA)
    expect(own.json).not.toHaveProperty('decisionReminderFor')
    expect(storedToDay(own.json.decisionBy)).toBe(decide)
  })

  it('an owner who is away has it sent to the cover; a project nobody owns goes to the team', () => {
    const member = (
      id: number,
      away: { from: string; until: string; coverId: number | null } | null,
    ) => ({
      id,
      name: `M${id}`,
      email: `m${id}@konnected.test`,
      language: 'en' as const,
      away,
      rowId: null,
      morningEmailOn: null,
    })
    const today = osloDay(new Date())
    const team = [
      member(1, { from: today, until: today, coverId: 2 }),
      member(2, null),
      member(3, null),
    ]
    expect(recipientsFor(team, 1, today).map((m) => m.id)).toEqual([2])
    expect(recipientsFor(team, 2, today).map((m) => m.id)).toEqual([2])
    expect(recipientsFor(team, null, today).map((m) => m.id)).toEqual([2, 3])
  })
})

describe('latest note to the company: the team writes it, the company sees only the latest', () => {
  beforeAll(async () => {
    await resetDatabase()
    w = await createWorld()
    cookies = {
      admin: await sessionFor(w.admin.id),
      alpha: await login(w.alpha.user.email),
      beta: await login(w.beta.user.email),
      companyA: await login(w.companyA.user.email),
      companyB: await login(w.companyB.user.email),
    }
  })

  it('two notes: the project shows the latest, the history keeps both', async () => {
    const team = session(w.admin)
    expect(
      await saveNoteToCompany(w.payload, team, form({ id: w.projectA.id, note: 'Note-One' })),
    ).toMatchObject({ status: 'done' })
    expect(
      await saveNoteToCompany(w.payload, team, form({ id: w.projectA.id, note: 'Note-Two' })),
    ).toMatchObject({ status: 'done' })
    const history = await noteHistory(w.payload, team, w.projectA.id)
    expect(history.map((h) => h.note)).toEqual(['Note-Two', 'Note-One'])

    const own = await rest.get(`projects/${w.projectA.id}`, cookies.companyA)
    expect(own.json.noteToCompany).toBe('Note-Two')
    expect(own.json.noteToCompanyAt).toBeTruthy()
    // The history is the team's: the company reads no activity log.
    const logs = await rest.get('activity-logs?limit=100', cookies.companyA)
    expect(logs.text).not.toContain('Note-One')
    expect(await noteHistory(w.payload, session(w.companyA.user), w.projectA.id)).toEqual([])
  })

  it('nobody else writes or reads it', async () => {
    for (const user of [w.alpha.user, w.companyA.user, w.companyB.user]) {
      expect(
        await saveNoteToCompany(w.payload, session(user), form({ id: w.projectA.id, note: 'x' })),
      ).toMatchObject({ error: 'forbidden' })
    }
    // A company's own write to the field is dropped.
    await rest.patch(`projects/${w.projectA.id}`, { noteToCompany: 'Mine' }, cookies.companyA)
    // Students and another company never read it.
    for (const cookie of [cookies.alpha, cookies.beta, cookies.companyB]) {
      const list = await rest.get('projects?depth=2&limit=100', cookie)
      expect(list.text).not.toContain('Note-Two')
    }
    const stored = await w.payload.findByID({
      collection: 'projects',
      id: w.projectA.id,
      overrideAccess: true,
    })
    expect(stored.noteToCompany).toBe('Note-Two')
  })

  it('a note over 1,000 characters is refused, and a draft takes no note', async () => {
    expect(
      await saveNoteToCompany(
        w.payload,
        session(w.admin),
        form({ id: w.projectA.id, note: 'x'.repeat(1001) }),
      ),
    ).toMatchObject({ error: 'note_too_long' })
    expect(
      await saveNoteToCompany(w.payload, session(w.admin), form({ id: w.projectB.id, note: 'x' })),
    ).toMatchObject({ error: 'not_open' })
  })
})
