import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { appUrl } from '@/lib/auth/env'
import { storedToDay, todayInOslo } from '@/lib/projects/fields'
import { routeToTeam, teamRecipients } from '@/lib/team/recipients'
import type { Match, ProblemReport, Project } from '@/payload-types'

import { studentRecipient } from './matchingEmails'
import { companyProjectLink, companyRecipient } from './projectEmails'
import { type EmailType, sendEmail } from './send'
import {
  type EmailLocale,
  type ProblemEmailKind,
  problemPathEmail,
  teamProblemEmail,
} from './templates'

type Rel = number | { id: number } | null | undefined

/**
 * The emails of the problem paths (Kanban cards "Problem reports" and "Projects without a match"),
 * each in the recipient's saved language, sent after the response:
 * - the student's report reached Konnected (to the student);
 * - the due date moved (to the student and the company);
 * - the match ended and applications reopened (to the student, and to the company with the new
 *   closing day);
 * - the project closed without delivery (to the student and the company, with the team's reason);
 * - the project closed without a match, or its applications reopened (to the company).
 *
 * Minimal personal data: the student's note is never sent anywhere; the company's emails name no
 * student. Bypass: the server reads the project's title and company and the recipients' addresses
 * with `overrideAccess: true`. Only the email type and the user id are logged.
 */

type ProjectFacts = Pick<Project, 'id' | 'title' | 'companyName' | 'company'>

async function projectFacts(req: PayloadRequest, projectId: number | undefined) {
  if (!projectId) return null
  return (await req.payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { title: true, companyName: true, company: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })) as ProjectFacts | null
}

const studentLink = (locale: EmailLocale, applicationId: number | undefined) =>
  applicationId
    ? `${appUrl()}/${locale}/student/applications/${applicationId}`
    : `${appUrl()}/${locale}/student/applications`

type Values = { date?: string | null; from?: string | null; reason?: string | null }

async function toStudent(
  req: PayloadRequest,
  match: Pick<Match, 'student' | 'application'>,
  project: ProjectFacts,
  kind: ProblemEmailKind,
  type: EmailType,
  values: Values = {},
) {
  const to = await studentRecipient(req, relationId(match.student as Rel))
  if (!to) return
  await sendEmail(req.payload, {
    to: to.email,
    email: problemPathEmail(to.locale, kind, {
      title: project.title,
      company: project.companyName ?? '',
      ...values,
      href: studentLink(to.locale, relationId(match.application as Rel)),
    }),
    type,
    userId: to.id,
  })
}

async function toCompany(
  req: PayloadRequest,
  project: ProjectFacts,
  kind: ProblemEmailKind,
  type: EmailType,
  values: Values = {},
) {
  const to = await companyRecipient(req, relationId(project.company as Rel))
  if (!to) return
  await sendEmail(req.payload, {
    to: to.email,
    email: problemPathEmail(to.locale, kind, {
      title: project.title,
      company: project.companyName ?? '',
      ...values,
      href: companyProjectLink(to.locale, project.id),
    }),
    type,
    userId: to.id,
  })
}

