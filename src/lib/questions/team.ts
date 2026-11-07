import type { Payload } from 'payload'

import { isAdmin, relationId } from '@/access/roles'
import { type Owner, ownersById, type SessionUser } from '@/lib/team/approvals'
import { myOwnerIds } from '@/lib/team/members'
import { promiseState, type PromiseState } from '@/lib/workingDays'
import type { Question, SavedAnswer } from '@/payload-types'

import {
  ANSWER_DAYS,
  ANSWER_MAX,
  cleanText,
  QUESTION_MAX,
  type QuestionError,
  questionErrorCode,
  type QuestionSide,
  type QuestionState,
  SAVED_TITLE_MAX,
} from './fields'

/**
 * The team's side of Ask Konnected (mockup "Questions"): the queue of open questions with the
 * project's owner (or the shared pool) and the 2-working-day countdown, one question with what was
 * passed on to the other side, answering, relaying, and the saved answers. Everything is read and
 * written through the Local API as the team member with `overrideAccess: false`; the Questions
 * hook holds every rule. Nothing here logs question or answer text.
 */

const asActor = (actor: SessionUser) => ({ user: actor, overrideAccess: false as const })

export type QuestionItem = {
  id: number
  projectId: number
  title: string
  companyName: string | null
  side: QuestionSide
  /** The student's name (the team reads it) or the company's. */
  asker: string
  owner: Owner
  /** When it was asked (ISO). */
  since: string
  due: PromiseState
}

type Facts = {
  title: Map<number, string>
  company: Map<number, string | null>
  owner: Map<number, Owner>
  ownerId: Map<number, number | null>
  studentOfApplication: Map<number, string>
}

/** The projects, owners and student names behind a list of questions, read as the team member. */
async function factsFor(payload: Payload, actor: SessionUser, docs: Question[]): Promise<Facts> {
  const projectIds = [...new Set(docs.map((q) => relationId(q.project as number)!))]
  const applicationIds = [
    ...new Set(docs.map((q) => relationId(q.application as number)).filter(Boolean)),
  ] as number[]
  const [projects, applications] = await Promise.all([
    projectIds.length
      ? payload.find({
          collection: 'projects',
          where: { id: { in: projectIds } },
          depth: 0,
          pagination: false,
          select: { title: true, companyName: true, owner: true },
          ...asActor(actor),
        })
      : null,
    applicationIds.length
      ? payload.find({
          collection: 'applications',
          where: { id: { in: applicationIds } },
          depth: 0,
          pagination: false,
          select: { student: true },
          ...asActor(actor),
        })
      : null,
  ])
  const studentIds = [
    ...new Set((applications?.docs ?? []).map((a) => relationId(a.student as number)!)),
  ]
  const profiles = studentIds.length
    ? await payload.find({
        collection: 'student-profiles',
        where: { id: { in: studentIds } },
        depth: 0,
        pagination: false,
        select: { name: true },
        ...asActor(actor),
      })
    : null
  const nameOf = new Map((profiles?.docs ?? []).map((p) => [p.id, p.name]))
  const owners = await ownersById(
    payload,
    actor,
    (projects?.docs ?? []).map((p) => relationId(p.owner as number)),
  )
  return {
    title: new Map((projects?.docs ?? []).map((p) => [p.id, p.title])),
    company: new Map((projects?.docs ?? []).map((p) => [p.id, p.companyName ?? null])),
    ownerId: new Map(
      (projects?.docs ?? []).map((p) => [p.id, relationId(p.owner as number) ?? null]),
    ),
    owner: new Map(
      (projects?.docs ?? []).map((p) => [
        p.id,
        owners.get(relationId(p.owner as number) ?? 0) ?? null,
      ]),
    ),
    studentOfApplication: new Map(
      (applications?.docs ?? []).map((a) => [
        a.id,
        nameOf.get(relationId(a.student as number)!) ?? '',
      ]),
    ),
  }
}

const askerOf = (q: Question, facts: Facts): string =>
  q.side === 'student'
    ? (facts.studentOfApplication.get(relationId(q.application as number) ?? 0) ?? '')
    : (facts.company.get(relationId(q.project as number)!) ?? '')

function toItem(q: Question, facts: Facts, now: Date): QuestionItem {
  const projectId = relationId(q.project as number)!
  return {
    id: q.id,
    projectId,
    title: facts.title.get(projectId) ?? '',
    companyName: facts.company.get(projectId) ?? null,
    side: (q.side ?? 'student') as QuestionSide,
    asker: askerOf(q, facts),
    owner: facts.owner.get(projectId) ?? null,
    since: q.createdAt,
    due: promiseState(new Date(q.createdAt), ANSWER_DAYS, now),
  }
}

