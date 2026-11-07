import { CircleCheckIcon, ClockIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import type { FeedbackStatus } from '@/lib/feedback/feedback'

import { FeedbackForm } from './FeedbackForm'

/**
 * The body of the feedback page for the student and the company: the form beside "Why Konnected
 * asks", a thank-you once it was sent, or a note when the project has not closed yet.
 */
export function FeedbackBody({
  status,
  as,
  projectId,
  backHref,
}: {
  status: FeedbackStatus
  as: 'student' | 'company'
  projectId: number
  backHref: string
}) {
  const t = useTranslations('Feedback')
  if (status !== 'open') {
    const sent = status === 'sent'
    return (
      <Card className="gap-0 p-0 sm:p-0">
        <Banner
          tone={sent ? 'ok' : 'info'}
          icon={sent ? CircleCheckIcon : ClockIcon}
          className="rounded-card px-[22px] py-[18px] sm:px-[26px]"
        >
          <div className="grid gap-2">
            <p className="font-semibold">{sent ? t('sentTitle') : t('notOpenTitle')}</p>
            <p className="text-[0.9rem] text-muted-foreground">
              {sent ? t('sentBody') : t('notOpenBody')}
            </p>
            <div>
              <Button asChild size="sm" variant="secondary">
                <Link href={backHref}>
                  {as === 'student' ? t('backStudent') : t('backCompany')}
                </Link>
              </Button>
            </div>
          </div>
        </Banner>
      </Card>
    )
  }
  return (
    <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] md:gap-[26px]">
      <FeedbackForm projectId={projectId} as={as} backHref={backHref} />
      <Card className="gap-2">
        <CardTitle>{t('whyTitle')}</CardTitle>
        <p className="text-[0.9rem] text-muted-foreground">
          {as === 'student' ? t('whyStudent') : t('whyCompany')}
        </p>
        <p className="text-[0.9rem] text-muted-foreground">{t('ratingsLater')}</p>
      </Card>
    </div>
  )
}
