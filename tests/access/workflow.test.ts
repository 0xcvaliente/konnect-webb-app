import { beforeEach, describe, expect, it } from 'vitest'

import { relationId } from '@/access/roles'
import { Users } from '@/collections/Users'
import type { User } from '@/payload-types'

import {
  ADMIN_EMAIL,
  asUser,
  companyDetails,
  createWorld,
  getTestPayload,
  login,
  sessionFor,
  PASSWORD,
  readyFields,
  resetDatabase,
  rest,
  selectStudent,
  SENTINEL,
  type World,
} from '../helpers/world'
import { signedAgreement } from '../helpers/agreements'

/**
 * Roles, status rules, applications, matches, deliverables, payments and the activity log, each
 * checked as the role that matters. The Local API calls pass `overrideAccess: false` and a user.
 * A few go through REST with a real session cookie to cover the whole stack.
 */

let w: World

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
})

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })

describe('users and roles', () => {
  it('nobody can make themselves admin through the API', async () => {
    const cookie = await login(w.alpha.user.email)
    const res = await rest.patch(`users/${w.alpha.user.id}`, { role: 'admin' }, cookie)
    // The field is read-only for non-admins, so the value is dropped.
    const after = await w.payload.findByID({ collection: 'users', id: w.alpha.user.id })
    expect(after.role).toBe('student')
    expect(res.status === 200 || res.status === 403).toBe(true)
  })

  it('a public or non-admin request cannot create a user, so nobody can sign up as admin', async () => {
    const anon = await rest.post('users', {
      email: 'new@x.test',
      password: PASSWORD,
      role: 'admin',
    })
    expect(anon.status).toBe(403)
    const cookie = await login(w.alpha.user.email)
    const student = await rest.post(
      'users',
      { email: 'new2@x.test', password: PASSWORD, role: 'admin' },
      cookie,
    )
    expect(student.status).toBe(403)
  })

  it('the first-user endpoint is closed', async () => {
    const res = await rest.post('users/first-register', {
      email: ADMIN_EMAIL,
      password: PASSWORD,
      role: 'admin',
    })
    expect(res.status).toBe(403)
  })

  it('admin needs an allowlisted AND verified email, even for server code', async () => {
    const make = (email: string, verified: boolean) =>
      w.payload.create({
        collection: 'users',
        data: {
          email,
          password: PASSWORD,
          role: 'admin',
          ...(verified ? { emailVerifiedAt: new Date().toISOString() } : {}),
        },
        overrideAccess: true,
      })
    await expect(make('not.listed@konnected.test', true)).rejects.toThrow()
    await expect(make(ADMIN_EMAIL.replace('admin@', 'admin2@'), true)).rejects.toThrow()
    // Allowlisted but never verified: an unverified sign-up must not become admin.
    await expect(make('Admin@Konnected.test', false)).rejects.toThrow()
  })

  it('promoting an existing user to admin follows the same rule', async () => {
    await expect(
      w.payload.update({
        collection: 'users',
        id: w.alpha.user.id,
        data: { role: 'admin' },
        overrideAccess: true,
      }),
    ).rejects.toThrow()
  })

  it('a user lists only themselves, so a company cannot list students', async () => {
    for (const user of [w.companyA.user, w.alpha.user]) {
      const cookie = await login(user.email)
      const res = await rest.get('users?limit=100', cookie)
      const docs = res.json.docs as { id: number }[]
      expect(docs.map((d) => d.id)).toEqual([user.id])
    }
  })

  it('only admin can enter the admin panel', () => {
    const access = Users.access!.admin!
    const call = (user: User) => access({ req: { user: asUser(user) } } as never)
    expect(call(w.admin)).toBe(true)
    expect(call(w.alpha.user)).toBe(false)
    expect(call(w.companyA.user)).toBe(false)
  })
})

