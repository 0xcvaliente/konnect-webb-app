import { APIError, type PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'

/**
 * The two agreement gates (konnected-product-rules, rule 9). Checked on the server for every way
 * a project's status can change (REST, GraphQL, the Local API, the admin panel), from the project
 * status rules in lib/transitions.ts.
 *
 * Bypass: the lookups use `overrideAccess: true` because the gate is a rule about the project, the
 * same whoever moves it, and the acting user may not read the agreement. Only counts leave here.
 */

/** The project's company agreement is signed by the company and by Konnected. */
export async function companyAgreementSigned(
  req: PayloadRequest,
  projectId: number,
): Promise<boolean> {
  const { totalDocs } = await req.payload.count({
    collection: 'agreements',
    where: {
      and: [
        { project: { equals: projectId } },
        { kind: { equals: 'company' } },
        { status: { equals: 'signed' } },
      ],
    },
    overrideAccess: true,
    req,
  })
  return totalDocs > 0
}

/** The project's match has a student agreement signed by the student and by Konnected. */
export async function studentAgreementSigned(
  req: PayloadRequest,
  projectId: number,
): Promise<boolean> {
  const matches = await req.payload.find({
    collection: 'matches',
    where: { project: { equals: projectId } },
    depth: 0,
    limit: 1,
    select: { project: true },
    overrideAccess: true,
    req,
  })
  const matchId = relationId(matches.docs[0]?.id)
  if (!matchId) return false
  const { totalDocs } = await req.payload.count({
    collection: 'agreements',
    where: {
      and: [
        { match: { equals: matchId } },
        { kind: { equals: 'student' } },
        { status: { equals: 'signed' } },
      ],
    },
    overrideAccess: true,
    req,
  })
  return totalDocs > 0
}

/** Gate 1: a project is published only after its company agreement is signed by all parties. */
export async function assertCompanyAgreementSigned(
  req: PayloadRequest,
  projectId: number | undefined,
): Promise<void> {
  if (!projectId || !(await companyAgreementSigned(req, projectId))) {
    throw new APIError(
      'Project: the company agreement must be signed by the company and Konnected before publishing',
      409,
    )
  }
}

/** Gate 2: the work starts (in_progress) only after the student agreement is signed by all. */
export async function assertStudentAgreementSigned(
  req: PayloadRequest,
  projectId: number | undefined,
): Promise<void> {
  if (!projectId || !(await studentAgreementSigned(req, projectId))) {
    throw new APIError(
      'Project: the student agreement must be signed by the student and Konnected before the work starts',
      409,
    )
  }
}
