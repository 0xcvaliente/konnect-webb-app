import { cva, type VariantProps } from 'class-variance-authority'
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react'
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

/** Banner: 14 px radius, the tone mixed 9 % into the surface, no border, the icon in the tone. */
const bannerVariants = cva(
  'flex items-start gap-3 rounded-item bg-[color-mix(in_srgb,var(--tone)_9%,var(--surface))] px-3.5 py-3 text-foreground',
  {
    variants: {
      tone: {
        info: '[--tone:var(--primary)]',
        ok: '[--tone:var(--ok)]',
        warn: '[--tone:var(--warn)]',
        bad: '[--tone:var(--bad)]',
      },
    },
    defaultVariants: { tone: 'info' },
  },
)

const ICONS = {
  info: InfoIcon,
  ok: CircleCheckIcon,
  warn: TriangleAlertIcon,
  bad: CircleAlertIcon,
}

export function Banner({
  tone = 'info',
  className,
  children,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof bannerVariants>) {
  const Icon = ICONS[tone ?? 'info']
  return (
    <div className={cn(bannerVariants({ tone }), className)} {...props}>
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-5 shrink-0 text-[color-mix(in_srgb,var(--tone)_70%,var(--ink))]"
      />
      <div className="min-w-0">{children}</div>
    </div>
  )
}
