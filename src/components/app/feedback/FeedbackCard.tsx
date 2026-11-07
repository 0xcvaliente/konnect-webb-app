import { CircleCheckIcon, StarIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'

/**
 * "How did it go?" on the student's application page and the company's project page, once the
 * project closed after delivery ("Final pass" mockup): a link to the short form, or a thank-you
 * once it was sent. Only Konnected reads the answers.
 */
export function FeedbackCard({ href, sent }: { href: string; sent: boolean }) {
  const t = useTranslations('Feedback')
  return (
    <Card className="gap-3">
      <div className="grid gap-1">
        <CardTitle className="flex items-center gap-2">
          {sent ? (
            <CircleCheckIcon aria-hidden="true" className="size-[18px] text-success" />
          ) : (
            <StarIcon aria-hidden="true" className="size-[18px] text-primary" />
          )}
          {t('cardTitle')}
        </CardTitle>
        <p className="text-[0.9rem] text-muted-foreground">
          {sent ? t('cardSent') : t('cardBody')}
        </p>
      </div>
      {!sent && (
        <div>
          <Button asChild variant="secondary">
            <Link href={href}>{t('cardButton')}</Link>
          </Button>
        </div>
      )}
    </Card>
  )
}