/**
 * The open questions, oldest first (the oldest is closest to its promise). Mine: the questions on
 * projects I own (and those of anyone I cover today). Null for anyone but the team.
 */
export async function listQuestionQueue(
  payload: Payload,
  actor: SessionUser | null,
  { mine = false, now = new Date() }: { mine?: boolean; now?: Date } = {},
): Promise<(QuestionItem & { ownerId: number | null })[] | null> {
  if (!actor || !isAdmin(actor)) return null
  const found = await payload.find({
    collection: 'questions',
    where: { and: [{ kind: { equals: 'ask' } }, { status: { equals: 'open' } }] },
    depth: 0,
    pagination: false,
    sort: 'createdAt',
    ...asActor(actor),
  })
  const docs = found.docs as Question[]
  if (!docs.length) return []
  const facts = await factsFor(payload, actor, docs)
  const ids = mine ? await myOwnerIds(payload, actor) : null
  return docs
    .map((q) => ({
      ...toItem(q, facts, now),
      ownerId: facts.ownerId.get(relationId(q.project as number)!) ?? null,
    }))
    .filter((item) => !ids || ids.has(item.ownerId ?? 0))
}

/** Open questions, for the menu. */
export async function questionsCount(payload: Payload, actor: SessionUser | null) {
  if (!actor || !isAdmin(actor)) return 0
  const { totalDocs } = await payload.count({
    collection: 'questions',
    where: { and: [{ kind: { equals: 'ask' } }, { status: { equals: 'open' } }] },
    ...asActor(actor),
  })
  return totalDocs
}

export type TeamRelay = {
  id: number
  side: QuestionSide
  body: string
  answer: string | null
  createdAt: string
  answeredAt: string | null
}

export type TeamQuestion = QuestionItem & {
  body: string
  status: Question['status']
  answer: string | null
  answeredByName: string | null
  answeredAt: string | null
  relays: TeamRelay[]
  /** Someone on the other side can be asked: the company always, a student once selected. */
  canRelay: boolean
}

/** One question with what the team passed on to the other side. Null when not found. */
export async function loadTeamQuestion(
  payload: Payload,
  actor: SessionUser | null,
  id: number,
  now: Date = new Date(),
): Promise<TeamQuestion | null> {
  if (!actor || !isAdmin(actor)) return null
  const q = (await payload.findByID({
    collection: 'questions',
    id,
    depth: 0,
    disableErrors: true,
    ...asActor(actor),
  })) as Question | null
  if (!q || q.kind !== 'ask') return null
  const [facts, relays, active] = await Promise.all([
    factsFor(payload, actor, [q]),
    payload.find({
      collection: 'questions',
      where: { relayOf: { equals: q.id } },
      depth: 0,
      pagination: false,
      sort: 'createdAt',
      ...asActor(actor),
    }),
    q.side === 'company'
      ? payload.count({
          collection: 'matches',
          where: {
            and: [
              { project: { equals: relationId(q.project as number)! } },
              { endedAt: { exists: false } },
            ],
          },
          ...asActor(actor),
        })
      : null,
  ])
  return {
    ...toItem(q, facts, now),
    body: q.body,
    status: q.status,
    answer: q.answer ?? null,
    answeredByName: q.answeredByName ?? null,
    answeredAt: q.answeredAt ?? null,
    relays: (relays.docs as Question[]).map((r) => ({
      id: r.id,
      side: (r.side ?? 'company') as QuestionSide,
      body: r.body,
      answer: r.answer ?? null,
      createdAt: r.createdAt,
      answeredAt: r.answeredAt ?? null,
    })),
    canRelay: q.side === 'student' ? true : (active?.totalDocs ?? 0) > 0,
  }
}

export type AnsweredQuestion = {
  id: number
  asker: string
  title: string
  body: string
  answer: string
  answeredByName: string | null
  answeredAt: string
}

/** Questions answered in the last 7 days, newest first. */
export async function listRecentlyAnswered(
  payload: Payload,
  actor: SessionUser | null,
  now: Date = new Date(),
): Promise<AnsweredQuestion[]> {
  if (!actor || !isAdmin(actor)) return []
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const found = await payload.find({
    collection: 'questions',
    where: {
      and: [
        { kind: { equals: 'ask' } },
        { status: { equals: 'answered' } },
        { answeredAt: { greater_than_equal: since } },
      ],
    },
    depth: 0,
    limit: 20,
    sort: '-answeredAt',
    ...asActor(actor),
  })
  const docs = found.docs as Question[]
  if (!docs.length) return []
  const facts = await factsFor(payload, actor, docs)
  return docs.map((q) => ({
    id: q.id,
    asker: askerOf(q, facts),
    title: facts.title.get(relationId(q.project as number)!) ?? '',
    body: q.body,
    answer: q.answer ?? '',
    answeredByName: q.answeredByName ?? null,
    answeredAt: q.answeredAt ?? q.updatedAt,
  }))
}

