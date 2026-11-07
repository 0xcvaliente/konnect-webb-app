import { beforeEach, describe, expect, it, vi } from 'vitest'

import { registerCompany, saveCompany, type SessionUser } from '@/lib/companies/company'
import { formatOrgNumber, isValidOrgNumber, normalizeWebsite } from '@/lib/companies/fields'
import type { Company, CompanyLogo, User } from '@/payload-types'

import { signedAgreement } from '../helpers/agreements'
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
  sessionFor,
  type World,
} from '../helpers/world'

/**
 * The company registration card: the onboarding and profile Server Actions, the access rules on
 * companies and their logos, the one-user rule (also under a race) and what a pending company
 * cannot do. Each rule runs as admin, student, company, a user without a role and anonymous.
 * Local API calls pass `overrideAccess: false` and a user.
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
  await resetDatabase()
  w = await createWorld()
  requestHeaders.cookie = ''
})

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User): SessionUser => asUser(user) as SessionUser

let counter = 0
async function makeUser(role: User['role'], email = `user${++counter}@company.test`) {
  return (await w.payload.create({
    collection: 'users',
    data: { email, password: PASSWORD, role, _verified: true } as never,
    overrideAccess: true,
    disableVerificationEmail: true,
  })) as User
}

/** Read a user again, as the next request would (with its company link). */
const fresh = async (user: User) =>
  (await w.payload.findByID({ collection: 'users', id: user.id, depth: 0 })) as User

const companyOf = async (user: User) => {
  const found = await w.payload.find({
    collection: 'companies',
    where: { user: { equals: user.id } },
    depth: 0,
  })
  return found.docs[0] as Company | undefined
}

function registrationForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData()
  const values: Record<string, string> = {
    name: 'Fjordfrukt AS',
    orgNumber: '999 123 457',
    contactName: 'Marte Haugen',
    contactRole: 'Founder',
    website: 'fjordfrukt.example',
    sector: 'food',
    description: 'We make oat drinks.',
    logo: 'none',
    ...overrides,
  }
  for (const [key, value] of Object.entries(values)) form.set(key, value)
  return form
}

/** A new company user who registered a company through the onboarding. */
async function registered(overrides: Record<string, string> = {}) {
  const user = await makeUser('company')
  const result = await registerCompany(w.payload, session(user), registrationForm(overrides))
  expect(result).toMatchObject({ status: 'done' })
  const company = (await companyOf(user))!
  return { user: await fresh(user), company }
}

const approve = (id: number, status: Company['status'] = 'approved') =>
  w.payload.update({
    collection: 'companies',
    id,
    data: { status },
    ...as(w.admin),
  })

async function uploadLogo(user: User, name = 'logo.png') {
  return (await w.payload.create({
    collection: 'company-logos',
    data: {} as never,
    file: fileOf(await makePng(), name, 'image/png'),
    depth: 0,
    ...as(user),
  })) as CompanyLogo
}

describe('organisation number and website rules', () => {
  it('accepts nine digits with a valid modulus 11 check digit, with or without spaces', () => {
    expect(isValidOrgNumber('999123457')).toBe(true)
    expect(isValidOrgNumber('999 123 457')).toBe(true)
    expect(isValidOrgNumber('923609016')).toBe(true)
    expect(isValidOrgNumber('999123456')).toBe(false) // wrong check digit
    expect(isValidOrgNumber('99912345')).toBe(false) // eight digits
    expect(isValidOrgNumber('9991234570')).toBe(false) // ten digits
    expect(isValidOrgNumber('99912345A')).toBe(false)
    // When the check digit would be 10, no number with that start is valid.
    const weights = [3, 2, 7, 6, 5, 4, 3, 2]
    let start = 10000000
    while (weights.reduce((t, x, i) => t + x * Number(String(start)[i]), 0) % 11 !== 1) start++
    for (let d = 0; d <= 9; d++) expect(isValidOrgNumber(`${start}${d}`)).toBe(false)
    expect(formatOrgNumber('999123457')).toBe('999 123 457')
  })

  it('turns a typed website into a full http(s) address and refuses anything else', () => {
    expect(normalizeWebsite('fjordfrukt.no')).toBe('https://fjordfrukt.no')
    expect(normalizeWebsite('http://fjordfrukt.no/om')).toBe('http://fjordfrukt.no/om')
    for (const bad of [
      'javascript:alert(1)',
      'ftp://fjordfrukt.no',
      'https://user:pw@fjordfrukt.no',
      'localhost',
      'not a site',
      'data:text/html,hi',
    ]) {
      expect(normalizeWebsite(bad), bad).toBeNull()
    }
  })
})

