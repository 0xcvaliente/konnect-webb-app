import { APIError, type PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import type { Agreement, Company, Match, Project, StudentProfile } from '@/payload-types'

import { type AgreementSource, agreementValues } from './values'

/**
 * The two agreement gates (konnected-product-rules, rule 9). Checked on the server for every way
 * a project's status can change (REST, GraphQL, the Local API, the admin panel), from the project
 * status rules in lib/transitions.ts.
 *
 * A signed agreement opens its gate only while it still matches what it gates: the company
 * agreement the project's current company, the student agreement the match's current student and
 * project, and both the terms the parties signed (the values in the PDF, `agreement.values`)
 * recomputed from the project and match as they are now, including the change in the same
 * request. A new price, scope or student after signing needs a new agreement.
 *
 * Not compared: the agreement's own date and reference, and the parties' own details (company
 * name, organisation number, contact, student name). A party may update those; who signed is
 * checked by id instead.
 *
 * Bypass: the lookups use `overrideAccess: true` because the gate is a rule about the project, the
 * same whoever moves it, and the acting user may not read the agreement. Only a yes or no leaves
 * here.
 */

const compared = (field: string) =>
  !field.startsWith('agreement.') && !field.startsWith('company.') && field !== 'student.fullName'

/** The terms the agreement was signed with are the terms the source gives now. */
function sameTerms(agreement: Agreement, source: AgreementSource): boolean {
  const signed = (agreement.values ?? {}) as Record<string, string | null>
  const now = agreementValues(source, { reference: agreement.reference }) as Record<
    string,
    string | null
  >
  return Object.keys(signed)
    .filter(compared)
    .every((field) => (signed[field] ?? null) === (now[field] ?? null))
}

async function signedAgreements(
  req: PayloadRequest,
  kind: 'company' | 'student',
  where: { project: number } | { match: number },
): Promise<Agreement[]> {
  const found = await req.payload.find({
    collection: 'agreements',
    where: {
      and: [
        'project' in where
          ? { project: { equals: where.project } }
          : { match: { equals: where.match } },
        { kind: { equals: kind } },
        { status: { equals: 'signed' } },
      ],
    },
    depth: 0,
    pagination: false,
    overrideAccess: true,
    req,
  })
  return found.docs as Agreement[]
}

type Gate = 'unsigned' | 'changed' | 'open'

/** The project's company agreement, signed by the company and Konnected, for its company and terms. */
async function companyGate(req: PayloadRequest, project: Project): Promise<Gate> {
  const agreements = await signedAgreements(req, 'company', { project: project.id })
  if (!agreements.length) return 'unsigned'
  const companyId = relationId(project.company)
  const company = { id: companyId } as Company
  const matches = agreements.some(
    (a) =>
      relationId(a.company) === companyId && sameTerms(a, { kind: 'company', project, company }),
  )
  return matches ? 'open' : 'changed'
}

/** The match's student agreement, signed by the student and Konnected, for its student and terms. */
async function studentGate(req: PayloadRequest, project: Project): Promise<Gate> {
  const matches = await req.payload.find({
    collection: 'matches',
    where: { project: { equals: project.id } },
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
  })
  const match = matches.docs[0] as Match | undefined
  if (!match) return 'unsigned'
  const agreements = await signedAgreements(req, 'student', { match: match.id })
  if (!agreements.length) return 'unsigned'
  const studentId = relationId(match.student)
  const student = { id: studentId } as StudentProfile
  const company = { id: relationId(project.company) } as Company
  const fits = agreements.some(
    (a) =>
      relationId(a.student) === studentId &&
      relationId(a.project) === project.id &&
      sameTerms(a, { kind: 'student', project, company, match, student }),
  )
  return fits ? 'open' : 'changed'
}

const CHANGED =
  'no longer matches (another company or student, or a new price, scope or dates). Make a new agreement first.'

/**
 * Gate 1: a project is published only after its company agreement is signed by all parties.
 * `project` is the project as it will be saved, with the changes of the same request.
 */
export async function assertCompanyAgreementSigned(
  req: PayloadRequest,
  project: Project | undefined,
): Promise<void> {
  const gate = project?.id ? await companyGate(req, project) : 'unsigned'
  if (gate === 'unsigned') {
    throw new APIError(
      'Project: the company agreement must be signed by the company and Konnected before publishing',
      409,
    )
  }
  if (gate === 'changed') {
    throw new APIError(`Project: the signed company agreement ${CHANGED}`, 409)
  }
}

/** Gate 2: the work starts (in_progress) only after the student agreement is signed by all. */
export async function assertStudentAgreementSigned(
  req: PayloadRequest,
  project: Project | undefined,
): Promise<void> {
  const gate = project?.id ? await studentGate(req, project) : 'unsigned'
  if (gate === 'unsigned') {
    throw new APIError(
      'Project: the student agreement must be signed by the student and Konnected before the work starts',
      409,
    )
  }
  if (gate === 'changed') {
    throw new APIError(`Project: the signed student agreement ${CHANGED}`, 409)
  }
}
