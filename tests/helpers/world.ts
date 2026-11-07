import config from '@payload-config'
import { GRAPHQL_POST, REST_DELETE, REST_GET, REST_PATCH, REST_POST } from '@payloadcms/next/routes'
import pg from 'pg'
import { getPayload, type Payload } from 'payload'

import { createSessionCookie } from '@/lib/auth/session'
import type { Project, User } from '@/payload-types'

import { publishTestTemplates, signedAgreement } from './agreements'
import { fileOf, makePdf, makePng } from './files'

export const PASSWORD = 'Test-passw0rd-1234'

/** Company A's fix request on the released deliverable in the world. */
export const FIX_NOTE = 'Please fix the chart on page 2'
export const ADMIN_EMAIL = 'admin@konnected.test'

let payloadPromise: Promise<Payload> | undefined
export const getTestPayload = (): Promise<Payload> => (payloadPromise ??= getPayload({ config }))

/**
 * Empty every application table between tests. The migrations table is kept.
 *
 * Work a previous test left running after its response (an agreement's PDF job, an email) may
 * still hold row locks; PostgreSQL can then pick the TRUNCATE as a deadlock victim. Try again a
 * few times: the other work finishes and the TRUNCATE goes through.
 */
export async function resetDatabase(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'payload_migrations%'`,
    )
    if (rows.length) {
      const tables = rows.map((r) => `"${r.tablename}"`).join(', ')
      for (let attempt = 1; ; attempt++) {
        try {
          await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`)
          break
        } catch (error) {
          const deadlock = (error as { code?: string }).code === '40P01'
          if (!deadlock || attempt >= 5) throw error
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
        }
      }
    }
  } finally {
    await pool.end()
  }
}

/** Distinctive values that must never reach a company. The leak tests search for them. */
export const SENTINEL = {
  alpha: {
    name: 'Sentinel-Name-Alpha',
    school: 'Sentinel-School-Alpha',
    programme: 'Sentinel-Programme-Alpha',
    interest: 'Sentinel-Interest-Alpha',
    projectType: 'Sentinel-Project-Type-Alpha',
    userEmail: 'sentinel.user.alpha@student.test',
    contactEmail: 'sentinel.contact.alpha@student.test',
    phone: '+47-SENTINEL-ALPHA',
    pitch: 'Sentinel-Pitch-Alpha',
    experience: 'Sentinel-Experience-Alpha',
    highlights: 'Sentinel-Highlights-Alpha',
    skill: 'Sentinel-Skill-Alpha',
    cvName: 'Sentinel-CV-Alpha.pdf',
    applicationNote: 'Sentinel-Application-Note-Alpha',
  },
  beta: {
    name: 'Sentinel-Name-Beta',
    school: 'Sentinel-School-Beta',
    programme: 'Sentinel-Programme-Beta',
    interest: 'Sentinel-Interest-Beta',
    projectType: 'Sentinel-Project-Type-Beta',
    userEmail: 'sentinel.user.beta@student.test',
    contactEmail: 'sentinel.contact.beta@student.test',
    phone: '+47-SENTINEL-BETA',
    pitch: 'Sentinel-Pitch-Beta',
    experience: 'Sentinel-Experience-Beta',
    highlights: 'Sentinel-Highlights-Beta',
    skill: 'Sentinel-Skill-Beta',
    cvName: 'Sentinel-CV-Beta.pdf',
    applicationNote: 'Sentinel-Application-Note-Beta',
  },
}

/**
 * A made-up organisation number with a valid check digit, different for each name (one company
 * account per organisation number: the team cannot approve two companies with the same one).
 * Starts with 91, so it never equals the numbers the registration tests type in.
 */
export const orgNumberFor = (name: string): string => {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000
  for (let n = hash; ; n = (n + 1) % 1_000_000) {
    const base = `91${String(n).padStart(6, '0')}`
    const weights = [3, 2, 7, 6, 5, 4, 3, 2]
    const rest = weights.reduce((sum, w, i) => sum + w * Number(base[i]), 0) % 11
    const check = rest === 0 ? 0 : 11 - rest
    if (check !== 10) return `${base}${check}`
  }
}

/**
 * Everything the company onboarding asks for, for a company called `name`. The organisation
 * number is made up but has a valid check digit.
 */
export const companyDetails = (name: string) => ({
  name,
  orgNumber: orgNumberFor(name),
  contactName: `${name} contact`,
  contactRole: 'Founder',
  website: 'https://company.example',
  sector: 'software' as const,
  description: `${name} description`,
})

