import type { Payload } from 'payload'

import { isStudent } from '@/access/roles'
import { listOwnApplications, type OwnApplication } from '@/lib/applications/student'
import { listOwnAgreements } from '@/lib/agreements/views'
import { loadStudentWork } from '@/lib/deliverables/student'
import { loadStudentProblem } from '@/lib/problems/student'
import { dayToStored, todayInOslo } from '@/lib/projects/fields'

import { findOwnProfile, type SessionUser } from './profile'

/**
 * The student's home (Kanban card "Student and company dashboards", mockup "Student Home"): what
 * needs the student now, the projects they work on with their stage, the applications waiting on
 * Konnected, and where their profile stands. Every read runs as the student with access control
 * on, through the same functions the other student pages use.
 */

export type StudentNeed =
  | { kind: 'agreement'; id: number; title: string }
  | { kind: 'profile_changes' }
  | { kind: 'cv' }
  | {
      kind: 'hand_in' | 'more' | 'fix'
      applicationId: number
      title: string
      dueDay: string | null
    }

export type RunningProject = {
  applicationId: number
  title: string
  companyName: string
  /** matched, in_progress or delivered. */
  projectStatus: 'matched' | 'in_progress' | 'delivered'
  dueDay: string | null
  /** The student told Konnected about a problem; the team has not answered yet. */
  problemOpen: boolean
}

export type StudentHome = {
  name: string
  /** No application yet: the "just started" home. */
  fresh: boolean
  needs: StudentNeed[]
  running: RunningProject[]
  /** Applied or shortlisted: Konnected decides. */
  waiting: OwnApplication[]
  profile: { review: 'waiting' | 'changes_requested' | 'reviewed'; hasCv: boolean }
  /** Published projects that still take applications. */
  openProjects: number
}

const RUNNING = ['matched', 'in_progress', 'delivered'] as const

export async function loadStudentHome(
  payload: Payload,
  user: SessionUser | null,
): Promise<StudentHome | null> {
  if (!user || !isStudent(user)) return null
  const profile = await findOwnProfile(payload, user)
  if (!profile) return null
  const [applications, agreements, open] = await Promise.all([
    listOwnApplications(payload, user, 'need'),
    listOwnAgreements(payload, user),
    payload.count({
      collection: 'projects',
      where: {
        or: [
          { deadline: { exists: false } },
          { deadline: { greater_than_equal: dayToStored(todayInOslo()) } },
        ],
      },
      user,
      overrideAccess: false,
    }),
  ])
  const all = applications ?? []
  const needs: StudentNeed[] = []
  for (const a of agreements) {
    if (a.kind === 'student' && a.status === 'awaiting_party')
      needs.push({ kind: 'agreement', id: a.id, title: a.title ?? '' })
  }
  const review = profile.reviewStatus ?? 'waiting'
  if (review === 'changes_requested') needs.push({ kind: 'profile_changes' })
  if (!profile.cv) needs.push({ kind: 'cv' })

  const running: RunningProject[] = []
  for (const a of all.filter((x) => x.status === 'selected')) {
    const [work, problem] = await Promise.all([
      loadStudentWork(payload, user, a.projectId),
      loadStudentProblem(payload, user, a.projectId),
    ])
    if (!work) continue
    const status = work.projectStatus
    if (!(RUNNING as readonly string[]).includes(status ?? '') || work.state.accepted) continue
    const dueDay = problem?.dueDay ?? null
    running.push({
      applicationId: a.id,
      title: a.title,
      companyName: a.companyName,
      projectStatus: status as RunningProject['projectStatus'],
      dueDay,
      problemOpen: Boolean(problem?.open),
    })
    if (work.state.canSubmit) {
      const returned = work.handIns[0]?.status === 'returned'
      needs.push({
        kind: work.state.fixOpen ? 'fix' : returned ? 'more' : 'hand_in',
        applicationId: a.id,
        title: a.title,
        dueDay,
      })
    }
  }

  return {
    name: profile.name ?? '',
    fresh: all.length === 0,
    needs,
    running,
    waiting: all.filter((a) => a.status === 'applied' || a.status === 'shortlisted'),
    profile: { review, hasCv: Boolean(profile.cv) },
    openProjects: open.totalDocs,
  }
}
