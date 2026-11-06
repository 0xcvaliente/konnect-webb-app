import { cn } from '@/lib/utils'

/** The logo mark: two overlapping rings, primary and data, next to the word "Konnected". */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 24"
      width="32"
      height="27"
      aria-hidden="true"
      className={cn('shrink-0 fill-none', className)}
    >
      <circle cx="10" cy="12" r="7" strokeWidth="3" className="stroke-primary" />
      <circle cx="18" cy="12" r="7" strokeWidth="3" className="stroke-data" />
    </svg>
  )
}

/** Logo mark and word mark together. The word is the accessible name. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark />
      <span className="text-[1.15rem] leading-none font-semibold tracking-[-0.015em]">
        Konnected
      </span>
    </span>
  )
}
