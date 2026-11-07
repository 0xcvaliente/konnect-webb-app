import { CheckIcon, FileTextIcon, LockIcon } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { SHARED_ITEMS, type SharedItem, sharedItemsOf } from '@/lib/matching/fields'
import type { SelectedStudent as Selected } from '@/lib/projects/project'

/**
 * "Your student" on the company's project page ("Final pass" mockup, Matched student): only what
 * the selected student agreed to share, from the match's shared copy. What the student did not
 * share is named as a kind ("Email and phone stay with Konnected"), never shown. Nothing about any
 * other applicant exists on this page.
 */
export async function SelectedStudent({ student }: { student: Selected }) {
  const t = await getTranslations('CompanyProject.student')
  const label = await getTranslations('SharedItems.label')
  const inline = await getTranslations('SharedItems.inline')
  const sf = await getTranslations('StudentFields')
  const format = await getFormatter()
  const { shared } = student
  const items = sharedItemsOf(shared)
  const notShared = SHARED_ITEMS.filter((item) => !items.includes(item))
  // Name and studies sit in the heading; the rest is listed.
  const listed = items.filter((item) => item !== 'name' && item !== 'school')
  const name = shared.name?.trim() || null
  const study = [
    shared.programme,
    shared.year && sf.has(`yearOption.${shared.year}` as never)
      ? sf(`yearOption.${shared.year}` as never)
      : null,
    shared.school,
  ]
    .filter(Boolean)
    .join(', ')
  const initials = name
    ? name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]!.toUpperCase())
        .join('')
    : '?'

  const value = (item: SharedItem): ReactNode => {
    switch (item) {
      case 'name':
        return name
      case 'school':
        return study
      case 'skills':
        return (
          <span className="flex flex-wrap gap-1.5">
            {(shared.skills ?? []).map((skill) => (
              <Badge key={skill} variant="tag">
                {skill}
              </Badge>
            ))}
          </span>
        )
      case 'pitch':
        return <span className="whitespace-pre-line">{shared.pitch}</span>
      case 'experience':
        return <span className="whitespace-pre-line">{shared.experience}</span>
      case 'cv':
        return student.cv ? (
          <Button asChild size="sm" variant="secondary">
            {/* The access-checked file route; it checks the student's tick on every request. */}
            <a href={student.cv.url}>
              <FileTextIcon aria-hidden="true" className="size-4" />
              {t('openCv')}
            </a>
          </Button>
        ) : null
      case 'contactEmail':
        return <a href={`mailto:${shared.contactEmail}`}>{shared.contactEmail}</a>
      case 'phone':
        return <a href={`tel:${shared.phone}`}>{shared.phone}</a>
    }
  }

  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle>{t('title')}</CardTitle>
        <span className="text-[0.85rem] text-muted-foreground">
          {t('selectedOn', {
            date: format.dateTime(new Date(student.selectedAt), {
              dateStyle: 'medium',
              timeZone: 'Europe/Oslo',
            }),
          })}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-[0.85rem] font-bold text-primary-foreground"
        >
          {initials}
        </span>
        <div className="min-w-0">
          <b className="block font-semibold [overflow-wrap:anywhere]">{name ?? t('nameHidden')}</b>
          {study && (
            <small className="block text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
              {study}
            </small>
          )}
        </div>
      </div>
      <p className="text-[0.88rem] text-muted-foreground">{t('only')}</p>

      {items.length === 0 && <p className="text-[0.9rem]">{t('nothing')}</p>}
      {listed.length > 0 && (
        <ul className="grid">
          {listed.map((item) => (
            <li
              key={item}
              className="grid gap-1 border-b border-line py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,160px)_minmax(0,1fr)] sm:gap-4"
            >
              <span className="flex items-center gap-2 font-medium">
                <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-success" />
                {label(item)}
              </span>
              <span className="min-w-0 text-[0.92rem] [overflow-wrap:anywhere]">{value(item)}</span>
            </li>
          ))}
        </ul>
      )}

      {notShared.length > 0 && (
        <p className="flex items-start gap-2 text-[0.88rem] text-muted-foreground">
          <LockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {t('notShared', {
              items: format.list(
                notShared.map((item) => inline(item)),
                { type: 'conjunction' },
              ),
            })}
          </span>
        </p>
      )}
    </Card>
  )
}
