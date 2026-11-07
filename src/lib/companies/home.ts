import type { Payload } from 'payload'

import { companyIdOf, isCompany, relationId } from '@/access/roles'
import { listOwnAgreements } from '@/lib/agreements/views'
import { loadCompanyWork } from '@/lib/deliverables/student'
import { listOwnProjects, type SessionUser } from '@/lib/projects/project'
import { storedToDay } from '@/lib/projects/fields'
import type { ProjectStatus } from '@/lib/transitions'
import type { Match } from '@/payload-types'

/**
 * The company's status page (Kanban card "Student and company dashboards", mockup "Status"): what
 * needs the company now, and every project with its stage and who has the next step. Every read
 * runs as the company user with access control on: the company reads its own projects, its current
 * matches (dates only are used here) and the work Konnected released. Nothing about any student.
 */

export type CompanyNeed =
  | { kind: 'agreement'; id: number; title: string }
  | { kind: 'changes' | 'draft' | 'accept'; projectId: number; title: string }

/** Who has the next step on a project. */
export type WaitingOn = 'you' | 'konnected' | 'student' | null

/** What the row says about the project, besides its stage (CompanyHome.note.<key>). */
export type RowNote =
  | 'draft'
  | 'submitted'
  | 'changes_requested'
  | 'rejected'
  | 'approved_sign'
  | 'approved'
  | 'published'
  | 'published_open'
  | 'reopened_match'
  | 'reopened'
  | 'matched'
  | 'in_progress'
  | 'in_progress_due'
  | 'due_moved'
  | 'delivered_accept'
  | 'delivered'
  | 'closed'
  | 'closed_no_delivery'
  | 'closed_no_match'

export type CompanyProjectRow = {
  id: number
  title: string
  status: ProjectStatus
  waitingOn: WaitingOn
  note: RowNote
  /** `YYYY-MM-DD` for the note: the due date, or the closing day for applications. */
  day: string | null
  /** The main action for the company, if any. */
  action: 'edit' | 'sign' | 'accept' | null
  agreementId: number | null
}

export type CompanyHome = {
  needs: CompanyNeed[]
  projects: CompanyProjectRow[]
}

export async function loadCompanyHome(
  payload: Payload,
  user: SessionUser | null,
): Promise<CompanyHome | null> {
  if (!user || !isCompany(user) || !companyIdOf(user)) return null
  const [projects, agreements, matches] = await Promise.all([
    listOwnProjects(payload, user),
    listOwnAgreements(payload, user),
    payload.find({
      collection: 'matches',
      depth: 0,
      pagination: false,
      select: { project: true, endDate: true, dueDateHistory: true },
      user,
      overrideAccess: false,
    }),
  ])
  const toSign = new Map<number, number>()
  for (const a of agreements) {
    const projectId = relationId(a.project as number)
    if (a.kind === 'company' && a.status === 'awaiting_party' && projectId)
      toSign.set(projectId, a.id)
  }
  const matchOf = new Map(
    (matches.docs as Pick<Match, 'project' | 'endDate' | 'dueDateHistory'>[]).map((m) => [
      relationId(m.project as number),
      m,
    ]),
  )

  const needs: CompanyNeed[] = []
  for (const a of agreements) {
    if (a.kind === 'company' && a.status === 'awaiting_party')
      needs.push({ kind: 'agreement', id: a.id, title: a.title ?? '' })
  }

  const rows: CompanyProjectRow[] = []
  for (const p of projects) {
    const match = matchOf.get(p.id)
    const due = storedToDay(match?.endDate)
    const moved = (match?.dueDateHistory ?? []).length > 0
    const row: CompanyProjectRow = {
      id: p.id,
      title: p.title,
      status: p.status,
      waitingOn: 'konnected',
      note: p.status as RowNote,
      day: null,
      action: null,
      agreementId: null,
    }
    switch (p.status) {
      case 'draft':
        Object.assign(row, { waitingOn: 'you', action: 'edit' })
        needs.push({ kind: 'draft', projectId: p.id, title: p.title })
        break
      case 'changes_requested':
        Object.assign(row, { waitingOn: 'you', action: 'edit' })
        needs.push({ kind: 'changes', projectId: p.id, title: p.title })
        break
      case 'rejected':
        row.waitingOn = null
        break
      case 'approved': {
        const agreementId = toSign.get(p.id) ?? null
        if (agreementId)
          Object.assign(row, {
            waitingOn: 'you',
            note: 'approved_sign',
            action: 'sign',
            agreementId,
          })
        break
      }
      case 'published':
        row.day = storedToDay(p.deadline)
        if (!row.day) row.note = 'published_open'
        if (p.reopenedAt)
          row.note = p.reopenReason === 'match_ended' ? 'reopened_match' : 'reopened'
        break
      case 'in_progress':
        Object.assign(row, {
          waitingOn: 'student',
          note: moved ? 'due_moved' : due ? 'in_progress_due' : 'in_progress',
          day: due,
        })
        break
      case 'delivered': {
        const work = await loadCompanyWork(payload, user, p.id, p.status)
        if (work?.state.canAccept) {
          Object.assign(row, { waitingOn: 'you', note: 'delivered_accept', action: 'accept' })
          needs.push({ kind: 'accept', projectId: p.id, title: p.title })
        }
        break
      }
      case 'closed':
        row.waitingOn = null
        row.note =
          p.closeOutcome === 'no_delivery'
            ? 'closed_no_delivery'
            : p.closeOutcome === 'no_match'
              ? 'closed_no_match'
              : 'closed'
        break
    }
    rows.push(row)
  }
  // What needs the company first, then what runs, then what is done.
  const rank = (r: CompanyProjectRow) =>
    r.waitingOn === 'you' ? 0 : r.waitingOn ? 1 : r.status === 'closed' ? 3 : 2
  rows.sort((a, b) => rank(a) - rank(b))
  return { needs, projects: rows }
}
