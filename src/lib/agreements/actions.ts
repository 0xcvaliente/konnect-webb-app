'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import { isAdmin } from '@/access/roles'
import type { User } from '@/payload-types'

import { type AgreementInput, requestAgreement, voidAgreement } from './generate'
import { signAgreement } from './sign'
import { signInMethodOf } from './signInMethod'
import type { AgreementActionState } from './state'

/**
 * Server Actions for the agreement screens. Each is a public POST endpoint, so each reads the
 * session again and passes that user on; the rules live in lib/agreements and in the collections.
 * The acting user and the signer never come from the form. Next.js refuses Server Action calls
 * whose Origin does not match the host. Form values are never logged.
 */

async function session() {
  const payload = await getPayload({ config })
  const head = await headers()
  const { user } = await payload.auth({ headers: head })
  return { payload, head, user: (user as (User & { collection: 'users' }) | null) ?? null }
}

const idOf = (form: FormData, name: string): number | null => {
  const value = Number(form.get(name))
  return Number.isInteger(value) && value > 0 ? value : null
}

const error = (code: string, fields?: string[]): AgreementActionState => ({
  status: 'error',
  error: code,
  fields,
  doneAt: Date.now(),
})

/** Team: make the company agreement of a project, or the student agreement of a match. */
export async function requestAgreementAction(
  _prev: AgreementActionState,
  form: FormData,
): Promise<AgreementActionState> {
  const { payload, user } = await session()
  const kind = form.get('kind')
  const input: AgreementInput | null =
    kind === 'company' && idOf(form, 'projectId')
      ? { kind: 'company', projectId: idOf(form, 'projectId')! }
      : kind === 'student' && idOf(form, 'matchId')
        ? { kind: 'student', matchId: idOf(form, 'matchId')! }
        : null
  if (!input) return error('not_found')
  const result = await requestAgreement(payload, user, input)
  return result.ok
    ? { status: 'done', doneAt: Date.now(), id: result.id }
    : error(result.error, result.fields)
}

/** Team: withdraw an unfinished agreement, and make a new one when asked. */
export async function voidAgreementAction(
  _prev: AgreementActionState,
  form: FormData,
): Promise<AgreementActionState> {
  const { payload, user } = await session()
  const id = idOf(form, 'agreementId')
  if (!id) return error('not_found')
  const result = await voidAgreement(payload, user, id, { remake: form.get('remake') === 'yes' })
  return result.ok
    ? { status: 'done', doneAt: Date.now(), id: result.id }
    : error(result.error, result.fields)
}

/** Company, student or team: sign an agreement. */
export async function signAgreementAction(
  _prev: AgreementActionState,
  form: FormData,
): Promise<AgreementActionState> {
  const { payload, head, user } = await session()
  const id = idOf(form, 'agreementId')
  if (!id) return error('not_found')
  if (!user) return error('forbidden')
  const method = signInMethodOf(head.get('cookie'), payload.config.cookiePrefix, user)
  const result = await signAgreement(
    payload,
    user,
    {
      agreementId: id,
      typedName: String(form.get('typedName') ?? ''),
      agree: form.get('agree') === 'on',
      authority: form.get('authority') === 'on',
      documentSha256: String(form.get('documentSha256') ?? ''),
    },
    method,
  )
  return result.ok
    ? { status: 'done', doneAt: Date.now(), id, result: result.status }
    : error(result.error)
}

/** Team: publish or retire a template, or delete a draft. Through the collection's own rules. */
export async function templateAction(
  _prev: AgreementActionState,
  form: FormData,
): Promise<AgreementActionState> {
  const { payload, user } = await session()
  if (!user || !isAdmin(user)) return error('forbidden')
  const id = idOf(form, 'templateId')
  const action = form.get('action')
  if (!id) return error('not_found')
  try {
    if (action === 'delete') {
      await payload.delete({
        collection: 'agreement-templates',
        id,
        user,
        overrideAccess: false,
      })
    } else if (action === 'publish' || action === 'retire') {
      await payload.update({
        collection: 'agreement-templates',
        id,
        data: { status: action === 'publish' ? 'published' : 'retired' },
        user,
        overrideAccess: false,
      })
    } else {
      return error('generic')
    }
  } catch {
    return error('not_allowed')
  }
  return { status: 'done', doneAt: Date.now(), id, result: String(action) }
}
