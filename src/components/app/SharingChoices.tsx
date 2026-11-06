'use client'

import { useTranslations } from 'next-intl'

import { Checkbox } from '@/components/ui/checkbox'
import { SHARE_KEYS, type ShareKey } from '@/lib/students/fields'

/** The sharing checkboxes: every item off until ticked. Used here and on the profile page. */
export function SharingChoices({
  values,
  onChange,
  name = false,
}: {
  values: Record<ShareKey, boolean>
  onChange?: (key: ShareKey, on: boolean) => void
  /** Give each box a form name, so it is sent with a plain form submit. */
  name?: boolean
}) {
  const f = useTranslations('StudentFields')
  return (
    <ul className="grid">
      {SHARE_KEYS.map((key) => {
        const hint = f.has(`shareHint.${key}`) ? f(`shareHint.${key}`) : null
        return (
          <li key={key} className="border-b border-line last:border-b-0">
            <label
              htmlFor={`share-${key}`}
              className="flex min-h-11 cursor-pointer items-start gap-3 py-2.5"
            >
              <Checkbox
                id={`share-${key}`}
                name={name ? key : undefined}
                checked={onChange ? values[key] : undefined}
                defaultChecked={onChange ? undefined : values[key]}
                onCheckedChange={onChange ? (on) => onChange(key, on === true) : undefined}
                aria-describedby={hint ? `share-${key}-hint` : undefined}
                className="mt-0.5"
              />
              <span className="grid gap-0.5">
                <span className="font-semibold">{f(`share.${key}`)}</span>
                {hint && (
                  <span id={`share-${key}-hint`} className="text-[0.85rem] text-muted-foreground">
                    {hint}
                  </span>
                )}
              </span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}