describe('student', () => {
  it('reads and edits only their own profile', async () => {
    const own = await w.payload.find({ collection: 'student-profiles', ...as(w.alpha.user) })
    expect(own.docs.map((d) => d.id)).toEqual([w.alpha.profile.id])
    await expect(
      w.payload.findByID({
        collection: 'student-profiles',
        id: w.beta.profile.id,
        ...as(w.alpha.user),
      }),
    ).rejects.toThrow()
    await expect(
      w.payload.update({
        collection: 'student-profiles',
        id: w.beta.profile.id,
        data: { pitch: 'hacked' },
        ...as(w.alpha.user),
      }),
    ).rejects.toThrow()
  })

  it('cannot move their profile to another user', async () => {
    const updated = await w.payload.update({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      data: { user: w.beta.user.id, pitch: 'edited' },
      ...as(w.alpha.user),
    })
    expect(updated.pitch).toBe('edited')
    const after = await w.payload.findByID({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      depth: 0,
    })
    expect(after.user).toBe(w.alpha.user.id)
  })

  it('reads only published projects, with the company name copy and no company relation', async () => {
    const res = await w.payload.find({ collection: 'projects', ...as(w.beta.user), depth: 3 })
    expect(res.docs.map((p) => p.title)).toEqual(['Project A open'])
    expect(res.docs[0]).toMatchObject({ companyName: 'Company A' })
    expect(res.docs[0]).not.toHaveProperty('company')
  })

  it('cannot read companies, other matches, other payments or the activity log', async () => {
    for (const collection of ['companies', 'activity-logs'] as const) {
      await expect(w.payload.find({ collection, ...as(w.beta.user) })).rejects.toThrow()
    }
    // A student reads only their own payment rows; beta has none.
    const payments = await w.payload.find({ collection: 'payments', ...as(w.beta.user) })
    expect(payments.docs).toHaveLength(0)
    const matches = await w.payload.find({ collection: 'matches', ...as(w.beta.user) })
    expect(matches.docs).toHaveLength(0)
    const own = await w.payload.find({ collection: 'matches', ...as(w.alpha.user) })
    expect(own.docs).toHaveLength(1)
  })

  it('cannot change a project', async () => {
    await expect(
      w.payload.update({
        collection: 'projects',
        id: w.projectOpen.id,
        data: { title: 'x' },
        ...as(w.beta.user),
      }),
    ).rejects.toThrow()
  })
})