/** A day `days` from today, stored the way the project form stores days (noon UTC). */
export const dayFromNow = (days: number): string => {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return `${date.toISOString().slice(0, 10)}T12:00:00.000Z`
}

/**
 * Everything a company must fill in before it can send a project for review: applications close
 * in a week, the work starts a week later.
 */
export const readyFields = () => ({
  description: 'What needs to be done',
  deliverable: 'A short report',
  desiredSkills: ['Research'],
  workloadHours: 20,
  durationWeeks: 2,
  workMode: 'remote' as const,
  paidOrUnpaid: 'paid' as const,
  deadline: dayFromNow(7),
  startDate: dayFromNow(14),
})

/** A user document shaped for the Local API `user` option. */
export const asUser = (user: User) => ({ ...user, collection: 'users' as const })

export type World = Awaited<ReturnType<typeof createWorld>>

/**
 * A small world with every role:
 * - an admin, two students (alpha shares only skills, beta shares nothing), two companies
 * - companyA is approved and has a project Konnected selected alpha for (so it has a match) and
 *   that is delivered: a released deliverable on which company A asked for its one round of
 *   fixes, alpha's fixed hand-in (not released yet), and the match's payment log row
 * - companyB is approved and has its own draft project
 * - files: each student has a CV on their profile (neither ticked "share my CV"), the released and
 *   the unreleased deliverable each list one file, and project A and project A open each have a
 *   brief attachment
 *
 * Built through the Local API as admin, so the status rules in the hooks are exercised too.
 */
