import { beforeAll, describe, expect, it } from 'vitest'

import {
  asUser,
  createWorld,
  graphql,
  login,
  PASSWORD,
  sessionFor,
  resetDatabase,
  rest,
  SENTINEL,
  type World,
} from '../helpers/world'

/**
 * The rule that matters most: a company never reads student personal data, at any depth, through
 * any API. Every check runs through all three ways in: the Local API with access control on, REST,
 * and GraphQL. Each also has a positive control: the same query as admin DOES return the data, so
 * we know the check could fail.
 */

const SLUGS = [
  'users',
  'student-profiles',
  'companies',
  'projects',
  'applications',
  'matches',
  'deliverables',
  'payments',
  'activity-logs',
  'cvs',
  'deliverable-files',
  'brief-files',
  'company-logos',
] as const

// What a company must never see about student alpha. alpha shares only skills, so the skill is
// allowed (and expected) in a match's sharedInfo. beta shares nothing.
const FORBIDDEN = [
  ...Object.entries(SENTINEL.alpha)
    .filter(([key]) => key !== 'skill')
    .map(([, value]) => value),
  ...Object.values(SENTINEL.beta),
  'Sentinel-Agreement-Notes',
]

const GRAPHQL_QUERIES: Record<(typeof SLUGS)[number], string> = {
  users:
    '{ Users(limit: 100) { docs { id email name role accountStatus lastSignInAt company { id } } } }',
  'student-profiles':
    '{ StudentProfiles(limit: 100) { docs { id name school programme year contactEmail phone pitch experience highlights skills interests preferredProjectTypes reviewStatus reviewedAt privacy { shareName shareSchool shareContactEmail sharePhone } user { id email } } } }',
  companies:
    '{ Companies(limit: 100) { docs { id name orgNumber contactName contactRole website sector description status approvedAt user { id email } teamOwner { id email } logo { id url } } } }',
  projects:
    '{ Projects(limit: 100) { docs { id title description tasks deliverable desiredSkills workloadHours durationWeeks startDate workMode location paidOrUnpaid unpaidBenefit deadline fee noteToCompany noteToCompanyAt status companyName company { id name } attachments { id originalName } } } }',
  applications:
    '{ Applications(limit: 100) { docs { id status note student { id name contactEmail user { id email } } project { id title } } } }',
  matches:
    '{ Matches(limit: 100) { docs { id agreementNotes sharedInfo { name school programme year pitch skills experience contactEmail phone cv { id originalName owner { id email } } } student { id name contactEmail phone user { id email } } application { id } project { id title company { id name } } } } }',
  deliverables:
    '{ Deliverables(limit: 100) { docs { id status note links { url } files { id originalName uploadedBy { id email } } match { id student { id name contactEmail } project { id } } } } }',
  payments:
    '{ Payments(limit: 100) { docs { id projectFee konnectedShare studentPay invoiceSentAt match { id student { id name } project { id } } } } }',
  'activity-logs': '{ ActivityLogs(limit: 100) { docs { id action targetCollection } } }',
  cvs: '{ Cvs(limit: 100) { docs { id filename originalName url owner { id email } } } }',
  'deliverable-files':
    '{ DeliverableFiles(limit: 100) { docs { id filename originalName url uploadedBy { id email } match { id student { id name } } } } }',
  'brief-files':
    '{ BriefFiles(limit: 100) { docs { id filename originalName url company { id name } } } }',
  'company-logos':
    '{ CompanyLogos(limit: 100) { docs { id filename originalName url uploadedBy { id email } } } }',
}

let world: World
let companyCookie: string
let adminCookie: string

/** Konnected's note to company A on its matched project. Only the team and company A read it. */
const NOTE_TO_COMPANY = 'Leak-Check-Note-To-Company-A'

beforeAll(async () => {
  await resetDatabase()
  world = await createWorld()
  companyCookie = await login(world.companyA.user.email)
  adminCookie = await sessionFor(world.admin.id)
  await world.payload.update({
    collection: 'projects',
    id: world.projectOpen.id,
    data: { noteToCompany: NOTE_TO_COMPANY, fee: 43_210 },
    user: asUser(world.admin),
    overrideAccess: false,
  })
})

