import { CircleCheckIcon, ClockIcon, InfoIcon, LockIcon } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'

import { Banner } from '@/components/app/Banner'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle } from '@/components/ui/card'
import { fixUntilDay } from '@/lib/deliverables/fields'
import type { StudentWork as Work } from '@/lib/deliverables/student'

import { HandInForm } from './HandInForm'
import { HandInView } from './HandInView'

/**
 * The work on the student's application page ("Final pass" mockup, application page while the
 * work runs): where it stands (not started, with Konnected, released, a fix asked, accepted), the
 * upload form when the student may hand in (never once Konnected closed the project), and every hand-in so far with its files.
 */
export async function StudentWork({ work, company }: { work: Work; company: string }) {
  const t = await getTranslations('StudentWork')
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
  const latest = handIns[0] ?? null
  const current = state.current ? handIns.find((h) => h.id === state.current!.id) : null
  const returned = latest?.status === 'returned' ? latest : null

  let title = t('title.upload')
  let banner: {
    tone: 'info' | 'ok' | 'warn'
    icon?: typeof InfoIcon
    head: string
    body: string
    quote?: string | null
  }
  if (state.blocked === 'not_started') {
    title = t('title.notStarted')
    banner = {
      tone: 'info',
      icon: LockIcon,
      head: t('notStarted.title'),
      body: t('notStarted.body'),
    }
  } else if (state.blocked === 'closed' && !(state.accepted && current)) {
    // Konnected closes a project only once the work is settled (lib/deliverables/gates.ts), so
    // this shows only when nothing was released or accepted through the app.
    title = t('title.closed')
    banner = { tone: 'info', icon: LockIcon, head: t('closed.title'), body: t('closed.body') }
  } else if (state.waiting) {
    title = t('title.waiting')
    banner = {
      tone: 'info',
      icon: ClockIcon,
      head: t('waiting.title'),
      body: t('waiting.body', {
        date: day(handIns.find((h) => h.id === state.waiting!.id)?.submittedAt),
        company,
      }),
    }
  } else if (state.fixOpen && current) {
    title = t('title.fix')
    banner = {
      tone: 'warn',
      head: t('fix.title', { company, date: day(current.fixRequestedAt) }),
      body: returned ? t('fix.bodyReturned') : t('fix.body', { company }),
      quote: returned?.returnNote ?? current.fixNote,
    }
  } else if (state.accepted && current) {
    title = t('title.accepted')
    banner = {
      tone: 'ok',
      icon: CircleCheckIcon,
      head:
        current.acceptedBy === 'auto' || current.status === 'released'
          ? t('accepted.titleAuto')
          : t('accepted.title', { company }),
      body: t('accepted.body'),
    }
  } else if (current) {
    title = t('title.released')
    banner = {
      tone: 'ok',
      icon: CircleCheckIcon,
      head: t('released.title', { company, date: day(current.releasedAt) }),
      body: state.fixUsed
        ? t('released.bodyFixed', { company })
        : t('released.body', { company, date: dayOf(fixUntilDay(current.releasedAt!)) }),
    }
  } else if (returned) {
    title = t('title.more')
    banner = {
      tone: 'warn',
      head: t('more.title', { date: day(returned.returnedAt) }),
      body: t('more.body'),
      quote: returned.returnNote,
    }
  } else {
    banner = { tone: 'info', head: t('ready.title'), body: t('ready.body', { company }) }
  }

  return (
    <>
      <Card className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          {state.fixOpen && <Badge tone="warn">{t('fixBadge')}</Badge>}
        </div>
        <Banner tone={banner.tone} icon={banner.icon}>
          <p className="font-semibold">{banner.head}</p>
          <p className="text-[0.88rem] text-muted-foreground">{banner.body}</p>
          {banner.quote && (
            <p className="mt-1.5 border-l-[3px] border-line pl-3 text-[0.9rem] [overflow-wrap:anywhere] whitespace-pre-line">
              {banner.quote}
            </p>
          )}
        </Banner>
        {state.canSubmit && <HandInForm matchId={work.matchId} company={company} />}
      </Card>

      {handIns.length > 0 && (
        <Card className="gap-4">
          <CardTitle>{t('handInsTitle')}</CardTitle>
          <div className="grid gap-5">
            {handIns.map((h) => (
              <HandInView
                key={h.id}
                handIn={h}
                audience="student"
                className="border-t border-line pt-4 first:border-t-0 first:pt-0"
              />
            ))}
          </div>
        </Card>
      )}
    </>
  )
}
