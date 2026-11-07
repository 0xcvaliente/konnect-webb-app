import type { Payload } from 'payload'

import { isCompany, isStudent } from '@/access/roles'
import type { SessionUser } from '@/lib/students/profile'
import { addWorkingDays, osloDay } from '@/lib/workingDays'
import type { Question } from '@/payload-types'

import {
  ANSWER_DAYS,
  ANSWER_MAX,
  cleanText,
  OPEN_LIMIT,
  QUESTION_MAX,
  type QuestionError,
  questionErrorCode,
  type QuestionState,
} from './fields'

/**
 * The asker's side of Ask Konnected: the card on the student's application page and on the
 * company's project page. Every read and write runs as the signed-in user with
 * `overrideAccess: false`: the Questions collection returns only the rows addressed to them (their
 * own questions and Konnected's relays), and its hook decides what may be asked and answered.
 */

const asUser = (user: SessionUser) => ({ user, overrideAccess: false as const })

export type AskedQuestion = {
  id: number
  body: string
  createdAt: string
  /** `YYYY-MM-DD`: Konnected promised an answer by this day. */
  answerBy: string
  answer: string | null
  answeredByName: string | null
  answeredAt: string | null
}

export type ReceivedRelay = {
  id: number
  body: string
  createdAt: string
  answer: string | null
  answeredAt: string | null
}

export type AskerQuestions = {
  asked: AskedQuestion[]
  relays: ReceivedRelay[]
  /** The person may ask another question (fewer than 3 open on this project). */
  canAsk: boolean
}

/** The user's questions and Konnected's relays on one project, newest first. */
export async function loadAskerQuestions(
  payload: Payload,
  user: SessionUser | null,
  projectId: number | null,
): Promise<AskerQuestions | null> {
  if (!user || !(isStudent(user) || isCompany(user)) || !projectId) return null
  const found = await payload.find({
    collection: 'questions',
    where: { project: { equals: projectId } },
    depth: 0,
    pagination: false,
    sort: '-createdAt',
    ...asUser(user),
  })
  const docs = found.docs as Question[]
  const asked = docs
    .filter((q) => q.kind === 'ask')
    .map((q) => ({
      id: q.id,
      body: q.body,
      createdAt: q.createdAt,
      answerBy: addWorkingDays(osloDay(new Date(q.createdAt)), ANSWER_DAYS),
      answer: q.answer ?? null,
      answeredByName: q.answeredByName ?? null,
      answeredAt: q.answeredAt ?? null,
    }))
  const relays = docs
    .filter((q) => q.kind === 'relay')
    .map((q) => ({
      id: q.id,
      body: q.body,
      createdAt: q.createdAt,
      answer: q.answer ?? null,
      answeredAt: q.answeredAt ?? null,
    }))
  const open = asked.filter((q) => !q.answer).length
  return { asked, relays, canAsk: open < OPEN_LIMIT }
}

const fail = (error: QuestionError): QuestionState => ({
  status: 'error',
  error,
  doneAt: Date.now(),
})

const idFrom = (form: FormData, key: string): number => {
  const raw = form.get(key)
  return typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : 0
}

function refused(payload: Payload, error: unknown): QuestionState {
  const code = questionErrorCode(error)
  if (code) return fail(code)
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status)
      : undefined
  if (status === 404) return fail('not_found')
  if (status === 403) return fail('forbidden')
  payload.logger.error({
    msg: 'Ask Konnected failed',
    reason: error instanceof Error ? error.name : 'unknown',
  })
  return fail('generic')
}

/**
 * Ask Konnected a question. A student sends the application id, a company the project id; the
 * hook checks either belongs to the user and takes the project and the asker from there.
 */
export async function askQuestion(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<QuestionState> {
  if (!user || !(isStudent(user) || isCompany(user))) return fail('forbidden')
  const body = cleanText(form.get('body'))
  if (!body) return fail('text_required')
  if (body.length > QUESTION_MAX) return fail('too_long')
  const target = isStudent(user)
    ? { application: idFrom(form, 'applicationId') }
    : { project: idFrom(form, 'projectId') }
  if (!Object.values(target)[0]) return fail('not_found')
  try {
    await payload.create({
      collection: 'questions',
      data: { ...target, body } as never,
      ...asUser(user),
    })
  } catch (error) {
    return refused(payload, error)
  }
  return { status: 'done', doneAt: Date.now() }
}

/** Answer a question Konnected passed on. Once; only Konnected reads the answer. */
export async function answerRelay(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<QuestionState> {
  if (!user || !(isStudent(user) || isCompany(user))) return fail('forbidden')
  const id = idFrom(form, 'id')
  if (!id) return fail('not_found')
  const answer = cleanText(form.get('answer'))
  if (!answer) return fail('text_required')
  if (answer.length > ANSWER_MAX) return fail('too_long')
  try {
    await payload.update({
      collection: 'questions',
      id,
      data: { status: 'answered', answer },
      ...asUser(user),
    })
  } catch (error) {
    return refused(payload, error)
  }
  return { status: 'done', doneAt: Date.now() }
}
