import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import type { Company, Match, Project, StudentProfile } from '@/payload-types'

import {
  type AgreementKind,
  PAYMENT_TERMS_DAYS,
  TEMPLATE_FIELDS,
  type TemplateField,
  VAT_RATE,
} from './fields'

/**
 * The values an agreement is filled with, from the project (and, for a student agreement, the
 * match and the student's profile). Only the fields on the allowed list for the kind are returned
 * (lib/agreements/fields.ts), so the company agreement never carries student data and the student
 * agreement never carries the company's price.
 *
 * Formats (an assumption until the team says otherwise): dates as ISO 8601 (2026-11-06), money
 * in Norwegian kroner with Norwegian number format ("6 500,00 kr").
 */

export type AgreementSource =
  | { kind: 'company'; project: Project; company: Company }
  | {
      kind: 'student'
      project: Project
      company: Company
      match: Match
      student: StudentProfile
    }

const money = (amount: number) =>
  new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK' }).format(amount)

const day = (value: string | null | undefined) =>
  value ? new Date(value).toISOString().slice(0, 10) : null

const text = (value: string | null | undefined) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || null
}

/** All values for the kind. A field without a value is null (the team sees which ones). */
export function agreementValues(
  source: AgreementSource,
  { reference, today = new Date() }: { reference: string; today?: Date },
): Record<TemplateField, string | null> {
  const { project, company } = source
  const fee = typeof project.fee === 'number' && project.fee > 0 ? project.fee : null
  const vat = fee === null ? null : Math.round(fee * VAT_RATE * 100) / 100

  const all: Record<TemplateField, string | null> = {
    'agreement.date': day(today.toISOString()),
    'agreement.reference': reference,
    'project.title': text(project.title),
    'project.description': text(project.description),
    'project.tasks': text(project.tasks),
    'project.deliverable': text(project.deliverable),
    'project.workload': text(project.workload),
    'project.timeframe': text(project.duration),
    'project.deadline': day(project.deadline),
    // Until projects carry their own paid or unpaid choice: a project with a price is paid.
    'project.payment': fee === null ? 'Unpaid / Ulønnet' : 'Paid / Betalt',
    'company.name': text(company.name),
    'company.orgNumber': text(company.orgNumber),
    'company.contactName': text(company.contactName),
    'price.exclVat': fee === null ? null : money(fee),
    'price.vatRate': `${Math.round(VAT_RATE * 100)} %`,
    'price.vat': vat === null ? null : money(vat),
    'price.total': fee === null || vat === null ? null : money(fee + vat),
    'payment.termsDays': String(PAYMENT_TERMS_DAYS),
    'student.fullName': source.kind === 'student' ? text(source.student.name) : null,
    'project.startDate': source.kind === 'student' ? day(source.match.startDate) : null,
    'project.dueDate': source.kind === 'student' ? day(source.match.endDate) : null,
  }
  const allowed = TEMPLATE_FIELDS[source.kind]
  return Object.fromEntries(allowed.map((field) => [field, all[field]])) as Record<
    TemplateField,
    string | null
  >
}

/** The template's fields that have no value for this source. */
export const missingFields = (fields: string[], values: Record<string, string | null>) =>
  fields.filter((field) => !values[field])

/**
 * Read what an agreement is made from. Bypass: the server reads the project, company, match and
 * student profile with `overrideAccess: true` to fill the template; only the allowed fields above
 * leave this module, and only into the agreement of the party concerned.
 */
export async function loadSource(
  req: PayloadRequest,
  input: { kind: 'company'; projectId: number } | { kind: 'student'; matchId: number },
): Promise<AgreementSource | null> {
  const find = async <T>(
    collection: 'projects' | 'companies' | 'matches' | 'student-profiles',
    id: number,
  ) =>
    (await req.payload.findByID({
      collection,
      id,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
      req,
    })) as T | null

  if (input.kind === 'company') {
    const project = await find<Project>('projects', input.projectId)
    const company = project && (await find<Company>('companies', relationId(project.company)!))
    return project && company ? { kind: 'company', project, company } : null
  }
  const match = await find<Match>('matches', input.matchId)
  if (!match) return null
  const project = await find<Project>('projects', relationId(match.project)!)
  const student = await find<StudentProfile>('student-profiles', relationId(match.student)!)
  const company = project && (await find<Company>('companies', relationId(project.company)!))
  return project && student && company
    ? { kind: 'student', project, company, match, student }
    : null
}

/** Load the source again for an existing agreement. */
export function sourceOf(agreement: {
  kind: AgreementKind
  project: number | { id: number }
  match?: number | { id: number } | null
}) {
  return agreement.kind === 'company'
    ? ({ kind: 'company', projectId: relationId(agreement.project)! } as const)
    : ({ kind: 'student', matchId: relationId(agreement.match)! } as const)
}
