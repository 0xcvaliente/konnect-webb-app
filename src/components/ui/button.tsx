import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Pill buttons (konnected-design-system, Components):
 * main = primary, normal = tint, secondary = surface with a line outline, text = no fill,
 * band = the main action when it sits on the mint band.
 * 44 px tall on phones, 38 px from 640 px.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border border-transparent font-semibold whitespace-nowrap no-underline transition-colors disabled:pointer-events-none disabled:opacity-55 aria-disabled:pointer-events-none aria-disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[18px]",
  {
    variants: {
      variant: {
        main: 'bg-primary text-primary-foreground hover:bg-primary/90',
        normal:
          'bg-tint text-tint-foreground hover:bg-[color-mix(in_srgb,var(--tint)_80%,var(--primary)_8%)]',
        secondary: 'border-line bg-surface text-foreground hover:bg-surface-2',
        text: 'bg-transparent text-primary hover:underline hover:underline-offset-4',
        band: 'bg-band-link text-primary-foreground hover:bg-band-link/90',
        destructive: 'bg-destructive text-[var(--bg)] hover:bg-destructive/90',
      },
      size: {
        default: 'min-h-11 px-[18px] text-body sm:min-h-[38px]',
        sm: 'min-h-11 px-3.5 text-[0.875rem] sm:min-h-8',
        lg: 'min-h-12 px-6 text-base',
        icon: 'size-11 sm:size-[38px]',
      },
    },
    defaultVariants: {
      variant: 'main',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'main',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
