import { CheckIcon, MessageSquareTextIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { OpenRow, StageBars, StageKey, stageName } from '@/components/app/dashboard/Parts'
import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { APPLICATION_STATUS_TONE } from '@/lib/applications/fields'
import { loadStudentHome, type StudentNeed } from '@/lib/students/home'
import { requireStudent } from '@/lib/students/session'
import { cn } from '@/lib/utils'

// The student's home ("Final pass" mockup, Student Home): what needs the student now, the projects
// they work on with their stage, the applications waiting on Konnected, where the profile stands
// and how many projects take applications. A student who has not applied yet sees the three steps
// to get started instead. Read as the student with access control on.
export const dynamic = 'force-dynamic'

type Step = { state: 'done' | 'cur' | 'todo'; title: string; body: string }

function Steps({ steps, label }: { steps: Step[]; label: string }) {
  return (
    <ol aria-label={label} className="grid gap-1">
      {steps.map((step, i) => (
        <li
          key={step.title}
          aria-current={step.state === 'cur' ? 'step' : undefined}
          className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 py-[7px]"
        >
          <span
            aria-hidden="true"
            className={cn(
              'grid size-7 place-items-center rounded-full border-[1.5px] text-[0.8rem] font-bold tabular-nums',
              step.state === 'done' && 'border-success text-success',
              step.state === 'cur' && 'border-primary bg-primary text-primary-foreground',
              step.state === 'todo' && 'border-input bg-surface text-muted-foreground',
            )}
          >
            {step.state === 'done' ? <CheckIcon className="size-3.5" strokeWidth={3} /> : i + 1}
          </span>
          <span className="grid min-w-0 gap-0.5">
            <b className="font-semibold">{step.title}</b>
            <small className="text-[0.85rem] text-muted-foreground">{step.body}</small>
          </span>
        </li>
      ))}
    </ol>
  )
}

export default async function StudentHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user, account } = await requireStudent(locale)
  const home = await loadStudentHome(payload, user)
  if (!home) notFound()

  const t = await getTranslations('StudentHome')
  const ts = await getTranslations('ApplicationStatus')
  const format = await getFormatter()
  const day = (value: string) => {
    const [y, m, d] = value.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: 'medium',
      timeZone: 'Europe/Oslo',
    })
  }
  const first = home.name.trim().split(/\s+/)[0] ?? ''

  const review = home.profile.review
  const profileCard = (
    <Card className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>{t('profileTitle')}</CardTitle>
        <Badge
          tone={review === 'reviewed' ? 'ok' : review === 'changes_requested' ? 'warn' : 'info'}
        >
          {t(`profileState.${review}`)}
        </Badge>
      </div>
      <Steps
        label={t('profileTitle')}
        steps={[
          { state: 'done', title: t('stepQuestions'), body: t('stepQuestionsDone') },
          {
            state: home.profile.hasCv ? 'done' : 'cur',
            title: t('stepCv'),
            body: home.profile.hasCv ? t('stepCvDone') : t('stepCvMissing'),
          },
          {
            state: review === 'reviewed' ? 'done' : home.profile.hasCv ? 'cur' : 'todo',
            title: t('stepReview'),
            body:
              review === 'reviewed'
                ? t('stepReviewDone')
                : review === 'changes_requested'
                  ? t('stepReviewChanges')
                  : t('stepReviewWaiting'),
          },
        ]}
      />
      <Button asChild variant={home.profile.hasCv ? 'secondary' : 'main'} className="w-full">
        <Link href="/student/profile">{home.profile.hasCv ? t('openProfile') : t('uploadCv')}</Link>
      </Button>
    </Card>
  )

  if (home.fresh) {
    return (
      <SiteShell
        role="student"
        current="home"
        user={account}
        title={first ? t('titleFresh', { name: first }) : t('titleNoName')}
        lede={t('ledeFresh')}
      >
        <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] md:gap-[26px]">
          <div className="grid min-w-0 gap-6 md:gap-[26px]">
            <Card className="gap-4">
              <CardTitle>{t('startTitle')}</CardTitle>
              <ol className="grid gap-4">
                {(
                  [
                    [t('start1Title'), t('start1Body'), t('uploadCv'), '/student/profile', true],
                    [
                      t('start2Title'),
                      t('start2Body'),
                      t('start2Action'),
                      '/student/profile',
                      false,
                    ],
                    [t('start3Title'), t('start3Body'), t('browse'), '/student/projects', false],
                  ] as const
                ).map(([title, body, action, href, main], i) => (
                  <li key={title} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'grid size-7 place-items-center rounded-full border-[1.5px] text-[0.8rem] font-bold',
                        main
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input text-muted-foreground',
                      )}
                    >
                      {i + 1}
                    </span>
                    <span className="grid min-w-0 justify-items-start gap-1">
                      <b className="font-semibold">{title}</b>
                      <small className="text-[0.88rem] text-muted-foreground">{body}</small>
                      <Button asChild size="sm" variant={main ? 'main' : 'secondary'}>
                        <Link href={href}>{action}</Link>
                      </Button>
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
            <Card className="gap-2">
              <CardTitle>{t('appsTitle')}</CardTitle>
              <p className="text-[0.9rem] text-muted-foreground">{t('appsEmpty')}</p>
            </Card>
          </div>
          <aside className="grid min-w-0 gap-6 md:gap-[26px]">{profileCard}</aside>
        </div>
      </SiteShell>
    )
  }

  const needRow = (need: StudentNeed, i: number) => {
    const lead = <Badge tone="warn">{t('toDo')}</Badge>
    switch (need.kind) {
      case 'agreement':
        return (
          <OpenRow
            key={`a${need.id}`}
            href={`/student/agreements/${need.id}`}
            lead={lead}
            title={need.title}
            sub={t('need.agreement')}
          />
        )
      case 'profile_changes':
        return (
          <OpenRow
            key="profile"
            href="/student/profile"
            lead={lead}
            title={t('need.profile_changesTitle')}
            sub={t('need.profile_changes')}
          />
        )
      case 'cv':
        return (
          <OpenRow
            key="cv"
            href="/student/profile"
            lead={lead}
            title={t('need.cvTitle')}
            sub={t('need.cv')}
          />
        )
      default:
        return (
          <OpenRow
            key={`w${need.applicationId}-${i}`}
            href={`/student/applications/${need.applicationId}`}
            lead={lead}
            title={need.title}
            sub={
              need.dueDay
                ? `${t(`need.${need.kind}`)}. ${t('need.due', { date: day(need.dueDay) })}`
                : t(`need.${need.kind}`)
            }
          />
        )
    }
  }

  return (
    <SiteShell
      role="student"
      current="home"
      user={account}
      title={first ? t('title', { name: first }) : t('titleNoName')}
      lede={t('lede', { count: home.needs.length })}
    >
      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] md:gap-[26px]">
        <div className="grid min-w-0 gap-6 md:gap-[26px]">
          <Card className="gap-2">
            <CardTitle>{t('needsTitle')}</CardTitle>
            {home.needs.length ? (
              <ul className="grid">{home.needs.map(needRow)}</ul>
            ) : (
              <p className="text-[0.9rem] text-muted-foreground">{t('needsEmpty')}</p>
            )}
          </Card>

          <Card className="gap-3">
            <CardTitle>{t('runningTitle')}</CardTitle>
            {home.running.length ? (
              <>
                <ul className="grid">
                  {await Promise.all(
                    home.running.map(async (p) => (
                      <li
                        key={p.applicationId}
                        className="grid gap-2.5 border-b border-line py-4 first:pt-1 last:border-b-0 last:pb-1"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                          <h3 className="min-w-0 text-base font-semibold [overflow-wrap:anywhere]">
                            <Link
                              href={`/student/applications/${p.applicationId}`}
                              className="text-foreground"
                            >
                              {p.title}
                            </Link>
                          </h3>
                          <span className="text-[0.85rem] text-muted-foreground">
                            {p.companyName}
                          </span>
                        </div>
                        <StageBars status={p.projectStatus} warn={p.problemOpen} />
                        <p className="text-[0.88rem] text-muted-foreground">
                          <b className="mr-1 font-semibold text-foreground">
                            {await stageName(p.projectStatus)}
                          </b>
                          {p.dueDay ? t('due', { date: day(p.dueDay) }) : t('noDue')}
                        </p>
                        {p.problemOpen && (
                          <p className="inline-flex items-center gap-1.5 text-[0.85rem] text-muted-foreground">
                            <MessageSquareTextIcon aria-hidden="true" className="size-4" />
                            {t('problemOpen')}
                          </p>
                        )}
                      </li>
                    )),
                  )}
                </ul>
                <StageKey />
              </>
            ) : (
              <p className="text-[0.9rem] text-muted-foreground">{t('runningEmpty')}</p>
            )}
          </Card>

          <Card className="gap-2">
            <CardTitle>{t('waitingTitle')}</CardTitle>
            {home.waiting.length ? (
              <ul className="grid">
                {home.waiting.map((a) => (
                  <OpenRow
                    key={a.id}
                    href={`/student/applications/${a.id}`}
                    lead={<Badge tone={APPLICATION_STATUS_TONE[a.status]}>{ts(a.status)}</Badge>}
                    title={a.title}
                    sub={
                      a.decideBy
                        ? t('decideBy', { company: a.companyName, date: day(a.decideBy) })
                        : t('waitingNoDate', { company: a.companyName })
                    }
                  />
                ))}
              </ul>
            ) : (
              <p className="text-[0.9rem] text-muted-foreground">{t('waitingEmpty')}</p>
            )}
          </Card>
        </div>

        <aside className="grid min-w-0 gap-6 md:gap-[26px]">
          {profileCard}
          <Card className="gap-3">
            <CardTitle>{t('newTitle')}</CardTitle>
            <p className="text-[0.9rem]">{t('newBody', { count: home.openProjects })}</p>
            <Button asChild className="w-full">
              <Link href="/student/projects">{t('browse')}</Link>
            </Button>
          </Card>
        </aside>
      </div>
    </SiteShell>
  )
}