/** Run one query through the Local API. A denied collection throws, which counts as no data. */
async function localAll(user: World['admin'], slug: (typeof SLUGS)[number]) {
  try {
    const res = await world.payload.find({
      collection: slug,
      depth: 5,
      limit: 100,
      user: asUser(user),
      overrideAccess: false,
    })
    return JSON.stringify(res)
  } catch {
    return ''
  }
}

async function everything(transport: 'local' | 'rest' | 'graphql', as: 'company' | 'admin') {
  const user = as === 'company' ? world.companyA.user : world.admin
  const cookie = as === 'company' ? companyCookie : adminCookie
  const parts: string[] = []
  for (const slug of SLUGS) {
    if (transport === 'local') parts.push(await localAll(user, slug))
    if (transport === 'rest') parts.push((await rest.get(`${slug}?depth=5&limit=100`, cookie)).text)
    if (transport === 'graphql') parts.push((await graphql(GRAPHQL_QUERIES[slug], cookie)).text)
  }
  return parts.join('\n')
}

describe.each(['local', 'rest', 'graphql'] as const)(
  'company sees no student data (%s)',
  (transport) => {
    it('positive control: admin DOES see student personal data', async () => {
      const all = await everything(transport, 'admin')
      expect(all).toContain(SENTINEL.alpha.name)
      expect(all).toContain(SENTINEL.alpha.contactEmail)
      expect(all).toContain(SENTINEL.beta.phone)
      expect(all).toContain(SENTINEL.alpha.cvName)
    })

    it('a company reads no student personal data in any collection at depth 5', async () => {
      const all = await everything(transport, 'company')
      for (const secret of FORBIDDEN) {
        expect(all, `leaked: ${secret}`).not.toContain(secret)
      }
    })

    it('a company still reads its own matched project data (the sweep is not vacuous)', async () => {
      const all = await everything(transport, 'company')
      // Own project, own match with only the agreed skill, and the released deliverable.
      expect(all).toContain('Project A')
      expect(all).toContain(SENTINEL.alpha.skill)
      expect(all).toContain('Released work')
      // The file on the released deliverable and its own brief attachment, not the unreleased one.
      expect(all).toContain('final-report.pdf')
      expect(all).toContain('brief-a.png')
      expect(all).not.toContain('draft-report.pdf')
      // Not the unreleased deliverable, not another company's project.
      expect(all).not.toContain('Not released yet')
      expect(all).not.toContain('Project B draft')
    })
  },
)

describe.each(['local', 'rest', 'graphql'] as const)(
  "the project form's team-only fields (%s)",
  (transport) => {
    const sweep = async (as: 'company' | 'student') => {
      const user = as === 'company' ? world.companyA.user : world.beta.user
      if (transport === 'local') return localAll(user, 'projects')
      const cookie = as === 'company' ? companyCookie : await login(world.beta.user.email)
      if (transport === 'rest') return (await rest.get('projects?depth=5&limit=100', cookie)).text
      return (await graphql(GRAPHQL_QUERIES.projects, cookie)).text
    }

    it('the owning company reads the price and Konnected\u2019s note (positive control)', async () => {
      const all = await sweep('company')
      expect(all).toContain(NOTE_TO_COMPANY)
      expect(all).toContain('43210')
    })

    it('a student reads the published project but never the price or the note', async () => {
      const all = await sweep('student')
      expect(all).toContain('Project A open')
      expect(all).not.toContain(NOTE_TO_COMPANY)
      expect(all).not.toContain('43210')
    })
  },
)

describe('the account name (users.name) never reaches a company', () => {
  it('the student user record carries the profile name, and only the team sees it', async () => {
    // The name is copied from the profile onto the user record (copyNameToUser).
    const adminView = await rest.get(`users/${world.alpha.user.id}?depth=0`, adminCookie)
    expect(adminView.json.name).toBe(SENTINEL.alpha.name)
    const adminGql = await graphql(`{ User(id: ${world.alpha.user.id}) { name } }`, adminCookie)
    expect(adminGql.text).toContain(SENTINEL.alpha.name)

    const direct = await rest.get(`users/${world.alpha.user.id}?depth=0`, companyCookie)
    expect([403, 404]).toContain(direct.status)
    expect(direct.text).not.toContain(SENTINEL.alpha.name)
    const gql = await graphql(`{ User(id: ${world.alpha.user.id}) { name email } }`, companyCookie)
    expect(gql.text).not.toContain(SENTINEL.alpha.name)
    await expect(
      world.payload.findByID({
        collection: 'users',
        id: world.alpha.user.id,
        user: asUser(world.companyA.user),
        overrideAccess: false,
      }),
    ).rejects.toThrow()
  })
})

