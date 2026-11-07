import type { Payload } from 'payload'

import { type AccessUser, relationId } from '@/access/roles'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import { storedToDay } from '@/lib/projects/fields'
import type { Agreement, BriefFile, Match, User } from '@/payload-types'

import type { KickoffView, StudentAgreementStage } from './fields'

/**
 * The kick-off as each party reads it (lib/kickoff/fields.ts). Every read runs through the Local
 * API as the signed-in user with `overrideAccess: false`, so the collections' rules decide: a
 * student reads only their own match, a company only the match that runs on its own project, never
 * the team's `contact` relation. Nothing here logs values.
 */

type Actor = AccessUser & { collection?: 'users' }

const asActor = (user: Actor) => ({
  user: { ...user, collection: 'users' } as User & { collection: 'users' },
  overrideAccess: false as const,
})

/** The kick-off on a match, or null before it is recorded. */
export function kickoffOf(
  match: Pick<Match, 'kickoff' | 'startDate' | 'endDate'> | null | undefined,
): KickoffView | null {
  const k = match?.kickoff
  if (!match || !k?.recordedAt) return null
  return {
    scope: k.scope ?? '',
    delivery: k.delivery ?? '',
    startDay: storedToDay(match.startDate),
    dueDay: storedToDay(match.endDate),
    checkIns: (k.checkIns ?? [])
      .map((c) => storedToDay(c.day))
      .filter((d): d is string => Boolean(d))
      .sort(),
    contactName: k.contactName ?? '',
    recordedAt: k.recordedAt,
  }
}

/** The stage of the newest student agreement on a match, read as `user`. */
export async function studentAgreementStage(
  payload: Payload,
  user: Actor,
  matchId: number,
): Promise<{ stage: StudentAgreementStage; id: number | null }> {
  const found = await payload.find({
    collection: 'agreements',
    where: {
      and: [
        { match: { equals: matchId } },
        { kind: { equals: 'student' } },
        { status: { not_equals: 'void' } },
      ],
    },
    sort: '-createdAt',
    limit: 1,
    depth: 0,
    select: { status: true },
    ...asActor(user),
  })
  const a = found.docs[0] as Pick<Agreement, 'id' | 'status'> | undefined
  if (!a) return { stage: 'none', id: null }
  return { stage: a.status as StudentAgreementStage, id: a.id }
}

export type FileLink = { id: number; name: string; url: string }

export type StudentKickoff = {
  matchId: number
  kickoff: KickoffView | null
  agreement: { stage: StudentAgreementStage; id: number | null }
  /** The brief attachments the company added, which the selected student may open. */
  files: FileLink[]
}

/**
 * The student's kick-off card for a project they were selected for: their own running match, its
 * kick-off, where their agreement stands, and the brief attachments.
 *
 * Bypass: the server reads which brief files the project lists (the student cannot read a project
 * that is no longer published). Only the ids leave the bypass; the files themselves are read as
 * the student, so the brief-files rule (the selected student of a running match) decides.
 */
export async function loadStudentKickoff(
  payload: Payload,
  user: Actor,
  projectId: number | null | undefined,
): Promise<StudentKickoff | null> {
  if (!projectId) return null
  const matches = await payload.find({
    collection: 'matches',
    where: {
      and: [
        { project: { equals: projectId } },
        { 'student.user': { equals: user.id } },
        ACTIVE_MATCH,
      ],
    },
    limit: 1,
    depth: 0,
    select: { kickoff: true, startDate: true, endDate: true },
    ...asActor(user),
  })
  const match = matches.docs[0] as Match | undefined
  if (!match) return null
  const project = await payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { attachments: true },
    overrideAccess: true,
    disableErrors: true,
  })
  const ids = (project?.attachments ?? [])
    .map((a) => relationId(a as number | { id: number }))
    .filter((id): id is number => Boolean(id))
  const files = ids.length
    ? (
        await payload.find({
          collection: 'brief-files',
          where: { id: { in: ids } },
          depth: 0,
          pagination: false,
          ...asActor(user),
        })
      ).docs
    : []
  return {
    matchId: match.id,
    kickoff: kickoffOf(match),
    agreement: await studentAgreementStage(payload, user, match.id),
    files: (files as BriefFile[])
      .filter((f) => f.url)
      .map((f) => ({ id: f.id, name: f.originalName ?? f.filename ?? 'file', url: f.url! })),
  }
}

/** The company's kick-off card: the kick-off of the match that runs on its own project. */
export async function loadCompanyKickoff(
  payload: Payload,
  user: Actor,
  projectId: number,
): Promise<KickoffView | null> {
  const matches = await payload.find({
    collection: 'matches',
    where: { project: { equals: projectId } },
    limit: 1,
    depth: 0,
    select: { kickoff: true, startDate: true, endDate: true },
    ...asActor(user),
  })
  return kickoffOf(matches.docs[0] as Match | undefined)
}
