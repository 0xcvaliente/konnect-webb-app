import { beforeAll, describe, expect, it } from 'vitest'

import {
  asUser,
  createWorld,
  graphql,
  login,
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
  users: '{ Users(limit: 100) { docs { id email role company { id } } } }',
  'student-profiles':
    '{ StudentProfiles(limit: 100) { docs { id name contactEmail phone pitch experience highlights skills user { id email } } } }',
  companies: '{ Companies(limit: 100) { docs { id name description status } } }',
  projects:
    '{ Projects(limit: 100) { docs { id title description status companyName company { id name } attachments { id originalName } } } }',
  applications:
    '{ Applications(limit: 100) { docs { id status note student { id name contactEmail user { id email } } project { id title } } } }',
  matches:
    '{ Matches(limit: 100) { docs { id agreementNotes sharedInfo { name pitch skills experience cv { id originalName owner { id email } } } student { id name contactEmail phone user { id email } } application { id } project { id title company { id name } } } } }',
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
}

let world: World
let companyCookie: string
let adminCookie: string

beforeAll(async () => {
  await resetDatabase()
  world = await createWorld()
  companyCookie = await login(world.companyA.user.email)
  adminCookie = await sessionFor(world.admin.id)
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
    expect(shared.name).toBeNull()
    expect(shared.pitch).toBeNull()
    expect(shared.experience).toBeNull()
  })
})
