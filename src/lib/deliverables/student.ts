import type { Payload } from 'payload'

import { isCompany, isStudent } from '@/access/roles'
import type { SessionUser } from '@/lib/students/profile'
import type { Deliverable, DeliverableFile } from '@/payload-types'

import {
  type DeliverableError,
  deliverableErrorCode,
  type DeliverableState,
  type DeliveryItem,
  deliveryState,
  type DeliveryState,
  isWebLink,
  LINK_LABEL_MAX,
  MAX_LINKS,
  NOTE_MAX,
} from './fields'
import { MAX_DELIVERABLE_FILES } from '@/collections/DeliverableFiles'

/**
 * The student's and the company's side of the hand-off. Every read and write goes through the
 * Local API as the signed-in user with `overrideAccess: false`, so the Deliverables access rules
 * (own match; released work only for the company) and its hook (the flow's rules) decide. The
 * checks here come first only to give clear answers. Nothing here logs notes or file names.
 */

const asUser = (user: SessionUser) => ({ user, overrideAccess: false as const })

export type DeliverableFileView = {
  id: number
  name: string
  size: number | null
  url: string | null
}

/** One hand-in as the pages show it. Notes are shown only to whom the collection lets read them. */
export type HandIn = {
  id: number
  status: Deliverable['status']
  note: string | null
  files: DeliverableFileView[]
  links: { label: string | null; url: string }[]
  submittedAt: string | null
  releasedAt: string | null
  returnNote: string | null
  returnedAt: string | null
  fixNote: string | null
  fixRequestedAt: string | null
  acceptedAt: string | null
  acceptedBy: Deliverable['acceptedBy'] | null
  createdAt: string
}

export const toHandIn = (doc: Deliverable): HandIn => ({
  id: doc.id,
  status: doc.status,
  note: doc.note ?? null,
  files: (doc.files ?? [])
    .filter((f): f is DeliverableFile => typeof f === 'object' && f !== null)
    .map((f) => ({
      id: f.id,
      name: f.originalName ?? f.filename ?? 'file',
      size: f.filesize ?? null,
      url: f.url ?? null,
    })),
  links: (doc.links ?? []).map((l) => ({ label: l.label ?? null, url: l.url })),
  submittedAt: doc.submittedAt ?? null,
  releasedAt: doc.releasedAt ?? null,
  returnNote: doc.returnNote ?? null,
  returnedAt: doc.returnedAt ?? null,
  fixNote: doc.fixNote ?? null,
  fixRequestedAt: doc.fixRequestedAt ?? null,
  acceptedAt: doc.acceptedAt ?? null,
  acceptedBy: doc.acceptedBy ?? null,
  createdAt: doc.createdAt,
})

const asItem = (h: HandIn): DeliveryItem => ({
  id: h.id,
  status: h.status,
  createdAt: h.createdAt,
  releasedAt: h.releasedAt,
  fixRequestedAt: h.fixRequestedAt,
})

export type StudentWork = {
  matchId: number
  projectStatus: string | null
  /** Newest first. */
  handIns: HandIn[]
  state: DeliveryState
}

/**
 * The work on one of the student's own matches, by project. Null before Konnected selected the
 * student, and for anyone else.
 */
export async function loadStudentWork(
  payload: Payload,
  user: SessionUser | null,
  projectId: number | null,
): Promise<StudentWork | null> {
  if (!user || !isStudent(user) || !projectId) return null
  const found = await payload.find({
    collection: 'matches',
    where: { project: { equals: projectId } },
    limit: 1,
    depth: 0,
    select: { project: true },
    ...asUser(user),
  })
  const match = found.docs[0]
  if (!match) return null
  // Bypass: a student reads published projects only, and this one is matched. The student's own
  // match was read above with access control on; only the project's status is read here, to say
  // whether the work has started.
  const project = await payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { status: true },
    overrideAccess: true,
    disableErrors: true,
  })
  const docs = await payload.find({
    collection: 'deliverables',
    where: { match: { equals: match.id } },
    depth: 1,
    pagination: false,
    sort: '-createdAt',
    ...asUser(user),
  })
  const handIns = docs.docs.map((d) => toHandIn(d as Deliverable))
  return {
    matchId: match.id,
    projectStatus: project?.status ?? null,
    handIns,
    state: deliveryState(handIns.map(asItem), project?.status),
  }
}

const fail = (error: DeliverableError): DeliverableState => ({
  status: 'error',
  error,
  doneAt: Date.now(),
})

