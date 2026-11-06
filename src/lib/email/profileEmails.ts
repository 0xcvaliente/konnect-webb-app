import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { appUrl } from '@/lib/auth/env'
import type { StudentProfile } from '@/payload-types'

import { sendEmail } from './send'
import { emailLocale, profileReviewEmail, type ProfileReviewKind } from './templates'

/**
 * Tell the student that Konnected reviewed their profile, or what it asks them to change. Sent
 * to the student's own sign-in address, in their saved language. Called from the StudentProfiles
 * afterChange hook.
 *
 * Bypass: the server reads the student's user with `overrideAccess: true` for the address and the
 * language; the acting user is a team member. Neither is logged.
 */
export async function sendProfileReviewEmail(
  req: PayloadRequest,
  profile: Pick<StudentProfile, 'user' | 'reviewNote'>,
  kind: ProfileReviewKind,
): Promise<void> {
  const userId = relationId(profile.user as number | { id: number } | null | undefined)
  if (!userId) return
  const user = await req.payload.findByID({
    collection: 'users',
    id: userId,
    depth: 0,
    select: { email: true, language: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!user?.email) return
  const locale = emailLocale(user.language)
  await sendEmail(req.payload, {
    to: user.email,
    email: profileReviewEmail(locale, kind, {
      note: profile.reviewNote,
      href: `${appUrl()}/${locale}/student/profile`,
    }),
    type: kind === 'reviewed' ? 'profile_reviewed' : 'profile_changes_requested',
    userId: user.id,
  })
}
