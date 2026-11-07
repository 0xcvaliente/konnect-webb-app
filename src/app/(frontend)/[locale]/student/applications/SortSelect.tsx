'use client'

import { useTranslations } from 'next-intl'
import { useId, useTransition } from 'react'

import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useRouter } from '@/i18n/navigation'
import { APPLICATION_SORTS, type ApplicationSort } from '@/lib/applications/fields'

/**
 * "Show first" on My applications ("Final pass" mockup). The order lives in the address, so the
 * server sorts, and a reload or Back keeps it.
 */
export function SortSelect({ sort, count }: { sort: ApplicationSort; count: number }) {
  const t = useTranslations('Applications')
  const router = useRouter()
  const id = useId()
  const [pending, startTransition] = useTransition()

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Label htmlFor={id}>{t('sortLabel')}</Label>
      <Select
        value={sort}
        onValueChange={(value) =>
          startTransition(() =>
            router.replace(
              value === 'need' ? '/student/applications' : `/student/applications?sort=${value}`,
              { scroll: false },
            ),
          )
        }
      >
        <SelectTrigger id={id} className="w-auto min-w-[12rem] flex-[0_1_14rem]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {APPLICATION_SORTS.map((key) => (
            <SelectItem key={key} value={key}>
              {t(`sort.${key}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p
        role="status"
        aria-busy={pending || undefined}
        className="text-[0.85rem] text-muted-foreground"
      >
        {t('sortNote', { count, order: t(`sortOrder.${sort}`) })}
      </p>
    </div>
  )
}
