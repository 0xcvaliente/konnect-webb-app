import { CircleCheckIcon, ClockIcon, InfoIcon, WrenchIcon } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'

import { Banner } from '@/components/app/Banner'
import { Card, CardTitle } from '@/components/ui/card'
import type { CompanyWork as Work } from '@/lib/deliverables/student'

import { CompanyDecision } from './CompanyDecision'
import { HandInView } from './HandInView'

/**
 * "Deliverable" on the company's project page ("Final pass" mockup, project page): nothing until
 * Konnected releases the work; then the files and links to download, and Accept or Ask for a fix
 * (one round, within 7 days). Earlier releases stay listed below. Only released work exists here:
 * the collection never returns anything else to a company.
 */
export async function CompanyWork({ work }: { work: Work }) {
  const t = await getTranslations('CompanyWork')
  const format = await getFormatter()
  const day = (iso: string | null | undefined) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'long', timeZone: 'Europe/Oslo' }) : ''
  const dayOf = (yyyyMmDd: string) => {
    const [y, m, d] = yyyyMmDd.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: 'long',
      timeZone: 'Europe/Oslo',
    })
  }
  const { state, handIns } = work
  const current = state.current ? handIns.find((h) => h.id === state.current!.id) : null
  const earlier = handIns.filter((h) => h.id !== current?.id)

  return (
    <Card className="gap-4">
      <CardTitle>{t('title')}</CardTitle>
      {!current ? (
        <Banner icon={InfoIcon}>
          <p className="font-semibold">{t('none.title')}</p>
          <p className="text-[0.88rem] text-muted-foreground">{t('none.body')}</p>
        </Banner>
      ) : (
        <>
          {state.fixOpen ? (
            <Banner tone="warn" icon={WrenchIcon}>
              <p className="font-semibold">
                {t('fixOpen.title', { date: day(current.fixRequestedAt) })}
              </p>
              <p className="text-[0.88rem] text-muted-foreground">{t('fixOpen.body')}</p>
            </Banner>
          ) : state.accepted ? (
            <Banner tone="ok" icon={CircleCheckIcon}>
              <p className="font-semibold">
                {current.status === 'accepted'
                  ? t(`accepted.${current.acceptedBy ?? 'company'}`, {
                      date: day(current.acceptedAt),
                    })
                  : t('accepted.window')}
              </p>
              <p className="text-[0.88rem] text-muted-foreground">{t('accepted.body')}</p>
            </Banner>
          ) : (
            <Banner tone="ok" icon={ClockIcon}>
              <p className="font-semibold">
                {t('released.title', { date: day(current.releasedAt) })}
              </p>
              <p className="text-[0.88rem] text-muted-foreground">{t('released.body')}</p>
            </Banner>
          )}
          <HandInView handIn={current} audience="company" />
          {state.canAccept && !state.accepted && (
            <CompanyDecision
              deliverableId={current.id}
              canAskFix={state.canAskFix}
              fixUntil={state.fixUntil ? dayOf(state.fixUntil) : null}
            />
          )}
          {earlier.length > 0 && (
            <section
              aria-labelledby="earlier-releases"
              className="grid gap-4 border-t border-line pt-4"
            >
              <h3 id="earlier-releases" className="text-[0.95rem] font-semibold">
                {t('earlierTitle')}
              </h3>
              {earlier.map((h) => (
                <HandInView key={h.id} handIn={h} audience="company" />
              ))}
            </section>
          )}
        </>
      )}
    </Card>
  )
}
