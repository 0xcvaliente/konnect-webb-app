'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { SessionUser } from '@/lib/students/profile'

import { answerRelay, askQuestion } from './asker'
import type { QuestionState } from './fields'
import { addSavedAnswer, answerQuestion, relayQuestion, removeSavedAnswer } from './team'

/**
 * Server Actions for Ask Konnected. Each is a public POST endpoint, so each reads the session
 * again here and passes that user on; the user and their role never come from the form. The
 * Questions and SavedAnswers access rules and hooks decide everything.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

/** A student or a company asks Konnected. */
export async function askQuestionAction(
  _prev: QuestionState,
  form: FormData,
): Promise<QuestionState> {
  const { payload, user } = await session()
  return askQuestion(payload, user, form)
}

/** A student or a company answers a question Konnected passed on. */
export async function answerRelayAction(
  _prev: QuestionState,
  form: FormData,
): Promise<QuestionState> {
  const { payload, user } = await session()
  return answerRelay(payload, user, form)
}

/** The team answers a question. */
export async function answerQuestionAction(
  _prev: QuestionState,
  form: FormData,
): Promise<QuestionState> {
  const { payload, user } = await session()
  return answerQuestion(payload, user, form)
}

/** The team passes a question on to the other side. */
export async function relayQuestionAction(
  _prev: QuestionState,
  form: FormData,
): Promise<QuestionState> {
  const { payload, user } = await session()
  return relayQuestion(payload, user, form)
}

/** The team keeps an answer for later. */
export async function addSavedAnswerAction(
  _prev: QuestionState,
  form: FormData,
): Promise<QuestionState> {
  const { payload, user } = await session()
  return addSavedAnswer(payload, user, form)
}

/** The team removes a saved answer. */
export async function removeSavedAnswerAction(
  _prev: QuestionState,
  form: FormData,
): Promise<QuestionState> {
  const { payload, user } = await session()
  return removeSavedAnswer(payload, user, form)
}
