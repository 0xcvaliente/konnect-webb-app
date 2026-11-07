import { APIError, type Payload } from 'payload'

import { isAdmin } from '@/access/roles'
import { agreementGateOf } from '@/lib/agreements/gates'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import { dayToStored, parseDay, storedToDay } from '@/lib/projects/fields'
import type { SessionUser } from '@/lib/team/approvals'
import type { Match, Project } from '@/payload-types'

import {
  KICKOFF_LIMITS,
  type KickoffError,
  kickoffErrorCode,
  type KickoffState,
  type KickoffView,
  type StudentAgreementStage,
} from './fields'
import type { KickoffContext } from './rules'
import { kickoffOf, studentAgreementStage } from './views'

/**
 * The team's side of the kick-off (Kanban card "Kick-off form and kick-off cards") and of the
 * latest note to the company (card "Latest note to the company on the project page"). Every read
 * and write runs through the Local API as the team member with `overrideAccess: false`; the
 * Matches and Projects hooks hold the rules (for every API) and write the activity log. Nothing
 * here logs notes or form values.
 */

const asActor = (actor: SessionUser) => ({ user: actor, overrideAccess: false as const })

/** A short note to the company, shown on its project page. */
export const NOTE_TO_COMPANY_MAX = 1000

const fail = (error: KickoffError): KickoffState => ({
  status: 'error',
  error,
  doneAt: Date.now(),
})
const ok = (): KickoffState => ({ status: 'done', doneAt: Date.now() })

const text = (form: FormData, key: string): string => {
  const value = form.get(key)
  return typeof value === 'string' ? value.trim().replace(/\r\n/g, '\n') : ''
}

const idOf = (form: FormData, key = 'id'): number | undefined => {
  const id = Number(text(form, key))
  return Number.isInteger(id) && id > 0 ? id : undefined
}

/** Payload's refusals as answers for the page. Never throws: a throwing action loses the page. */
function refused(payload: Payload, error: unknown): KickoffState {
  const code = kickoffErrorCode(error)
  if (code) return fail(code)
  if (agreementGateOf(error)) return fail('not_signed')
  const status =
    error instanceof APIError || (typeof error === 'object' && error && 'status' in error)
      ? Number((error as { status: unknown }).status)
      : undefined
  if (status === 404) return fail('not_found')
  if (status === 409) return fail('changed')
  if (status === 400 || status === 403) return fail('not_open')
  payload.logger.error({
    msg: 'Team kick-off decision failed',
    reason: error instanceof Error ? error.name : 'unknown',
  })
  return fail('generic')
}

async function projectOf(payload: Payload, actor: SessionUser, id: number | undefined) {
  if (!id) return null
  return (await payload.findByID({
    collection: 'projects',
    id,
    depth: 0,
    disableErrors: true,
    ...asActor(actor),
  })) as Project | null
}

async function activeMatch(payload: Payload, actor: SessionUser, projectId: number) {
  const found = await payload.find({
    collection: 'matches',
    where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
    limit: 1,
    depth: 0,
    ...asActor(actor),
  })
  return (found.docs[0] as Match | undefined) ?? null
}

export type KickoffInput = {
  scope: string
  delivery: string
  start: string
  due: string
  checkIns: string[]
  contactId: number
}

/** Read and check the kick-off form. Days are `YYYY-MM-DD`. */
export function readKickoffForm(form: FormData): KickoffInput | KickoffError {
  const scope = text(form, 'scope')
  if (!scope) return 'scope_required'
  if (scope.length > KICKOFF_LIMITS.scope) return 'scope_too_long'
  const delivery = text(form, 'delivery')
  if (!delivery) return 'delivery_required'
  if (delivery.length > KICKOFF_LIMITS.delivery) return 'delivery_too_long'
  const start = parseDay(text(form, 'start'))
  if (!start) return 'start_invalid'
  const due = parseDay(text(form, 'due'))
  if (!due) return 'due_invalid'
  if (due < start) return 'due_before_start'
  const typed = form
    .getAll('checkIn')
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
  if (typed.length > KICKOFF_LIMITS.checkIns) return 'too_many_check_ins'
  const checkIns: string[] = []
  for (const value of typed) {
    const day = parseDay(value)
    if (!day || day < start || day > due) return 'check_in_invalid'
    if (!checkIns.includes(day)) checkIns.push(day)
  }
  const contactId = idOf(form, 'contact')
  if (!contactId) return 'contact_required'
  return { scope, delivery, start, due, checkIns: checkIns.sort(), contactId }
}

type Decision = (
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
) => Promise<KickoffState>

/**
 * Record (or correct) the kick-off of a matched project: the agreed scope, the dates, the
 * check-ins, the Konnected contact and how to deliver. The Matches hook checks the project is
 * still matched, that no student agreement is made from it yet, and that the contact is on the
 * team. Not a move of the due date: no email, no history.
 */
