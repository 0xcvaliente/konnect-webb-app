/**
 * Development seed: one admin, one student (with a CV), one approved company, and one project in
 * each status.
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
  if (!made.ok) throw new Error(`The seed could not make an agreement: ${made.error}`)
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

  // Finished projects first: a student works on at most 2 projects at once, so the seed student
  // applies to the closed and delivered ones before the matched and in-progress ones are running.
  for (const status of [...target].reverse()) {
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
        studentPay: 3500,
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
          data: { project: project.id, note: 'I have done similar work before.' } as never,
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
          data: {
            project: project.id,
            student: profile.id,
            application: application.id,
            // Agreed at kick-off; the student agreement uses them.
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          },
          user: adminCtx,
          overrideAccess: false,
        })
      }
      // The agreement gates: the company agreement before publishing, the student agreement
      // before the work starts.
      if (step === 'published') {
        await seedSignedAgreement(payload, admin, companyUser, {
          kind: 'company',
          projectId: project.id,
        })
      }
      if (step === 'in_progress') {
        const match = await payload.find({
          collection: 'matches',
          where: { project: { equals: project.id } },
          limit: 1,
          depth: 0,
          overrideAccess: true,
        })
        await seedSignedAgreement(payload, admin, studentUser, {
          kind: 'student',
          matchId: match.docs[0]!.id,
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
