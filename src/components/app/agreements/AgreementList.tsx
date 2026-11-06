import { ChevronRightIcon } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'

import { Card } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import type { Agreement } from '@/payload-types'

import { AgreementStatusPill } from './AgreementParts'

/** The party's own agreements, newest first, each opening its page. */
export async function AgreementList({
  agreements,
  base,
}: {
  agreements: Agreement[]
  /** The area: /company/agreements or /student/agreements. */
  base: string
}) {
  const t = await getTranslations('AgreementSign')
  const a = await getTranslations('Agreements')
  const format = await getFormatter()
  if (!agreements.length) {
    return (
      <Card>
        <p className="text-muted-foreground">{t('listEmpty')}</p>
      </Card>
    )
  }
  return (
    <Card className="gap-0 p-2 sm:p-3">
      <ul className="grid">
        {agreements.map((agreement) => (
          <li key={agreement.id} className="border-b border-line last:border-b-0">
            <Link
              href={`${base}/${agreement.id}`}
              className="flex min-h-14 items-center gap-3 rounded-item px-3 py-3 text-foreground no-underline hover:bg-surface-2"
            >
              <span className="grid min-w-0 flex-1 gap-0.5">
                <b className="font-semibold [overflow-wrap:anywhere]">{agreement.title}</b>
                <span className="text-[0.85rem] text-muted-foreground">
                  {a(`kind.${agreement.kind}`)}, {agreement.reference},{' '}
                  {format.dateTime(new Date(agreement.createdAt), { dateStyle: 'medium' })}
                </span>
              </span>
              <AgreementStatusPill status={agreement.status} party />
              <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="sr-only">{t('open')}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}
