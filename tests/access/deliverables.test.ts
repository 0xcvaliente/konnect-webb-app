import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { acceptDueDeliverables } from '@/lib/deliverables/autoAccept'
import { deliveryState } from '@/lib/deliverables/fields'
import {
  companyDecision,
  loadCompanyWork,
  loadStudentWork,
  submitDeliverable,
} from '@/lib/deliverables/student'
import type { SessionUser } from '@/lib/students/profile'
import {
  listDeliverableQueue,
  loadTeamDeliverable,
  releaseDeliverable,
  returnDeliverable,
} from '@/lib/team/deliverables'
import type { Deliverable, User } from '@/payload-types'

import {
  asUser,
  createWorld,
  graphql,
  login,
  readyFields,
  resetDatabase,
  rest,
  selectStudent,
  SENTINEL,
  sessionFor,
  type World,
  workingMatch,
} from '../helpers/world'
import { signedAgreement } from '../helpers/agreements'
import { fileOf, makePdf } from '../helpers/files'

/**
 * Kanban card "Deliverable submission and handoff": the student hands in files and links with a
 * note; Konnected releases the work to the company or asks for more; the company sees only
 * released work and accepts it or asks for one round of fixes within 7 days (after that it counts
 * as accepted); a fix request opens the work again for the student. Every move is checked as each
 * role (admin, the matched student, another student, the company, another company, anonymous)
 * through the Local API with access control on, and the main ones through REST and GraphQL.
 */

let w: World
/** beta's match on a new project of company A, in progress: a clean start for each test. */
let work: Awaited<ReturnType<typeof workingMatch>>
let mail: MockInstance

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User) => asUser(user) as unknown as SessionUser

const UNRELEASED = 'Unreleased-Hand-In-Note-Beta'
const RETURN_NOTE = 'Team-Return-Note-For-Beta'
const FIX = 'Company-Fix-Note-For-Beta'

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
  work = await workingMatch(w.payload, w.admin, w.beta, w.companyA, 'Beta project')
  mail?.mockRestore()
  mail = vi.spyOn(w.payload.email, 'sendEmail')
})

const handIn = (user: User, extra: Partial<Deliverable> = {}) =>
  w.payload.create({
    collection: 'deliverables',
    data: {
      match: work.match.id,
      note: UNRELEASED,
      links: [{ label: 'Board', url: 'https://example.test/board' }],
      status: 'submitted',
      ...extra,
    } as Deliverable,
    ...as(user),
  })

const move = (id: number, data: Partial<Deliverable>, user: User) =>
  w.payload.update({ collection: 'deliverables', id, data, ...as(user) })

const read = (id: number) =>
  w.payload.findByID({ collection: 'deliverables', id, depth: 0, overrideAccess: true })

const mailsTo = (email: string) =>
  mail.mock.calls
    .map((c) => c[0] as { to: string; subject: string; text: string; html: string })
    .filter((m) => m.to === email)

const projectStatus = async () =>
  (await w.payload.findByID({ collection: 'projects', id: work.project.id, overrideAccess: true }))
    .status

