import config from '@payload-config'
import { BriefcaseBusinessIcon, ChevronRightIcon, GraduationCapIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { SiteShell } from '@/components/app/SiteShell'
import { Card } from '@/components/ui/card'
import { redirect } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'

// The role step after the first sign-in. Still a placeholder: the onboarding card replaces it.
export const dynamic = 'force-dynamic'

const OPTIONS = [
  { role: 'student', Icon: GraduationCapIcon },
  { role: 'company', Icon: BriefcaseBusinessIcon },
] as const

export default async function ChooseRolePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const t = await getTranslations('ChooseRole')
  const tRole = await getTranslations('Roles')
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user || user.role !== 'pending') return redirect({ href: '/', locale })

  return (
    <SiteShell
      user={{ name: user.email, detail: tRole(user.role) }}
      title={t('title')}
      lede={t('lede', { email: user.email })}
    >
      <Card className="p-3 sm:p-4">
        <form method="post" action="/api/auth/role" className="grid gap-3 sm:grid-cols-2">
          {OPTIONS.map(({ role, Icon }) => (
            <button
              key={role}
              type="submit"
              name="role"
              value={role}
              className="group flex min-h-24 cursor-pointer items-start gap-4 rounded-[18px] border-[1.5px] border-line bg-surface p-4 text-left transition-colors hover:border-primary hover:bg-surface-2 sm:p-5"
            >
              <span
                aria-hidden="true"
                className="grid size-11 shrink-0 place-items-center rounded-full bg-tint text-tint-foreground"
              >
                <Icon className="size-5" />
              </span>
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="text-base font-semibold text-foreground">{t(role)}</span>
                <span className="text-muted-foreground">{t(`${role}Hint`)}</span>
              </span>
              <ChevronRightIcon
                aria-hidden="true"
                className="mt-3 size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
              />
            </button>
          ))}
        </form>
      </Card>
    </SiteShell>
  )
}