export async function createWorld() {
  const payload = await getTestPayload()

  const makeUser = async (email: string, role: User['role'], extra: Partial<User> = {}) =>
    payload.create({
      collection: 'users',
      data: { email, password: PASSWORD, role, _verified: true, ...extra } as never,
      overrideAccess: true,
      disableVerificationEmail: true,
    }) as Promise<User>

  const admin = await makeUser(ADMIN_EMAIL, 'admin', { emailVerifiedAt: new Date().toISOString() })
  const adminCtx = asUser(admin)
  // Konnected's agreement templates (test text), so projects can be published and started.
  const templates = await publishTestTemplates(payload, admin)

  const makeStudent = async (key: 'alpha' | 'beta', privacy: Record<string, boolean>) => {
    const s = SENTINEL[key]
    const user = await makeUser(s.userEmail, 'student')
    const profile = await payload.create({
      collection: 'student-profiles',
      data: {
        user: user.id,
        name: s.name,
        school: s.school,
        programme: s.programme,
        year: 2,
        pitch: s.pitch,
        skills: [s.skill],
        interests: [s.interest],
        preferredProjectTypes: [s.projectType],
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

  // Each student uploads a CV as themselves and puts it on their profile.
  const addCv = async (student: typeof alpha, name: string) => {
    const cv = await payload.create({
      collection: 'cvs',
      data: {} as never,
      file: fileOf(makePdf(name), name, 'application/pdf'),
      user: asUser(student.user),
      overrideAccess: false,
    })
    await payload.update({
      collection: 'student-profiles',
      id: student.profile.id,
      data: { cv: cv.id },
      user: asUser(student.user),
      overrideAccess: false,
    })
    return cv
  }
  const alphaCv = await addCv(alpha, SENTINEL.alpha.cvName)
  const betaCv = await addCv(beta, SENTINEL.beta.cvName)

  /** A company user registers their company as themselves; Konnected approves it. */
  const makeCompany = async (email: string, name: string) => {
    const user = await makeUser(email, 'company')
    const company = await payload.create({
      collection: 'companies',
      data: { ...companyDetails(name), status: 'pending' },
      user: asUser(user),
      overrideAccess: false,
    })
    await payload.update({
      collection: 'companies',
      id: company.id,
      data: { status: 'approved' },
      user: adminCtx,
      overrideAccess: false,
    })
    const linked = (await payload.findByID({
      collection: 'users',
      id: user.id,
      depth: 0,
      overrideAccess: true,
    })) as User
    return { user: linked, company }
  }
  const companyA = await makeCompany('company.a@company.test', 'Company A')
  const companyB = await makeCompany('company.b@company.test', 'Company B')

  /**
   * Create a project and move it through `path` as admin. Before publishing, the company agreement
   * is made and signed by the company and Konnected (the publishing gate).
   */
  const makeProject = async (
    company: { company: { id: number }; user: User },
    title: string,
    path: Project['status'][],
  ) => {
    let project = await payload.create({
      collection: 'projects',
      data: {
        ...readyFields(),
        company: company.company.id,
        title,
        description: `${title} description`,
        fee: 1000,
        status: 'draft',
      },
      overrideAccess: true,
    })
    for (const status of path) {
      if (status === 'published') {
        await signedAgreement(payload, admin, company.user, {
          kind: 'company',
          projectId: project.id,
        })
      }
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

  // alpha applies to project A as themselves. Konnected reviews alpha's profile (every profile is
  // reviewed before matching), shortlists, then selects: the selection makes the match and moves
  // the project to matched.
  await payload.update({
    collection: 'student-profiles',
    id: alpha.profile.id,
    data: { reviewStatus: 'reviewed' },
    user: adminCtx,
    overrideAccess: false,
    // Undone below: the review leaves no activity row behind.
    context: { skipActivityLog: true },
  })
  const application = await payload.create({
    collection: 'applications',
    data: { project: projectA.id, note: SENTINEL.alpha.applicationNote } as never,
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
  const made = await payload.find({
    collection: 'matches',
    where: { project: { equals: projectA.id } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const match = await payload.update({
    collection: 'matches',
    id: made.docs[0]!.id,
    data: { agreementNotes: 'Sentinel-Agreement-Notes' },
    user: adminCtx,
    overrideAccess: false,
  })
  // The approval-queue tests start from a profile that waits for review: put alpha's review back
  // as it was, straight in the database (no email, no activity row).
  await payload.db.updateOne({
    collection: 'student-profiles',
    where: { id: { equals: alpha.profile.id } },
    data: { reviewStatus: 'waiting', reviewedAt: null, reviewedSnapshot: null },
    returning: false,
  })
  // The work starts only after the student agreement is signed (the second gate).
  await signedAgreement(payload, admin, alpha.user, { kind: 'student', matchId: match.id })
  await payload.update({
    collection: 'projects',
    id: projectA.id,
    data: { status: 'in_progress' },
    user: adminCtx,
    overrideAccess: false,
  })

  // alpha uploads one file for each deliverable, as themselves.
  const addDeliverableFile = async (name: string) =>
    payload.create({
      collection: 'deliverable-files',
      data: { match: match.id },
      file: fileOf(makePdf(name), name, 'application/pdf'),
      user: asUser(alpha.user),
      overrideAccess: false,
    })
  const fileReleased = await addDeliverableFile('final-report.pdf')
  const fileHidden = await addDeliverableFile('draft-report.pdf')

  const deliverableReleased = await payload.create({
    collection: 'deliverables',
    data: {
      match: match.id,
      note: 'Released work',
      status: 'submitted',
      links: [{ url: 'https://example.test/a' }],
      files: [fileReleased.id],
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
  // Company A asks for its one round of fixes, so alpha hands in again (not released yet).
  await payload.update({
    collection: 'deliverables',
    id: deliverableReleased.id,
    data: { status: 'fix_requested', fixNote: FIX_NOTE },
    user: asUser(companyA.user),
    overrideAccess: false,
  })
  const deliverableHidden = await payload.create({
    collection: 'deliverables',
    data: {
      match: match.id,
      note: 'Not released yet',
      status: 'submitted',
      links: [{ url: 'https://example.test/b' }],
      files: [fileHidden.id],
    },
    user: asUser(alpha.user),
    overrideAccess: false,
  })

  // Company A uploads a brief attachment for each of two projects. Konnected attaches them (the
  // projects are past the stage where the company can still edit them).
  const addBrief = async (projectId: number, name: string) => {
    const brief = await payload.create({
      collection: 'brief-files',
      data: {} as never,
      file: fileOf(await makePng(), name, 'image/png'),
      user: asUser(companyA.user),
      overrideAccess: false,
    })
    await payload.update({
      collection: 'projects',
      id: projectId,
      data: { attachments: [brief.id] },
      user: adminCtx,
      overrideAccess: false,
    })
    return brief
  }
  const briefA = await addBrief(projectA.id, 'brief-a.png')
  const briefOpen = await addBrief(projectOpen.id, 'brief-open.png')

  // Selecting alpha for the paid project A made its payment log row; the team fills it in.
  const made2 = await payload.find({
    collection: 'payments',
    where: { match: { equals: match.id } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const payment = await payload.update({
    collection: 'payments',
    id: made2.docs[0]!.id,
    data: {
      konnectedShare: 200,
      studentPay: 700,
      invoiceSentAt: new Date().toISOString(),
    },
    user: adminCtx,
    overrideAccess: false,
  })

  return {
    payload,
    templates,
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
    alphaCv,
    betaCv,
    fileReleased,
    fileHidden,
    briefA,
    briefOpen,
  }
}

/**
 * Konnected picks `student` for the published project `projectId` the one real way: the student
 * applies, the team selects. The selection makes the match and moves the project to matched. A
 * profile that is not reviewed yet is marked reviewed first (selecting needs a reviewed profile).
 */
export async function selectStudent(
  payload: Payload,
  admin: User,
  student: { user: User; profile: { id: number } },
  projectId: number,
) {
  const profile = await payload.findByID({
    collection: 'student-profiles',
    id: student.profile.id,
    depth: 0,
    overrideAccess: true,
  })
  if (profile.reviewStatus !== 'reviewed') {
    await payload.update({
      collection: 'student-profiles',
      id: student.profile.id,
      data: { reviewStatus: 'reviewed' },
      user: asUser(admin),
      overrideAccess: false,
    })
  }
  const application = await payload.create({
    collection: 'applications',
    data: { project: projectId, note: 'I would like to do this.' } as never,
    user: asUser(student.user),
    overrideAccess: false,
  })
  await payload.update({
    collection: 'applications',
    id: application.id,
    data: { status: 'selected' },
    user: asUser(admin),
    overrideAccess: false,
  })
  const found = await payload.find({
    collection: 'matches',
    where: { project: { equals: projectId } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return { application, match: found.docs[0]! }
}

// ---------- HTTP transports. These call the real Next route handlers with a real Request. ----------

const ORIGIN = 'http://localhost:3000'

type Json = Record<string, unknown>

export type HttpResult = { status: number; json: Json; text: string; headers: Headers }

const toResult = async (res: Response): Promise<HttpResult> => {
  const headers = res.headers
  const text = await res.text()
  let json: Json = {}
  try {
    json = text ? (JSON.parse(text) as Json) : {}
  } catch {
    // Not JSON. `text` still holds the body.
  }
  return { status: res.status, json, text, headers }
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
  const isForm = options.body instanceof FormData
  const request = new Request(url, {
    method,
    headers: {
      origin: ORIGIN,
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body && !isForm ? { 'content-type': 'application/json' } : {}),
    },
    body: isForm
      ? (options.body as FormData)
      : options.body
        ? JSON.stringify(options.body)
        : undefined,
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
  /** A multipart upload, the way the browser and the admin panel send files. */
  upload: (
    path: string,
    file: { data: Buffer; name: string; type: string },
    data: Record<string, unknown> = {},
    cookie?: string,
  ) => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(file.data)], { type: file.type }), file.name)
    form.append('_payload', JSON.stringify(data))
    return call(REST_POST(config) as Handler, 'POST', path, { cookie, body: form })
  },
}

export async function graphql(query: string, cookie?: string): Promise<HttpResult> {
  const request = new Request(`${ORIGIN}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ query }),
  })
  return toResult(await GRAPHQL_POST(config)(request))
}

/**
 * A session cookie for any user, made the way Google sign-in makes it. Admins cannot use the
 * password login (they sign in with Google only), so admin tests use this.
 */
export async function sessionFor(userId: number): Promise<string> {
  const cookie = await createSessionCookie(await getTestPayload(), userId)
  return cookie.split(';')[0]!
}

/** Log in through the real login endpoint and return a cookie header for later requests. */
export async function login(email: string, password = PASSWORD): Promise<string> {
  const request = new Request(`${ORIGIN}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
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

/**
 * A new project of `company` that Konnected publishes and selects `student` for, with both
 * agreements signed, moved to in progress: the student may hand in work on its match now.
 */
export async function workingMatch(
  payload: Payload,
  admin: User,
  student: { user: User; profile: { id: number } },
  company: { company: { id: number }; user: User },
  title: string,
  extra: Partial<Project> = {},
) {
  const adminCtx = asUser(admin)
  const project = await payload.create({
    collection: 'projects',
    data: {
      ...readyFields(),
      company: company.company.id,
      title,
      fee: 1000,
      status: 'draft',
      ...extra,
    } as Project,
    overrideAccess: true,
  })
  for (const status of ['submitted', 'approved'] as const) {
    await payload.update({
      collection: 'projects',
      id: project.id,
      data: { status },
      user: adminCtx,
      overrideAccess: false,
    })
  }
  await signedAgreement(payload, admin, company.user, { kind: 'company', projectId: project.id })
  await payload.update({
    collection: 'projects',
    id: project.id,
    data: { status: 'published' },
    user: adminCtx,
    overrideAccess: false,
  })
  const { match, application } = await selectStudent(payload, admin, student, project.id)
  await signedAgreement(payload, admin, student.user, { kind: 'student', matchId: match.id })
  await payload.update({
    collection: 'projects',
    id: project.id,
    data: { status: 'in_progress' },
    user: adminCtx,
    overrideAccess: false,
  })
  return { project, match, application }
}