describe('handing in', () => {
  it('the matched student hands in; the hand-in waits for Konnected', async () => {
    const d = await handIn(w.beta.user)
    expect(d.status).toBe('submitted')
    expect(d.submittedAt).toBeTruthy()
    expect(d.releasedAt ?? null).toBeNull()
  })

  it('nobody else hands in for the match: another student, a company, anonymous', async () => {
    await expect(handIn(w.alpha.user)).rejects.toThrow(/not yours/)
    await expect(handIn(w.companyA.user)).rejects.toThrow()
    await expect(handIn(w.companyB.user)).rejects.toThrow()
    const res = await rest.post('deliverables', {
      match: work.match.id,
      links: [{ url: 'https://example.test/x' }],
    })
    expect(res.status).toBe(403)
  })

  it('the student cannot choose a status or the server dates', async () => {
    await expect(handIn(w.beta.user, { status: 'released' })).rejects.toThrow(/must start/)
    const d = await handIn(w.beta.user, {
      releasedAt: new Date().toISOString(),
      acceptedBy: 'company',
      fixNote: 'x',
      returnNote: 'y',
    })
    expect(d).toMatchObject({ releasedAt: null, acceptedBy: null, fixNote: null, returnNote: null })
  })

  it('needs a file or a link, and links are web addresses', async () => {
    await expect(handIn(w.beta.user, { links: [] })).rejects.toThrow(/at least one/)
    await expect(handIn(w.beta.user, { links: [{ url: 'javascript:alert(1)' }] })).rejects.toThrow(
      /web address/,
    )
    const file = await w.payload.create({
      collection: 'deliverable-files',
      data: { match: work.match.id },
      file: fileOf(makePdf('report.pdf'), 'report.pdf', 'application/pdf'),
      ...as(w.beta.user),
    })
    const d = await handIn(w.beta.user, { links: [], files: [file.id] })
    expect(d.files).toHaveLength(1)
  })

  it('not before the work starts: a matched project waits for the student agreement', async () => {
    const p = await w.payload.create({
      collection: 'projects',
      data: {
        ...readyFields(),
        company: w.companyA.company.id,
        title: 'Not started',
        fee: 1000,
        status: 'draft',
      },
      overrideAccess: true,
    })
    for (const status of ['submitted', 'approved'] as const) {
      await w.payload.update({ collection: 'projects', id: p.id, data: { status }, ...as(w.admin) })
    }
    await signedAgreement(w.payload, w.admin, w.companyA.user, { kind: 'company', projectId: p.id })
    await w.payload.update({
      collection: 'projects',
      id: p.id,
      data: { status: 'published' },
      ...as(w.admin),
    })
    const { match } = await selectStudent(w.payload, w.admin, w.alpha, p.id)
    await expect(
      w.payload.create({
        collection: 'deliverables',
        data: { match: match.id, links: [{ url: 'https://example.test/a' }], status: 'submitted' },
        ...as(w.alpha.user),
      }),
    ).rejects.toThrow(/not started/)
  })

  it('one hand-in at a time: a second waits until Konnected answers the first', async () => {
    await handIn(w.beta.user)
    await expect(handIn(w.beta.user)).rejects.toThrow(/already waits/)
  })

  it('two hand-ins at the same moment: only one is made', async () => {
    const results = await Promise.allSettled([handIn(w.beta.user), handIn(w.beta.user)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rows = await w.payload.count({
      collection: 'deliverables',
      where: { match: { equals: work.match.id } },
      overrideAccess: true,
    })
    expect(rows.totalDocs).toBe(1)
  })

  it('the student cannot change a hand-in after sending it, through any API', async () => {
    const d = await handIn(w.beta.user)
    await expect(move(d.id, { note: 'changed' }, w.beta.user)).rejects.toThrow()
    const cookie = await login(w.beta.user.email)
    expect((await rest.patch(`deliverables/${d.id}`, { note: 'changed' }, cookie)).status).toBe(403)
    expect((await read(d.id)).note).toBe(UNRELEASED)
  })
})

describe('Konnected checks: release or ask for more', () => {
  it('only the team releases; the first release delivers the project and emails the company', async () => {
    const d = await handIn(w.beta.user)
    for (const user of [w.beta.user, w.alpha.user, w.companyA.user, w.companyB.user]) {
      await expect(move(d.id, { status: 'released' }, user)).rejects.toThrow()
    }
    expect((await read(d.id)).status).toBe('submitted')
    expect(await projectStatus()).toBe('in_progress')

    const released = await move(d.id, { status: 'released' }, w.admin)
    expect(released.status).toBe('released')
    expect(released.releasedAt).toBeTruthy()
    expect(await projectStatus()).toBe('delivered')

    const toCompany = mailsTo(w.companyA.user.email)
    expect(toCompany.map((m) => m.subject)).toEqual([expect.stringContaining('Beta project')])
    expect(toCompany[0]!.text).toContain('one round of fixes')
    // Nothing about the student in the company's email.
    for (const secret of Object.values(SENTINEL.beta)) {
      expect(`${toCompany[0]!.subject}${toCompany[0]!.text}${toCompany[0]!.html}`).not.toContain(
        secret,
      )
    }
    expect(toCompany[0]!.text).not.toContain(UNRELEASED)
  })

  it('asking for more needs a note; the student sees it, the company never does', async () => {
    const d = await handIn(w.beta.user)
    await expect(move(d.id, { status: 'returned' }, w.admin)).rejects.toThrow(/Say what/)
    await expect(
      move(d.id, { status: 'returned', returnNote: RETURN_NOTE }, w.companyA.user),
    ).rejects.toThrow()
    const back = await move(d.id, { status: 'returned', returnNote: RETURN_NOTE }, w.admin)
    expect(back).toMatchObject({ status: 'returned', returnNote: RETURN_NOTE })

    const own = await w.payload.findByID({
      collection: 'deliverables',
      id: d.id,
      ...as(w.beta.user),
    })
    expect(own.returnNote).toBe(RETURN_NOTE)
    const company = await w.payload.find({ collection: 'deliverables', ...as(w.companyA.user) })
    expect(JSON.stringify(company)).not.toContain(RETURN_NOTE)
    expect(company.docs.map((x) => x.id)).not.toContain(d.id)

    expect(mailsTo(w.beta.user.email).map((m) => m.subject)).toEqual([
      expect.stringContaining('asked for more'),
    ])
    expect(mailsTo(w.beta.user.email)[0]!.text).not.toContain(RETURN_NOTE)
    expect(mailsTo(w.companyA.user.email)).toHaveLength(0)
    // The student may hand in again.
    expect((await handIn(w.beta.user)).status).toBe('submitted')
    expect(await projectStatus()).toBe('in_progress')
  })

  it('no other moves: returned and accepted are final, submitted cannot be accepted', async () => {
    const d = await handIn(w.beta.user)
    await expect(move(d.id, { status: 'accepted' }, w.admin)).rejects.toThrow(/not a valid/)
    await move(d.id, { status: 'returned', returnNote: RETURN_NOTE }, w.admin)
    await expect(move(d.id, { status: 'released' }, w.admin)).rejects.toThrow(/not a valid/)
    const d2 = await handIn(w.beta.user)
    await move(d2.id, { status: 'released' }, w.admin)
    await move(d2.id, { status: 'accepted' }, w.companyA.user)
    for (const status of ['released', 'submitted', 'fix_requested'] as const) {
      await expect(move(d2.id, { status, fixNote: 'x' }, w.admin)).rejects.toThrow()
    }
  })

  it('once released, with no fix asked, there is nothing more to hand in', async () => {
    const d = await handIn(w.beta.user)
    await move(d.id, { status: 'released' }, w.admin)
    await expect(handIn(w.beta.user)).rejects.toThrow(/nothing more/)
  })
})

describe('the company: released work only, accept or one round of fixes', () => {
  it('never sees a hand-in before release, by any API, at any depth', async () => {
    const file = await w.payload.create({
      collection: 'deliverable-files',
      data: { match: work.match.id },
      file: fileOf(makePdf('beta-secret.pdf'), 'beta-secret.pdf', 'application/pdf'),
      ...as(w.beta.user),
    })
    const d = await handIn(w.beta.user, { files: [file.id] })
    const cookie = await login(w.companyA.user.email)
    const sweeps = [
      JSON.stringify(
        await w.payload.find({ collection: 'deliverables', depth: 5, ...as(w.companyA.user) }),
      ),
      JSON.stringify(
        await w.payload.find({ collection: 'deliverable-files', depth: 5, ...as(w.companyA.user) }),
      ),
      (await rest.get('deliverables?depth=5&limit=100', cookie)).text,
      (await rest.get(`deliverables/${d.id}?depth=5`, cookie)).text,
      (await rest.get('deliverable-files?depth=5&limit=100', cookie)).text,
      (await rest.get(`deliverable-files/file/${file.filename}`, cookie)).text,
      (
        await graphql(
          '{ Deliverables(limit: 100) { docs { id note status returnNote fixNote files { originalName } } } }',
          cookie,
        )
      ).text,
      (await graphql(`{ Deliverable(id: ${d.id}) { id note } }`, cookie)).text,
    ]
    for (const text of sweeps) {
      expect(text).not.toContain(UNRELEASED)
      expect(text).not.toContain('beta-secret.pdf')
    }
    // Positive control: after release the same sweeps find it.
    await move(d.id, { status: 'released' }, w.admin)
    expect((await rest.get(`deliverables/${d.id}?depth=1`, cookie)).text).toContain(UNRELEASED)
    expect((await rest.get(`deliverable-files/file/${file.filename}`, cookie)).status).toBe(200)
    // Anonymous never.
    expect((await rest.get(`deliverables/${d.id}`)).status).toBe(403)
  })

  it('accepts: the student and the company get an email; nobody else can accept', async () => {
    const d = await handIn(w.beta.user)
    await move(d.id, { status: 'released' }, w.admin)
    mail.mockClear()
    for (const user of [w.beta.user, w.alpha.user, w.companyB.user]) {
      await expect(move(d.id, { status: 'accepted' }, user)).rejects.toThrow()
    }
    const done = await move(d.id, { status: 'accepted', note: 'company edit' }, w.companyA.user)
    expect(done).toMatchObject({ status: 'accepted', acceptedBy: 'company', note: UNRELEASED })
    expect(done.acceptedAt).toBeTruthy()
    expect(mailsTo(w.beta.user.email).map((m) => m.subject)).toEqual([
      expect.stringContaining('accepted'),
    ])
    expect(mailsTo(w.companyA.user.email).map((m) => m.subject)).toEqual([
      expect.stringContaining('accepted'),
    ])
  })

  it('the team may accept for the company', async () => {
    const d = await handIn(w.beta.user)
    await move(d.id, { status: 'released' }, w.admin)
    expect(await move(d.id, { status: 'accepted' }, w.admin)).toMatchObject({
      status: 'accepted',
      acceptedBy: 'team',
    })
  })

  it('one round of fixes: the note reaches the student, the fixed work goes through Konnected again', async () => {
    const d = await handIn(w.beta.user)
    await move(d.id, { status: 'released' }, w.admin)
    mail.mockClear()
    await expect(move(d.id, { status: 'fix_requested' }, w.companyA.user)).rejects.toThrow(
      /Say what/,
    )
    await expect(
      move(d.id, { status: 'fix_requested', fixNote: FIX }, w.companyB.user),
    ).rejects.toThrow()
    await expect(
      move(d.id, { status: 'fix_requested', fixNote: FIX }, w.beta.user),
    ).rejects.toThrow()
    const fixed = await move(d.id, { status: 'fix_requested', fixNote: FIX }, w.companyA.user)
    expect(fixed).toMatchObject({ status: 'fix_requested', fixNote: FIX })
    expect(fixed.fixRequestedAt).toBeTruthy()
    // The student reads the company's note and is emailed (without the note).
    const own = await w.payload.findByID({
      collection: 'deliverables',
      id: d.id,
      ...as(w.beta.user),
    })
    expect(own.fixNote).toBe(FIX)
    const toStudent = mailsTo(w.beta.user.email)
    expect(toStudent.map((m) => m.subject)).toEqual([expect.stringContaining('fix')])
    expect(toStudent[0]!.text).not.toContain(FIX)

    // The student hands in the fix; the company does not see it until Konnected releases it.
    const second = await handIn(w.beta.user, { note: 'Fixed version' })
    const before = await w.payload.find({
      collection: 'deliverables',
      where: { match: { equals: work.match.id } },
      ...as(w.companyA.user),
    })
    expect(before.docs.map((x) => x.id)).toEqual([d.id])
    await move(second.id, { status: 'released' }, w.admin)

    // No second round.
    await expect(
      move(second.id, { status: 'fix_requested', fixNote: 'again' }, w.companyA.user),
    ).rejects.toThrow(/already used/)
    expect((await move(second.id, { status: 'accepted' }, w.companyA.user)).status).toBe('accepted')
    // And nothing more to hand in.
    await expect(handIn(w.beta.user)).rejects.toThrow(/nothing more/)
  })

  it('after 7 days no fix can be asked; the job records the work as accepted and emails both', async () => {
    const old = await handIn(w.beta.user)
    await move(old.id, { status: 'released' }, w.admin)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    await w.payload.db.updateOne({
      collection: 'deliverables',
      where: { id: { equals: old.id } },
      data: { releasedAt: eightDaysAgo },
      returning: false,
    })
    await expect(
      move(old.id, { status: 'fix_requested', fixNote: FIX }, w.companyA.user),
    ).rejects.toThrow(/7 days/)

    // A second match, released today, is not due.
    const fresh = await workingMatch(w.payload, w.admin, w.alpha, w.companyB, 'Fresh project')
    const recent = await w.payload.create({
      collection: 'deliverables',
      data: {
        match: fresh.match.id,
        links: [{ url: 'https://example.test/f' }],
        status: 'submitted',
      },
      ...as(w.alpha.user),
    })
    await move(recent.id, { status: 'released' }, w.admin)
    mail.mockClear()

    // The rule needs the job's own context: a plain update without a user is refused.
    await expect(
      w.payload.update({ collection: 'deliverables', id: old.id, data: { status: 'accepted' } }),
    ).rejects.toThrow()
    expect(await acceptDueDeliverables(w.payload)).toBe(1)
    expect(await read(old.id)).toMatchObject({ status: 'accepted', acceptedBy: 'auto' })
    expect((await read(recent.id)).status).toBe('released')
    expect(mailsTo(w.beta.user.email)).toHaveLength(1)
    expect(mailsTo(w.companyA.user.email)).toHaveLength(1)
    // Running it again does nothing.
    expect(await acceptDueDeliverables(w.payload)).toBe(0)
  })

  it('the job is scheduled hourly on the maintenance queue', async () => {
    const task = w.payload.config.jobs.tasks?.find((t) => t.slug === 'acceptDueDeliverables')
    expect(task?.schedule?.[0]).toMatchObject({ cron: '20 * * * *', queue: 'maintenance' })
  })
})

describe('the activity log records every hand-in and every decision, with who made it', () => {
  it('create, released, fix requested, accepted', async () => {
    const d = await handIn(w.beta.user)
    await move(d.id, { status: 'released' }, w.admin)
    await move(d.id, { status: 'fix_requested', fixNote: FIX }, w.companyA.user)
    const logs = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [
          { targetCollection: { equals: 'deliverables' } },
          { targetId: { equals: String(d.id) } },
        ],
      },
      sort: 'createdAt',
      depth: 0,
      ...as(w.admin),
    })
    expect(logs.docs.map((l) => [l.action, l.toStatus ?? null, l.actor])).toEqual([
      ['create', 'submitted', w.beta.user.id],
      ['status_change', 'released', w.admin.id],
      ['status_change', 'fix_requested', w.companyA.user.id],
    ])
  })

  it('the team’s note when it asks for more is kept on the log row', async () => {
    const d = await handIn(w.beta.user)
    const form = new FormData()
    form.set('id', String(d.id))
    form.set('returnNote', RETURN_NOTE)
    expect((await returnDeliverable(w.payload, session(w.admin), form)).status).toBe('done')
    const logs = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [
          { targetCollection: { equals: 'deliverables' } },
          { toStatus: { equals: 'returned' } },
        ],
      },
      depth: 0,
      ...as(w.admin),
    })
    expect(logs.docs[0]).toMatchObject({ note: RETURN_NOTE, actor: w.admin.id })
  })
})

