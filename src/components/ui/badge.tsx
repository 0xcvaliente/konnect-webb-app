import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * status: a status pill. The tone is mixed 12 % into the surface, the text 62 % into the ink, with a
 * 7 px dot in the tone. tag: a quiet label. new: the tint "new" tag.
 */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-tag whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        status:
          'bg-[color-mix(in_srgb,var(--tone)_12%,var(--surface))] font-medium text-[color-mix(in_srgb,var(--tone)_62%,var(--ink))]',
        tag: 'bg-surface-2 text-muted-foreground',
        new: 'bg-tint font-medium text-tint-foreground',
      },
      tone: {
        ok: '[--tone:var(--ok)]',
        warn: '[--tone:var(--warn)]',
        bad: '[--tone:var(--bad)]',
        info: '[--tone:var(--primary)]',
        mute: '[--tone:var(--ink-2)]',
      },
    },
    defaultVariants: {
      variant: 'status',
      tone: 'info',
    },
  },
)

function Badge({
  className,
  variant = 'status',
  tone = 'info',
  children,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant, tone }), className)}
      {...props}
    >
      {variant === 'status' && (
        <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-(--tone)" />
      )}
      {children}
    </span>
  )
}

export { Badge, badgeVariants }
