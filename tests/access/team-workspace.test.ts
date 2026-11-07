import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import type { SessionUser } from '@/lib/team/approvals'
import { coveredBy, listTeam, mineIds, saveAway } from '@/lib/team/members'
import { isMorningWindow, sendMorningEmails } from '@/lib/team/morningEmail'
import { reassign, takeFromPool } from '@/lib/team/ownership'
import { itemsOf, loadToday, poolItems } from '@/lib/team/today'
import { addDays, addWorkingDays, osloDay } from '@/lib/workingDays'
import type { ActivityLog, User } from '@/payload-types'

import {
  ADMIN_EMAIL,
  asUser,
  companyDetails,
  createWorld,
  graphql,
  login,
  PASSWORD,
  resetDatabase,
  rest,
  SENTINEL,
  sessionFor,
  type World,
  workingMatch,
} from '../helpers/world'

/**
 * Kanban cards "Team split: company owners and the shared pool", "Today queue", "Today: My work
 * and Everyone, plus a personal morning email" and "Team page: workload, owners and away cover".
 * Owners and the shared pool route the work; they never limit access. Every write is tried as
 * each role (the team, a student, a company, anonymous) through the Local API with access
 * control on, and through REST and GraphQL where a role could try it directly.
 */

const AMANDA = 'amanda@konnected.test'
const JULIE = 'julie@konnected.test'

let w: World
let amanda: User
let julie: User
let mail: MockInstance

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User) => asUser(user) as unknown as SessionUser
const form = (values: Record<string, string | number>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(values)) f.set(k, String(v))
  return f
}

const makeAdmin = async (email: string, name: string, language: 'en' | 'no' = 'en') =>
  (await w.payload.create({
    collection: 'users',
    data: {
      email,
      name,
      password: PASSWORD,
      role: 'admin',
      language,
      _verified: true,
      emailVerifiedAt: new Date().toISOString(),
    } as never,
    overrideAccess: true,
    disableVerificationEmail: true,
  })) as User

const logRows = async (collection: string, id: number) =>
  (
    await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [
          { targetCollection: { equals: collection } },
          { targetId: { equals: String(id) } },
          { action: { equals: 'reassign' } },
        ],
      },
      sort: 'createdAt',
      depth: 0,
      overrideAccess: true,
    })
  ).docs as ActivityLog[]

const ownerOf = async (id: number) =>
  (
    await w.payload.findByID({
      collection: 'projects',
      id,
      depth: 0,
      overrideAccess: true,
    })
  ).owner

