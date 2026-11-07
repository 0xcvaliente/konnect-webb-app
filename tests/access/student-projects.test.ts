import { beforeAll, describe, expect, it } from 'vitest'

import { browseOpenProjects, browseWhere, findProjectForStudent } from '@/lib/projects/browse'
import {
  NO_FILTERS,
  PAGE_MAX,
  PAGE_SIZE,
  readBrowseParams,
  SEARCH_MAX,
  SKILLS_MAX,
} from '@/lib/projects/browseFields'
import { todayInOslo } from '@/lib/projects/fields'
import { approveProject, type SessionUser } from '@/lib/team/approvals'
import type { ActivityLog, Project, User } from '@/payload-types'

import {
  asUser,
  createWorld,
  dayFromNow,
  graphql,
  login,
  readyFields,
  resetDatabase,
  rest,
  sessionFor,
  type World,
} from '../helpers/world'

/**
 * Kanban card "Student project list, search, filters and detail page": students read published
 * projects only (drafts and every other status hidden through REST, GraphQL and the Local API),
 * the list's search, filters, sort and server-side paging, the project page, and that companies,
 * the team and signed-out visitors never get the student list. Plus the two new project fields:
 * what the student is paid (team writes, students read, companies never) and when the project
 * was published (server only).
 */

let w: World
let studentCookie: string
let companyCookie: string
let adminCookie: string

const session = (user: User | null): SessionUser | null =>
  user ? (asUser(user) as SessionUser) : null
const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })

const form = (values: Record<string, string | number>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, String(value))
  return data
}

/** Create a project for a company and move it through `path` as the team. */
async function project(
  company: World['companyA'],
  title: string,
  data: Partial<Project>,
  path: Project['status'][] = ['submitted', 'approved', 'published'],
): Promise<Project> {
  let doc = await w.payload.create({
    collection: 'projects',
    data: {
      ...readyFields(),
      company: company.company.id,
      title,
      description: `${title} description`,
      fee: 10_000,
      status: 'draft',
      ...data,
    } as never,
    overrideAccess: true,
  })
  for (const status of path) {
    doc = await w.payload.update({
      collection: 'projects',
      id: doc.id,
      data: { status },
      ...as(w.admin),
    })
  }
  return doc
}

let figma: Project
let research: Project
let closed: Project
let submitted: Project
const bulk: Project[] = []

const ALL_STATUSES_BUT_PUBLISHED = [
  'draft',
  'submitted',
  'changes_requested',
  'rejected',
  'approved',
  'matched',
  'in_progress',
  'delivered',
  'closed',
]

beforeAll(async () => {
  await resetDatabase()
  w = await createWorld()
  studentCookie = await login(w.beta.user.email)
  companyCookie = await login(w.companyB.user.email)
  adminCookie = await sessionFor(w.admin.id)
  // A company name no other text in the world contains, for the search by company.
  await w.payload.update({
    collection: 'companies',
    id: w.companyB.company.id,
    data: { name: 'Havbris Tech AS' },
    ...as(w.admin),
  })

  figma = await project(w.companyB, 'Cat Figma dashboard', {
    description: 'Turn raw sensor readings into a clickable dashboard',
    desiredSkills: ['Figma', 'UX'],
    workMode: 'remote',
    durationWeeks: 3,
    workloadHours: 30,
    paidOrUnpaid: 'paid',
    fee: 6000,
    studentPay: 4500,
    noteToCompany: 'Cat-Team-Note',
  })
  await project(w.companyB, 'Cat Copy for an app', {
    desiredSkills: ['figma', 'Copywriting'],
    workMode: 'on_site',
    location: 'Oslo',
    durationWeeks: 1,
    workloadHours: 15,
    paidOrUnpaid: 'unpaid',
    unpaidBenefit: 'A reference letter',
  })
  research = await project(w.companyA, 'Cat Market research', {
    desiredSkills: ['Research'],
    workMode: 'hybrid',
    location: 'Bergen',
    durationWeeks: 6,
    workloadHours: 90,
    paidOrUnpaid: 'paid',
    // Applications close today (in Norway).
    deadline: `${todayInOslo()}T12:00:00.000Z`,
  })
  closed = await project(w.companyA, 'Cat Closed already', { deadline: dayFromNow(-2) })
  submitted = await project(w.companyB, 'Cat Still in review', {}, ['submitted'])
  for (let i = 1; i <= PAGE_SIZE + 1; i += 1) {
    bulk.push(await project(w.companyA, `Bulk ${String(i).padStart(2, '0')}`, {}))
  }
})

