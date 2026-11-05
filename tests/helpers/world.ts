import config from '@payload-config'
import { GRAPHQL_POST, REST_DELETE, REST_GET, REST_PATCH, REST_POST } from '@payloadcms/next/routes'
import pg from 'pg'
import { getPayload, type Payload } from 'payload'

import type { Project, User } from '@/payload-types'

export const PASSWORD = 'Test-passw0rd-1234'
export const ADMIN_EMAIL = 'admin@konnected.test'

let payloadPromise: Promise<Payload> | undefined
export const getTestPayload = (): Promise<Payload> => (payloadPromise ??= getPayload({ config }))

/** Empty every application table between tests. The migrations table is kept. */
export async function resetDatabase(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'payload_migrations%'`,
    )
    if (rows.length) {
      const tables = rows.map((r) => `"${r.tablename}"`).join(', ')
      await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`)
    }
  } finally {
    await pool.end()
  }
}

/** Distinctive values that must never reach a company. The leak tests search for them. */
export const SENTINEL = {
  alpha: {
    name: 'Sentinel-Name-Alpha',
    userEmail: 'sentinel.user.alpha@student.test',
    contactEmail: 'sentinel.contact.alpha@student.test',
    phone: '+47-SENTINEL-ALPHA',
    pitch: 'Sentinel-Pitch-Alpha',
    experience: 'Sentinel-Experience-Alpha',
    highlights: 'Sentinel-Highlights-Alpha',
    skill: 'Sentinel-Skill-Alpha',
  },
  beta: {
    name: 'Sentinel-Name-Beta',
    userEmail: 'sentinel.user.beta@student.test',
    contactEmail: 'sentinel.contact.beta@student.test',
    phone: '+47-SENTINEL-BETA',
    pitch: 'Sentinel-Pitch-Beta',
    experience: 'Sentinel-Experience-Beta',
    highlights: 'Sentinel-Highlights-Beta',
    skill: 'Sentinel-Skill-Beta',
  },
}

/** A user document shaped for the Local API `user` option. */
export const asUser = (user: User) => ({ ...user, collection: 'users' as const })

export type World = Awaited<ReturnType<typeof createWorld>>

/**
 * A small world with every role:
 * - an admin, two students (alpha shares only skills, beta shares nothing), two companies
 * - companyA is approved and has a published project that is matched to alpha, with a match,
 *   a released deliverable, an unreleased deliverable and a payment
 * - companyB is approved and has its own draft project
 *
 * Built through the Local API as admin, so the status rules in the hooks are exercised too.
 */
