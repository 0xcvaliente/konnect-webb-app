import type { ProjectStatus } from '@/lib/transitions'

/** The pill tone for each project status ("Final pass" mockup, status pills). */
export const PROJECT_STATUS_TONE: Record<ProjectStatus, 'ok' | 'warn' | 'bad' | 'info' | 'mute'> = {
  draft: 'mute',
  submitted: 'info',
  changes_requested: 'warn',
  rejected: 'bad',
  approved: 'info',
  published: 'ok',
  matched: 'ok',
  in_progress: 'info',
  delivered: 'ok',
  closed: 'mute',
}

/** The seven stages on the progress track, in order. Labels: ProjectStatus.stage.<key>. */
export const STAGES = [
  'draft',
  'review',
  'published',
  'matched',
  'in_progress',
  'delivered',
  'closed',
] as const
export type Stage = (typeof STAGES)[number]

/** Where a status sits on the track. A rejected project is not on it. */
export const STAGE_OF: Partial<Record<ProjectStatus, number>> = {
  draft: 0,
  submitted: 1,
  changes_requested: 1,
  approved: 1,
  published: 2,
  matched: 3,
  in_progress: 4,
  delivered: 5,
  closed: 6,
}

/** The company may change its project only in these statuses. */
export const isEditable = (status: ProjectStatus): boolean =>
  status === 'draft' || status === 'changes_requested'
