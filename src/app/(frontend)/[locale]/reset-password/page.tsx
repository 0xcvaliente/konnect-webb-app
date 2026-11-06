import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { EntryShell } from '@/components/app/EntryShell'
import { routing } from '@/i18n/routing'

import { ResetRequestForm } from '../AuthPageForms'

/** Ask for a password reset link. Open to everyone; the answer is the same for every address. */
export default async function ResetRequestPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const t = await getTranslations('Reset')
  return (
    <EntryShell title={t('askTitle')} lede={t('askLede')}>
      <ResetRequestForm locale={locale} />
    </EntryShell>
  )
}
