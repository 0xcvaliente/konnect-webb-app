import * as React from 'react'

import { cn } from '@/lib/utils'

/** Text input: 14 px radius, --edge border, 16 px text on phones (no iOS zoom), 15 px from 640 px. */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex min-h-11 w-full min-w-0 rounded-item border border-input bg-surface px-3 py-2 text-base text-foreground transition-colors sm:min-h-10 sm:text-body',
        'file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-55',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
