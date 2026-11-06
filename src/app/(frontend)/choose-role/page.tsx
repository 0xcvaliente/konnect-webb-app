import config from '@payload-config'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

// Plain placeholder for the role step after the first sign-in. Styling comes with the design base.
export const dynamic = 'force-dynamic'

export default async function ChooseRolePage() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user) redirect('/')
  if (user.role !== 'pending') redirect('/')

  return (
    <main>
      <h1>How will you use Konnected?</h1>
      <form method="post" action="/api/auth/role">
        <button type="submit" name="role" value="student">
          I am a student
        </button>
        <button type="submit" name="role" value="company">
          I am a company
        </button>
      </form>
    </main>
  )
}
