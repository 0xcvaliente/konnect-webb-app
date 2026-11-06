import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { relationId } from '@/access/roles'
import { projectSubmittedEmail } from '@/lib/email/templates'
import { type ProjectInput, todayInOslo } from '@/lib/projects/fields'
import {
  findOwnProject,
  listOwnProjects,
  projectHistory,
  saveProjectDraft,
  sendProjectForReview,
  type SessionUser,
} from '@/lib/projects/project'
import en from '@/messages/en.json'
import no from '@/messages/no.json'
import type { Project, User } from '@/payload-types'

import { fileOf, makePdf, makePng } from '../helpers/files'
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
 * Kanban card "Project submission form (company)": drafts, sending for review, who reads what,
 * the price and Konnected's note, attachments, the confirmation email, and the form's server
 * functions. Every rule is checked as each role that matters (admin, student, company,
 * anonymous). Local API calls pass `overrideAccess: false` and a user; REST and GraphQL go through
 * the real route handlers with a real session cookie.
 */

let w: World

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
})

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User): SessionUser => asUser(user) as SessionUser

const day = (offset: number) => {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

/** A complete form, as the browser sends it. */
const readyInput = (overrides: Partial<ProjectInput> = {}): ProjectInput => ({
  title: 'Onboarding email sequence',
  description: 'A welcome sequence for new subscribers.',
  tasks: 'Write five emails\nSuggest subject lines',
  desiredSkills: 'Copywriting, Email marketing',
  workloadHours: '20',
  durationWeeks: '2',
  startDate: day(14),
  workMode: 'remote',
  location: '',
  deadline: day(7),
  deliverable: 'Five emails in a shared document.',
  paidOrUnpaid: 'paid',
  unpaidBenefit: '',
  attachments: [],
  ...overrides,
})

/** A company user who registered a company Konnected has not approved yet. */
async function pendingCompany(email = 'pending@company.test') {
  const user = (await w.payload.create({
    collection: 'users',
    data: { email, password: PASSWORD, role: 'company', _verified: true } as never,
    overrideAccess: true,
    disableVerificationEmail: true,
  })) as User
  const company = await w.payload.create({
    collection: 'companies',
    data: { ...companyDetails('Pending AS'), status: 'pending' },
    ...as(user),
  })
  const fresh = (await w.payload.findByID({
    collection: 'users',
    id: user.id,
    depth: 0,
  })) as User
  return { user: fresh, company }
}

const approve = (companyId: number) =>
  w.payload.update({
    collection: 'companies',
    id: companyId,
    data: { status: 'approved' },
    ...as(w.admin),
  })

/** A draft of company A with everything filled in, made as company A. */
const draftOfA = (data: Partial<Project> = {}) =>
  w.payload.create({
    collection: 'projects',
    data: { ...readyFields(), title: 'Draft of A', ...data } as never,
    ...as(w.companyA.user),
  })

const move = (id: number, status: Project['status'], user: User) =>
  w.payload.update({ collection: 'projects', id, data: { status }, ...as(user) })

const stored = (id: number) => w.payload.findByID({ collection: 'projects', id, depth: 0 })

// ---------------------------------------------------------------------------------------------
describe('who reads a project before Konnected publishes it', () => {
  it('only the owning company and admins read a draft, through every way in', async () => {
    const id = w.projectB.id // company B's draft
    const cookies = {
      companyA: await login(w.companyA.user.email),
      companyB: await login(w.companyB.user.email),
      alpha: await login(w.alpha.user.email),
      admin: await sessionFor(w.admin.id),
    }
    const local = async (user: User) =>
      (
        await w.payload.find({
          collection: 'projects',
          where: { id: { equals: id } },
          ...as(user),
        })
      ).totalDocs
    expect(await local(w.companyB.user)).toBe(1)
    expect(await local(w.admin)).toBe(1)
    expect(await local(w.companyA.user)).toBe(0)
    expect(await local(w.alpha.user)).toBe(0)
    expect(await local(w.beta.user)).toBe(0)

    expect((await rest.get(`projects/${id}`, cookies.companyB)).status).toBe(200)
    expect((await rest.get(`projects/${id}`, cookies.admin)).status).toBe(200)
    for (const cookie of [cookies.companyA, cookies.alpha, undefined]) {
      const res = await rest.get(`projects/${id}`, cookie)
      expect([403, 404]).toContain(res.status)
      expect(res.text).not.toContain('Project B draft')
    }

    const query = `{ Projects(limit: 100) { docs { id title status } } }`
    expect((await graphql(query, cookies.companyB)).text).toContain('Project B draft')
    expect((await graphql(query, cookies.admin)).text).toContain('Project B draft')
    for (const cookie of [cookies.companyA, cookies.alpha, undefined]) {
      expect((await graphql(query, cookie)).text).not.toContain('Project B draft')
    }

    // The company's own list holds its own projects only.
    const own = await listOwnProjects(w.payload, session(w.companyB.user))
    expect(own.map((p) => p.id)).toEqual([id])
    expect(await findOwnProject(w.payload, session(w.companyA.user), id)).toBeNull()
    expect(await findOwnProject(w.payload, session(w.alpha.user), id)).toBeNull()
  })

  it('students and anonymous visitors never see an unpublished project, in any status', async () => {
    const titles: Record<string, Project['status'][]> = {
      'S draft': [],
      'S submitted': ['submitted'],
      'S changes': ['submitted', 'changes_requested'],
      'S rejected': ['submitted', 'rejected'],
      'S approved': ['submitted', 'approved'],
      'S published': ['submitted', 'approved', 'published'],
    }
    for (const [title, path] of Object.entries(titles)) {
      const p = await draftOfA({ title })
      for (const status of path) {
        await move(p.id, status, status === 'submitted' ? w.companyA.user : w.admin)
      }
    }
    const seen = async (user?: User) => {
      if (!user) {
        const res = await rest.get('projects?limit=100')
        return res.status === 200 ? ((res.json.docs as Project[]) ?? []).map((p) => p.title) : []
      }
      const res = await w.payload.find({ collection: 'projects', limit: 100, ...as(user) })
      return res.docs.map((p) => p.title)
    }
    for (const student of [w.alpha.user, w.beta.user]) {
      const titlesSeen = await seen(student)
      expect(titlesSeen).toContain('S published')
      for (const hidden of ['S draft', 'S submitted', 'S changes', 'S rejected', 'S approved'])
        expect(titlesSeen).not.toContain(hidden)
    }
    expect(await seen()).toEqual([])

    const cookie = await login(w.alpha.user.email)
    const rows = await rest.get('projects?limit=100&depth=2', cookie)
    for (const doc of rows.json.docs as Project[]) expect(doc.status).toBe('published')
    const gql = await graphql('{ Projects(limit: 100) { docs { title status } } }', cookie)
    expect(gql.text).toContain('S published')
    expect(gql.text).not.toMatch(/"(draft|submitted|changes_requested|rejected|approved)"/)
  })
})

// ---------------------------------------------------------------------------------------------
describe('sending a project for review', () => {
  it('a pending company keeps drafts; only an approved company sends (REST, Local API)', async () => {
    const { user, company } = await pendingCompany()
    const cookie = await login(user.email)
    const created = await rest.post('projects', { ...readyFields(), title: 'Mine' }, cookie)
    expect(created.status).toBe(201)
    const id = (created.json.doc as Project).id
    expect(relationId((await stored(id)).company)).toBe(company.id)

    expect((await rest.patch(`projects/${id}`, { status: 'submitted' }, cookie)).status).toBe(403)
    await expect(move(id, 'submitted', user)).rejects.toThrow(/approved/)
    expect((await stored(id)).status).toBe('draft')

    await approve(company.id)
    expect((await rest.patch(`projects/${id}`, { status: 'submitted' }, cookie)).status).toBe(200)
    expect((await stored(id)).status).toBe('submitted')
  })

  it('a company sends only a complete project, and the answer names what is missing', async () => {
    const p = await w.payload.create({
      collection: 'projects',
      data: { title: 'Only a title' } as never,
      ...as(w.companyA.user),
    })
    expect(p.status).toBe('draft')
    const error = await move(p.id, 'submitted', w.companyA.user).catch((e: unknown) => e)
    const paths = (error as { data?: { errors?: { path: string }[] } }).data?.errors?.map(
      (e) => e.path,
    )
    expect(paths).toEqual(
      expect.arrayContaining([
        'description',
        'deliverable',
        'desiredSkills',
        'workloadHours',
        'durationWeeks',
        'workMode',
        'paidOrUnpaid',
        'deadline',
        'startDate',
      ]),
    )
    const cookie = await login(w.companyA.user.email)
    expect((await rest.patch(`projects/${p.id}`, { status: 'submitted' }, cookie)).status).toBe(400)
    expect((await stored(p.id)).status).toBe('draft')

    // Not remote: the place is needed. Unpaid: what the student gets is needed.
    await w.payload.update({
      collection: 'projects',
      id: p.id,
      data: { ...readyFields(), workMode: 'on_site', paidOrUnpaid: 'unpaid' },
      ...as(w.companyA.user),
    })
    const second = await move(p.id, 'submitted', w.companyA.user).catch((e: unknown) => e)
    expect(
      (second as { data: { errors: { path: string }[] } }).data.errors.map((e) => e.path).sort(),
    ).toEqual(['location', 'unpaidBenefit'])
    await w.payload.update({
      collection: 'projects',
      id: p.id,
      data: { location: 'Bergen', unpaidBenefit: 'A reference' },
      ...as(w.companyA.user),
    })
    expect((await move(p.id, 'submitted', w.companyA.user)).status).toBe('submitted')
  })

  it('applications close today or later, and the work starts after they close', async () => {
    const past = await draftOfA({ deadline: `${day(-1)}T12:00:00.000Z` })
    const e1 = await move(past.id, 'submitted', w.companyA.user).catch((e: unknown) => e)
    expect((e1 as { data: { errors: { path: string; message: string }[] } }).data.errors).toEqual([
      { path: 'deadline', message: 'past' },
    ])
    const early = await draftOfA({ startDate: `${day(3)}T12:00:00.000Z` })
    const e2 = await move(early.id, 'submitted', w.companyA.user).catch((e: unknown) => e)
    expect((e2 as { data: { errors: { path: string; message: string }[] } }).data.errors).toEqual([
      { path: 'startDate', message: 'before_deadline' },
    ])
  })

  it('the company edits only while draft or changes requested; only Konnected moves it on', async () => {
    const p = await draftOfA()
    await move(p.id, 'submitted', w.companyA.user)
    await expect(
      w.payload.update({
        collection: 'projects',
        id: p.id,
        data: { title: 'changed in review' },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()
    const cookie = await login(w.companyA.user.email)
    expect((await rest.patch(`projects/${p.id}`, { title: 'x' }, cookie)).status).toBe(403)

    // Only Konnected decides; nobody else can make the review moves.
    for (const status of ['approved', 'rejected', 'changes_requested', 'published'] as const) {
      await expect(move(p.id, status, w.companyA.user)).rejects.toThrow()
      await expect(move(p.id, status, w.alpha.user)).rejects.toThrow()
      expect((await rest.patch(`projects/${p.id}`, { status })).status).toBe(403)
    }
    expect((await stored(p.id)).status).toBe('submitted')

    // Konnected asks for changes: the company can edit and send again.
    await move(p.id, 'changes_requested', w.admin)
    const edited = await w.payload.update({
      collection: 'projects',
      id: p.id,
      data: { title: 'Better title' },
      ...as(w.companyA.user),
    })
    expect(edited.title).toBe('Better title')
    await move(p.id, 'submitted', w.companyA.user)
    // A company cannot pull a project back to draft.
    await expect(move(p.id, 'draft', w.companyA.user)).rejects.toThrow()

    // Every create and status change is in the activity log, with who made it.
    const log = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [{ targetCollection: { equals: 'projects' } }, { targetId: { equals: String(p.id) } }],
      },
      sort: 'createdAt',
      depth: 0,
    })
    expect(log.docs.map((r) => [r.action, r.toStatus, relationId(r.actor)])).toEqual([
      ['create', 'draft', w.companyA.user.id],
      ['status_change', 'submitted', w.companyA.user.id],
      ['status_change', 'changes_requested', w.admin.id],
      ['status_change', 'submitted', w.companyA.user.id],
    ])
    // The company's timeline gets the statuses and times only.
    const history = await projectHistory(w.payload, p.id)
    expect(history.map((h) => h.status)).toEqual([
      'draft',
      'submitted',
      'changes_requested',
      'submitted',
    ])
    expect(Object.keys(history[0]!).sort()).toEqual(['at', 'created', 'status'])
  })

  it('a student or a visitor cannot create or change a project', async () => {
    await expect(
      w.payload.create({
        collection: 'projects',
        data: { ...readyFields(), title: 'by a student', company: w.companyA.company.id } as never,
        ...as(w.alpha.user),
      }),
    ).rejects.toThrow()
    expect(
      (await rest.post('projects', { title: 'anon', company: w.companyA.company.id })).status,
    ).toBe(403)
    const cookie = await login(w.alpha.user.email)
    expect((await rest.patch(`projects/${w.projectOpen.id}`, { title: 'x' }, cookie)).status).toBe(
      403,
    )
  })
})

// ---------------------------------------------------------------------------------------------
describe('the confirmation email', () => {
  let send: MockInstance
  beforeEach(() => {
    send = vi.spyOn(w.payload.email, 'sendEmail')
  })

  it('goes to the company in its language, with a link to the project, each time it is sent', async () => {
    await w.payload.update({
      collection: 'users',
      id: w.companyA.user.id,
      data: { language: 'no' },
      overrideAccess: true,
    })
    const p = await draftOfA({ title: 'Sentinel-Free Title' })
    send.mockClear()
    await move(p.id, 'submitted', w.companyA.user)
    expect(send).toHaveBeenCalledTimes(1)
    const message = send.mock.calls[0]![0] as {
      to: string
      subject: string
      html: string
      text: string
    }
    expect(message.to).toBe(w.companyA.user.email)
    expect(message.subject).toBe(no.Email.projectSubmitted.subject)
    expect(message.text).toContain(`http://localhost:3000/no/company/projects/${p.id}`)
    expect(message.text).toContain('Sentinel-Free Title')
    const all = JSON.stringify(message)
    for (const value of [...Object.values(SENTINEL.alpha), ...Object.values(SENTINEL.beta)])
      expect(all).not.toContain(value)

    // Changes asked, sent again: a second confirmation. Konnected's own moves send nothing here.
    send.mockClear()
    await move(p.id, 'changes_requested', w.admin)
    expect(send).not.toHaveBeenCalled()
    await move(p.id, 'submitted', w.companyA.user)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a draft save sends nothing', async () => {
    send.mockClear()
    const p = await draftOfA()
    await w.payload.update({
      collection: 'projects',
      id: p.id,
      data: { title: 'again' },
      ...as(w.companyA.user),
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('renders completely in English and Norwegian, and escapes the title', () => {
    for (const [locale, m] of [
      ['en', en],
      ['no', no],
    ] as const) {
      const href = `http://localhost:3000/${locale}/company/projects/7`
      const email = projectSubmittedEmail(locale, '<b>Plan</b>', href)
      expect(email.subject).toBe(m.Email.projectSubmitted.subject)
      for (const part of [email.subject, email.html, email.text]) {
        expect(part).not.toMatch(/undefined|\{\w+\}|\[object/)
      }
      expect(email.html).toContain(`href="${href}"`)
      expect(email.html).toContain('&lt;b&gt;Plan&lt;/b&gt;')
      expect(email.html).not.toContain('<b>Plan</b>')
      expect(email.html).not.toMatch(/<img|<script|<iframe/i)
      expect(email.text).toContain(href)
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe("the price and Konnected's note", () => {
  it('a company cannot set either, on create or update, through any API', async () => {
    const p = await draftOfA({ fee: 99_999, noteToCompany: 'self-written' })
    let after = await stored(p.id)
    expect(after.fee ?? null).toBeNull()
    expect(after.noteToCompany ?? null).toBeNull()

    const cookie = await login(w.companyA.user.email)
    await rest.patch(`projects/${p.id}`, { fee: 1, noteToCompany: 'x' }, cookie)
    await w.payload.update({
      collection: 'projects',
      id: p.id,
      data: { fee: 2, noteToCompany: 'y', noteToCompanyAt: new Date().toISOString() },
      ...as(w.companyA.user),
    })
    const gql = await graphql(
      `mutation { updateProject(id: ${p.id}, data: { fee: 3, noteToCompany: "z" }) { id } }`,
      cookie,
    )
    expect(gql.status).toBeLessThan(500)
    after = await stored(p.id)
    expect(after.fee ?? null).toBeNull()
    expect(after.noteToCompany ?? null).toBeNull()
    expect(after.noteToCompanyAt ?? null).toBeNull()
  })

  it('Konnected sets them; the company reads them on its own project; students never do', async () => {
    const id = w.projectOpen.id // published, company A
    const updated = await w.payload.update({
      collection: 'projects',
      id,
      data: { fee: 12_000, noteToCompany: 'Applications close on Friday.' },
      ...as(w.admin),
    })
    expect(updated.noteToCompanyAt).toBeTruthy()

    const own = await w.payload.findByID({ collection: 'projects', id, ...as(w.companyA.user) })
    expect(own.fee).toBe(12_000)
    expect(own.noteToCompany).toBe('Applications close on Friday.')

    for (const student of [w.alpha.user, w.beta.user]) {
      const seen = await w.payload.findByID({ collection: 'projects', id, ...as(student) })
      expect(seen.title).toBe('Project A open')
      expect(seen.fee).toBeUndefined()
      expect(seen.noteToCompany).toBeUndefined()
      expect(seen.noteToCompanyAt).toBeUndefined()
    }
    const cookie = await login(w.alpha.user.email)
    const viaRest = await rest.get(`projects/${id}?depth=2`, cookie)
    expect(viaRest.status).toBe(200)
    expect(viaRest.text).not.toContain('12000')
    expect(viaRest.text).not.toContain('Applications close on Friday.')
    const gql = await graphql(`{ Project(id: ${id}) { title fee noteToCompany } }`, cookie)
    expect(gql.text).not.toContain('12000')
    expect(gql.text).not.toContain('Applications close on Friday.')
  })
})

// ---------------------------------------------------------------------------------------------
describe('brief attachments', () => {
  const uploadAs = (user: User, name: string) =>
    w.payload.create({
      collection: 'brief-files',
      data: {} as never,
      file: fileOf(makePdf(name), name, 'application/pdf'),
      ...as(user),
    })

  it('a pending company uploads and attaches its own files to a draft; never another company’s', async () => {
    const { user } = await pendingCompany()
    const mine = await uploadAs(user, 'mine.pdf')
    const p = await w.payload.create({
      collection: 'projects',
      data: { title: 'With a file', attachments: [mine.id] } as never,
      ...as(user),
    })
    expect(p.attachments?.map((a) => relationId(a as number))).toEqual([mine.id])

    const theirs = await uploadAs(w.companyB.user, 'theirs.pdf')
    await expect(
      w.payload.update({
        collection: 'projects',
        id: p.id,
        data: { attachments: [mine.id, theirs.id] },
        ...as(user),
      }),
    ).rejects.toThrow(/does not belong/)
  })

  it('at most 10 files on one project', async () => {
    const files = []
    for (let i = 0; i < 11; i++) files.push(await uploadAs(w.companyA.user, `f${i}.pdf`))
    const p = await draftOfA({ attachments: files.slice(0, 10).map((f) => f.id) })
    expect(p.attachments).toHaveLength(10)
    await expect(
      w.payload.update({
        collection: 'projects',
        id: p.id,
        data: { attachments: files.map((f) => f.id) },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()
  })

  it('only the owner and admins read a project’s files; applicants never do, even once published', async () => {
    const brief = await w.payload.create({
      collection: 'brief-files',
      data: {} as never,
      file: fileOf(await makePng(), 'brief-new.png', 'image/png'),
      ...as(w.companyA.user),
    })
    const p = await draftOfA({ title: 'Published with brief', attachments: [brief.id] })
    const readers = async () => {
      const out: Record<string, boolean> = {}
      for (const [key, user] of Object.entries({
        companyA: w.companyA.user,
        companyB: w.companyB.user,
        alpha: w.alpha.user,
        beta: w.beta.user,
        admin: w.admin,
      })) {
        // A role with no access at all gets an error, which counts as not reading it.
        const res = await w.payload
          .find({ collection: 'brief-files', where: { id: { equals: brief.id } }, ...as(user) })
          .catch(() => ({ totalDocs: 0 }))
        out[key] = res.totalDocs === 1
      }
      return out
    }
    const expected = { companyA: true, companyB: false, alpha: false, beta: false, admin: true }
    expect(await readers()).toEqual(expected)

    await move(p.id, 'submitted', w.companyA.user)
    for (const status of ['approved', 'published'] as const) await move(p.id, status, w.admin)
    expect(await readers()).toEqual(expected)

    // The file itself, through the access-checked route.
    const url = `brief-files/file/${brief.filename}`
    expect((await rest.get(url, await login(w.companyA.user.email))).status).toBe(200)
    for (const cookie of [
      await login(w.companyB.user.email),
      await login(w.beta.user.email),
      undefined,
    ]) {
      expect((await rest.get(url, cookie)).status).toBe(403)
    }
    // A student sees the published project, but not its attachments' contents.
    const seen = await w.payload.findByID({
      collection: 'projects',
      id: p.id,
      depth: 2,
      ...as(w.beta.user),
    })
    expect(JSON.stringify(seen)).not.toContain('brief-new.png')
  })
})

// ---------------------------------------------------------------------------------------------
describe("the form's server functions", () => {
  it('a pending company saves drafts; sending answers "not approved" and keeps the draft', async () => {
    const { user, company } = await pendingCompany()
    const me = session(user)
    const saved = await saveProjectDraft(w.payload, me, undefined, {
      ...readyInput(),
      // Anything the company may not choose is ignored.
      company: w.companyB.company.id,
      status: 'published',
      fee: 1,
      noteToCompany: 'x',
    })
    expect(saved).toMatchObject({ status: 'saved' })
    const draft = await stored(saved.id!)
    expect(relationId(draft.company)).toBe(company.id)
    expect(draft.status).toBe('draft')
    expect(draft.fee ?? null).toBeNull()
    expect(draft.noteToCompany ?? null).toBeNull()
    expect(draft.desiredSkills).toEqual(['Copywriting', 'Email marketing'])
    expect(draft.workloadHours).toBe(20)

    const sent = await sendProjectForReview(w.payload, me, saved.id, readyInput({ title: 'New' }))
    expect(sent).toMatchObject({ status: 'error', error: 'not_approved', id: saved.id })
    const after = await stored(saved.id!)
    expect(after.status).toBe('draft')
    expect(after.title).toBe('New')

    await approve(company.id)
    const fresh = session((await w.payload.findByID({ collection: 'users', id: user.id })) as User)
    expect(await sendProjectForReview(w.payload, fresh, saved.id, readyInput())).toMatchObject({
      status: 'sent',
      id: saved.id,
    })
    expect((await stored(saved.id!)).status).toBe('submitted')
    // Sent: the form can no longer change it.
    expect(await saveProjectDraft(w.payload, fresh, saved.id, readyInput())).toMatchObject({
      status: 'error',
      error: 'not_editable',
    })
  })

  it('a send with missing answers marks them and keeps what was typed', async () => {
    const me = session(w.companyA.user)
    const result = await sendProjectForReview(
      w.payload,
      me,
      undefined,
      readyInput({ description: '', deadline: day(-2), paidOrUnpaid: 'unpaid' }),
    )
    expect(result.status).toBe('error')
    expect(result.fields).toMatchObject({
      description: 'required',
      deadline: 'past',
      unpaidBenefit: 'required',
    })
    expect(result.id).toBeTruthy()
    expect((await stored(result.id!)).status).toBe('draft')
  })

  it('refuses bad input, other roles and other companies’ projects', async () => {
    const me = session(w.companyA.user)
    expect(
      await saveProjectDraft(w.payload, me, undefined, readyInput({ title: '' })),
    ).toMatchObject({ fields: { title: 'required' } })
    expect(
      await saveProjectDraft(
        w.payload,
        me,
        undefined,
        readyInput({ workloadHours: '2.5', durationWeeks: '9', startDate: '2026-02-30' }),
      ),
    ).toMatchObject({
      fields: { workloadHours: 'invalid', durationWeeks: 'invalid', startDate: 'invalid' },
    })
    expect(
      await saveProjectDraft(w.payload, me, undefined, readyInput({ workMode: 'moon' })),
    ).toMatchObject({ fields: { workMode: 'invalid' } })

    for (const user of [w.alpha.user, w.admin]) {
      expect(await saveProjectDraft(w.payload, session(user), undefined, readyInput())).toEqual({
        status: 'error',
        error: 'forbidden',
      })
    }
    expect(await saveProjectDraft(w.payload, null, undefined, readyInput())).toMatchObject({
      error: 'forbidden',
    })
    // Company A cannot save into company B's draft.
    expect(await saveProjectDraft(w.payload, me, w.projectB.id, readyInput())).toMatchObject({
      error: 'not_found',
    })
    expect((await stored(w.projectB.id)).title).toBe('Project B draft')
  })

  it('removing a file from a draft deletes it; dates are kept as the same day', async () => {
    const me = session(w.companyA.user)
    const file = await w.payload.create({
      collection: 'brief-files',
      data: {} as never,
      file: fileOf(makePdf('gone.pdf'), 'gone.pdf', 'application/pdf'),
      ...as(w.companyA.user),
    })
    const saved = await saveProjectDraft(
      w.payload,
      me,
      undefined,
      readyInput({ attachments: [file.id] }),
    )
    expect(saved.status).toBe('saved')
    const draft = await stored(saved.id!)
    expect(draft.deadline?.slice(0, 10)).toBe(day(7))
    expect((draft.deadline ?? '').slice(0, 10) >= todayInOslo()).toBe(true)

    await saveProjectDraft(w.payload, me, saved.id, readyInput({ attachments: [] }))
    expect(
      await w.payload.findByID({
        collection: 'brief-files',
        id: file.id,
        disableErrors: true,
      }),
    ).toBeNull()
  })
})
