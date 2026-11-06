/**
 * Development seed: one admin, one student (with a CV), one approved company, and one project in
 * each status.
 * Run with `pnpm seed`. Safe to run again: everything is found by email or title first.
 *
 * Local development only. It refuses to run in production, and the passwords below are throwaway
 * values for local accounts. Every status change goes through the real access rules and hooks as
 * the admin user, so the seed also proves the status workflow.
 */
import config from '@payload-config'
import { getPayload, type Payload } from 'payload'

import { adminEmails } from '@/access/adminEmails'
import { samplePdf } from '@/lib/uploads/samplePdf'
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

  const move = (id: number, status: Status) =>
    payload.update({
      collection: 'projects',
      id,
      data: { status },
      user: adminCtx,
      overrideAccess: false,
    })

  const MAIN: Status[] = [
    'submitted',
    'approved',
    'published',
    'matched',
    'in_progress',
    'delivered',
    'closed',
  ]
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

  for (const status of target) {
    const title = `Seed project: ${status}`
    const exists = await payload.count({
      collection: 'projects',
      where: { title: { equals: title } },
      overrideAccess: true,
    })
    if (exists.totalDocs > 0) continue

    const project = await payload.create({
      collection: 'projects',
      data: {
        company: companyId,
        status: 'draft',
        title,
        description: `A seed project in the ${status} state.`,
        tasks: 'Do the seed task.',
        deliverable: 'A short written report.',
        desiredSkills: ['research'],
        workloadHours: 20,
        durationWeeks: 2,
        workMode: 'remote',
        paidOrUnpaid: 'paid',
        fee: 5000,
      },
      overrideAccess: true,
    })

    const path: Status[] =
      status === 'changes_requested'
        ? ['submitted', 'changes_requested']
        : status === 'rejected'
          ? ['submitted', 'rejected']
          : status === 'draft'
            ? []
            : MAIN.slice(0, MAIN.indexOf(status) + 1)

    for (const step of path) {
      if (step === 'matched') {
        // Konnected picks the student: apply, shortlist, select, then create the match.
        const application = await payload.create({
          collection: 'applications',
          data: { project: project.id } as never,
          user: studentCtx,
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
        await payload.create({
          collection: 'matches',
          data: { project: project.id, student: profile.id, application: application.id },
          user: adminCtx,
          overrideAccess: false,
        })
      }
      await move(project.id, step)
    }
  }

  payload.logger.info('Seed done. Local accounts use the throwaway dev password from src/seed.ts.')
}

// `payload run` stops when this module finishes loading, so wait for the seed with top-level await.
try {
  await seed()
} catch (error) {
  console.error(error)
  process.exit(1)
}