export const recordKickoff: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const input = readKickoffForm(form)
  if (typeof input === 'string') return fail(input)
  const project = await projectOf(payload, actor, idOf(form))
  if (!project) return fail('not_found')
  if (project.status !== 'matched') return fail('not_open')
  const match = await activeMatch(payload, actor, project.id)
  if (!match) return fail('not_open')
  try {
    await payload.update({
      collection: 'matches',
      id: match.id,
      data: {
        startDate: dayToStored(input.start),
        endDate: dayToStored(input.due),
        kickoff: {
          scope: input.scope,
          delivery: input.delivery,
          checkIns: input.checkIns.map((day) => ({ day: dayToStored(day) })),
          contact: input.contactId,
        },
      },
      ...asActor(actor),
      context: { kickoffSave: match.id } satisfies KickoffContext,
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

/**
 * Start the work: the project moves from matched to in progress. The kick-off must be recorded;
 * the Projects hook checks the signed student agreement (the second gate) for every API.
 */
export const startWork: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const project = await projectOf(payload, actor, idOf(form))
  if (!project) return fail('not_found')
  if (project.status !== 'matched') return fail('changed')
  const match = await activeMatch(payload, actor, project.id)
  if (!match) return fail('not_open')
  if (!match.kickoff?.recordedAt) return fail('no_kickoff')
  try {
    await payload.update({
      collection: 'projects',
      id: project.id,
      data: { status: 'in_progress' },
      ...asActor(actor),
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

/**
 * Write the latest note to the company (shown on its project page). The Projects hook dates it
 * and keeps every note in the activity log; the page shows only the latest. An empty note clears
 * what the company sees (the history stays).
 */
export const saveNoteToCompany: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const note = text(form, 'note')
  if (note.length > NOTE_TO_COMPANY_MAX) return fail('note_too_long')
  const project = await projectOf(payload, actor, idOf(form))
  if (!project) return fail('not_found')
  // A draft has not reached Konnected; a review note goes with the review decision instead.
  if (project.status === 'draft') return fail('not_open')
  if ((project.noteToCompany ?? '') === note) return ok()
  try {
    await payload.update({
      collection: 'projects',
      id: project.id,
      data: { noteToCompany: note || null },
      ...asActor(actor),
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

export type TeamKickoff = {
  matchId: number
  /** When Konnected selected the student (ISO). */
  selectedAt: string
  kickoff: KickoffView | null
  /** What the form starts from (the saved kick-off, or the project's own dates). */
  form: {
    scope: string
    delivery: string
    start: string
    due: string
    checkIns: string[]
    contactId: number | null
  }
  agreement: { stage: StudentAgreementStage; id: number | null }
  /** The project's company agreement is signed (it had to be, to publish). */
  companySigned: boolean
}

/** The kick-off of the running match on a project, read as the team member. */
export async function loadTeamKickoff(
  payload: Payload,
  actor: SessionUser | null,
  project: { id: number; startDay: string | null; ownerId: number | null },
): Promise<TeamKickoff | null> {
  if (!actor || !isAdmin(actor)) return null
  const match = await activeMatch(payload, actor, project.id)
  if (!match) return null
  const [agreement, company] = await Promise.all([
    studentAgreementStage(payload, actor, match.id),
    payload.count({
      collection: 'agreements',
      where: {
        and: [
          { project: { equals: project.id } },
          { kind: { equals: 'company' } },
          { status: { equals: 'signed' } },
        ],
      },
      ...asActor(actor),
    }),
  ])
  const kickoff = kickoffOf(match)
  const k = match.kickoff
  const contact = k?.contact
  return {
    matchId: match.id,
    selectedAt: match.createdAt,
    kickoff,
    form: {
      scope: k?.scope ?? '',
      delivery: k?.delivery ?? '',
      start: storedToDay(match.startDate) ?? project.startDay ?? '',
      due: storedToDay(match.endDate) ?? '',
      checkIns: kickoff?.checkIns ?? [],
      // The saved contact, else the project's owner, else the team member filling it in.
      contactId:
        (typeof contact === 'object' && contact ? contact.id : (contact ?? null)) ??
        project.ownerId ??
        actor.id,
    },
    agreement,
    companySigned: company.totalDocs > 0,
  }
}

export type NoteRow = { id: number; note: string | null; at: string; by: string | null }

/** Every note Konnected wrote to the company on a project, newest first (the activity log). */
export async function noteHistory(
  payload: Payload,
  actor: SessionUser | null,
  projectId: number,
): Promise<NoteRow[]> {
  if (!actor || !isAdmin(actor)) return []
  const rows = await payload.find({
    collection: 'activity-logs',
    where: {
      and: [
        { targetCollection: { equals: 'projects' } },
        { targetId: { equals: String(projectId) } },
        { field: { equals: 'noteToCompany' } },
      ],
    },
    sort: '-createdAt',
    limit: 50,
    depth: 1,
    ...asActor(actor),
  })
  return rows.docs.map((r) => {
    const by = typeof r.actor === 'object' && r.actor ? r.actor : null
    return {
      id: r.id,
      note: r.note ?? null,
      at: r.createdAt,
      by: by ? by.name || by.email : null,
    }
  })
}