describe('registration (registerCompany)', () => {
  it('a company user without a company registers it: pending, linked both ways, values stored clean', async () => {
    const { user, company } = await registered()
    expect(company).toMatchObject({
      name: 'Fjordfrukt AS',
      orgNumber: '999123457',
      contactName: 'Marte Haugen',
      contactRole: 'Founder',
      website: 'https://fjordfrukt.example',
      sector: 'food',
      status: 'pending',
      approvedAt: null,
    })
    expect(company.user).toBe(user.id)
    expect(user.company).toBe(company.id)

    // The registration is logged.
    const logs = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [
          { targetCollection: { equals: 'companies' } },
          { targetId: { equals: String(company.id) } },
        ],
      },
    })
    expect(logs.docs.map((l) => l.action)).toContain('create')
  })

  it('checks every answer on the server', async () => {
    const user = await makeUser('company')
    const result = await registerCompany(
      w.payload,
      session(user),
      registrationForm({
        name: '',
        orgNumber: '999 123 456',
        contactName: 'x'.repeat(200),
        contactRole: '',
        website: 'javascript:alert(1)',
        sector: 'weapons',
        description: '',
        logo: 'abc',
      }),
    )
    expect(result).toEqual({
      status: 'error',
      fields: {
        name: 'required',
        orgNumber: 'invalid',
        contactName: 'too_long',
        contactRole: 'required',
        website: 'invalid',
        sector: 'invalid',
        description: 'required',
        logo: 'invalid',
      },
    })
    expect(await companyOf(user)).toBeUndefined()
  })

  it('the collection itself refuses a company user who skips the onboarding (REST)', async () => {
    const user = await makeUser('company')
    const cookie = await login(user.email)
    const bare = await rest.post('companies', { name: 'Only a name' }, cookie)
    expect(bare.status).toBe(400)
    const badOrg = await rest.post(
      'companies',
      { ...companyDetails('Bad Org'), orgNumber: '123456789' },
      cookie,
    )
    expect(badOrg.status).toBe(400)
    const badSite = await rest.post(
      'companies',
      { ...companyDetails('Bad Site'), website: 'javascript:alert(1)' },
      cookie,
    )
    expect(badSite.status).toBe(400)
    expect(await companyOf(user)).toBeUndefined()

    // Status, user, owner and approval date in the request are ignored.
    const ok = await rest.post(
      'companies',
      {
        ...companyDetails('Sneaky AS'),
        status: 'approved',
        user: w.alpha.user.id,
        teamOwner: w.admin.id,
        approvedAt: new Date().toISOString(),
      },
      cookie,
    )
    expect(ok.status).toBe(201)
    const stored = await w.payload.findByID({
      collection: 'companies',
      id: (ok.json.doc as { id: number }).id,
      depth: 0,
    })
    expect(stored).toMatchObject({
      status: 'pending',
      user: user.id,
      teamOwner: null,
      approvedAt: null,
    })
  })

  it('works once: a second registration is refused', async () => {
    const { user } = await registered()
    expect(await registerCompany(w.payload, session(user), registrationForm())).toEqual({
      status: 'error',
      error: 'exists',
    })
    const cookie = await login(user.email)
    expect((await rest.post('companies', companyDetails('Second'), cookie)).status).toBe(403)
    expect(
      (await w.payload.count({ collection: 'companies', where: { user: { equals: user.id } } }))
        .totalDocs,
    ).toBe(1)
  })

  it('works once even under a race: two registrations at the same moment make one company', async () => {
    const user = await makeUser('company')
    const results = await Promise.allSettled([
      registerCompany(w.payload, session(user), registrationForm({ name: 'Race One' })),
      registerCompany(w.payload, session(user), registrationForm({ name: 'Race Two' })),
      w.payload.create({
        collection: 'companies',
        data: { ...companyDetails('Race Three'), status: 'pending' },
        ...as(user),
      }),
    ])
    expect(results.every((r) => r.status === 'fulfilled' || r.status === 'rejected')).toBe(true)
    const companies = await w.payload.find({
      collection: 'companies',
      where: { user: { equals: user.id } },
      depth: 0,
    })
    expect(companies.totalDocs).toBe(1)
    expect((await fresh(user)).company).toBe(companies.docs[0]!.id)
    // No company was left behind without its user.
    expect(
      (await w.payload.count({ collection: 'companies', where: { name: { like: 'Race' } } }))
        .totalDocs,
    ).toBe(1)
  })

  it('admin, student, a user without a role and anonymous cannot register a company', async () => {
    const pending = await makeUser('pending')
    for (const user of [w.admin, w.alpha.user, pending, null]) {
      expect(
        await registerCompany(w.payload, user ? session(user) : null, registrationForm()),
        user?.email ?? 'anonymous',
      ).toEqual({ status: 'error', error: 'forbidden' })
    }
    for (const user of [w.alpha.user, pending]) {
      await expect(
        w.payload.create({
          collection: 'companies',
          data: { ...companyDetails('Not mine'), status: 'pending' },
          ...as(user),
        }),
      ).rejects.toThrow()
    }
    expect((await rest.post('companies', companyDetails('Anon'), undefined)).status).toBe(403)
    expect(
      (
        await w.payload.count({
          collection: 'companies',
          where: { name: { equals: 'Fjordfrukt AS' } },
        })
      ).totalDocs,
    ).toBe(0)
  })
})

