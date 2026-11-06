import {
  APIError,
  type CollectionBeforeOperationHook,
  type PayloadRequest,
  type Where,
} from 'payload'

import { companyIdOf, isAdmin, relationId } from '@/access/roles'

/**
 * Limits on files nothing uses yet, and the clean-up of files nothing uses any more.
 *
 * Uploading and attaching are two steps: a file is uploaded first, then listed on a profile, a
 * project or a deliverable. Without a limit, one account could upload file after file and fill
 * the server's disk, which PostgreSQL shares. So each account may hold only a few files that are
 * not in use (`MAX_UNUSED_FILES`), and a daily job removes files nothing has used for
 * `UNUSED_FILE_DAYS` days (see `removeUnusedFiles`).
 *
 * Bypass: the lookups here use `overrideAccess: true` because they read documents the uploader
 * may not read (a match, another profile) or run with no user at all (the clean-up job). Only ids
 * and counts leave these functions.
 */

export type FileSlug = 'cvs' | 'brief-files' | 'deliverable-files'

/**
 * How many files one account may hold that are not in use. Uploads above it are refused until
 * the person uses or deletes some. Admins have no limit.
 *
 * - CVs: files not on the student's profile. The profile holds one CV; three spare ones are enough
 *   to replace it a few times.
 * - Brief files: files not on a project the company submitted. Files on a draft count, so an
 *   account Konnected has not approved (it cannot submit) cannot fill the disk through drafts.
 * - Deliverable files: files not on a deliverable. Twice the 10 files one deliverable lists.
 */
export const MAX_UNUSED_FILES: Record<FileSlug, number> = {
  cvs: 3,
  'brief-files': 20,
  'deliverable-files': 20,
}

/** Files nothing has used for this many days are removed by the daily clean-up. */
export const UNUSED_FILE_DAYS = 7

type Rel = number | { id: number } | null | undefined

const ids = (values: Rel[]): number[] => [
  ...new Set(values.map((v) => relationId(v)).filter((v): v is number => typeof v === 'number')),
]

/** `id not in list`, or nothing when the list is empty. */
const notIn = (list: number[]): Where[] => (list.length ? [{ id: { not_in: list } }] : [])

/** CVs on a student profile, or kept on a match as what the student shared. */
async function cvsInUse(req: PayloadRequest, userId?: number): Promise<number[]> {
  const profiles = await req.payload.find({
    collection: 'student-profiles',
    where: userId ? { user: { equals: userId } } : { cv: { exists: true } },
    depth: 0,
    pagination: false,
    select: { cv: true },
    overrideAccess: true,
    req,
  })
  const matches = await req.payload.find({
    collection: 'matches',
    where: userId ? { 'student.user': { equals: userId } } : { 'sharedInfo.cv': { exists: true } },
    depth: 0,
    pagination: false,
    select: { sharedInfo: { cv: true } },
    overrideAccess: true,
    req,
  })
  return ids([...profiles.docs.map((p) => p.cv), ...matches.docs.map((m) => m.sharedInfo?.cv)])
}

/** Brief files on projects matching `where`. */
async function briefsOn(req: PayloadRequest, where?: Where): Promise<number[]> {
  const projects = await req.payload.find({
    collection: 'projects',
    where,
    depth: 0,
    pagination: false,
    select: { attachments: true },
    overrideAccess: true,
    req,
  })
  return ids(projects.docs.flatMap((p) => p.attachments ?? []))
}

/** Deliverable files listed on deliverables matching `where`. */
async function deliverableFilesOn(req: PayloadRequest, where?: Where): Promise<number[]> {
  const deliverables = await req.payload.find({
    collection: 'deliverables',
    where,
    depth: 0,
    pagination: false,
    select: { files: true },
    overrideAccess: true,
    req,
  })
  return ids(deliverables.docs.flatMap((d) => d.files ?? []))
}

/**
 * The uploader's own files that do not count as in use, as a `where`. Undefined when the user
 * cannot own files of this kind (create access refuses them anyway).
 */
async function unusedOwnFiles(req: PayloadRequest, slug: FileSlug): Promise<Where | undefined> {
  const user = req.user
  if (!user) return undefined
  if (slug === 'cvs') {
    return { and: [{ owner: { equals: user.id } }, ...notIn(await cvsInUse(req, user.id))] }
  }
  if (slug === 'brief-files') {
    const companyId = companyIdOf(user)
    if (!companyId) return undefined
    const submitted = await briefsOn(req, {
      and: [{ company: { equals: companyId } }, { status: { not_equals: 'draft' } }],
    })
    return { and: [{ company: { equals: companyId } }, ...notIn(submitted)] }
  }
  const listed = await deliverableFilesOn(req, { 'match.student.user': { equals: user.id } })
  return { and: [{ uploadedBy: { equals: user.id } }, ...notIn(listed)] }
}

/**
 * Refuse a new upload while the uploader already holds `MAX_UNUSED_FILES` files that are not in
 * use. Runs before the file is checked or stored. Admins are not limited.
 */
export const limitUnusedFiles =
  (slug: FileSlug): CollectionBeforeOperationHook =>
  async ({ args, operation, req }) => {
    if (operation !== 'create' || isAdmin(req.user)) return args
    const where = await unusedOwnFiles(req, slug)
    if (!where) return args
    const { totalDocs } = await req.payload.count({
      collection: slug,
      where,
      overrideAccess: true,
      req,
    })
    if (totalDocs >= MAX_UNUSED_FILES[slug]) {
      throw new APIError(
        'You have too many uploaded files that are not in use. Use or delete some first.',
        429,
      )
    }
    return args
  }

/**
 * Remove files nothing uses that are older than `days`: CVs on no profile and no match (each
 * student keeps their newest CV), brief files on no project, deliverable files on no deliverable.
 * Deleting the document deletes the file on disk and writes an activity log row.
 */
export async function removeUnusedFiles(
  req: PayloadRequest,
  { days = UNUSED_FILE_DAYS, now = new Date() }: { days?: number; now?: Date } = {},
): Promise<Record<FileSlug, number>> {
  const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
  const old: Where = { createdAt: { less_than: before } }

  // Each student's newest CV stays, even if it is not on the profile yet.
  const allCvs = await req.payload.find({
    collection: 'cvs',
    depth: 0,
    pagination: false,
    sort: '-createdAt',
    select: { owner: true },
    overrideAccess: true,
    req,
  })
  const newest = new Map<number, number>()
  for (const cv of allCvs.docs) {
    const owner = relationId(cv.owner)
    if (owner && !newest.has(owner)) newest.set(owner, cv.id)
  }

  const unused: Record<FileSlug, Where> = {
    cvs: { and: [old, ...notIn([...(await cvsInUse(req)), ...newest.values()])] },
    'brief-files': { and: [old, ...notIn(await briefsOn(req))] },
    'deliverable-files': { and: [old, ...notIn(await deliverableFilesOn(req))] },
  }

  const removed = { cvs: 0, 'brief-files': 0, 'deliverable-files': 0 }
  for (const slug of Object.keys(unused) as FileSlug[]) {
    const result = await req.payload.delete({
      collection: slug,
      where: unused[slug],
      depth: 0,
      overrideAccess: true,
      req,
    })
    removed[slug] = result.docs.length
    if (result.errors.length) {
      req.payload.logger.error(
        { collection: slug, failed: result.errors.length },
        'Could not remove some unused files',
      )
    }
  }
  return removed
}