const idOf = (value: FormDataEntryValue | null): number => {
  const text = typeof value === 'string' ? value : ''
  return /^\d{1,10}$/.test(text) ? Number(text) : 0
}

/**
 * Send a hand-in as the signed-in student: the files already uploaded for the match, the links
 * and the note. The student comes from the session; the hook checks the match is theirs and that
 * the work is open for a hand-in.
 */
export async function submitDeliverable(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<DeliverableState> {
  if (!user || !isStudent(user)) return fail('forbidden')
  const matchId = idOf(form.get('matchId'))
  if (!matchId) return fail('not_found')
  const files = [...new Set(form.getAll('file').map(idOf).filter(Boolean))]
  if (files.length > MAX_DELIVERABLE_FILES) return fail('too_many_files')
  const labels = form.getAll('linkLabel').map((v) => (typeof v === 'string' ? v.trim() : ''))
  const urls = form.getAll('linkUrl').map((v) => (typeof v === 'string' ? v.trim() : ''))
  const links: { label: string | null; url: string }[] = []
  urls.forEach((url, i) => {
    const label = labels[i] ?? ''
    if (!url && !label) return
    links.push({ label: label.slice(0, LINK_LABEL_MAX) || null, url })
  })
  if (links.length > MAX_LINKS) return fail('too_many_links')
  if (links.some((l) => !isWebLink(l.url))) return fail('bad_link')
  if (!files.length && !links.length) return fail('empty')
  const rawNote = form.get('note')
  const note = typeof rawNote === 'string' ? rawNote.trim() : ''
  if (note.length > NOTE_MAX) return fail('note_too_long')

  try {
    await payload.create({
      collection: 'deliverables',
      data: { match: matchId, files, links, note: note || null, status: 'submitted' },
      ...asUser(user),
    })
    return { status: 'done', doneAt: Date.now() }
  } catch (error) {
    return fail(deliverableErrorCode(error) ?? (statusOf(error) === 403 ? 'forbidden' : 'generic'))
  }
}

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined

// ---------- The company ----------

export type CompanyWork = {
  /** What Konnected released, newest first. Nothing else exists for the company. */
  handIns: HandIn[]
  state: DeliveryState
}

/**
 * The released work on one of the company user's own projects, read as that user: the collection
 * returns released hand-ins only. Null for anyone else. The caller must have read the project as
 * the company user first.
 */
export async function loadCompanyWork(
  payload: Payload,
  user: SessionUser | null,
  projectId: number,
  projectStatus: string,
): Promise<CompanyWork | null> {
  if (!user || !isCompany(user)) return null
  const docs = await payload.find({
    collection: 'deliverables',
    where: { 'match.project': { equals: projectId } },
    depth: 1,
    pagination: false,
    sort: '-createdAt',
    ...asUser(user),
  })
  const handIns = docs.docs.map((d) => toHandIn(d as Deliverable))
  return { handIns, state: deliveryState(handIns.map(asItem), projectStatus) }
}

/** Accept the released work, or ask for the one round of fixes, as the signed-in company user. */
export async function companyDecision(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
  decision: 'accept' | 'fix',
): Promise<DeliverableState> {
  if (!user || !isCompany(user)) return fail('forbidden')
  const id = idOf(form.get('id'))
  if (!id) return fail('not_found')
  const found = await payload.find({
    collection: 'deliverables',
    where: { id: { equals: id } },
    limit: 1,
    depth: 0,
    select: { status: true },
    ...asUser(user),
  })
  const doc = found.docs[0]
  if (!doc) return fail('not_found')
  if (doc.status !== 'released') return fail('not_open')
  let fixNote: string | undefined
  if (decision === 'fix') {
    const raw = form.get('fixNote')
    fixNote = typeof raw === 'string' ? raw.trim() : ''
    if (!fixNote) return fail('note_required')
    if (fixNote.length > NOTE_MAX) return fail('note_too_long')
  }
  try {
    await payload.update({
      collection: 'deliverables',
      id,
      data:
        decision === 'accept'
          ? { status: 'accepted' }
          : { status: 'fix_requested', fixNote: fixNote! },
      ...asUser(user),
    })
    return { status: 'done', doneAt: Date.now() }
  } catch (error) {
    return fail(deliverableErrorCode(error) ?? (statusOf(error) === 403 ? 'forbidden' : 'generic'))
  }
}