beforeEach(async () => {
  vi.stubEnv('ADMIN_EMAILS', `${ADMIN_EMAIL},${AMANDA},${JULIE}`)
  await resetDatabase()
  w = await createWorld()
  amanda = await makeAdmin(AMANDA, 'Amanda Berg')
  julie = await makeAdmin(JULIE, 'Julie Lie', 'no')
  mail?.mockRestore()
  mail = vi.spyOn(w.payload.email, 'sendEmail')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('owners: companies and projects', () => {
  it('approving a company makes the approver its owner, and a new project starts with it', async () => {
    // The world's companies were approved by the admin.
    const company = await w.payload.findByID({
      collection: 'companies',
      id: w.companyA.company.id,
      ...as(w.admin),
    })
    expect(company.teamOwner).toMatchObject({ id: w.admin.id })

    const project = await w.payload.create({
      collection: 'projects',
      data: { title: 'Owner copy', status: 'draft' } as never,
      ...as(w.companyA.user),
    })
    // The company never reads the owner, but the project has one: the company's.
    expect(project).not.toHaveProperty('owner')
    expect(await ownerOf(project.id)).toBe(w.admin.id)
  })

  it('the team moves one project with a note; the history keeps it', async () => {
    const result = await reassign(
      w.payload,
      session(w.admin),
      form({
        collection: 'projects',
        id: w.projectOpen.id,
        ownerId: amanda.id,
        note: 'Amanda knows them',
      }),
    )
    expect(result.status).toBe('done')
    expect(await ownerOf(w.projectOpen.id)).toBe(amanda.id)
    const rows = await logRows('projects', w.projectOpen.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      field: 'owner',
      fromStatus: String(w.admin.id),
      toStatus: String(amanda.id),
      note: 'Amanda knows them',
      actor: w.admin.id,
    })
  })

  it('a reassignment needs a note and someone on the team', async () => {
    const base = { collection: 'projects', id: w.projectOpen.id }
    const noNote = await reassign(
      w.payload,
      session(w.admin),
      form({ ...base, ownerId: amanda.id }),
    )
    expect(noNote).toMatchObject({ status: 'error', error: 'note' })
    const student = await reassign(
      w.payload,
      session(w.admin),
      form({ ...base, ownerId: w.alpha.user.id, note: 'Not on the team' }),
    )
    expect(student).toMatchObject({ status: 'error', error: 'owner' })
    // The collection refuses a non-team owner too, whatever the way in.
    await expect(
      w.payload.update({
        collection: 'projects',
        id: w.projectOpen.id,
        data: { owner: w.companyA.user.id },
        ...as(w.admin),
      }),
    ).rejects.toThrow()
    expect(await ownerOf(w.projectOpen.id)).toBe(w.admin.id)
    expect(await logRows('projects', w.projectOpen.id)).toHaveLength(0)
  })

  it('students, companies and anonymous visitors cannot reassign or take anything', async () => {
    const f = () =>
      form({ collection: 'projects', id: w.projectOpen.id, ownerId: amanda.id, note: 'Mine now' })
    for (const user of [w.alpha.user, w.companyA.user]) {
      expect(await reassign(w.payload, session(user), f())).toMatchObject({ error: 'notFound' })
      expect(
        await takeFromPool(
          w.payload,
          session(user),
          form({ collection: 'student-profiles', id: w.beta.profile.id }),
        ),
      ).toMatchObject({ error: 'notFound' })
    }
    expect(await reassign(w.payload, null, f())).toMatchObject({ error: 'notFound' })

    // Direct writes: the company's own project and company, the student's own profile.
    const companyCookie = await login(w.companyA.user.email)
    const betaCookie = await login(w.beta.user.email)
    await rest.patch(
      `companies/${w.companyA.company.id}`,
      { teamOwner: w.companyA.user.id, takenBy: w.companyA.user.id },
      companyCookie,
    )
    await rest.patch(
      `student-profiles/${w.beta.profile.id}`,
      { takenBy: w.beta.user.id },
      betaCookie,
    )
    const draft = await w.payload.create({
      collection: 'projects',
      data: { title: 'Company draft', status: 'draft' } as never,
      ...as(w.companyA.user),
    })
    await rest.patch(
      `projects/${draft.id}`,
      { owner: amanda.id, takenBy: amanda.id },
      companyCookie,
    )
    const company = await w.payload.findByID({
      collection: 'companies',
      id: w.companyA.company.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(company.teamOwner).toBe(w.admin.id)
    expect(company.takenBy ?? null).toBeNull()
    const profile = await w.payload.findByID({
      collection: 'student-profiles',
      id: w.beta.profile.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(profile.takenBy ?? null).toBeNull()
    const project = await w.payload.findByID({
      collection: 'projects',
      id: draft.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(project.owner).toBe(w.admin.id)
    expect(project.takenBy ?? null).toBeNull()
  })

  it('a company never reads owners or takers, through REST or GraphQL', async () => {
    const cookie = await login(w.companyA.user.email)
    const own = await rest.get(`projects/${w.projectOpen.id}?depth=2`, cookie)
    expect(own.status).toBe(200)
    expect(own.json).not.toHaveProperty('owner')
    expect(own.json).not.toHaveProperty('takenBy')
    const company = await rest.get(`companies/${w.companyA.company.id}?depth=2`, cookie)
    expect(company.json).not.toHaveProperty('teamOwner')
    expect(company.json).not.toHaveProperty('takenBy')
    const gql = await graphql(
      '{ Projects { docs { id owner { id email } takenBy { id } } } Companies { docs { id teamOwner { id email } takenBy { id } } } }',
      cookie,
    )
    expect(gql.text).not.toContain(ADMIN_EMAIL)
    // Students: published projects only, never the owner.
    const student = await rest.get(`projects/${w.projectOpen.id}`, await login(w.beta.user.email))
    expect(student.status).toBe(200)
    expect(student.json).not.toHaveProperty('owner')
  })

  it('a new company owner takes along the projects that followed, not a moved one', async () => {
    const moved = await workingMatch(w.payload, w.admin, w.beta, w.companyA, 'Moved project')
    await reassign(
      w.payload,
      session(w.admin),
      form({
        collection: 'projects',
        id: moved.project.id,
        ownerId: amanda.id,
        note: 'Amanda runs this one',
      }),
    )
    const result = await reassign(
      w.payload,
      session(amanda),
      form({
        collection: 'companies',
        id: w.companyA.company.id,
        ownerId: julie.id,
        note: 'Julie takes over Company A',
      }),
    )
    expect(result.status).toBe('done')
    expect(await ownerOf(w.projectOpen.id)).toBe(julie.id) // followed
    expect(await ownerOf(moved.project.id)).toBe(amanda.id) // moved on its own, stays
    const companyRows = await logRows('companies', w.companyA.company.id)
    expect(companyRows.at(-1)).toMatchObject({
      field: 'teamOwner',
      toStatus: String(julie.id),
      note: 'Julie takes over Company A',
      actor: amanda.id,
    })
    // The project that followed carries the same note in its own history.
    expect((await logRows('projects', w.projectOpen.id)).at(-1)).toMatchObject({
      field: 'owner',
      toStatus: String(julie.id),
      note: 'Julie takes over Company A',
    })
  })
})

describe('the shared pool', () => {
  it('a new company waits in the pool; "Take it" moves it to one list, once', async () => {
    const user = await w.payload.create({
      collection: 'users',
      data: {
        email: 'new.co@company.test',
        password: PASSWORD,
        role: 'company',
        _verified: true,
      } as never,
      overrideAccess: true,
      disableVerificationEmail: true,
    })
    const company = await w.payload.create({
      collection: 'companies',
      data: { ...companyDetails('Skarv Robotics'), status: 'pending' },
      ...as(user as User),
    })
    const before = await loadToday(w.payload, session(w.admin))
    const inPool = poolItems(before!.items)
    expect(inPool.map((i) => i.key)).toContain(`companies-${company.id}`)
    // beta's profile is waiting for review and nobody took it.
    expect(inPool.map((i) => i.key)).toContain(`students-${w.beta.profile.id}`)

    const take = (actor: User) =>
      takeFromPool(w.payload, session(actor), form({ collection: 'companies', id: company.id }))
    expect((await take(amanda)).status).toBe('done')
    expect(await take(w.admin)).toMatchObject({ status: 'error', error: 'taken' })

    const after = await loadToday(w.payload, session(w.admin))
    expect(poolItems(after!.items).map((i) => i.key)).not.toContain(`companies-${company.id}`)
    expect(itemsOf(after!.items, new Set([amanda.id])).map((i) => i.key)).toContain(
      `companies-${company.id}`,
    )
    const rows = await logRows('companies', company.id)
    expect(rows).toMatchObject([
      { field: 'takenBy', toStatus: String(amanda.id), actor: amanda.id },
    ])

    // Whoever took it becomes the owner when anyone on the team approves it.
    await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { status: 'approved' },
      ...as(w.admin),
    })
    const approved = await w.payload.findByID({
      collection: 'companies',
      id: company.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(approved.teamOwner).toBe(amanda.id)
  })

  it('a pool item turns amber after 2 working days', async () => {
    const now = new Date(`${addWorkingDays(osloDay(new Date()), 2)}T10:00:00Z`)
    const data = await loadToday(w.payload, session(w.admin), now)
    const profile = data!.items.find((i) => i.key === `students-${w.beta.profile.id}`)!
    expect(profile.pool).toMatchObject({ waited: 2, amber: true })
    const fresh = await loadToday(w.payload, session(w.admin))
    expect(fresh!.items.find((i) => i.key === profile.key)!.pool!.amber).toBe(false)
  })
})

describe('Today: My work and Everyone', () => {
  it('splits the open work by owner; everyone still sees everything', async () => {
    await reassign(
      w.payload,
      session(w.admin),
      form({
        collection: 'projects',
        id: w.projectHidden.id,
        ownerId: amanda.id,
        note: 'For Amanda',
      }),
    )
    const asAdmin = await loadToday(w.payload, session(w.admin))
    const asAmanda = await loadToday(w.payload, session(amanda))
    // The same items for every team member: ownership never hides anything.
    expect(asAmanda!.items.map((i) => i.key).sort()).toEqual(
      asAdmin!.items.map((i) => i.key).sort(),
    )
    const amandas = itemsOf(asAmanda!.items, new Set([amanda.id])).map((i) => i.key)
    expect(amandas).toContain(`projects-${w.projectHidden.id}`)
    expect(itemsOf(asAdmin!.items, new Set([w.admin.id])).map((i) => i.key)).not.toContain(
      `projects-${w.projectHidden.id}`,
    )
    // The key numbers count the whole team's work.
    expect(asAdmin!.numbers.activeCompanies).toBe(2)
    expect(asAdmin!.numbers.pool).toBeGreaterThan(0)
    // Students and companies get nothing.
    expect(await loadToday(w.payload, session(w.alpha.user))).toBeNull()
    expect(await loadToday(w.payload, session(w.companyA.user))).toBeNull()
  })

  it('shows a profile review promise counting down in working days, and overdue after it', async () => {
    await takeFromPool(
      w.payload,
      session(w.admin),
      form({ collection: 'student-profiles', id: w.beta.profile.id }),
    )
    const later = new Date(`${addWorkingDays(osloDay(new Date()), 3)}T10:00:00Z`)
    const data = await loadToday(w.payload, session(w.admin), later)
    const item = itemsOf(data!.items, new Set([w.admin.id])).find(
      (i) => i.key === `students-${w.beta.profile.id}`,
    )!
    expect(item.due).toMatchObject({ left: -1, tone: 'late' })
    // Most urgent first: late items lead the list.
    expect(itemsOf(data!.items, new Set([w.admin.id]))[0]!.due?.tone).toBe('late')
  })

  it('work due within 3 working days shows for the project owner until it is handed in', async () => {
    const work = await workingMatch(w.payload, w.admin, w.beta, w.companyB, 'Due soon project')
    const due = addWorkingDays(osloDay(new Date()), 1)
    await w.payload.update({
      collection: 'matches',
      id: work.match.id,
      data: { endDate: `${due}T12:00:00.000Z` },
      ...as(w.admin),
    })
    const data = await loadToday(w.payload, session(w.admin))
    const item = data!.items.find((i) => i.key === `work-${work.match.id}`)
    expect(item).toMatchObject({
      kind: 'workDue',
      ownerId: w.admin.id,
      due: { left: 1, tone: 'soon' },
    })
  })
})

describe('away and cover', () => {
  it('any team member sets away days; the cover sees the items; the change is logged', async () => {
    const today = osloDay(new Date())
    const until = addDays(today, 4)
    const saved = await saveAway(
      w.payload,
      session(w.admin),
      form({ memberId: amanda.id, from: today, until, coverId: julie.id }),
    )
    expect(saved.status).toBe('done')
    const team = (await listTeam(w.payload, session(julie)))!
    expect(coveredBy(team, julie.id, today).map((m) => m.id)).toEqual([amanda.id])
    expect([...mineIds(team, julie.id, today)].sort()).toEqual([amanda.id, julie.id].sort())
    // Not after the last day.
    expect(coveredBy(team, julie.id, addDays(until, 1))).toEqual([])
    const log = await w.payload.find({
      collection: 'activity-logs',
      where: { action: { equals: 'away_change' } },
      depth: 0,
      overrideAccess: true,
    })
    expect(log.docs[0]).toMatchObject({ toStatus: `${today}..${until}`, actor: w.admin.id })

    // Clearing removes them.
    await saveAway(w.payload, session(julie), form({ memberId: amanda.id, clear: '1' }))
    const after = (await listTeam(w.payload, session(julie)))!
    expect(after.find((m) => m.id === amanda.id)!.away).toBeNull()
  })

  it('refuses bad days, self-cover and a cover outside the team', async () => {
    const today = osloDay(new Date())
    const base = { memberId: amanda.id, from: today, until: addDays(today, 2) }
    expect(
      await saveAway(w.payload, session(w.admin), form({ ...base, coverId: amanda.id })),
    ).toMatchObject({ error: 'cover' })
    expect(
      await saveAway(w.payload, session(w.admin), form({ ...base, coverId: w.alpha.user.id })),
    ).toMatchObject({ error: 'cover' })
    expect(
      await saveAway(
        w.payload,
        session(w.admin),
        form({ ...base, until: addDays(today, -1), coverId: julie.id }),
      ),
    ).toMatchObject({ error: 'dates' })
    expect(
      await saveAway(
        w.payload,
        session(w.admin),
        form({ ...base, until: addDays(today, 120), coverId: julie.id }),
      ),
    ).toMatchObject({ error: 'dates' })
    // The collection holds the same rules for a direct write.
    await expect(
      w.payload.create({
        collection: 'team-members',
        data: {
          user: amanda.id,
          awayFrom: `${today}T12:00:00Z`,
          awayUntil: `${today}T12:00:00Z`,
          coveredBy: amanda.id,
        },
        ...as(w.admin),
      }),
    ).rejects.toThrow()
    await expect(
      w.payload.create({
        collection: 'team-members',
        data: { user: w.alpha.user.id },
        ...as(w.admin),
      }),
    ).rejects.toThrow()
  })

  it('students, companies and anonymous visitors cannot read or write the team rows', async () => {
    await w.payload.create({
      collection: 'team-members',
      data: { user: amanda.id },
      ...as(w.admin),
    })
    for (const user of [w.alpha.user, w.companyA.user]) {
      await expect(w.payload.find({ collection: 'team-members', ...as(user) })).rejects.toThrow()
      await expect(
        w.payload.create({ collection: 'team-members', data: { user: user.id }, ...as(user) }),
      ).rejects.toThrow()
      expect(
        await saveAway(w.payload, session(user), form({ memberId: amanda.id, clear: '1' })),
      ).toMatchObject({ error: 'notFound' })
      const cookie = await login(user.email)
      expect((await rest.get('team-members', cookie)).status).toBe(403)
      expect((await rest.post('team-members', { user: user.id }, cookie)).status).toBe(403)
      const gql = await graphql('{ TeamMembers { docs { id user { email } } } }', cookie)
      expect(gql.text).not.toContain(AMANDA)
    }
    expect((await rest.get('team-members')).status).toBe(403)
    // The team reads them.
    const adminCookie = await sessionFor(w.admin.id)
    const own = await rest.get('team-members', adminCookie)
    expect(own.status).toBe(200)
    expect((own.json as { totalDocs: number }).totalDocs).toBe(1)
  })
})

describe('the morning email', () => {
  it('goes out on working days from 07:30 in Oslo, never on weekends or holidays', () => {
    expect(isMorningWindow(new Date('2026-11-09T06:45:00Z'))).toBe(true) // Mon 07:45 (winter)
    expect(isMorningWindow(new Date('2026-11-09T06:30:00Z'))).toBe(true) // 07:30 exactly
    expect(isMorningWindow(new Date('2026-11-09T06:15:00Z'))).toBe(false) // 07:15
    expect(isMorningWindow(new Date('2026-11-09T11:30:00Z'))).toBe(false) // 12:30
    expect(isMorningWindow(new Date('2026-06-15T05:30:00Z'))).toBe(true) // Mon 07:30 (summer)
    expect(isMorningWindow(new Date('2026-11-07T08:00:00Z'))).toBe(false) // Saturday
    expect(isMorningWindow(new Date('2027-03-29T06:00:00Z'))).toBe(false) // Easter Monday
    expect(isMorningWindow(new Date('2027-05-17T06:00:00Z'))).toBe(false) // 17 May, a Monday
    expect(isMorningWindow(new Date('2026-05-14T06:00:00Z'))).toBe(false) // Ascension Day
  })

  it("lists each member's own items, in their language, once a day, with no student names", async () => {
    // The admin takes beta's profile; three working days on, its 2 working day promise is late.
    await takeFromPool(
      w.payload,
      session(w.admin),
      form({ collection: 'student-profiles', id: w.beta.profile.id }),
    )
    // Julie (Norwegian) owns a project waiting for review.
    await reassign(
      w.payload,
      session(w.admin),
      form({
        collection: 'projects',
        id: w.projectHidden.id,
        ownerId: julie.id,
        note: 'For Julie',
      }),
    )
    const day = addWorkingDays(osloDay(new Date()), 3)
    const now = new Date(`${day}T07:00:00Z`) // 08:00 or 09:00 in Oslo
    const before = new Date(`${day}T04:00:00Z`) // before 07:30 in Oslo
    expect(await sendMorningEmails(w.payload, before)).toBe(0)

    const sent = await sendMorningEmails(w.payload, now)
    const calls = mail.mock.calls.map(
      (c) => c[0] as { to: string; subject: string; text: string; html: string },
    )
    const toAdmin = calls.find((m) => m.to === ADMIN_EMAIL)!
    expect(toAdmin.subject).toMatch(/^Good morning/)
    // beta's profile, and alpha's (the world's admin decided on it, so it is the admin's).
    expect(toAdmin.text).toContain('Overdue (2)')
    expect(toAdmin.text).toContain('Student profile to review: a student profile')
    for (const m of calls) {
      expect(m.text).not.toContain(SENTINEL.beta.name)
      expect(m.html).not.toContain(SENTINEL.beta.name)
    }
    // Julie's project has no promise, so her email is only there if the pool is amber; when she
    // gets one, it is in Norwegian.
    const toJulie = calls.find((m) => m.to === JULIE)
    if (toJulie) expect(toJulie.subject).toMatch(/^God morgen/)
    expect(sent).toBe(calls.length)

    // Once a day: a second run sends nothing.
    mail.mockClear()
    expect(await sendMorningEmails(w.payload, new Date(now.getTime() + 15 * 60_000))).toBe(0)
    expect(mail).not.toHaveBeenCalled()
  })

  it('skips a member who is away and gives their items to the cover', async () => {
    await takeFromPool(
      w.payload,
      session(amanda),
      form({ collection: 'student-profiles', id: w.beta.profile.id }),
    )
    const day = addWorkingDays(osloDay(new Date()), 3)
    await saveAway(
      w.payload,
      session(w.admin),
      form({
        memberId: amanda.id,
        from: osloDay(new Date()),
        until: addDays(day, 2),
        coverId: w.admin.id,
      }),
    )
    await sendMorningEmails(w.payload, new Date(`${day}T07:00:00Z`))
    const calls = mail.mock.calls.map((c) => c[0] as { to: string; text: string })
    expect(calls.some((m) => m.to === AMANDA)).toBe(false)
    const toAdmin = calls.find((m) => m.to === ADMIN_EMAIL)!
    expect(toAdmin.text).toContain('Covering for Amanda (1)')
  })
})