describe('the pages’ functions, as each role', () => {
  it('the student sends through submitDeliverable; nobody else can', async () => {
    const form = new FormData()
    form.set('matchId', String(work.match.id))
    form.append('linkLabel', 'Board')
    form.append('linkUrl', 'https://example.test/board')
    form.set('note', 'Here it is')
    for (const user of [w.companyA.user, w.admin]) {
      expect(await submitDeliverable(w.payload, session(user), form)).toMatchObject({
        status: 'error',
        error: 'forbidden',
      })
    }
    expect(await submitDeliverable(w.payload, session(w.alpha.user), form)).toMatchObject({
      error: 'forbidden',
    })
    expect(await submitDeliverable(w.payload, null, form)).toMatchObject({ error: 'forbidden' })
    expect((await submitDeliverable(w.payload, session(w.beta.user), form)).status).toBe('done')
    expect(await submitDeliverable(w.payload, session(w.beta.user), form)).toMatchObject({
      error: 'waiting',
    })
    const bad = new FormData()
    bad.set('matchId', String(work.match.id))
    bad.append('linkUrl', 'ftp://example.test')
    expect(await submitDeliverable(w.payload, session(w.beta.user), bad)).toMatchObject({
      error: 'bad_link',
    })
  })

  it('the student’s view of the work, and nobody else gets it', async () => {
    const d = await handIn(w.beta.user)
    const own = await loadStudentWork(w.payload, session(w.beta.user), work.project.id)
    expect(own?.state).toMatchObject({ canSubmit: false, blocked: 'waiting' })
    expect(own?.handIns.map((h) => h.id)).toEqual([d.id])
    expect(await loadStudentWork(w.payload, session(w.alpha.user), work.project.id)).toBeNull()
    expect(await loadStudentWork(w.payload, session(w.companyA.user), work.project.id)).toBeNull()
  })

  it('the company’s view holds released work only, and only for its own project', async () => {
    const first = await handIn(w.beta.user)
    expect(
      (await loadCompanyWork(w.payload, session(w.companyA.user), work.project.id, 'in_progress'))
        ?.handIns,
    ).toEqual([])
    await move(first.id, { status: 'released' }, w.admin)
    const view = await loadCompanyWork(
      w.payload,
      session(w.companyA.user),
      work.project.id,
      'delivered',
    )
    expect(view?.handIns.map((h) => h.id)).toEqual([first.id])
    expect(view?.state).toMatchObject({ canAccept: true, canAskFix: true })
    expect(view?.handIns[0]?.returnNote ?? null).toBeNull()
    expect(
      (await loadCompanyWork(w.payload, session(w.companyB.user), work.project.id, 'delivered'))
        ?.handIns,
    ).toEqual([])
    expect(
      await loadCompanyWork(w.payload, session(w.beta.user), work.project.id, 'delivered'),
    ).toBeNull()
  })

  it('companyDecision: the owning company only', async () => {
    const d = await handIn(w.beta.user)
    await move(d.id, { status: 'released' }, w.admin)
    const form = new FormData()
    form.set('id', String(d.id))
    expect(
      await companyDecision(w.payload, session(w.companyB.user), form, 'accept'),
    ).toMatchObject({ error: 'not_found' })
    expect(await companyDecision(w.payload, session(w.beta.user), form, 'accept')).toMatchObject({
      error: 'forbidden',
    })
    expect(await companyDecision(w.payload, session(w.companyA.user), form, 'fix')).toMatchObject({
      error: 'note_required',
    })
    form.set('fixNote', FIX)
    expect((await companyDecision(w.payload, session(w.companyA.user), form, 'fix')).status).toBe(
      'done',
    )
  })

  it('the team’s queue and decisions: the team only', async () => {
    const d = await handIn(w.beta.user)
    const queue = await listDeliverableQueue(w.payload, session(w.admin))
    expect(queue?.find((i) => i.id === d.id)).toMatchObject({
      section: 'check',
      title: 'Beta project',
      studentName: SENTINEL.beta.name,
    })
    for (const user of [w.beta.user, w.companyA.user]) {
      expect(await listDeliverableQueue(w.payload, session(user))).toBeNull()
      expect(await loadTeamDeliverable(w.payload, session(user), d.id)).toBeNull()
    }
    const form = new FormData()
    form.set('id', String(d.id))
    for (const user of [w.beta.user, w.companyA.user]) {
      expect(await releaseDeliverable(w.payload, session(user), form)).toMatchObject({
        error: 'forbidden',
      })
    }
    expect((await releaseDeliverable(w.payload, session(w.admin), form)).status).toBe('done')
    const after = await listDeliverableQueue(w.payload, session(w.admin))
    expect(after?.find((i) => i.id === d.id)).toMatchObject({ section: 'company' })
    const detail = await loadTeamDeliverable(w.payload, session(w.admin), d.id)
    expect(detail?.state.canAskFix).toBe(true)
  })
})