describe('server-only account fields are not part of any API', () => {
  it('the status version and the sign-out time are hidden, even from the team', async () => {
    const marker = '2001-02-03T04:05:06.789Z'
    const user = await world.payload.create({
      collection: 'users',
      data: { email: 'hidden-fields@example.test', password: PASSWORD, role: 'student' } as never,
      overrideAccess: true,
      disableVerificationEmail: true,
    })
    try {
      await world.payload.db.updateOne({
        collection: 'users',
        where: { id: { equals: user.id } },
        data: { sessionsValidAfter: marker, accountStatusVersion: 4242 },
        returning: false,
      })
      for (const cookie of [companyCookie, adminCookie]) {
        const gql = await graphql(
          `{ User(id: ${user.id}) { id accountStatusVersion sessionsValidAfter } }`,
          cookie,
        )
        const one = await rest.get(`users/${user.id}?depth=0`, cookie)
        const all = await rest.get('users?depth=0&limit=100', cookie)
        for (const text of [gql.text, one.text, all.text]) {
          expect(text).not.toContain(marker)
          expect(text).not.toContain('4242')
        }
      }
      // Positive control: the values are stored.
      const row = await world.payload.db.findOne<{
        id: number
        sessionsValidAfter?: string | null
      }>({
        collection: 'users',
        where: { id: { equals: user.id } },
      })
      expect(row!.sessionsValidAfter).toBe(marker)
    } finally {
      await world.payload.delete({ collection: 'users', id: user.id, overrideAccess: true })
    }
  })
})

describe('company cannot reach student collections directly', () => {
  it('REST: student profiles and applications are forbidden', async () => {
    for (const path of [
      'student-profiles',
      `student-profiles/${world.alpha.profile.id}`,
      'applications',
      `applications/${world.application.id}`,
    ]) {
      const res = await rest.get(path, companyCookie)
      expect([403, 404], path).toContain(res.status)
    }
  })

  it('REST: a where filter through a relation cannot probe student fields', async () => {
    const res = await rest.get(
      `matches?where[student.contactEmail][like]=sentinel&depth=0`,
      companyCookie,
    )
    // Either rejected or no rows. It must never reveal that a student matches.
    expect(res.text).not.toContain('sentinel.contact')
    const docs = (res.json.docs as unknown[] | undefined) ?? []
    expect(docs).toHaveLength(0)
  })

  it('Local API: findByID on a profile is denied', async () => {
    await expect(
      world.payload.findByID({
        collection: 'student-profiles',
        id: world.alpha.profile.id,
        user: asUser(world.companyA.user),
        overrideAccess: false,
      }),
    ).rejects.toThrow()
  })

  it('a match shows the company no student or application relation, only the shared copy', async () => {
    const res = await rest.get(`matches/${world.match.id}?depth=5`, companyCookie)
    expect(res.status).toBe(200)
    expect(res.json).not.toHaveProperty('student')
    expect(res.json).not.toHaveProperty('application')
    expect(res.json).not.toHaveProperty('agreementNotes')
    const shared = res.json.sharedInfo as Record<string, unknown>
    expect(JSON.stringify(shared.skills)).toContain(SENTINEL.alpha.skill)
    for (const key of [
      'name',
      'school',
      'programme',
      'year',
      'pitch',
      'experience',
      'cv',
      'contactEmail',
      'phone',
    ]) {
      expect(shared[key], key).toBeNull()
    }
  })

  it('positive control: the admin sweep finds the new profile fields, so the sweep can fail', async () => {
    for (const transport of ['local', 'rest', 'graphql'] as const) {
      const all = await everything(transport, 'admin')
      expect(all, transport).toContain(SENTINEL.alpha.school)
      expect(all, transport).toContain(SENTINEL.beta.programme)
      expect(all, transport).toContain(SENTINEL.alpha.interest)
      expect(all, transport).toContain(SENTINEL.beta.projectType)
    }
  })
})