const titlesOf = (docs: { title?: string | null }[]) => docs.map((d) => d.title)

// ---------------------------------------------------------------------------------------------
describe('students read published projects only', () => {
  it('Local API: every project a student reads is published', async () => {
    const res = await w.payload.find({
      collection: 'projects',
      limit: 200,
      depth: 0,
      ...as(w.beta.user),
    })
    expect(res.docs.length).toBeGreaterThan(0)
    expect(new Set(res.docs.map((d) => d.status))).toEqual(new Set(['published']))
    expect(titlesOf(res.docs)).toContain('Cat Figma dashboard')
    expect(titlesOf(res.docs)).not.toContain('Cat Still in review')
    expect(titlesOf(res.docs)).not.toContain('Project B draft')
    expect(titlesOf(res.docs)).not.toContain('Project A')
  })

  it('Local API: a draft, a project in review and a running one are not found by id', async () => {
    for (const id of [w.projectB.id, w.projectHidden.id, w.projectA.id, submitted.id]) {
      await expect(
        w.payload.findByID({ collection: 'projects', id, depth: 0, ...as(w.beta.user) }),
      ).rejects.toThrow()
    }
  })

  it('Local API: asking for another status by where still returns nothing', async () => {
    const res = await w.payload.find({
      collection: 'projects',
      where: { status: { in: ALL_STATUSES_BUT_PUBLISHED } },
      depth: 0,
      ...as(w.beta.user),
    })
    expect(res.docs).toHaveLength(0)
  })

  it('REST: the list and single reads show published projects only', async () => {
    const list = await rest.get('projects?limit=200&depth=0', studentCookie)
    expect(list.status).toBe(200)
    const docs = list.json.docs as Project[]
    expect(new Set(docs.map((d) => d.status))).toEqual(new Set(['published']))
    expect(list.text).not.toContain('Project B draft')
    expect(list.text).not.toContain('Cat Still in review')

    const filtered = await rest.get(
      'projects?where[status][equals]=draft&depth=0&limit=200',
      studentCookie,
    )
    expect((filtered.json.docs as unknown[]) ?? []).toHaveLength(0)

    for (const id of [w.projectB.id, w.projectHidden.id, w.projectA.id, submitted.id]) {
      const one = await rest.get(`projects/${id}?depth=0`, studentCookie)
      expect([403, 404], String(id)).toContain(one.status)
    }
    const open = await rest.get(`projects/${figma.id}?depth=0`, studentCookie)
    expect(open.status).toBe(200)
  })

  it('GraphQL: the list and single reads show published projects only', async () => {
    const list = await graphql(
      '{ Projects(limit: 200) { docs { id title status } } }',
      studentCookie,
    )
    const docs = (list.json.data as { Projects: { docs: Project[] } }).Projects.docs
    expect(docs.length).toBeGreaterThan(0)
    expect(new Set(docs.map((d) => d.status))).toEqual(new Set(['published']))
    expect(list.text).not.toContain('Project B draft')
    for (const id of [w.projectB.id, submitted.id]) {
      const one = await graphql(`{ Project(id: ${id}) { id title } }`, studentCookie)
      expect(one.text).not.toContain('Project B draft')
      expect(one.text).not.toContain('Cat Still in review')
      expect((one.json.data as { Project: unknown } | null)?.Project ?? null).toBeNull()
    }
  })

  it('a student never reads the price, the team note or another field meant for the company', async () => {
    const res = await rest.get(`projects/${figma.id}?depth=5`, studentCookie)
    expect(res.json).not.toHaveProperty('fee')
    expect(res.json).not.toHaveProperty('noteToCompany')
    expect(res.json).not.toHaveProperty('company')
    expect(res.text).not.toContain('Cat-Team-Note')
    expect(res.text).not.toContain('6000')
    // What the student is paid is for students.
    expect(res.json.studentPay).toBe(4500)
  })
})