/** "Konnected has your message": to the student who reported. The note is not repeated. */
export async function sendProblemReceivedEmail(
  req: PayloadRequest,
  report: Pick<ProblemReport, 'match' | 'project'>,
): Promise<void> {
  const project = await projectFacts(req, relationId(report.project as Rel))
  const match = await req.payload.findByID({
    collection: 'matches',
    id: relationId(report.match as Rel)!,
    depth: 0,
    select: { student: true, application: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!project || !match) return
  await toStudent(req, match, project, 'received', 'problem_received')
}

/**
 * "A problem was reported", to the team straight away: to the project's owner on the team (the
 * project's own owner, else its company's), and while that owner is away to whoever covers them;
 * when nobody on the team owns it (the shared pool), to every team member who is not away, as the
 * morning email routes work (lib/team/recipients.ts). Only the title and the kind of problem: the
 * student's note and anything about the student stay behind sign-in.
 *
 * Bypass: the student who reported cannot read the project's owners, the company or the team's
 * addresses; the server reads them with `overrideAccess: true`. Only the email type and the user
 * id are logged.
 */
export async function sendProblemReportedToTeam(
  req: PayloadRequest,
  report: Pick<ProblemReport, 'project' | 'kind'>,
): Promise<void> {
  const projectId = relationId(report.project as Rel)
  if (!projectId) return
  const project = await req.payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { title: true, owner: true, takenBy: true, company: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!project) return
  const team = await teamRecipients(req)
  if (!team.length) return
  const onTeam = (id: number | undefined) => (id && team.some((m) => m.id === id) ? id : undefined)
  let ownerId =
    onTeam(relationId(project.owner as Rel)) ?? onTeam(relationId(project.takenBy as Rel))
  if (!ownerId) {
    const company = await req.payload.findByID({
      collection: 'companies',
      id: relationId(project.company as Rel)!,
      depth: 0,
      select: { teamOwner: true, takenBy: true },
      overrideAccess: true,
      disableErrors: true,
      req,
    })
    ownerId =
      onTeam(relationId(company?.teamOwner as Rel)) ?? onTeam(relationId(company?.takenBy as Rel))
  }
  for (const to of routeToTeam(team, ownerId ?? null, todayInOslo())) {
    await sendEmail(req.payload, {
      to: to.email,
      email: teamProblemEmail(to.locale, {
        title: project.title,
        kind: report.kind,
        pool: !ownerId,
        href: `${appUrl()}/${to.locale}/team/projects/${project.id}`,
      }),
      type: 'problem_reported_team',
      userId: to.id,
    })
  }
}

/** The due date moved: the new and the old day, to the student and the company. */
export async function sendDueDateEmails(
  req: PayloadRequest,
  match: Pick<Match, 'project' | 'student' | 'application'>,
  from: string | null | undefined,
  to: string | null | undefined,
): Promise<void> {
  const project = await projectFacts(req, relationId(match.project as Rel))
  if (!project) return
  const values = { from: storedToDay(from), date: storedToDay(to) }
  await toStudent(req, match, project, 'dueDateStudent', 'due_date_moved', values)
  await toCompany(req, project, 'dueDateCompany', 'due_date_moved', values)
}

/**
 * The match ended: reopened (the student is told the work ended; the company the new closing
 * day) or closed without delivery (both get the team's reason).
 */
export async function sendMatchEndedEmails(
  req: PayloadRequest,
  match: Pick<Match, 'student' | 'application'>,
  project: Pick<Project, 'id' | 'deadline' | 'closeReason'>,
  outcome: 'reopened' | 'closed',
): Promise<void> {
  const facts = await projectFacts(req, project.id)
  if (!facts) return
  if (outcome === 'reopened') {
    await toStudent(req, match, facts, 'endedStudent', 'match_ended')
    await toCompany(req, facts, 'rematchCompany', 'project_rematch', {
      date: storedToDay(project.deadline),
    })
    return
  }
  const reason = project.closeReason ?? null
  await toStudent(req, match, facts, 'closedStudent', 'project_closed_no_delivery', { reason })
  await toCompany(req, facts, 'closedNoDeliveryCompany', 'project_closed_no_delivery', { reason })
}

/** A published project nobody fitted: closed without a match (with the reason), or reopened. */
export async function sendNoMatchEmail(
  req: PayloadRequest,
  project: Pick<Project, 'id' | 'deadline' | 'closeReason'>,
  outcome: 'reopened' | 'closed',
): Promise<void> {
  const facts = await projectFacts(req, project.id)
  if (!facts) return
  if (outcome === 'reopened') {
    await toCompany(req, facts, 'reopenedCompany', 'applications_reopened', {
      date: storedToDay(project.deadline),
    })
    return
  }
  await toCompany(req, facts, 'closedNoMatchCompany', 'project_closed_no_match', {
    reason: project.closeReason ?? null,
  })
}