describe('one person per company account', () => {
  it('a second user cannot be linked to a company, through any way in', async () => {
    const second = await makeUser('company')

    // Local API with access control off still hits the unique index.
    await expect(
      w.payload.update({
        collection: 'users',
        id: second.id,
        data: { company: w.companyA.company.id },
        overrideAccess: true,
      }),
    ).rejects.toThrow()

    // Nobody writes `users.company` through the API, not even an admin: the value is dropped.
    const adminCookie = await sessionFor(w.admin.id)
    await rest.patch(`users/${second.id}`, { company: w.companyA.company.id }, adminCookie)
    const self = await login(second.email)
    await rest.patch(`users/${second.id}`, { company: w.companyA.company.id }, self)
    const graph = await graphql(
      `mutation { updateUser(id: ${second.id}, data: { company: ${w.companyA.company.id} }) { id } }`,
      adminCookie,
    )
    expect(graph.status).toBeLessThan(500)
    expect((await fresh(second)).company ?? null).toBeNull()

    // A company cannot take on a user who already has another company.
    await expect(
      w.payload.update({
        collection: 'companies',
        id: w.companyA.company.id,
        data: { user: w.companyB.user.id },
        ...as(w.admin),
      }),
    ).rejects.toThrow()

    const linked = await w.payload.find({
      collection: 'users',
      where: { company: { equals: w.companyA.company.id } },
      depth: 0,
    })
    expect(linked.docs.map((u) => u.id)).toEqual([w.companyA.user.id])
  })

  it('under a race, two users linked to one company at the same moment: only one sticks', async () => {
    const [one, two] = [await makeUser('company'), await makeUser('company')]
    const company = await w.payload.create({
      collection: 'companies',
      data: { ...companyDetails('Shared AS'), status: 'pending' },
      ...as(w.admin),
    })
    const results = await Promise.allSettled(
      [one, two].map((u) =>
        w.payload.update({
          collection: 'users',
          id: u.id,
          data: { company: company.id },
          overrideAccess: true,
        }),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const linked = await w.payload.count({
      collection: 'users',
      where: { company: { equals: company.id } },
    })
    expect(linked.totalDocs).toBe(1)
  })

  it('an admin can hand a company to another company user; the old user is unlinked', async () => {
    const next = await makeUser('company')
    await w.payload.update({
      collection: 'companies',
      id: w.companyA.company.id,
      data: { user: next.id },
      ...as(w.admin),
    })
    expect((await fresh(next)).company).toBe(w.companyA.company.id)
    expect((await fresh(w.companyA.user)).company ?? null).toBeNull()

    // Only company users can hold a company.
    await expect(
      w.payload.update({
        collection: 'companies',
        id: w.companyA.company.id,
        data: { user: w.alpha.user.id },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/not a company user/)
  })

  it('a company with a logo can be handed over; the admin and the new user can still save it', async () => {
    const { user: old, company } = await registered()
    const logo = await uploadLogo(old)
    await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { logo: logo.id },
      ...as(old),
    })
    const next = await makeUser('company')
    await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { user: next.id },
      ...as(w.admin),
    })
    expect(await approve(company.id)).toMatchObject({ status: 'approved', logo: { id: logo.id } })

    // The new user keeps the logo the old user uploaded, and the profile still saves.
    const form = registrationForm({ logo: String(logo.id), description: 'Under new hands' })
    form.delete('name')
    form.delete('orgNumber')
    expect(await saveCompany(w.payload, session(await fresh(next)), form)).toMatchObject({
      status: 'done',
    })
    const stored = await w.payload.findByID({ collection: 'companies', id: company.id, depth: 0 })
    expect(stored).toMatchObject({ user: next.id, logo: logo.id, description: 'Under new hands' })

    // The company still cannot take a logo the old user uploads after the handover.
    const stray = await uploadLogo(old, 'stray.png')
    await expect(
      w.payload.update({
        collection: 'companies',
        id: company.id,
        data: { logo: stray.id },
        ...as(await fresh(next)),
      }),
    ).rejects.toThrow(/does not belong/)
  })

  it('an admin attaches a logo they uploaded, and saves a company whose user is gone', async () => {
    const { user, company } = await registered()
    const own = await uploadLogo(user)
    await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { logo: own.id },
      ...as(user),
    })

    const adminLogo = await uploadLogo(w.admin, 'from-konnected.png')
    const attached = await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { logo: adminLogo.id },
      depth: 0,
      ...as(w.admin),
    })
    expect(attached.logo).toBe(adminLogo.id)

    // The user is deleted: the company keeps its logo and the team can still approve or rename it.
    await w.payload.delete({ collection: 'users', id: user.id, overrideAccess: true })
    const orphan = await w.payload.findByID({ collection: 'companies', id: company.id, depth: 0 })
    expect(orphan.user ?? null).toBeNull()
    expect(await approve(company.id)).toMatchObject({ status: 'approved' })
    const renamed = await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { name: 'Renamed by Konnected AS' },
      ...as(w.admin),
    })
    expect(renamed.name).toBe('Renamed by Konnected AS')
  })
})

