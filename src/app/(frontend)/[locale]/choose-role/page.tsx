import config from '@payload-config'
import { ArrowRightIcon, BuildingIcon, UserIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { EntryShell } from '@/components/app/EntryShell'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { redirect } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'

// The role step after the first sign-in ("Final pass" mockup, Choose role). The form posts to
// /api/auth/role, which checks the session and the origin and allows only student or company,
// once, from `pending`.
export const dynamic = 'force-dynamic'

const OPTIONS = [
  { role: 'student', Icon: UserIcon, points: ['student1', 'student2', 'student3'] },
  { role: 'company', Icon: BuildingIcon, points: ['company1', 'company2', 'company3'] },
] as const

export default async function ChooseRolePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const t = await getTranslations('ChooseRole')
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user || user.role !== 'pending') return redirect({ href: '/', locale })

  return (
    <EntryShell title={t('title')} lede={t('lede', { email: user.email })}>
      <div className="grid gap-4">
        <form method="post" action="/api/auth/role" className="grid gap-4">
          <fieldset className="grid gap-3">
            <legend className="sr-only">{t('legend')}</legend>
            <RadioGroup name="role" defaultValue="student" required className="gap-3">
              {OPTIONS.map(({ role, Icon, points }) => (
                <label
                  key={role}
                  htmlFor={`role-${role}`}
                  className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-3.5 rounded-card border-[1.5px] border-line bg-surface p-[18px] transition-colors hover:bg-surface-2 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:outline-3 has-[[data-state=checked]]:outline-primary/30"
                >
                  <RadioGroupItem value={role} id={`role-${role}`} className="mt-0.5" />
                  <span className="grid gap-2">
                    <span className="flex items-center gap-2 text-base leading-tight font-semibold">
                      <Icon aria-hidden="true" className="size-5 shrink-0 text-primary" />
                      {t(role)}
                    </span>
                    <ul className="grid gap-1.5 text-[0.92rem] text-muted-foreground">
                      {points.map((point) => (
                        <li
                          key={point}
                          className="relative pl-[18px] before:absolute before:top-[0.6em] before:left-0 before:size-1.5 before:rounded-full before:bg-primary"
                        >
                          {t(point)}
                        </li>
                      ))}
                    </ul>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          <Button type="submit" className="w-full">
            {t('continue')}
            <ArrowRightIcon aria-hidden="true" />
          </Button>
        </form>
        <form method="post" action="/api/auth/logout" className="justify-self-center">
          <Button type="submit" variant="text">
            {t('notYou')}
          </Button>
        </form>
      </div>
    </EntryShell>
  )
}
