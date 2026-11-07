import { DownloadIcon, ExternalLinkIcon, FileTextIcon, LinkIcon } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DELIVERABLE_STATUS_TONE, fileSizeText } from '@/lib/deliverables/fields'
import type { HandIn } from '@/lib/deliverables/student'
import { cn } from '@/lib/utils'

/**
 * One hand-in ("Final pass" mockup, files on the application page, the team's Deliverables and
 * the company's project page): its status, when it happened, the student's note, the files to
 * download (through the access-checked file route, with the uploaded name) and the links.
 *
 * `audience` decides the status words: a company never sees a hand-in before release, so it gets
 * "Released" and what it did after; the team's notes to the student are shown only to the student
 * and the team (the collection does not even return them to a company).
 */
export async function HandInView({
  handIn,
  audience,
  headingLevel = 3,
  className,
}: {
  handIn: HandIn
  audience: 'student' | 'company' | 'team'
  headingLevel?: 2 | 3
  className?: string
}) {
  const t = await getTranslations('Deliverables')
  const format = await getFormatter()
  const day = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Europe/Oslo' }) : ''
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  const when =
    audience === 'company'
      ? t('releasedOn', { date: day(handIn.releasedAt) })
      : t('sentOn', { date: day(handIn.submittedAt ?? handIn.createdAt) })

  return (
    <article className={cn('grid min-w-0 gap-3', className)} aria-label={when}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading className="text-[0.95rem] font-semibold">{when}</Heading>
        <Badge tone={DELIVERABLE_STATUS_TONE[handIn.status]}>
          {t(`status.${audience}.${handIn.status}`)}
        </Badge>
      </div>

      {handIn.note && (
        <blockquote className="border-l-[3px] border-line py-0.5 pl-3.5 text-[0.92rem] [overflow-wrap:anywhere] whitespace-pre-line">
          {handIn.note}
        </blockquote>
      )}

      {handIn.files.length > 0 && (
        <ul className="grid gap-2" aria-label={t('filesLabel')}>
          {handIn.files.map((file) => (
            <li
              key={file.id}
              className="flex flex-wrap items-center gap-3 rounded-item border-[1.5px] border-line bg-surface px-3.5 py-3"
            >
              <FileTextIcon aria-hidden="true" className="size-[22px] shrink-0 text-primary" />
              <div className="min-w-0 flex-1 basis-40">
                <p className="font-semibold [overflow-wrap:anywhere]">{file.name}</p>
                {fileSizeText(file.size) && (
                  <p className="text-[0.85rem] text-muted-foreground">{fileSizeText(file.size)}</p>
                )}
              </div>
              {file.url && (
                <Button asChild variant="secondary" size="sm">
                  <a href={file.url} download={file.name}>
                    <DownloadIcon aria-hidden="true" className="size-4" />
                    {t('download')}
                    <span className="sr-only">: {file.name}</span>
                  </a>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {handIn.links.length > 0 && (
        <ul className="grid gap-1.5" aria-label={t('linksLabel')}>
          {handIn.links.map((link, i) => (
            <li key={i} className="flex min-w-0 items-start gap-2 text-[0.92rem]">
              <LinkIcon aria-hidden="true" className="mt-1 size-4 shrink-0 text-primary" />
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex min-h-11 min-w-0 items-start gap-1 font-semibold [overflow-wrap:anywhere] sm:min-h-0"
              >
                {link.label || link.url}
                <ExternalLinkIcon aria-hidden="true" className="mt-1 size-3.5 shrink-0" />
                <span className="sr-only"> {t('opensNewTab')}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {audience !== 'company' && handIn.returnNote && (
        <p className="rounded-item bg-surface-2 px-3.5 py-2.5 text-[0.88rem] [overflow-wrap:anywhere] whitespace-pre-line">
          <b className="block font-semibold">
            {t('returnNoteTitle', { date: day(handIn.returnedAt) })}
          </b>
          {handIn.returnNote}
        </p>
      )}
      {handIn.fixNote && (
        <p className="rounded-item bg-surface-2 px-3.5 py-2.5 text-[0.88rem] [overflow-wrap:anywhere] whitespace-pre-line">
          <b className="block font-semibold">
            {t(audience === 'company' ? 'fixNoteTitleCompany' : 'fixNoteTitle', {
              date: day(handIn.fixRequestedAt),
            })}
          </b>
          {handIn.fixNote}
        </p>
      )}
      {handIn.acceptedAt && (
        <p className="text-[0.85rem] text-muted-foreground">
          {t(`acceptedLine.${handIn.acceptedBy ?? 'company'}`, { date: day(handIn.acceptedAt) })}
        </p>
      )}
    </article>
  )
}
