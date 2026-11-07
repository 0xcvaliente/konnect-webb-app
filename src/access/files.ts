import type { PayloadRequest, Where } from 'payload'

import { RELEASED_STATUSES } from '@/lib/deliverables/fields'
import { ACTIVE_MATCH } from '@/lib/problems/rules'

import { relationId } from './roles'

/**
 * Lookups behind the read and delete rules of the private file collections. The rules depend on
 * other documents (a match, a released deliverable, a project's status), so they are computed per
 * request and turned into an `id in [...]` constraint. Payload applies that constraint to REST,
 * GraphQL, the Local API and the file route alike.
 *
 * Bypass: these reads use `overrideAccess: true` because the asking user may not read the
 * documents involved (a company cannot read student profiles). Only ids leave these functions.
 */

type Rel = number | { id: number } | null | undefined

const ids = (values: Rel[]): number[] => [
  ...new Set(values.map((v) => relationId(v)).filter((v): v is number => typeof v === 'number')),
]

/** `id in ids`, or no access at all when the list is empty. */
export const idIn = (list: number[]): Where | false => (list.length ? { id: { in: list } } : false)

/**
 * CVs a company may read: the current CV of each student Konnected selected (matched) for one of
 * the company's projects, and only when that student ticked "share my CV".
 */
export async function cvIdsSharedWith(req: PayloadRequest, companyId: number): Promise<number[]> {
  const matches = await req.payload.find({
    collection: 'matches',
    // Only the current match: after Konnected ends one, the company opens nothing of that student.
    where: { and: [{ 'project.company': { equals: companyId } }, ACTIVE_MATCH] },
    depth: 0,
    pagination: false,
    overrideAccess: true,
    req,
  })
  const studentIds = ids(matches.docs.map((m) => m.student))
  if (!studentIds.length) return []
  const profiles = await req.payload.find({
    collection: 'student-profiles',
    where: { and: [{ id: { in: studentIds } }, { 'privacy.shareCv': { equals: true } }] },
    depth: 0,
    pagination: false,
    overrideAccess: true,
    req,
  })
  return ids(profiles.docs.map((p) => p.cv))
}

/** Files on deliverables that match `where`. */
async function deliverableFileIds(req: PayloadRequest, where: Where): Promise<number[]> {
  const deliverables = await req.payload.find({
    collection: 'deliverables',
    where,
    depth: 0,
    pagination: false,
    overrideAccess: true,
    req,
  })
  return ids(deliverables.docs.flatMap((d) => d.files ?? []))
}

/**
 * Deliverable files a company may read: those on deliverables of its own projects that Konnected
 * released (also after the company accepted them or asked for fixes).
 */
export const releasedFileIdsForCompany = (req: PayloadRequest, companyId: number) =>
  deliverableFileIds(req, {
    and: [
      { 'match.project.company': { equals: companyId } },
      { status: { in: [...RELEASED_STATUSES] } },
    ],
  })

/**
 * A student's files on a hand-in they sent. They can no longer be deleted: Konnected checks a
 * hand-in as it was sent, and the company receives it as Konnected released it.
 */
export const sentFileIdsForStudent = (req: PayloadRequest, userId: number) =>
  deliverableFileIds(req, { 'match.student.user': { equals: userId } })

/** Brief files on projects that match `where`. */
async function attachmentIds(req: PayloadRequest, where: Where): Promise<number[]> {
  const projects = await req.payload.find({
    collection: 'projects',
    where,
    depth: 0,
    pagination: false,
    overrideAccess: true,
    req,
  })
  return ids(projects.docs.flatMap((p) => p.attachments ?? []))
}

/** Brief files a student may read: only those of projects Konnected selected them for. */
export async function briefIdsForStudent(req: PayloadRequest, userId: number): Promise<number[]> {
  const matches = await req.payload.find({
    collection: 'matches',
    // Brief attachments are for the selected student only, while the match runs.
    where: { and: [{ 'student.user': { equals: userId } }, ACTIVE_MATCH] },
    depth: 0,
    pagination: false,
    overrideAccess: true,
    req,
  })
  const projectIds = ids(matches.docs.map((m) => m.project))
  return projectIds.length ? attachmentIds(req, { id: { in: projectIds } }) : []
}

/**
 * Brief files a company can no longer delete: those on its projects that left `draft` or
 * `changes_requested`, so a project Konnected reviewed does not change under it.
 */
export const lockedBriefIdsForCompany = (req: PayloadRequest, companyId: number) =>
  attachmentIds(req, {
    and: [
      { company: { equals: companyId } },
      { status: { not_in: ['draft', 'changes_requested'] } },
    ],
  })

/** The logo on a company, or undefined. */
export async function ownCompanyLogoId(
  req: PayloadRequest,
  companyId: number | undefined,
): Promise<number | undefined> {
  if (!companyId) return undefined
  const company = await req.payload.findByID({
    collection: 'companies',
    id: companyId,
    depth: 0,
    select: { logo: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  return relationId(company?.logo)
}

/**
 * Logos students may read: those copied onto published projects (students read only published
 * projects, and see the company's name and logo there, never the company itself).
 */
export async function logoIdsForStudents(req: PayloadRequest): Promise<number[]> {
  const projects = await req.payload.find({
    collection: 'projects',
    where: { and: [{ status: { equals: 'published' } }, { companyLogo: { exists: true } }] },
    depth: 0,
    pagination: false,
    select: { companyLogo: true },
    overrideAccess: true,
    req,
  })
  return ids(projects.docs.map((p) => p.companyLogo))
}

/** Logos that something uses: the logo on a company, or the copy on a project. */
export async function logoIdsInUse(req: PayloadRequest): Promise<number[]> {
  const companies = await req.payload.find({
    collection: 'companies',
    where: { logo: { exists: true } },
    depth: 0,
    pagination: false,
    select: { logo: true },
    overrideAccess: true,
    req,
  })
  const projects = await req.payload.find({
    collection: 'projects',
    where: { companyLogo: { exists: true } },
    depth: 0,
    pagination: false,
    select: { companyLogo: true },
    overrideAccess: true,
    req,
  })
  return ids([...companies.docs.map((c) => c.logo), ...projects.docs.map((p) => p.companyLogo)])
}
