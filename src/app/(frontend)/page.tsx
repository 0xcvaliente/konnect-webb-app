import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import { AUTH_MESSAGES, isAuthErrorCode, pickLanguage } from '@/lib/auth/messages'

// Placeholder home page until the entry page card. It shows the sign-in state so the flow can be
// tried end to end. Nothing here is final design.
export const dynamic = 'force-dynamic'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string }>
}) {
  const { auth_error } = await searchParams
  const requestHeaders = await headers()
  const language = pickLanguage(requestHeaders.get('accept-language'))
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: requestHeaders })

  return (
    <main>
      <h1>Konnected</h1>
      {isAuthErrorCode(auth_error) && <p role="alert">{AUTH_MESSAGES[auth_error][language]}</p>}
      {user ? (
        <>
          <p>
            Signed in as {user.email} ({user.role})
          </p>
          {user.role === 'pending' && <a href="/choose-role">Choose student or company</a>}
          <form method="post" action="/api/auth/logout">
            <button type="submit">Sign out</button>
          </form>
        </>
      ) : (
        // eslint-disable-next-line @next/next/no-html-link-for-pages -- API route, needs a full navigation
        <a href="/api/auth/google/start">Continue with Google</a>
      )}
    </main>
  )
}