describe('reading companies', () => {
  it('a company reads only its own company, through every way in', async () => {
    const local = await w.payload.find({ collection: 'companies', ...as(w.companyA.user) })
    expect(local.docs.map((c) => c.name)).toEqual(['Company A'])
    await expect(
      w.payload.findByID({
        collection: 'companies',
        id: w.companyB.company.id,
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()

    const cookie = await login(w.companyA.user.email)
    const list = await rest.get('companies?limit=100', cookie)
    expect((list.json.docs as { name: string }[]).map((c) => c.name)).toEqual(['Company A'])
    expect([403, 404]).toContain(
      (await rest.get(`companies/${w.companyB.company.id}`, cookie)).status,
    )
    const gql = await graphql('{ Companies(limit: 100) { docs { name } } }', cookie)
    expect(JSON.stringify(gql.json)).not.toContain('Company B')

    // Its own record shows the approval date but not who at Konnected owns it.
    const own = await rest.get(`companies/${w.companyA.company.id}`, cookie)
    expect(own.json).toHaveProperty('approvedAt')
    expect(own.json).not.toHaveProperty('teamOwner')
  })

  it('students, users without a role and anonymous visitors cannot read or list companies', async () => {
    const pending = await makeUser('pending')
    for (const user of [w.alpha.user, pending]) {
      await expect(w.payload.find({ collection: 'companies', ...as(user) })).rejects.toThrow()
      const cookie = await login(user.email)
      expect((await rest.get('companies', cookie)).status).toBe(403)
      expect((await rest.get(`companies/${w.companyA.company.id}`, cookie)).status).toBe(403)
      const gql = await graphql('{ Companies { docs { name } } }', cookie)
      expect(JSON.stringify(gql.json)).not.toContain('Company A')
    }
    expect((await rest.get('companies')).status).toBe(403)
  })

  it('admins list every company', async () => {
    const res = await w.payload.find({ collection: 'companies', ...as(w.admin) })
    expect(res.docs.map((c) => c.name).sort()).toEqual(['Company A', 'Company B'])
  })

  it('a student sees only the name and logo of a company on a published project', async () => {
    const logo = await uploadLogo(w.companyA.user)
    await w.payload.update({
      collection: 'companies',
      id: w.companyA.company.id,
      data: { logo: logo.id },
      ...as(w.companyA.user),
    })
    const cookie = await login(w.alpha.user.email)
    const res = await rest.get(`projects/${w.projectOpen.id}?depth=2`, cookie)
    expect(res.status).toBe(200)
    expect(res.json.companyName).toBe('Company A')
    expect(res.json).not.toHaveProperty('company')
    const copy = res.json.companyLogo as Record<string, unknown>
    expect(copy.id).toBe(logo.id)
    expect(copy).not.toHaveProperty('uploadedBy')
    expect(JSON.stringify(res.json)).not.toContain('Company A contact')
  })
})

describe('changing a company', () => {
  it('a pending company edits every field it filled in; status, user, owner and approval stay', async () => {
    const { user, company } = await registered()
    const form = registrationForm({
      name: 'Fjordfrukt Norge AS',
      orgNumber: '923609016',
      website: '',
      description: 'Oat drinks and oat ice cream.',
    })
    expect(await saveCompany(w.payload, session(user), form)).toMatchObject({ status: 'done' })
    const after = await w.payload.findByID({ collection: 'companies', id: company.id, depth: 0 })
    expect(after).toMatchObject({
      name: 'Fjordfrukt Norge AS',
      orgNumber: '923609016',
      website: null,
      description: 'Oat drinks and oat ice cream.',
      status: 'pending',
    })

    const cookie = await login(user.email)
    const res = await rest.patch(
      `companies/${company.id}`,
      {
        status: 'approved',
        user: w.companyB.user.id,
        teamOwner: w.admin.id,
        approvedAt: new Date().toISOString(),
      },
      cookie,
    )
    expect(res.status).toBe(200)
    expect(
      await w.payload.findByID({ collection: 'companies', id: company.id, depth: 0 }),
    ).toMatchObject({ status: 'pending', user: user.id, teamOwner: null, approvedAt: null })
  })

  it('a company cannot change another company', async () => {
    const cookie = await login(w.companyA.user.email)
    const res = await rest.patch(
      `companies/${w.companyB.company.id}`,
      { description: 'hacked' },
      cookie,
    )
    expect([403, 404]).toContain(res.status)
    const b = await w.payload.findByID({ collection: 'companies', id: w.companyB.company.id })
    expect(b.description).toBe('Company B description')
  })

  it('after approval the name and organisation number are fixed for the company, not for admins', async () => {
    const { user, company } = await registered()
    await approve(company.id)
    const me = session(await fresh(user))

    // The page sends no name or number once approved; the rest saves.
    const form = registrationForm({ description: 'New text' })
    form.delete('name')
    form.delete('orgNumber')
    expect(await saveCompany(w.payload, me, form)).toMatchObject({ status: 'done' })

    // A different name in the form is refused, not silently ignored.
    expect(await saveCompany(w.payload, me, registrationForm({ name: 'Renamed AS' }))).toEqual({
      status: 'error',
      fields: { name: 'locked' },
    })
    // Through the API too.
    await expect(
      w.payload.update({
        collection: 'companies',
        id: company.id,
        data: { orgNumber: '923609016' },
        ...as(me),
      }),
    ).rejects.toThrow(/after approval/)

    const after = await w.payload.findByID({ collection: 'companies', id: company.id })
    expect(after).toMatchObject({
      name: 'Fjordfrukt AS',
      orgNumber: '999123457',
      description: 'New text',
    })

    await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { name: 'Renamed by Konnected AS' },
      ...as(w.admin),
    })
    expect((await w.payload.findByID({ collection: 'companies', id: company.id })).name).toBe(
      'Renamed by Konnected AS',
    )
  })

  it('a rejected company corrects and sends once; after that it cannot change anything', async () => {
    const { user, company } = await registered()
    await approve(company.id, 'rejected')
    const me = await fresh(user)
    // Its one correction (owner decision) goes back to Konnected for review.
    expect(await saveCompany(w.payload, session(me), registrationForm())).toMatchObject({
      status: 'done',
    })
    const resent = await w.payload.findByID({ collection: 'companies', id: company.id })
    expect(resent.status).toBe('pending')
    expect(resent.resentAt).toBeTruthy()
    // Rejected again: no second correction.
    await approve(company.id, 'rejected')
    expect(await saveCompany(w.payload, session(me), registrationForm())).toEqual({
      status: 'error',
      error: 'not_editable',
    })
    await expect(
      w.payload.update({
        collection: 'companies',
        id: company.id,
        data: { description: 'changed' },
        ...as(me),
      }),
    ).rejects.toThrow()
  })

  it('admin, student, a user without a role and anonymous cannot use the profile save', async () => {
    const pending = await makeUser('pending')
    for (const user of [w.admin, w.alpha.user, pending, null]) {
      expect(await saveCompany(w.payload, user ? session(user) : null, registrationForm())).toEqual(
        { status: 'error', error: 'forbidden' },
      )
    }
    // A company user who has not registered yet is sent to the onboarding.
    const newcomer = await makeUser('company')
    expect(await saveCompany(w.payload, session(newcomer), registrationForm())).toEqual({
      status: 'error',
      error: 'no_company',
    })
  })

  it('only admins approve: the date is set and logged; the owner must be on the team', async () => {
    const { user, company } = await registered()
    await expect(
      w.payload.update({
        collection: 'companies',
        id: company.id,
        data: { status: 'approved' },
        ...as(w.alpha.user),
      }),
    ).rejects.toThrow()

    const approved = await approve(company.id)
    expect(approved.status).toBe('approved')
    expect(approved.approvedAt).toBeTruthy()
    const logs = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [
          { targetCollection: { equals: 'companies' } },
          { targetId: { equals: String(company.id) } },
          { action: { equals: 'status_change' } },
        ],
      },
    })
    expect(logs.docs[0]).toMatchObject({ fromStatus: 'pending', toStatus: 'approved' })

    await expect(
      w.payload.update({
        collection: 'companies',
        id: company.id,
        data: { teamOwner: user.id },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/must be on the team/)
    const owned = await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { teamOwner: w.admin.id },
      ...as(w.admin),
    })
    expect(owned.teamOwner).toMatchObject({ id: w.admin.id })

    // Taking the approval back clears the date.
    expect((await approve(company.id, 'rejected')).approvedAt).toBeNull()
  })

  it('a company with a Konnected owner still saves its profile, and never learns who it is', async () => {
    const { company, user } = w.companyA
    await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { teamOwner: w.admin.id },
      ...as(w.admin),
    })

    // The profile page.
    const form = registrationForm({ description: 'Saved again' })
    form.delete('name')
    form.delete('orgNumber')
    expect(await saveCompany(w.payload, session(await fresh(user)), form)).toMatchObject({
      status: 'done',
    })
    // The Local API as the company.
    await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { contactRole: 'CEO' },
      ...as(await fresh(user)),
    })
    // REST and GraphQL: saved, and nothing in the answer names the owner.
    const cookie = await login(user.email)
    const patched = await rest.patch(`companies/${company.id}`, { contactName: 'Via REST' }, cookie)
    expect(patched.status).toBe(200)
    expect(patched.json.doc).not.toHaveProperty('teamOwner')
    expect(patched.text).not.toMatch(/owner|invalid/i)
    expect(patched.text).not.toContain(w.admin.email)
    const gql = await graphql(
      `mutation { updateCompany(id: ${company.id}, data: { contactName: "Via GraphQL" }) { contactName } }`,
      cookie,
    )
    expect(gql.json).not.toHaveProperty('errors')
    expect(gql.text).not.toMatch(/owner|invalid/i)

    const stored = await w.payload.findByID({ collection: 'companies', id: company.id, depth: 0 })
    expect(stored).toMatchObject({
      teamOwner: w.admin.id,
      description: 'Saved again',
      contactRole: 'CEO',
      contactName: 'Via GraphQL',
    })
  })

  it('a pilot company Konnected added without an organisation number can save its profile', async () => {
    const user = await makeUser('company')
    const pilot = await w.payload.create({
      collection: 'companies',
      data: { name: 'Pilot AS', status: 'pending' },
      ...as(w.admin),
    })
    await w.payload.update({
      collection: 'companies',
      id: pilot.id,
      data: { status: 'approved', user: user.id },
      ...as(w.admin),
    })
    const me = await fresh(user)

    // The page sends no name or number once approved; the user fills in the rest.
    const form = registrationForm({ name: 'Pilot AS' })
    form.delete('orgNumber')
    expect(await saveCompany(w.payload, session(me), form)).toMatchObject({ status: 'done' })
    const cookie = await login(user.email)
    expect(
      (await rest.patch(`companies/${pilot.id}`, { description: 'Via REST' }, cookie)).status,
    ).toBe(200)

    // The blank number is still Konnected's to fill in, not the company's.
    await expect(
      w.payload.update({
        collection: 'companies',
        id: pilot.id,
        data: { orgNumber: '923609016' },
        ...as(me),
      }),
    ).rejects.toThrow(/after approval/)
    expect(
      (await w.payload.findByID({ collection: 'companies', id: pilot.id, depth: 0 })).orgNumber ??
        null,
    ).toBeNull()

    // While a company is pending its user must still give the number.
    const other = await makeUser('company')
    const pending = await w.payload.create({
      collection: 'companies',
      data: { ...companyDetails('Pending AS'), orgNumber: null, status: 'pending' },
      ...as(w.admin),
    })
    await w.payload.update({
      collection: 'companies',
      id: pending.id,
      data: { user: other.id },
      ...as(w.admin),
    })
    await expect(
      w.payload.update({
        collection: 'companies',
        id: pending.id,
        data: { description: 'changed' },
        ...as(await fresh(other)),
      }),
    ).rejects.toThrow(/Organisation number/)
  })
})