// ---------------------------------------------------------------------------------------------
describe('signed-out visitors and companies cannot browse', () => {
  it('signed out: REST, GraphQL and the Local API give no projects', async () => {
    const list = await rest.get('projects?limit=200&depth=0')
    expect([401, 403]).toContain(list.status)
    expect(list.text).not.toContain('Cat Figma dashboard')
    const one = await rest.get(`projects/${figma.id}?depth=0`)
    expect([401, 403, 404]).toContain(one.status)
    const gql = await graphql('{ Projects(limit: 200) { docs { id title } } }')
    expect(gql.text).not.toContain('Cat Figma dashboard')
    await expect(
      w.payload.find({ collection: 'projects', depth: 0, overrideAccess: false }),
    ).rejects.toThrow()
  })

  it('a company reads its own projects only, never another company’s published one', async () => {
    const list = await rest.get('projects?limit=200&depth=0', companyCookie)
    const docs = list.json.docs as Project[]
    expect(docs.length).toBeGreaterThan(0)
    expect(docs.every((d) => d.company === w.companyB.company.id)).toBe(true)
    expect(list.text).not.toContain('Project A open')
    expect(list.text).not.toContain('Cat Market research')
    const gql = await graphql('{ Projects(limit: 200) { docs { id title } } }', companyCookie)
    expect(gql.text).not.toContain('Project A open')
    const one = await rest.get(`projects/${research.id}?depth=0`, companyCookie)
    expect([403, 404]).toContain(one.status)
  })

  it('the list and the project page refuse everyone but a student', async () => {
    for (const user of [w.companyA.user, w.companyB.user, w.admin, null]) {
      expect(await browseOpenProjects(w.payload, session(user), NO_FILTERS)).toBeNull()
      expect(await findProjectForStudent(w.payload, session(user), figma.id)).toBeNull()
    }
  })

  it('a paused student account gets nothing either', async () => {
    const paused = { ...w.beta.user, accountStatus: 'paused' } as User
    expect(await browseOpenProjects(w.payload, session(paused), NO_FILTERS)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
describe('the student project list', () => {
  const browse = (params: Record<string, string | string[]> = {}) =>
    browseOpenProjects(w.payload, session(w.beta.user), readBrowseParams(params))

  it('shows open published projects only, newest first, a page at a time', async () => {
    const first = (await browse())!
    const second = (await browse({ page: '2' }))!
    const titles = [...titlesOf(first.cards), ...titlesOf(second.cards)]
    expect(first.cards).toHaveLength(PAGE_SIZE)
    // 13 bulk + Figma + Copy + Research + world's "Project A open". Closed and in-review are out.
    expect(first.totalDocs).toBe(PAGE_SIZE + 1 + 4)
    expect(first.totalPages).toBe(2)
    expect(titles).toHaveLength(first.totalDocs)
    expect(new Set(titles).size).toBe(titles.length)
    expect(titles).not.toContain('Cat Closed already')
    expect(titles).not.toContain('Cat Still in review')
    expect(titles).not.toContain('Project B draft')
    expect(titles).not.toContain('Project A')
    // Published last comes first.
    expect(titles[0]).toBe(`Bulk ${String(PAGE_SIZE + 1).padStart(2, '0')}`)
    expect(titles.at(-1)).toBe('Project A open')
  })

  it('a page past the end is empty but still counts the projects', async () => {
    const res = (await browse({ page: '9' }))!
    expect(res.cards).toHaveLength(0)
    expect(res.totalDocs).toBe(PAGE_SIZE + 1 + 4)
  })

  it('a project whose applications close today is still open', async () => {
    const res = (await browse({ q: 'Market research' }))!
    expect(titlesOf(res.cards)).toEqual(['Cat Market research'])
  })

  it('searches the title, the company name, the description and the skills', async () => {
    expect(titlesOf((await browse({ q: 'dashboard' }))!.cards)).toEqual(['Cat Figma dashboard'])
    expect(titlesOf((await browse({ q: 'SENSOR readings' }))!.cards)).toEqual([
      'Cat Figma dashboard',
    ])
    expect(titlesOf((await browse({ q: 'copywriting' }))!.cards)).toEqual(['Cat Copy for an app'])
    const byCompany = titlesOf((await browse({ q: 'havbris tech' }))!.cards)
    expect(byCompany.sort()).toEqual(['Cat Copy for an app', 'Cat Figma dashboard'])
    // Every word must match somewhere.
    expect((await browse({ q: 'dashboard copywriting' }))!.cards).toHaveLength(0)
    // Wildcards are plain text, not patterns.
    expect((await browse({ q: '%' }))!.totalDocs).toBe(PAGE_SIZE + 1 + 4)
    expect((await browse({ q: '%_%zzz' }))!.cards).toHaveLength(0)
  })

  it('filters by skill in any spelling, and offers the common skills as chips', async () => {
    const res = (await browse({ skill: 'FIGMA' }))!
    expect(titlesOf(res.cards).sort()).toEqual(['Cat Copy for an app', 'Cat Figma dashboard'])
    const labels = res.skills.map((s) => s.label)
    expect(labels[0]).toBe('Research') // the world's and the bulk projects' skill
    expect(labels.filter((l) => l.toLowerCase() === 'figma')).toHaveLength(1)
    expect(res.skills.find((s) => s.label.toLowerCase() === 'figma')!.count).toBe(2)
    // Several skills: any of them.
    const two = (await browse({ skill: ['UX', 'Copywriting'] }))!
    expect(titlesOf(two.cards).sort()).toEqual(['Cat Copy for an app', 'Cat Figma dashboard'])
  })

  it('filters by paid or unpaid, where, timeframe and workload', async () => {
    expect(titlesOf((await browse({ pay: 'unpaid' }))!.cards)).toEqual(['Cat Copy for an app'])
    expect((await browse({ pay: 'paid' }))!.totalDocs).toBe(PAGE_SIZE + 1 + 3)
    expect(titlesOf((await browse({ mode: 'on_site' }))!.cards)).toEqual(['Cat Copy for an app'])
    expect(titlesOf((await browse({ mode: 'hybrid' }))!.cards)).toEqual(['Cat Market research'])
    expect(titlesOf((await browse({ weeks: '3' }))!.cards)).toEqual(['Cat Figma dashboard'])
    expect(titlesOf((await browse({ load: 'over80' }))!.cards)).toEqual(['Cat Market research'])
    expect(titlesOf((await browse({ load: 'from21To40' }))!.cards)).toEqual(['Cat Figma dashboard'])
    expect(titlesOf((await browse({ load: 'upTo20', mode: 'on_site' }))!.cards)).toEqual([
      'Cat Copy for an app',
    ])
  })

  it('a card has what a student needs and nothing meant for the company', async () => {
    const res = (await browse({ q: 'Cat' }))!
    const card = res.cards.find((c) => c.title === 'Cat Figma dashboard')!
    expect(card).toMatchObject({
      companyName: 'Havbris Tech AS',
      paidOrUnpaid: 'paid',
      studentPay: 4500,
      workloadHours: 30,
      durationWeeks: 3,
      workMode: 'remote',
    })
    expect(card.deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const unpaid = res.cards.find((c) => c.title === 'Cat Copy for an app')!
    expect(unpaid).toMatchObject({ paidOrUnpaid: 'unpaid', unpaidBenefit: 'A reference letter' })
    const text = JSON.stringify(res)
    expect(text).not.toContain('Cat-Team-Note')
    expect(text).not.toContain('6000')
    expect(text).not.toMatch(/"(fee|noteToCompany|company|attachments)"/)
  })

  it('unknown or oversized filters from the address are dropped or cut', () => {
    const read = readBrowseParams({
      q: 'x'.repeat(500),
      skill: Array.from({ length: 20 }, (_, i) => `Skill ${i}`),
      pay: 'free',
      mode: 'moon',
      weeks: '5',
      load: 'huge',
      page: '999999',
    })
    expect(read.q).toHaveLength(SEARCH_MAX)
    expect(read.skills).toHaveLength(SKILLS_MAX)
    expect(read).toMatchObject({ pay: null, mode: null, weeks: null, load: null, page: PAGE_MAX })
    expect(readBrowseParams({ page: '-3' }).page).toBe(1)
    expect(readBrowseParams({ page: '2.5' }).page).toBe(1)
    // The query always keeps the published and still-open conditions first.
    const where = browseWhere(read, todayInOslo())
    expect(JSON.stringify(where)).toContain('"status":{"equals":"published"}')
  })
})

// ---------------------------------------------------------------------------------------------
describe('the project page for students', () => {
  it('shows a published project, open or closed, without the attachments', async () => {
    const open = await findProjectForStudent(w.payload, session(w.beta.user), w.projectOpen.id)
    expect(open).toMatchObject({ title: 'Project A open', companyName: 'Company A', open: true })
    expect(open).not.toHaveProperty('attachments')
    expect(JSON.stringify(open)).not.toContain('brief-open.png')

    const shut = await findProjectForStudent(w.payload, session(w.beta.user), closed.id)
    expect(shut).toMatchObject({ title: 'Cat Closed already', open: false })
  })

  it('a project that is not published is not found', async () => {
    for (const id of [w.projectB.id, w.projectHidden.id, w.projectA.id, submitted.id, 999_999]) {
      expect(await findProjectForStudent(w.payload, session(w.beta.user), id)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe('what the student is paid, and when a project was published', () => {
  const activity = async (id: number) =>
    (
      await w.payload.find({
        collection: 'activity-logs',
        where: {
          and: [{ targetCollection: { equals: 'projects' } }, { targetId: { equals: String(id) } }],
        },
        depth: 0,
        pagination: false,
        overrideAccess: true,
      })
    ).docs as ActivityLog[]

  it('a company never reads it, on its own project, through any API', async () => {
    const own = await rest.get(`projects/${figma.id}?depth=0`, companyCookie)
    expect(own.status).toBe(200)
    expect(own.json).not.toHaveProperty('studentPay')
    expect(own.text).not.toContain('4500')
    const gql = await graphql(`{ Project(id: ${figma.id}) { id studentPay } }`, companyCookie)
    expect((gql.json.data as { Project: { studentPay: unknown } }).Project.studentPay).toBeNull()
    const local = await w.payload.findByID({
      collection: 'projects',
      id: figma.id,
      depth: 0,
      ...as(w.companyB.user),
    })
    expect(local).not.toHaveProperty('studentPay')
    // Positive control: the team reads it.
    const admin = await rest.get(`projects/${figma.id}?depth=0`, adminCookie)
    expect(admin.json.studentPay).toBe(4500)
  })

  it('only the team writes it; a company or student value is dropped or refused', async () => {
    const draft = await w.payload.create({
      collection: 'projects',
      data: {
        title: 'Pay draft',
        studentPay: 999,
        publishedAt: '2001-01-01T00:00:00.000Z',
      } as never,
      ...as(w.companyB.user),
    })
    const stored = await w.payload.findByID({
      collection: 'projects',
      id: draft.id,
      overrideAccess: true,
    })
    expect(stored.studentPay ?? null).toBeNull()
    expect(stored.publishedAt ?? null).toBeNull()

    const patched = await rest.patch(
      `projects/${draft.id}`,
      { studentPay: 777, publishedAt: '2001-01-01T00:00:00.000Z' },
      companyCookie,
    )
    expect(patched.status).toBe(200)
    const after = await w.payload.findByID({
      collection: 'projects',
      id: draft.id,
      overrideAccess: true,
    })
    expect(after.studentPay ?? null).toBeNull()
    expect(after.publishedAt ?? null).toBeNull()

    const byStudent = await rest.patch(`projects/${figma.id}`, { studentPay: 1 }, studentCookie)
    expect([403, 404]).toContain(byStudent.status)
    const anon = await rest.patch(`projects/${figma.id}`, { studentPay: 1 })
    expect([401, 403, 404]).toContain(anon.status)
    expect(
      (await w.payload.findByID({ collection: 'projects', id: figma.id, overrideAccess: true }))
        .studentPay,
    ).toBe(4500)
  })

  it('the team sets it at approval: a whole amount, at most the price; logged', async () => {
    const draft = await w.payload.create({
      collection: 'projects',
      data: { ...readyFields(), title: 'Pay at approval' } as never,
      ...as(w.companyB.user),
    })
    await w.payload.update({
      collection: 'projects',
      id: draft.id,
      data: { status: 'submitted' },
      ...as(w.companyB.user),
    })
    const admin = session(w.admin)
    for (const bad of ['abc', '12.5', '0', '7000']) {
      expect(
        (
          await approveProject(
            w.payload,
            admin,
            form({ id: draft.id, pay: 'paid', price: 6000, studentPay: bad }),
          )
        ).error,
        bad,
      ).toBe('student_pay_invalid')
    }
    for (const outsider of [w.beta.user, w.companyB.user, null]) {
      expect(
        (
          await approveProject(
            w.payload,
            session(outsider),
            form({ id: draft.id, pay: 'paid', price: 6000, studentPay: 4000 }),
          )
        ).error,
      ).toBe('forbidden')
    }
    const ok = await approveProject(
      w.payload,
      admin,
      form({ id: draft.id, pay: 'paid', price: '6 000', studentPay: '4 000' }),
    )
    expect(ok.status).toBe('done')
    const stored = await w.payload.findByID({
      collection: 'projects',
      id: draft.id,
      overrideAccess: true,
    })
    expect(stored).toMatchObject({ status: 'approved', fee: 6000, studentPay: 4000 })
    const rows = await activity(draft.id)
    expect(rows.map((r) => [r.action, r.field ?? null, r.toStatus ?? null])).toEqual(
      expect.arrayContaining([['review_change', 'studentPay', '4000']]),
    )

    // The hook holds the rule for every API too.
    await expect(
      w.payload.update({
        collection: 'projects',
        id: draft.id,
        data: { studentPay: 6001 },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/student pay/)
  })

  it('an unpaid project pays the student nothing', async () => {
    const p = await project(w.companyB, 'Turns unpaid', { studentPay: 3000, fee: 5000 }, [
      'submitted',
    ])
    await w.payload.update({
      collection: 'projects',
      id: p.id,
      data: { status: 'approved', paidOrUnpaid: 'unpaid', unpaidBenefit: 'A reference' },
      ...as(w.admin),
    })
    const stored = await w.payload.findByID({
      collection: 'projects',
      id: p.id,
      overrideAccess: true,
    })
    expect(stored).toMatchObject({ paidOrUnpaid: 'unpaid' })
    expect(stored.studentPay ?? null).toBeNull()
    expect(stored.fee ?? null).toBeNull()
  })

  it('publishing stamps the time, which the list sorts on', async () => {
    const before = Date.now()
    const p = await project(w.companyA, 'Fresh one', {})
    const stored = await w.payload.findByID({
      collection: 'projects',
      id: p.id,
      overrideAccess: true,
    })
    expect(new Date(stored.publishedAt!).getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(figma.publishedAt).toBeTruthy()
    const list = (await browseOpenProjects(w.payload, session(w.beta.user), NO_FILTERS))!
    expect(list.cards[0]!.title).toBe('Fresh one')
  })
})
