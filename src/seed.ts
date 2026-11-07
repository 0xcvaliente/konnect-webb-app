/**
 * Development seed: a test user for every role and state, and a project in every state, so the
 * owner can click through everything locally:
 * - admin (ADMIN_EMAILS' first address; signs in with Google, or with a session made locally);
 * - student@ (reviewed, CV, two running projects), student2@ and student4@ (work on the
 *   problem-path projects), student3@ (just started: no CV, waiting for review, two applications);
 * - company@ (approved, a project in each status), company2@ (pending, with a draft), company3@
 *   (has not registered a company yet), newuser@ (has not chosen student or company);
 * - one project in each status, plus the problem paths: a problem reported, a due date moved, a
 *   match ended and applications reopened, closed without delivery, published without a match
 *   after applications closed, and closed without a match.
 * Run with `pnpm seed`. Safe to run again: everything is found by email or title first.
 *
 * Local development only. It refuses to run in production, and the passwords below are throwaway
 * values for local accounts. Every status change goes through the real access rules and hooks as
 * the admin user, so the seed also proves the status workflow.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import config from '@payload-config'
import { getPayload, type Payload } from 'payload'

import { adminEmails } from '@/access/adminEmails'
import type { AgreementKind } from '@/lib/agreements/fields'
import {
  generateAgreementPdf,
  type AgreementInput,
  requestAgreement,
} from '@/lib/agreements/generate'
import { convertDocxToPdf } from '@/lib/agreements/gotenberg'
import { textPdf } from '@/lib/agreements/pdf'
import { signAgreement } from '@/lib/agreements/sign'
import { samplePdf } from '@/lib/uploads/samplePdf'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import { dayToStored, todayInOslo } from '@/lib/projects/fields'
import type { SessionUser } from '@/lib/team/approvals'
import { closeWithoutDelivery, endMatchAndReopen, moveDueDate } from '@/lib/team/projects'
import { addDays } from '@/lib/workingDays'
import type { Project, User } from '@/payload-types'

if (process.env.NODE_ENV === 'production') {
  throw new Error('The seed script must not run in production.')
}

const DEV_PASSWORD = 'dev-only-password-change-me'
const SEED_ADMIN_EMAIL = adminEmails()[0] ?? 'admin@konnected.test'
process.env.ADMIN_EMAILS = [SEED_ADMIN_EMAIL, ...adminEmails()].join(',')

type Status = Project['status']

const ensureUser = async (
  payload: Payload,
  email: string,
  role: User['role'],
  extra: Partial<User> = {},
): Promise<User> => {
  const found = await payload.find({
    collection: 'users',
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  if (found.docs[0]) return found.docs[0]
  // Seed accounts count as verified, so they can sign in with the password straight away.
  return (await payload.create({
    collection: 'users',
    data: { email, password: DEV_PASSWORD, role, _verified: true, ...extra } as never,
    overrideAccess: true,
    disableVerificationEmail: true,
  })) as User
}

/**
 * The example agreement templates (docs/agreements, "EXAMPLE, not legal text"), uploaded and
 * published by the admin when no template of the kind is published yet.
 */
async function ensureTemplate(payload: Payload, admin: User, kind: AgreementKind) {
  const published = await payload.count({
    collection: 'agreement-templates',
    where: { and: [{ kind: { equals: kind } }, { status: { equals: 'published' } }] },
    overrideAccess: true,
  })
  if (published.totalDocs > 0) return
  const data = await fs.readFile(path.resolve(`docs/agreements/example-${kind}-agreement.docx`))
  const adminCtx = { ...admin, collection: 'users' as const }
  const draft = await payload.create({
    collection: 'agreement-templates',
    data: { kind } as never,
    file: {
      data,
      name: `example-${kind}-agreement.docx`,
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: data.length,
    },
    user: adminCtx,
    overrideAccess: false,
  })
  await payload.update({
    collection: 'agreement-templates',
    id: draft.id,
    data: { status: 'published' },
    user: adminCtx,
    overrideAccess: false,
  })
}

/** Gotenberg when it runs (GOTENBERG_URL), else a plain one-page PDF that says so. */
const seedConvert = async (docx: Buffer, name: string) => {
  try {
    return await convertDocxToPdf(docx, name)
  } catch {
    return textPdf([
      'Seed agreement. EXAMPLE, not legal text.',
      'Gotenberg was not running when the seed ran, so this PDF is a stand-in.',
    ])
  }
}

/**
 * A signed agreement for a seed project, made the real way: from the published template, signed by
 * the party, then by Konnected. The signed-PDF emails go out when the app's job runner starts.
 */