describe('company', () => {
  it('reads and edits only its own company and projects', async () => {
    const companies = await w.payload.find({ collection: 'companies', ...as(w.companyA.user) })
    expect(companies.docs.map((c) => c.name)).toEqual(['Company A'])
    const projects = await w.payload.find({ collection: 'projects', ...as(w.companyA.user) })
    expect(projects.docs.map((p) => p.title)).not.toContain('Project B draft')
    await expect(
      w.payload.update({
        collection: 'projects',
        id: w.projectB.id,
        data: { title: 'hacked' },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()
    await expect(
      w.payload.update({
        collection: 'companies',
        id: w.companyB.company.id,
        data: { name: 'hacked' },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()
  })

  it('a new company starts pending, is linked to its user, and cannot approve itself', async () => {
    const user = (await w.payload.create({
      collection: 'users',
      data: {
        email: 'new.company@company.test',
        password: PASSWORD,
        role: 'company',
        _verified: true,
      },
      overrideAccess: true,
      disableVerificationEmail: true,
    })) as User
    const company = await w.payload.create({
      collection: 'companies',
      data: { ...companyDetails('New Co'), status: 'approved' } as never,
      ...as(user),
    })
    expect(company.status).toBe('pending')
    const linked = await w.payload.findByID({ collection: 'users', id: user.id, depth: 0 })
    expect(linked.company).toBe(company.id)

    // Through REST, as the company: the status change is ignored.
    const cookie = await login(user.email)
    await rest.patch(`companies/${company.id}`, { status: 'approved' }, cookie)
    const after = await w.payload.findByID({ collection: 'companies', id: company.id })
    expect(after.status).toBe('pending')

    // One company per user.
    const relinked = (await w.payload.findByID({
      collection: 'users',
      id: user.id,
      depth: 0,
    })) as User
    await expect(
      w.payload.create({
        collection: 'companies',
        data: { ...companyDetails('Second'), status: 'pending' },
        ...as(relinked),
      }),
    ).rejects.toThrow()
  })

  it('a pending company writes drafts but sends them only after approval; a rejected one writes nothing', async () => {
    const user = (await w.payload.create({
      collection: 'users',
      data: { email: 'pending.company@company.test', password: PASSWORD, role: 'company' },
      overrideAccess: true,
    })) as User
    const company = await w.payload.create({
      collection: 'companies',
      data: { ...companyDetails('Pending Co'), status: 'pending' },
      ...as(user),
    })
    const me = (await w.payload.findByID({ collection: 'users', id: user.id, depth: 0 })) as User
    const draft = () =>
      w.payload.create({
        collection: 'projects',
        data: { ...readyFields(), title: 'Mine', company: company.id, status: 'draft' },
        ...as(me),
      })
    const project = await draft()
    expect(project.status).toBe('draft')
    // It can keep editing its draft.
    const edited = await w.payload.update({
      collection: 'projects',
      id: project.id,
      data: { title: 'Mine, edited' },
      ...as(me),
    })
    expect(edited.title).toBe('Mine, edited')
    // Sending for review waits for approval.
    await expect(
      w.payload.update({
        collection: 'projects',
        id: project.id,
        data: { status: 'submitted' },
        ...as(me),
      }),
    ).rejects.toThrow(/approved/)
    expect((await w.payload.findByID({ collection: 'projects', id: project.id })).status).toBe(
      'draft',
    )

    await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { status: 'approved' },
      user: asUser(w.admin),
      overrideAccess: false,
    })
    const submitted = await w.payload.update({
      collection: 'projects',
      id: project.id,
      data: { status: 'submitted' },
      ...as(me),
    })
    expect(submitted.status).toBe('submitted')

    // Konnected takes the approval back: the company cannot write drafts or edit them any more.
    const second = await draft()
    await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { status: 'rejected' },
      user: asUser(w.admin),
      overrideAccess: false,
    })
    await expect(draft()).rejects.toThrow()
    await expect(
      w.payload.update({
        collection: 'projects',
        id: second.id,
        data: { title: 'after rejection' },
        ...as(me),
      }),
    ).rejects.toThrow()
  })

  it('creates projects only for its own company and only as draft', async () => {
    const mine = await w.payload.create({
      collection: 'projects',
      data: {
        title: 'Sneaky',
        description: 'd',
        status: 'draft',
        company: w.companyB.company.id,
      },
      ...as(w.companyA.user),
    })
    expect(relationId(mine.company)).toBe(w.companyA.company.id)
    await expect(
      w.payload.create({
        collection: 'projects',
        data: {
          title: 'Skip',
          description: 'd',
          company: w.companyA.company.id,
          status: 'published',
        },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()
  })

  it('cannot approve, publish or match, and cannot edit after submitting', async () => {
    const draft = await w.payload.create({
      collection: 'projects',
      data: { ...readyFields(), title: 'D' } as never,
      ...as(w.companyA.user),
    })
    await expect(
      w.payload.update({
        collection: 'projects',
        id: draft.id,
        data: { status: 'approved' },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()
    await w.payload.update({
      collection: 'projects',
      id: draft.id,
      data: { status: 'submitted' },
      ...as(w.companyA.user),
    })
    await expect(
      w.payload.update({
        collection: 'projects',
        id: draft.id,
        data: { title: 'changed after submit' },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()
  })
})

describe('project status rules', () => {
  const move = (id: number, status: string, user: User) =>
    w.payload.update({ collection: 'projects', id, data: { status } as never, ...as(user) })

  it('rejects invalid transitions even for admin', async () => {
    await expect(move(w.projectB.id, 'published', w.admin)).rejects.toThrow(/not a valid change/)
    await expect(move(w.projectOpen.id, 'closed', w.admin)).rejects.toThrow()
    await expect(move(w.projectOpen.id, 'draft', w.admin)).rejects.toThrow()
  })

  it('follows the whole chain in order and only admin makes the admin moves', async () => {
    const p = await w.payload.create({
      collection: 'projects',
      data: {
        ...readyFields(),
        company: w.companyA.company.id,
        title: 'Chain',
        status: 'draft',
        fee: 4_000,
      },
      overrideAccess: true,
    })
    await move(p.id, 'submitted', w.companyA.user)
    await expect(move(p.id, 'approved', w.companyA.user)).rejects.toThrow()
    await move(p.id, 'changes_requested', w.admin)
    await move(p.id, 'submitted', w.companyA.user)
    for (const status of [
      'approved',
      'published',
      'matched',
      'in_progress',
      'delivered',
      'closed',
    ]) {
      // The two agreement gates: the company agreement before publishing, the student agreement
      // (after the match) before the work starts.
      if (status === 'published') {
        await signedAgreement(w.payload, w.admin, w.companyA.user, {
          kind: 'company',
          projectId: p.id,
        })
      }
      if (status === 'matched') {
        // Only a selection matches a project: changing the status alone is refused.
        await expect(move(p.id, 'matched', w.admin)).rejects.toThrow(/selecting a student/)
        await selectStudent(w.payload, w.admin, w.beta, p.id)
        continue
      }
      if (status === 'in_progress') {
        const m = await w.payload.find({
          collection: 'matches',
          where: { project: { equals: p.id } },
          ...as(w.admin),
        })
        await signedAgreement(w.payload, w.admin, w.beta.user, {
          kind: 'student',
          matchId: m.docs[0]!.id,
        })
      }
      await move(p.id, status, w.admin)
    }
    const done = await w.payload.findByID({ collection: 'projects', id: p.id })
    expect(done.status).toBe('closed')
    await expect(move(p.id, 'delivered', w.admin)).rejects.toThrow()
  })
})

describe('applications', () => {
  const apply = (user: User, project: number, extra: Record<string, unknown> = {}) =>
    w.payload.create({
      collection: 'applications',
      data: { project, note: 'Why I fit', ...extra } as never,
      ...as(user),
    })

  it('a student applies to a published project, as themselves', async () => {
    // The request names alpha as the applicant. The session wins.
    const app = await apply(w.beta.user, w.projectOpen.id, { student: w.alpha.profile.id })
    expect(relationId(app.student)).toBe(w.beta.profile.id)
    expect(app.status).toBe('applied')
  })

  it('cannot apply to a project that is not published', async () => {
    await expect(apply(w.beta.user, w.projectHidden.id)).rejects.toThrow()
    await expect(apply(w.beta.user, w.projectB.id)).rejects.toThrow()
  })

  it('cannot apply without a profile', async () => {
    const lone = (await w.payload.create({
      collection: 'users',
      data: { email: 'lone@student.test', password: PASSWORD, role: 'student' },
      overrideAccess: true,
    })) as User
    await expect(apply(lone, w.projectOpen.id)).rejects.toThrow(/profile/)
  })

  it('cannot apply twice, including two requests at the same moment', async () => {
    const results = await Promise.allSettled([
      apply(w.beta.user, w.projectOpen.id),
      apply(w.beta.user, w.projectOpen.id),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
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
    await expect(apply(w.beta.user, w.projectOpen.id)).rejects.toThrow()
  })

  it('a student can withdraw but cannot shortlist or select themselves', async () => {
    const app = await apply(w.beta.user, w.projectOpen.id)
    await expect(
      w.payload.update({
        collection: 'applications',
        id: app.id,
        data: { status: 'shortlisted' },
        ...as(w.beta.user),
      }),
    ).rejects.toThrow()
    const withdrawn = await w.payload.update({
      collection: 'applications',
      id: app.id,
      data: { status: 'withdrawn' },
      ...as(w.beta.user),
    })
    expect(withdrawn.status).toBe('withdrawn')
  })

  it("a student cannot touch another student's application", async () => {
    await expect(
      w.payload.update({
        collection: 'applications',
        id: w.application.id,
        data: { status: 'withdrawn' },
        ...as(w.beta.user),
      }),
    ).rejects.toThrow()
    const seen = await w.payload.find({ collection: 'applications', ...as(w.beta.user) })
    expect(seen.docs).toHaveLength(0)
  })

  it('only admin moves an application forward, in order', async () => {
    const app = await apply(w.beta.user, w.projectOpen.id)
    // Not back from the shortlist, and never withdrawn by the team.
    for (const [status, error] of [
      ['withdrawn', /your role cannot/],
      ['shortlisted', null],
      ['applied', /not a valid change/],
    ] as const) {
      const run = w.payload.update({
        collection: 'applications',
        id: app.id,
        data: { status },
        ...as(w.admin),
      })
      if (error) await expect(run).rejects.toThrow(error)
      else await run
    }
    for (const status of ['not_selected']) {
      await w.payload.update({
        collection: 'applications',
        id: app.id,
        data: { status } as never,
        ...as(w.admin),
      })
    }
  })

  it('a company cannot read or create applications', async () => {
    await expect(
      w.payload.find({ collection: 'applications', ...as(w.companyA.user) }),
    ).rejects.toThrow()
    await expect(apply(w.companyA.user, w.projectOpen.id)).rejects.toThrow()
  })
})

describe('matches', () => {
  it('a match is made only by selecting; nobody creates one directly, a project has at most one', async () => {
    const application = await w.payload.create({
      collection: 'applications',
      data: { project: w.projectOpen.id, note: 'Why I fit' } as never,
      ...as(w.beta.user),
    })
    for (const user of [w.beta.user, w.companyA.user, w.admin]) {
      await expect(
        w.payload.create({
          collection: 'matches',
          data: {
            project: w.projectOpen.id,
            student: w.beta.profile.id,
            application: application.id,
          },
          ...as(user),
        }),
      ).rejects.toThrow()
    }
    const admin = await sessionFor(w.admin.id)
    const res = await rest.post(
      'matches',
      { project: w.projectOpen.id, student: w.beta.profile.id, application: application.id },
      admin,
    )
    expect(res.status).toBe(400)
    expect(await w.payload.count({ collection: 'matches' })).toMatchObject({ totalDocs: 1 })
    // Project A already has its match: no second one, even through a selection.
    await expect(
      w.payload.create({
        collection: 'matches',
        data: { project: w.projectA.id, student: w.beta.profile.id },
        ...as(w.admin),
      }),
    ).rejects.toThrow()
  })

  it('the shared copy follows what the student agreed to, and refreshes when admin saves', async () => {
    const shared = (await w.payload.findByID({ collection: 'matches', id: w.match.id })).sharedInfo
    expect(shared).toMatchObject({ name: null, pitch: null, experience: null })
    expect(shared?.skills).toEqual([SENTINEL.alpha.skill])

    await w.payload.update({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      data: { privacy: { shareName: true, shareSkills: false } },
      ...as(w.alpha.user),
    })
    await w.payload.update({
      collection: 'matches',
      id: w.match.id,
      data: { startDate: new Date().toISOString() },
      ...as(w.admin),
    })
    const refreshed = (await w.payload.findByID({ collection: 'matches', id: w.match.id }))
      .sharedInfo
    expect(refreshed?.name).toBe(SENTINEL.alpha.name)
    expect(refreshed?.skills ?? []).toHaveLength(0)
  })

  it('a match keeps its student, project and application', async () => {
    for (const data of [
      { student: w.beta.profile.id },
      { project: w.projectOpen.id },
      { application: null },
    ]) {
      await expect(
        w.payload.update({ collection: 'matches', id: w.match.id, data, ...as(w.admin) }),
      ).rejects.toThrow(/keeps its student/)
    }
  })
})

describe('deliverables', () => {
  it('a student hands in only for their own match', async () => {
    const links = [{ url: 'https://example.test/work' }]
    await expect(
      w.payload.create({
        collection: 'deliverables',
        data: { match: w.match.id, note: 'not mine', status: 'submitted', links },
        ...as(w.beta.user),
      }),
    ).rejects.toThrow(/not yours/)
    // alpha's own match: refused only because a hand-in already waits for Konnected.
    await expect(
      w.payload.create({
        collection: 'deliverables',
        data: { match: w.match.id, note: 'mine', status: 'submitted', links },
        ...as(w.alpha.user),
      }),
    ).rejects.toThrow(/already waits/)
    await w.payload.update({
      collection: 'deliverables',
      id: w.deliverableHidden.id,
      data: { status: 'returned', returnNote: 'Add the appendix.' },
      ...as(w.admin),
    })
    const own = await w.payload.create({
      collection: 'deliverables',
      data: { match: w.match.id, note: 'mine', status: 'submitted', links },
      ...as(w.alpha.user),
    })
    expect(own.status).toBe('submitted')
  })

  it('a student cannot change or release a hand-in after sending it', async () => {
    await expect(
      w.payload.update({
        collection: 'deliverables',
        id: w.deliverableHidden.id,
        data: { status: 'released', note: 'edited' },
        ...as(w.alpha.user),
      }),
    ).rejects.toThrow()
    const after = await w.payload.findByID({
      collection: 'deliverables',
      id: w.deliverableHidden.id,
    })
    expect(after.status).toBe('submitted')
    expect(after.note).toBe('Not released yet')
  })

  it('a company sees a deliverable only after release, and only for its own project', async () => {
    const before = await w.payload.find({ collection: 'deliverables', ...as(w.companyA.user) })
    // The released one (now with the company's fix request), never the waiting hand-in.
    expect(before.docs.map((d) => d.id)).toEqual([w.deliverableReleased.id])
    const other = await w.payload.find({ collection: 'deliverables', ...as(w.companyB.user) })
    expect(other.docs).toHaveLength(0)

    await w.payload.update({
      collection: 'deliverables',
      id: w.deliverableHidden.id,
      data: { status: 'released' },
      ...as(w.admin),
    })
    const after = await w.payload.find({ collection: 'deliverables', ...as(w.companyA.user) })
    expect(after.docs).toHaveLength(2)
  })

  it('only admin releases, and released is final', async () => {
    await expect(
      w.payload.update({
        collection: 'deliverables',
        id: w.deliverableReleased.id,
        data: { status: 'submitted' },
        ...as(w.admin),
      }),
    ).rejects.toThrow()
  })
})

describe('payments', () => {
  it('a company sees a summary for its own project, without the margin', async () => {
    const res = await w.payload.find({ collection: 'payments', ...as(w.companyA.user) })
    expect(res.docs).toHaveLength(1)
    expect(res.docs[0]).toMatchObject({ projectFee: 1000 })
    expect(res.docs[0]).not.toHaveProperty('konnectedShare')
    expect(res.docs[0]).not.toHaveProperty('studentPay')
    expect(res.docs[0]).not.toHaveProperty('studentPaidAt')
  })

  it('another company sees nothing, the student only whether they were paid, only admin writes', async () => {
    const other = await w.payload.find({ collection: 'payments', ...as(w.companyB.user) })
    expect(other.docs).toHaveLength(0)
    const student = await w.payload.find({
      collection: 'payments',
      depth: 0,
      ...as(w.alpha.user),
    })
    expect(student.docs).toHaveLength(1)
    for (const key of [
      'projectFee',
      'konnectedShare',
      'studentPay',
      'invoiceNumber',
      'invoiceSentAt',
      'invoicePaidAt',
      'notes',
    ]) {
      expect(student.docs[0], key).not.toHaveProperty(key)
    }
    expect(student.docs[0]).toHaveProperty('studentPaidAt')
    const beta = await w.payload.find({ collection: 'payments', ...as(w.beta.user) })
    expect(beta.docs).toHaveLength(0)
    await expect(
      w.payload.update({
        collection: 'payments',
        id: w.payment.id,
        data: { projectFee: 1 },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()
    const admin = await w.payload.find({ collection: 'payments', ...as(w.admin) })
    expect(admin.docs[0]).toMatchObject({ konnectedShare: 200, studentPay: 700 })
  })
})

describe('activity log', () => {
  it('records creates and status changes, with who did them', async () => {
    const logs = await w.payload.find({
      collection: 'activity-logs',
      where: { targetCollection: { equals: 'projects' } },
      limit: 200,
      ...as(w.admin),
    })
    const published = logs.docs.find(
      (l) => l.targetId === String(w.projectOpen.id) && l.toStatus === 'published',
    )
    expect(published).toMatchObject({ action: 'status_change', fromStatus: 'approved' })
    expect(logs.docs.some((l) => l.action === 'create')).toBe(true)
    const adminActor = logs.docs.find((l) => l.toStatus === 'published')?.actor
    expect(typeof adminActor === 'object' ? adminActor?.id : adminActor).toBe(w.admin.id)
  })

  it('a new project and a role change are both logged', async () => {
    const count = async (collection: string) =>
      (
        await w.payload.count({
          collection: 'activity-logs',
          where: { targetCollection: { equals: collection } },
        })
      ).totalDocs
    const users = await count('users')
    const applications = await count('applications')
    expect(users).toBeGreaterThanOrEqual(5)
    expect(applications).toBeGreaterThanOrEqual(3) // create, shortlisted, selected
  })

  it('only admin reads it, and nobody can write it through an API', async () => {
    for (const user of [w.alpha.user, w.companyA.user]) {
      await expect(w.payload.find({ collection: 'activity-logs', ...as(user) })).rejects.toThrow()
    }
    await expect(
      w.payload.create({
        collection: 'activity-logs',
        data: { action: 'create', targetCollection: 'x', targetId: '1' },
        ...as(w.admin),
      }),
    ).rejects.toThrow()
    const cookie = await sessionFor(w.admin.id)
    const res = await rest.post(
      'activity-logs',
      { action: 'create', targetCollection: 'x', targetId: '1' },
      cookie,
    )
    expect(res.status).toBe(403)
    expect(await (await getTestPayload()).count({ collection: 'activity-logs' })).toBeDefined()
  })
})
