import config from '@payload-config'
import { NextResponse } from 'next/server'
import { getPayload } from 'payload'

import { googleEnv, isSameOrigin } from '@/lib/auth/env'

/**
 * First sign-in asks "student or company". This is the only way to leave the `pending` role, and
 * it can never produce `admin`. Only a signed-in user whose role is still `pending` can use it,
 * and only once.
 */
export async function POST(request: Request) {
  const { appUrl } = googleEnv()
  if (!isSameOrigin(request, appUrl)) return new Response('Forbidden', { status: 403 })

  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: request.headers })
  if (!user) return NextResponse.redirect(`${appUrl}/?auth_error=session_expired`, 303)

  const form = await request.formData()
  const role = form.get('role')
  if (user.role !== 'pending' || (role !== 'student' && role !== 'company')) {
    return new Response('Forbidden', { status: 403 })
  }

  // Bypass: `role` is admin-only in the API, so the server sets it, once, from `pending`.
  await payload.update({
    collection: 'users',
    id: user.id,
    data: { role },
    user,
    overrideAccess: true,
  })
  return NextResponse.redirect(`${appUrl}/`, 303)
}