async function seedSignedAgreement(
  payload: Payload,
  admin: User,
  party: User,
  input: AgreementInput,
) {
  const made = await requestAgreement(payload, admin, input)
  if (!made.ok)
    throw new Error(
      `The seed could not make an agreement: ${made.error} ${JSON.stringify((made as { fields?: unknown }).fields ?? [])}`,
    )
  await generateAgreementPdf(payload, made.id, { convert: seedConvert })
  for (const [user, name, method] of [
    [party, 'Seed Signer', 'password'],
    [admin, 'Konnected Seed', 'google'],
  ] as const) {
    const agreement = await payload.findByID({
      collection: 'agreements',
      id: made.id,
      depth: 0,
      overrideAccess: true,
    })
    const signed = await signAgreement(
      payload,
      user,
      {
        agreementId: made.id,
        typedName: name,
        agree: true,
        authority: true,
        documentSha256: agreement.unsignedSha256 ?? '',
      },
      method,
    )
    if (!signed.ok) throw new Error(`The seed could not sign an agreement: ${signed.error}`)
  }
}

/** The student applies to the project once (a second run finds the application). */
async function applyOnce(
  payload: Payload,
  projectId: number,
  student: { user: User; ctx: User & { collection: 'users' } },
) {
  const applied = await payload.count({
    collection: 'applications',
    where: {
      and: [{ project: { equals: projectId } }, { 'student.user': { equals: student.user.id } }],
    },
    overrideAccess: true,
  })
  if (applied.totalDocs) return
  await payload.create({
    collection: 'applications',
    data: { project: projectId, note: 'This fits what I study.' } as never,
    user: student.ctx,
    overrideAccess: false,
  })
}