/** The questions asked on one project, for the team's project page. */
export async function listProjectQuestions(
  payload: Payload,
  actor: SessionUser | null,
  projectId: number,
): Promise<{ id: number; side: QuestionSide; status: Question['status']; createdAt: string }[]> {
  if (!actor || !isAdmin(actor)) return []
  const found = await payload.find({
    collection: 'questions',
    where: { and: [{ project: { equals: projectId } }, { kind: { equals: 'ask' } }] },
    depth: 0,
    pagination: false,
    sort: '-createdAt',
    select: { side: true, status: true, createdAt: true },
    ...asActor(actor),
  })
  return found.docs.map((q) => ({
    id: q.id,
    side: (q.side ?? 'student') as QuestionSide,
    status: q.status,
    createdAt: q.createdAt,
  }))
}

export type SavedAnswerView = Pick<SavedAnswer, 'id' | 'title' | 'body'>

/** The team's saved answers, by title. */
export async function listSavedAnswers(
  payload: Payload,
  actor: SessionUser | null,
): Promise<SavedAnswerView[]> {
  if (!actor || !isAdmin(actor)) return []
  const found = await payload.find({
    collection: 'saved-answers',
    depth: 0,
    pagination: false,
    sort: 'title',
    ...asActor(actor),
  })
  return found.docs.map((s) => ({ id: s.id, title: s.title, body: s.body }))
}

// ---------- Writes ----------

const fail = (error: QuestionError): QuestionState => ({
  status: 'error',
  error,
  doneAt: Date.now(),
})
const done = (): QuestionState => ({ status: 'done', doneAt: Date.now() })

const idFrom = (form: FormData, key = 'id'): number => {
  const raw = form.get(key)
  return typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : 0
}

function refused(payload: Payload, error: unknown, what: string): QuestionState {
  const code = questionErrorCode(error)
  if (code) return fail(code)
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status)
      : undefined
  if (status === 404) return fail('not_found')
  if (status === 403) return fail('forbidden')
  payload.logger.error({
    msg: `${what} failed`,
    reason: error instanceof Error ? error.name : 'unknown',
  })
  return fail('generic')
}

/** Answer a question as the team member. The asker gets the answer by email and in the app. */
export async function answerQuestion(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<QuestionState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const id = idFrom(form)
  if (!id) return fail('not_found')
  const answer = cleanText(form.get('answer'))
  if (!answer) return fail('text_required')
  if (answer.length > ANSWER_MAX) return fail('too_long')
  try {
    await payload.update({
      collection: 'questions',
      id,
      data: { status: 'answered', answer },
      ...asActor(actor),
    })
  } catch (error) {
    return refused(payload, error, 'Answer')
  }
  return done()
}

/** Pass a question on to the other side, in the team member's own words. */
export async function relayQuestion(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<QuestionState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const id = idFrom(form)
  if (!id) return fail('not_found')
  const body = cleanText(form.get('body'))
  if (!body) return fail('text_required')
  if (body.length > QUESTION_MAX) return fail('too_long')
  try {
    await payload.create({
      collection: 'questions',
      data: { relayOf: id, body } as never,
      ...asActor(actor),
    })
  } catch (error) {
    return refused(payload, error, 'Relay')
  }
  return done()
}

/** Keep an answer for later, with a short title. */
export async function addSavedAnswer(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<QuestionState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const title = cleanText(form.get('title'))
  const body = cleanText(form.get('body'))
  if (!title || !body) return fail('text_required')
  if (title.length > SAVED_TITLE_MAX || body.length > ANSWER_MAX) return fail('too_long')
  try {
    await payload.create({ collection: 'saved-answers', data: { title, body }, ...asActor(actor) })
  } catch (error) {
    return refused(payload, error, 'Saved answer')
  }
  return done()
}

/** Remove a saved answer. */
export async function removeSavedAnswer(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<QuestionState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const id = idFrom(form)
  if (!id) return fail('not_found')
  try {
    await payload.delete({ collection: 'saved-answers', id, ...asActor(actor) })
  } catch (error) {
    return refused(payload, error, 'Saved answer')
  }
  return done()
}