describe('a pending company writes drafts, but sends nothing until Konnected approves it', () => {
  it('drafts and brief files now, sending for review only after approval', async () => {
    const { user, company } = await registered()
    const me = await fresh(user)
    const cookie = await login(user.email)
    const local = await w.payload.create({
      collection: 'projects',
      data: { title: 'Early', company: company.id, status: 'draft' },
      ...as(me),
    })
    expect(local.status).toBe('draft')
    const viaRest = await rest.post('projects', { ...readyFields(), title: 'Early REST' }, cookie)
    expect(viaRest.status).toBe(201)
    const id = (viaRest.json.doc as { id: number }).id
    const brief = { data: makePdf('brief.pdf'), name: 'brief.pdf', type: 'application/pdf' }
    expect((await rest.upload('brief-files', brief, {}, cookie)).status).toBe(201)
    // Its own logo is part of the profile, so it can upload one.
    expect(
      (
        await rest.upload(
          'company-logos',
          { data: await makePng(), name: 'l.png', type: 'image/png' },
          {},
          cookie,
        )
      ).status,
    ).toBe(201)
    // Sending for review waits for approval, through every way in.
    expect((await rest.patch(`projects/${id}`, { status: 'submitted' }, cookie)).status).toBe(403)
    expect((await w.payload.findByID({ collection: 'projects', id })).status).toBe('draft')

    await approve(company.id)
    expect((await rest.patch(`projects/${id}`, { status: 'submitted' }, cookie)).status).toBe(200)
    expect((await w.payload.findByID({ collection: 'projects', id })).status).toBe('submitted')
  })
})