/** The project's match Konnected has not ended. */
async function activeMatchId(payload: Payload, projectId: number): Promise<number | undefined> {
  const found = await payload.find({
    collection: 'matches',
    where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return found.docs[0]?.id
}

/**
 * A student with a profile. With `reviewer`, Konnected reviews the profile (it may be selected);
 * without, it waits for review and has no CV (the "just started" student home).
 */
async function ensureStudent(
  payload: Payload,
  reviewer: (User & { collection: 'users' }) | null,
  email: string,
  name: string,
) {
  const user = await ensureUser(payload, email, 'student')
  const ctx = { ...user, collection: 'users' as const }
  const found = await payload.find({
    collection: 'student-profiles',
    where: { user: { equals: user.id } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  let profile = found.docs[0]
  if (!profile) {
    profile = await payload.create({
      collection: 'student-profiles',
      data: {
        user: user.id,
        name,
        school: 'Example University',
        programme: 'Informatics',
        year: 2,
        pitch: 'Seed pitch.',
        skills: ['research', 'spreadsheets'],
        contactEmail: email,
        privacy: { shareName: true, shareSchool: true, shareSkills: true },
      },
      overrideAccess: true,
    })
  }
  if (reviewer && profile.reviewStatus !== 'reviewed') {
    if (!profile.cv) {
      const data = samplePdf(`${name} CV`)
      const cv = await payload.create({
        collection: 'cvs',
        data: {} as never,
        file: { data, name: 'seed-cv.pdf', mimetype: 'application/pdf', size: data.length },
        user: ctx,
        overrideAccess: false,
      })
      await payload.update({
        collection: 'student-profiles',
        id: profile.id,
        data: { cv: cv.id },
        user: ctx,
        overrideAccess: false,
      })
    }
    await payload.update({
      collection: 'student-profiles',
      id: profile.id,
      data: { reviewStatus: 'reviewed' },
      user: reviewer,
      overrideAccess: false,
    })
  }
  return { user, ctx }
}

async function seed() {
  const payload = await getPayload({ config })

  const admin = await ensureUser(payload, SEED_ADMIN_EMAIL, 'admin', {
    emailVerifiedAt: new Date().toISOString(),
  })
  const adminCtx = { ...admin, collection: 'users' as const }
  const studentUser = await ensureUser(payload, 'student@konnected.test', 'student')
  const studentCtx = { ...studentUser, collection: 'users' as const }
  let companyUser = await ensureUser(payload, 'company@konnected.test', 'company')

  // Student profile. The student shares only name and skills with a selected company.
  let profile = (
    await payload.find({
      collection: 'student-profiles',
      where: { user: { equals: studentUser.id } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0]
  if (!profile) {
    profile = await payload.create({
      collection: 'student-profiles',
      data: {
        user: studentUser.id,
        name: 'Seed Student',
        school: 'Example University',
        programme: 'Business Administration',
        year: 3,
        pitch: 'Seed pitch.',
        skills: ['market research', 'writing'],
        contactEmail: 'student@konnected.test',
        privacy: { shareName: true, shareSkills: true },
      },
      overrideAccess: true,
    })
  }

  // The student uploads a CV (a generated one-page PDF) and shares it with a selected company.
  if (!profile.cv) {
    const data = samplePdf('Seed Student CV')
    const cv = await payload.create({
      collection: 'cvs',
      data: {} as never,
      file: { data, name: 'seed-student-cv.pdf', mimetype: 'application/pdf', size: data.length },
      user: studentCtx,
      overrideAccess: false,
    })
    profile = await payload.update({
      collection: 'student-profiles',
      id: profile.id,
      data: { cv: cv.id, privacy: { ...profile.privacy, shareCv: true } },
      user: studentCtx,
      overrideAccess: false,
    })
  }

  // Konnected reviews every profile before matching.
  if (profile.reviewStatus !== 'reviewed') {
    profile = await payload.update({
      collection: 'student-profiles',
      id: profile.id,
      data: { reviewStatus: 'reviewed' },
      user: adminCtx,
      overrideAccess: false,
    })
  }

  // Company: registered by the company user (starts pending, linked to them), then approved by
  // the admin. The organisation number is made up but has a valid check digit.
  let companyId =
    typeof companyUser.company === 'object' ? companyUser.company?.id : companyUser.company
  if (!companyId) {
    const company = await payload.create({
      collection: 'companies',
      data: {
        name: 'Seed Startup AS',
        orgNumber: '999123457',
        contactName: 'Seed Contact',
        contactRole: 'Founder',
        website: 'https://seed-startup.example',
        sector: 'software',
        description: 'A seed company.',
        status: 'pending',
      },
      user: { ...companyUser, collection: 'users' as const },
      overrideAccess: false,
    })
    await payload.update({
      collection: 'companies',
      id: company.id,
      data: { status: 'approved' },
      user: adminCtx,
      overrideAccess: false,
    })
    companyUser = (await payload.findByID({
      collection: 'users',
      id: companyUser.id,
      depth: 0,
      overrideAccess: true,
    })) as User
    companyId = company.id
  }

  // A seed company made by an older version of this script lacks the details agreements need.
  // The organisation number cannot change after approval (Companies hook), so this repair of the
  // seed's own old data writes straight to the database. Development only (see the top).
  const seedCompany = await payload.findByID({
    collection: 'companies',
    id: companyId,
    depth: 0,
    overrideAccess: true,
  })
  if (!seedCompany.contactName || !seedCompany.orgNumber) {
    await payload.db.updateOne({
      collection: 'companies',
      where: { id: { equals: companyId } },
      data: {
        contactName: seedCompany.contactName || 'Seed Contact',
        contactRole: seedCompany.contactRole || 'Founder',
        orgNumber: seedCompany.orgNumber || '999123457',
      },
      returning: false,
    })
  }

  // Konnected's example agreement templates, so seed projects can be published and started.
  await ensureTemplate(payload, admin, 'company')
  await ensureTemplate(payload, admin, 'student')

  const move = (id: number, status: Status) =>
    payload.update({
      collection: 'projects',
      id,
      data: { status },
      user: adminCtx,
      overrideAccess: false,
    })

  type Student = { user: User; ctx: User & { collection: 'users' } }
  const mainStudent: Student = { user: studentUser, ctx: studentCtx }

  /**
   * Move a new project along `path` the real way: the company agreement before publishing, a
   * student applying and Konnected selecting them for `matched`, the student agreement before the
   * work starts. Every step runs as the admin (or the student) with access control on.
   */
  const advance = async (projectId: number, path: Status[], student: Student) => {
    for (const step of path) {
      if (step === 'matched') {
        // Konnected picks the student: apply, shortlist, select. Selecting makes the match and
        // moves the project to matched; the dates agreed at kick-off go on the match after.
        const application = await payload.create({
          collection: 'applications',
          data: { project: projectId, note: 'I have done similar work before.' } as never,
          user: student.ctx,
          overrideAccess: false,
        })
        for (const s of ['shortlisted', 'selected'] as const) {
          await payload.update({
            collection: 'applications',
            id: application.id,
            data: { status: s },
            user: adminCtx,
            overrideAccess: false,
          })
        }
        await payload.update({
          collection: 'matches',
          where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
          data: {
            // Agreed at kick-off; the student agreement uses them.
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          },
          user: adminCtx,
          overrideAccess: false,
        })
        continue
      }
      // The agreement gates: the company agreement before publishing, the student agreement
      // before the work starts.
      if (step === 'published') {
        await seedSignedAgreement(payload, admin, companyUser, {
          kind: 'company',
          projectId,
        })
      }
      if (step === 'in_progress') {
        const match = await payload.find({
          collection: 'matches',
          where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
          limit: 1,
          depth: 0,
          overrideAccess: true,
        })
        await seedSignedAgreement(payload, admin, student.user, {
          kind: 'student',
          matchId: match.docs[0]!.id,
        })
      }
      await move(projectId, step)
    }
  }

  /**
   * The seed project with this title: a new paid draft of `company`, or the one an earlier run
   * made. `advance` then takes it from where it stands, so a run that stopped half-way picks up.
   */
  const seedProject = async (title: string, ofCompany = companyId!) => {
    const found = await payload.find({
      collection: 'projects',
      where: { title: { equals: title } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    if (found.docs[0]) return found.docs[0]
    return payload.create({
      collection: 'projects',
      data: {
        company: ofCompany,
        status: 'draft',
        title,
        description: `${title}: a seed project.`,
        tasks: 'Do the seed task.',
        deliverable: 'A short written report.',
        desiredSkills: ['research'],
        workloadHours: 20,
        durationWeeks: 2,
        workMode: 'remote',
        paidOrUnpaid: 'paid',
        fee: 5000,
        studentPay: 3500,
        deadline: dayToStored(addDays(todayInOslo(), 10)),
        startDate: dayToStored(addDays(todayInOslo(), 17)),
      },
      overrideAccess: true,
    })
  }

  /** The steps of `path` still ahead of the project's status. */
  const ahead = (status: Status, path: Status[]) =>
    status === 'draft' ? path : path.includes(status) ? path.slice(path.indexOf(status) + 1) : []

  const MAIN: Status[] = [
    'submitted',
    'approved',
    'published',
    'matched',
    'in_progress',
    'delivered',
    'closed',
  ]
  const UNTIL = (status: Status) => MAIN.slice(0, MAIN.indexOf(status) + 1)
  const target: Status[] = [
    'draft',
    'submitted',
    'changes_requested',
    'rejected',
    'approved',
    'published',
    'matched',
    'in_progress',
    'delivered',
    'closed',
  ]

  // Finished projects first: a student works on at most 2 projects at once, so the seed student
  // applies to the closed and delivered ones before the matched and in-progress ones are running.
  for (const status of [...target].reverse()) {
    const project = await seedProject(`Seed project: ${status}`)
    const path: Status[] =
      status === 'changes_requested'
        ? ['submitted', 'changes_requested']
        : status === 'rejected'
          ? ['submitted', 'rejected']
          : status === 'draft'
            ? []
            : UNTIL(status)
    await advance(project.id, ahead(project.status, path), mainStudent)
  }

  // ---------- Problem paths (Kanban cards "Problem reports" and "Projects without a match") ----------
  // Other students work on these: the first one already has the 2 running projects above. Ended
  // matches do not count, so student2 can be matched again after each one ends.
  const second = await ensureStudent(
    payload,
    adminCtx,
    'student2@konnected.test',
    'Seed Student Two',
  )
  const fourth = await ensureStudent(
    payload,
    adminCtx,
    'student4@konnected.test',
    'Seed Student Four',
  )
  const fresh = await ensureStudent(payload, null, 'student3@konnected.test', 'Seed New Student')
  const team = adminCtx as unknown as SessionUser
  const form = (values: Record<string, string | number>) => {
    const f = new FormData()
    for (const [k, v] of Object.entries(values)) f.set(k, String(v))
    return f
  }
  const expectDone = (label: string, result: { status: string }) => {
    if (result.status !== 'done')
      throw new Error(`The seed could not ${label}: ${JSON.stringify(result)}`)
  }
  const report = async (projectId: number, student: Student, kind: string, note: string) => {
    const matchId = await activeMatchId(payload, projectId)
    const open = await payload.count({
      collection: 'problem-reports',
      where: { match: { equals: matchId } },
      overrideAccess: true,
    })
    if (!matchId || open.totalDocs) return
    await payload.create({
      collection: 'problem-reports',
      data: { match: matchId, kind, note } as never,
      user: student.ctx,
      overrideAccess: false,
    })
  }
  const inAWeek = addDays(todayInOslo(), 7)

  // The student could not finish: Konnected ended the match and takes applications again.
  const rematch = await seedProject('Seed project: match ended, applications reopened')
  if (!rematch.reopenedAt) {
    await advance(rematch.id, ahead(rematch.status, UNTIL('in_progress')), fourth)
    await report(
      rematch.id,
      fourth,
      'cannot_finish',
      'Seed: I got a full-time job and cannot finish.',
    )
    expectDone(
      'end a match',
      await endMatchAndReopen(
        payload,
        team,
        form({ id: rematch.id, date: inAWeek, note: 'Seed: the student stopped.' }),
      ),
    )
  }

  // Konnected closed a running project without delivery, with the reason both parties got.
  const stopped = await seedProject('Seed project: closed without delivery')
  if (stopped.status !== 'closed') {
    await advance(stopped.id, ahead(stopped.status, UNTIL('in_progress')), fourth)
    expectDone(
      'close without delivery',
      await closeWithoutDelivery(
        payload,
        team,
        form({
          id: stopped.id,
          reason: 'Seed: the company and Konnected agreed to stop. No invoice.',
        }),
      ),
    )
  }

  // The student needs more time: the report waits for the team (Today, "Problems reported").
  const troubled = await seedProject('Seed project: in progress, problem reported')
  await advance(troubled.id, ahead(troubled.status, UNTIL('in_progress')), second)
  await report(
    troubled.id,
    second,
    'more_time',
    'Seed: I have exams next week and can deliver a week later.',
  )

  // The student needed more time once already: the due date moved (the old one is kept).
  const moved = await seedProject('Seed project: in progress, due date moved')
  await advance(moved.id, ahead(moved.status, UNTIL('in_progress')), fourth)
  const movedMatch = await activeMatchId(payload, moved.id)
  const movedDoc = movedMatch
    ? await payload.findByID({
        collection: 'matches',
        id: movedMatch,
        depth: 0,
        overrideAccess: true,
      })
    : null
  if (movedDoc && !(movedDoc.dueDateHistory ?? []).length) {
    expectDone(
      'move a due date',
      await moveDueDate(
        payload,
        team,
        form({
          id: moved.id,
          date: addDays(todayInOslo(), 21),
          note: 'Seed: agreed with the student.',
        }),
      ),
    )
  }

  // Applications closed and nobody was selected (Today, "Projects without a match"). The new
  // student applied; the closing day is put in the past straight in the database (the form only
  // takes days ahead).
  const lonely = await seedProject('Seed project: published, no match yet')
  await advance(lonely.id, ahead(lonely.status, UNTIL('published')), second)
  await applyOnce(payload, lonely.id, fresh)
  await payload.db.updateOne({
    collection: 'projects',
    where: { id: { equals: lonely.id } },
    data: { deadline: dayToStored(addDays(todayInOslo(), -3)) },
    returning: false,
  })

  // Nobody fitted, and Konnected closed the project without a match.
  const unfit = await seedProject('Seed project: closed without a match')
  if (unfit.status !== 'closed') {
    await advance(unfit.id, ahead(unfit.status, UNTIL('published')), second)
    expectDone(
      'close without a match',
      await closeWithoutDelivery(
        payload,
        team,
        form({
          id: unfit.id,
          reason: 'Seed: no applicant had the skills. Konnected suggests a longer timeframe.',
        }),
      ),
    )
  }

  // The new student also waits for a decision on an open project (Student Home, waiting).
  const open = await seedProject('Seed project: published')
  await applyOnce(payload, open.id, fresh)

  // ---------- One test user for every other role and state ----------
  // A company Konnected has not approved yet (it may keep drafts), a company user who has not
  // registered a company, and a new account that has not chosen student or company.
  const pendingCompanyUser = await ensureUser(payload, 'company2@konnected.test', 'company')
  if (!pendingCompanyUser.company) {
    const pending = await payload.create({
      collection: 'companies',
      data: {
        name: 'Seed Pending AS',
        orgNumber: '999123465',
        contactName: 'Pending Contact',
        contactRole: 'Founder',
        website: 'https://seed-pending.example',
        sector: 'software',
        description: 'A seed company waiting for approval.',
        status: 'pending',
      },
      user: { ...pendingCompanyUser, collection: 'users' as const },
      overrideAccess: false,
    })
    await seedProject('Seed draft of a pending company', pending.id)
  }
  await ensureUser(payload, 'company3@konnected.test', 'company')
  await ensureUser(payload, 'newuser@konnected.test', 'pending')

  payload.logger.info('Seed done. Local accounts use the throwaway dev password from src/seed.ts.')
}

// `payload run` stops when this module finishes loading, so wait for the seed with top-level await.
try {
  await seed()
} catch (error) {
  console.error(error)
  process.exit(1)
}
