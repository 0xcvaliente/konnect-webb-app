import type { PayloadRequest, Where } from 'payload'

import { type AccessUser, companyIdOf, isAdmin, isStudent } from './roles'

/**
 * Who reads an agreement, its signatures and its PDFs (konnected-agreements, Access):
 * - admins: all of them;
 * - a company: only the company agreements of its own company;
 * - a student: only the student agreements of their own matches;
 * - anyone else: nothing.
 * A company never reads a student agreement, whatever the project. `prefix` is the path to the
 * agreement from the collection asked about ('' for agreements, 'agreement.' for the others).
 */
export function agreementPartyWhere(
  user: AccessUser | null | undefined,
  prefix = '',
): Where | boolean {
  if (isAdmin(user)) return true
  const companyId = companyIdOf(user)
  if (companyId) {
    return {
      and: [
        { [`${prefix}kind`]: { equals: 'company' } },
        { [`${prefix}company`]: { equals: companyId } },
      ],
    }
  }
  if (isStudent(user)) {
    return {
      and: [
        { [`${prefix}kind`]: { equals: 'student' } },
        { [`${prefix}student.user`]: { equals: user!.id } },
      ],
    }
  }
  return false
}

/**
 * The context flag that marks a write as made by Konnected's own agreement code (generating,
 * signing, completing). Agreements, signatures and agreement PDFs refuse every create and change
 * without it, so no API call (REST, GraphQL, or the Local API used elsewhere) can write them.
 * Clients cannot set `req.context`; only server code can.
 */
export const AGREEMENT_SERVER_WRITE = 'agreementServerWrite'

export const isAgreementServerWrite = (req: PayloadRequest): boolean =>
  (req.context as Record<string, unknown> | undefined)?.[AGREEMENT_SERVER_WRITE] === true

export const agreementServerContext = { [AGREEMENT_SERVER_WRITE]: true } as const