describe('company logos', () => {
  it('only PNG or JPG up to 1 MB; the uploader always comes from the session', async () => {
    const cookie = await login(w.companyA.user.email)
    const pdf = await rest.upload(
      'company-logos',
      { data: makePdf('x'), name: 'logo.png', type: 'image/png' },
      {},
      cookie,
    )
    expect(pdf.status).toBe(400)
    const svg = await rest.upload(
      'company-logos',
      {
        data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
        name: 'logo.svg',
        type: 'image/svg+xml',
      },
      {},
      cookie,
    )
    expect(svg.status).toBe(400)
    const big = Buffer.concat([await makePng(), Buffer.alloc(1024 * 1024 + 10)])
    const tooBig = await rest.upload(
      'company-logos',
      { data: big, name: 'big.png', type: 'image/png' },
      {},
      cookie,
    )
    expect(tooBig.status).toBe(413)
    const ok = await rest.upload(
      'company-logos',
      { data: await makePng(), name: 'logo.png', type: 'image/png' },
      { uploadedBy: w.companyB.user.id },
      cookie,
    )
    expect(ok.status).toBe(201)
    const doc = await w.payload.findByID({
      collection: 'company-logos',
      id: (ok.json.doc as { id: number }).id,
      depth: 0,
    })
    expect(doc.uploadedBy).toBe(w.companyA.user.id)

    // Students and visitors cannot upload.
    expect(
      (
        await rest.upload(
          'company-logos',
          { data: await makePng(), name: 'l.png', type: 'image/png' },
          {},
          await login(w.alpha.user.email),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await rest.upload(
          'company-logos',
          { data: await makePng(), name: 'l.png', type: 'image/png' },
          {},
        )
      ).status,
    ).toBe(403)
  })

  it('who can open a logo: its company and admins; students only once it is on a published project', async () => {
    const { user, company } = await registered()
    const logo = await uploadLogo(user)
    await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { logo: logo.id },
      ...as(await fresh(user)),
    })
    const cookies = {
      owner: await login(user.email),
      admin: await sessionFor(w.admin.id),
      otherCompany: await login(w.companyA.user.email),
      student: await login(w.alpha.user.email),
      anonymous: undefined,
    }
    const can = async (who: keyof typeof cookies) =>
      (await rest.get(`company-logos/file/${logo.filename}`, cookies[who])).status === 200
    expect(await can('owner')).toBe(true)
    expect(await can('admin')).toBe(true)
    expect(await can('otherCompany')).toBe(false)
    expect(await can('student')).toBe(false)
    expect(await can('anonymous')).toBe(false)

    // Konnected approves the company and publishes a project: the logo is copied onto it.
    await approve(company.id)
    let project = await w.payload.create({
      collection: 'projects',
      data: {
        title: 'Logo project',
        description: 'd',
        status: 'draft',
        paidOrUnpaid: 'unpaid',
      } as never,
      ...as(await fresh(user)),
    })
    expect(project.companyLogo).toMatchObject({ id: logo.id })
    for (const status of ['submitted', 'approved', 'published'] as const) {
      // Publishing needs the signed company agreement.
      if (status === 'published') {
        await signedAgreement(w.payload, w.admin, await fresh(user), {
          kind: 'company',
          projectId: project.id,
        })
      }
      project = await w.payload.update({
        collection: 'projects',
        id: project.id,
        // Konnected decides paid with a price: the test company template fills in the price.
        data: status === 'approved' ? { status, paidOrUnpaid: 'paid', fee: 1000 } : { status },
        ...as(w.admin),
      })
    }
    expect(await can('student')).toBe(true)
    expect(await can('otherCompany')).toBe(false)
    expect(await can('anonymous')).toBe(false)

    // The file is a download with locked-down headers, like every private file.
    const file = await rest.get(`company-logos/file/${logo.filename}`, cookies.student)
    expect(file.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it("a company cannot put another company's logo on its profile", async () => {
    const theirs = await uploadLogo(w.companyB.user)
    await expect(
      w.payload.update({
        collection: 'companies',
        id: w.companyA.company.id,
        data: { logo: theirs.id },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow(/does not belong/)
    // Not by naming the other user as the owner in the same request either.
    await expect(
      w.payload.update({
        collection: 'companies',
        id: w.companyA.company.id,
        data: { logo: theirs.id, user: w.companyB.user.id } as never,
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow(/does not belong/)
    const { user } = await registered()
    expect(
      await saveCompany(w.payload, session(user), registrationForm({ logo: String(theirs.id) })),
    ).toEqual({ status: 'error', fields: { logo: 'invalid' } })
  })

  it('a new logo or name reaches the copies on projects; the old logo file is removed', async () => {
    const first = await uploadLogo(w.companyA.user, 'first.png')
    await w.payload.update({
      collection: 'companies',
      id: w.companyA.company.id,
      data: { logo: first.id },
      ...as(w.companyA.user),
    })
    const read = () =>
      w.payload.findByID({ collection: 'projects', id: w.projectOpen.id, depth: 0 })
    expect((await read()).companyLogo).toBe(first.id)

    const second = await uploadLogo(w.companyA.user, 'second.png')
    const form = registrationForm({ logo: String(second.id), contactName: 'New contact' })
    form.delete('name')
    form.delete('orgNumber')
    expect(await saveCompany(w.payload, session(w.companyA.user), form)).toMatchObject({
      status: 'done',
    })
    expect((await read()).companyLogo).toBe(second.id)
    expect(
      (await w.payload.find({ collection: 'company-logos', where: { id: { equals: first.id } } }))
        .totalDocs,
    ).toBe(0)

    await w.payload.update({
      collection: 'companies',
      id: w.companyA.company.id,
      data: { name: 'Company A Renamed' },
      ...as(w.admin),
    })
    expect((await read()).companyName).toBe('Company A Renamed')
  })

  it('a logo in use cannot be deleted by the company; an unused one can', async () => {
    const used = await uploadLogo(w.companyA.user, 'used.png')
    await w.payload.update({
      collection: 'companies',
      id: w.companyA.company.id,
      data: { logo: used.id },
      ...as(w.companyA.user),
    })
    const spare = await uploadLogo(w.companyA.user, 'spare.png')
    const cookie = await login(w.companyA.user.email)
    expect([403, 404]).toContain((await rest.delete(`company-logos/${used.id}`, cookie)).status)
    expect(
      (await rest.delete(`company-logos/${spare.id}`, await login(w.companyB.user.email))).status,
    ).not.toBe(200)
    expect((await rest.delete(`company-logos/${spare.id}`, cookie)).status).toBe(200)
  })
})

describe('the Server Actions read the session themselves', () => {
  it('anonymous and student sessions are refused; a company session registers', async () => {
    const { registerCompanyAction, saveCompanyAction } = await import('@/lib/companies/actions')
    const idle = { status: 'idle' as const }

    requestHeaders.cookie = ''
    expect(await registerCompanyAction(idle, registrationForm())).toEqual({
      status: 'error',
      error: 'forbidden',
    })
    requestHeaders.cookie = await login(w.alpha.user.email)
    expect(await saveCompanyAction(idle, registrationForm())).toEqual({
      status: 'error',
      error: 'forbidden',
    })

    const user = await makeUser('company')
    requestHeaders.cookie = await login(user.email)
    expect(await registerCompanyAction(idle, registrationForm())).toMatchObject({
      status: 'done',
    })
    expect((await companyOf(user))?.user).toBe(user.id)
    // The next request knows the company: a second registration is refused.
    expect(await registerCompanyAction(idle, registrationForm())).toEqual({
      status: 'error',
      error: 'exists',
    })
  })
})