describe('deliveryState (the rules, without a database)', () => {
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()
  it('the 7 days count in whole Oslo days after the release', () => {
    const released = { id: 1, status: 'released' as const, createdAt: at(10), releasedAt: at(7) }
    expect(deliveryState([released], 'delivered').canAskFix).toBe(true)
    const late = { ...released, releasedAt: at(8.5) }
    expect(deliveryState([late], 'delivered')).toMatchObject({ canAskFix: false, accepted: true })
  })
  it('a fix round opens the work again, once', () => {
    const items = [
      {
        id: 1,
        status: 'fix_requested' as const,
        createdAt: at(5),
        releasedAt: at(4),
        fixRequestedAt: at(3),
      },
    ]
    expect(deliveryState(items, 'delivered')).toMatchObject({ canSubmit: true, fixOpen: true })
    const fixed = [
      ...items,
      { id: 2, status: 'released' as const, createdAt: at(2), releasedAt: at(1) },
    ]
    expect(deliveryState(fixed, 'delivered')).toMatchObject({
      canSubmit: false,
      canAskFix: false,
      canAccept: true,
    })
  })
})

describe('a company never reads the student through a hand-in', () => {
  it('a released hand-in shows no student relation at any depth', async () => {
    const d = await handIn(w.beta.user)
    await move(d.id, { status: 'released' }, w.admin)
    const cookie = await sessionFor(w.companyA.user.id)
    for (const depth of [0, 1, 2, 5]) {
      const res = await rest.get(`deliverables/${d.id}?depth=${depth}`, cookie)
      expect(res.status).toBe(200)
      for (const secret of [
        SENTINEL.beta.name,
        SENTINEL.beta.contactEmail,
        SENTINEL.beta.userEmail,
        SENTINEL.beta.phone,
      ]) {
        expect(res.text, `depth ${depth}`).not.toContain(secret)
      }
    }
  })
})