export async function createWorld() {
  const payload = await getTestPayload()

  const makeUser = async (email: string, role: User['role'], extra: Partial<User> = {}) =>
    payload.create({
      collection: 'users',
      data: { email, password: PASSWORD, role, ...extra } as never,
      overrideAccess: true,
    }) as Promise<User>

  const admin = await makeUser(ADMIN_EMAIL, 'admin', { emailVerifiedAt: new Date().toISOString() })
  const adminCtx = asUser(admin)

  const makeStudent = async (key: 'alpha' | 'beta', privacy: Record<string, boolean>) => {
    const s = SENTINEL[key]
    const user = await makeUser(s.userEmail, 'student')
    const profile = await payload.create({
      collection: 'student-profiles',
      data: {
        user: user.id,
        name: s.name,
        school: 'Test School',
        programme: 'Test Programme',
        year: 2,
        pitch: s.pitch,
        skills: [s.skill],
        experience: s.experience,
        highlights: s.highlights,
        contactEmail: s.contactEmail,
        phone: s.phone,
        privacy,
      },
      overrideAccess: true,
    })
    return { user, profile }
  }
  const alpha = await makeStudent('alpha', { shareSkills: true })
  const beta = await makeStudent('beta', {})

  const makeCompany = async (email: string, name: string) => {
    const user = await makeUser(email, 'company')
    const company = await payload.create({
      collection: 'companies',
      data: { name, description: `${name} description`, status: 'pending' },
      overrideAccess: true,
    })
    await payload.update({
      collection: 'companies',
      id: company.id,
      data: { status: 'approved' },
      user: adminCtx,
      overrideAccess: true,
    })
    const linked = (await payload.update({
      collection: 'users',
      id: user.id,
      data: { company: company.id },
      overrideAccess: true,
    })) as User
    return { user: linked, company }
  }
  const companyA = await makeCompany('company.a@company.test', 'Company A')
  const companyB = await makeCompany('company.b@company.test', 'Company B')

  /** Create a project and move it through `path` as admin. */
  const makeProject = async (
    company: { company: { id: number } },
    title: string,
    path: Project['status'][],
  ) => {
    let project = await payload.create({
      collection: 'projects',
      data: {
        company: company.company.id,
        title,
        description: `${title} description`,
        fee: 1000,
        status: 'draft',
      },
      overrideAccess: true,
    })
    for (const status of path) {
      project = await payload.update({
        collection: 'projects',
        id: project.id,
        data: { status },
        user: adminCtx,
        overrideAccess: true,
      })
    }
    return project
  }

  const published = ['submitted', 'approved', 'published'] as Project['status'][]
  const projectA = await makeProject(companyA, 'Project A', published)
  const projectB = await makeProject(companyB, 'Project B draft', [])
  const projectOpen = await makeProject(companyA, 'Project A open', published)
  const projectHidden = await makeProject(companyA, 'Project A not published', ['submitted'])

  // alpha applies to project A as themselves, Konnected shortlists then selects.
  const application = await payload.create({
    collection: 'applications',
    data: { project: projectA.id } as never,
    user: asUser(alpha.user),
    overrideAccess: false,
  })
  for (const status of ['shortlisted', 'selected'] as const) {
    await payload.update({
      collection: 'applications',
      id: application.id,
      data: { status },
      user: adminCtx,
      overrideAccess: false,
    })
  }
  const match = await payload.create({
    collection: 'matches',
    data: {
      project: projectA.id,
      student: alpha.profile.id,
      application: application.id,
      agreementNotes: 'Sentinel-Agreement-Notes',
    },
    user: adminCtx,
    overrideAccess: false,
  })
  for (const status of ['matched', 'in_progress'] as const) {
    await payload.update({
      collection: 'projects',
      id: projectA.id,
      data: { status },
      user: adminCtx,
      overrideAccess: false,
    })
  }

  const deliverableReleased = await payload.create({
    collection: 'deliverables',
    data: {
      match: match.id,
      note: 'Released work',
      status: 'submitted',
      links: [{ url: 'https://example.test/a' }],
    },
    user: asUser(alpha.user),
    overrideAccess: false,
  })
  await payload.update({
    collection: 'deliverables',
    id: deliverableReleased.id,
    data: { status: 'released' },
    user: adminCtx,
    overrideAccess: false,
  })
  const deliverableHidden = await payload.create({
    collection: 'deliverables',
    data: {
      match: match.id,
      note: 'Not released yet',
      status: 'submitted',
      links: [{ url: 'https://example.test/b' }],
    },
    user: asUser(alpha.user),
    overrideAccess: false,
  })

  const payment = await payload.create({
    collection: 'payments',
    data: {
      match: match.id,
      projectFee: 1000,
      konnectedShare: 200,
      studentPay: 700,
      invoiceSentAt: new Date().toISOString(),
    },
    user: adminCtx,
    overrideAccess: false,
  })

  return {
    payload,
    admin,
    alpha,
    beta,
    companyA,
    companyB,
    projectA,
    projectB,
    projectOpen,
    projectHidden,
    application,
    match,
    deliverableReleased,
    deliverableHidden,
    payment,
  }
}

// ---------- HTTP transports. These call the real Next route handlers with a real Request. ----------

const ORIGIN = 'http://localhost:3000'

type Json = Record<string, unknown>

export type HttpResult = { status: number; json: Json; text: string }

const toResult = async (res: Response): Promise<HttpResult> => {
  const text = await res.text()
  let json: Json = {}
  try {
    json = text ? (JSON.parse(text) as Json) : {}
  } catch {
    // Not JSON. `text` still holds the body.
  }
  return { status: res.status, json, text }
}

type Handler = (
  request: Request,
  args: { params: Promise<{ slug: string[] }> },
) => Promise<Response>

const call = async (
  handler: Handler,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<HttpResult> => {
  const url = new URL(`${ORIGIN}/api/${path}`)
  const request = new Request(url, {
    method,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const slug = path.split('?')[0]!.split('/').filter(Boolean)
  return toResult(await handler(request, { params: Promise.resolve({ slug }) }))
}

export const rest = {
  get: (path: string, cookie?: string) =>
    call(REST_GET(config) as Handler, 'GET', path, { cookie }),
  post: (path: string, body: unknown, cookie?: string) =>
    call(REST_POST(config) as Handler, 'POST', path, { cookie, body }),
  patch: (path: string, body: unknown, cookie?: string) =>
    call(REST_PATCH(config) as Handler, 'PATCH', path, { cookie, body }),
  delete: (path: string, cookie?: string) =>
    call(REST_DELETE(config) as Handler, 'DELETE', path, { cookie }),
}

export async function graphql(query: string, cookie?: string): Promise<HttpResult> {
  const request = new Request(`${ORIGIN}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ query }),
  })
  return toResult(await GRAPHQL_POST(config)(request))
}

/** Log in through the real login endpoint and return a cookie header for later requests. */
export async function login(email: string, password = PASSWORD): Promise<string> {
  const request = new Request(`${ORIGIN}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const res = await (REST_POST(config) as Handler)(request, {
    params: Promise.resolve({ slug: ['users', 'login'] }),
  })
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status}`)
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('payload-token='))
  if (!cookie) throw new Error('No session cookie returned')
  return cookie.split(';')[0]!
}
