'use client'

import { ArrowRightIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { KeyboardEvent, ReactNode, Ref } from 'react'

import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

import { Brand } from './LogoMark'

/**
 * The pieces of a one-question-per-screen onboarding ("Final pass" mockup, Student and Company
 * onboarding): the frame with the progress bar, the count and the up/down buttons, the question
 * title, pill options with A to H keys, and the Enter hint. Student and company onboarding share
 * them; each keeps its own questions and answers.
 */

/** Letters for the option keys: press A to H to pick an option. */
export const OPTION_KEYS = 'ABCDEFGH'

export const UNDERLINE =
  'min-h-12 rounded-none border-0 border-b-2 border-[color-mix(in_srgb,var(--primary)_35%,transparent)] bg-transparent px-0 py-2 text-[1.55rem] leading-snug placeholder:text-[color-mix(in_srgb,var(--ink-2)_70%,transparent)] focus-visible:border-primary focus-visible:outline-none sm:min-h-14 sm:text-[1.9rem] aria-invalid:border-destructive'
export const TITLE =
  'text-[1.55rem] leading-[1.3] font-medium tracking-[-0.01em] text-balance text-foreground sm:text-[1.9rem]'
export const BIG_TITLE =
  'text-[2.1rem] leading-[1.15] font-semibold tracking-[-0.015em] text-balance text-foreground sm:text-[2.6rem]'
export const HELP = 'max-w-[56ch] text-[1.05rem] text-muted-foreground'
const NAV_BUTTON =
  'grid h-10 w-11 cursor-pointer place-items-center bg-primary text-primary-foreground transition-opacity disabled:cursor-default disabled:opacity-40'

/**
 * Enter moves on (not in a text box where Enter makes a new line, nor on a button or link);
 * A to H pick the matching option inside `root`.
 */
export function onboardingKeys(
  event: KeyboardEvent<HTMLDivElement>,
  root: HTMLElement | null,
  next: () => void,
) {
  const target = event.target as HTMLElement
  if (event.key === 'Enter' && !event.shiftKey) {
    if (target.closest('button, a, textarea, [role=checkbox]')) return
    event.preventDefault()
    next()
    return
  }
  if (target.matches('input, textarea') || event.metaKey || event.ctrlKey || event.altKey) return
  const at = OPTION_KEYS.indexOf(event.key.toUpperCase())
  if (event.key.length !== 1 || at < 0) return
  const option = root?.querySelectorAll<HTMLButtonElement>('[data-option]')[at]
  if (option) {
    event.preventDefault()
    option.click()
  }
}

export function OnboardingFrame({
  label,
  progress,
  count,
  stepKey,
  direction,
  contentRef,
  onKeyDown,
  onPrevious,
  onNext,
  previousDisabled,
  nextDisabled,
  showNav,
  children,
}: {
  /** The region's name for screen readers. */
  label: string
  /** 0 to 100. */
  progress: number
  /** "Question 3 of 8", "Done" or nothing. */
  count: string
  /** Changes with every screen, so the new one animates in. */
  stepKey: string
  direction: 'in' | 'back'
  contentRef: Ref<HTMLDivElement>
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  onPrevious: () => void
  onNext: () => void
  previousDisabled: boolean
  nextDisabled: boolean
  showNav: boolean
  children: ReactNode
}) {
  const t = useTranslations('Onboarding')
  return (
    <div
      className="relative flex min-h-dvh flex-col bg-background"
      onKeyDown={onKeyDown}
      aria-label={label}
      role="region"
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-1.5 bg-[color-mix(in_srgb,var(--primary)_16%,transparent)]"
      >
        <i
          className="block h-full bg-data transition-[width] duration-350 ease-out motion-reduce:transition-none"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex items-center justify-between gap-3 px-4 pt-[18px] sm:px-8 sm:pt-[22px]">
        <Link href="/" className="inline-flex min-h-11 items-center rounded-full no-underline">
          <Brand className="text-foreground" />
        </Link>
        <span
          aria-live="polite"
          className="text-[0.88rem] text-muted-foreground [font-variant-numeric:tabular-nums]"
        >
          {count}
        </span>
      </div>

      <main
        id="main"
        className="grid flex-1 items-center px-4 pt-7 pb-24 sm:px-8 sm:pt-10 sm:pb-[104px]"
      >
        <div
          key={stepKey}
          ref={contentRef}
          tabIndex={-1}
          className={cn(
            'mx-auto grid w-full max-w-[680px] gap-5 outline-none',
            'animate-in fade-in duration-400 ease-out motion-reduce:animate-none',
            direction === 'in' ? 'slide-in-from-bottom-7' : 'slide-in-from-top-7',
          )}
        >
          {children}
        </div>
      </main>

      {showNav && (
        <div className="absolute right-4 bottom-4 flex gap-0.5 sm:right-7 sm:bottom-6">
          <button
            type="button"
            onClick={onPrevious}
            disabled={previousDisabled}
            aria-label={t('previous')}
            className={cn(NAV_BUTTON, 'rounded-l-full')}
          >
            <ChevronUpIcon aria-hidden="true" className="size-[18px]" strokeWidth={2.4} />
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={nextDisabled}
            aria-label={t('next')}
            className={cn(NAV_BUTTON, 'rounded-r-full')}
          >
            <ChevronDownIcon aria-hidden="true" className="size-[18px]" strokeWidth={2.4} />
          </button>
        </div>
      )}
    </div>
  )
}

/** The numbered question title ("3 →  What is …"). */
export function QuestionTitle({
  id,
  number,
  children,
}: {
  id: string
  number: number
  children: ReactNode
}) {
  return (
    <h2 id={id} className={TITLE}>
      <span
        aria-hidden="true"
        className="mr-2.5 inline-flex items-center gap-1 align-[0.25em] text-base font-semibold text-primary"
      >
        {number}
        <ArrowRightIcon aria-hidden="true" className="size-3.5" />
      </span>
      {children}
    </h2>
  )
}

/** Pill options with A to H keys. Each works as a toggle button (`aria-pressed`). */
export function OptionList({
  items,
  selected,
  onPick,
  labelledBy,
  describedBy,
  columns = false,
}: {
  items: { value: string; label: string }[]
  selected: (value: string) => boolean
  onPick: (value: string) => void
  labelledBy: string
  describedBy?: string
  columns?: boolean
}) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy || undefined}
      className={cn('grid max-w-[440px] gap-2', columns && 'sm:max-w-[620px] sm:grid-cols-2')}
    >
      {items.map((item, i) => (
        <button
          key={item.value}
          type="button"
          data-option
          aria-pressed={selected(item.value)}
          onClick={() => onPick(item.value)}
          className="group flex min-h-12 cursor-pointer items-center gap-3 rounded-full border border-[color-mix(in_srgb,var(--primary)_45%,transparent)] bg-[color-mix(in_srgb,var(--primary)_7%,var(--surface))] py-2 pr-[18px] pl-2.5 text-left text-[1.05rem] leading-snug font-medium text-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--primary)_15%,var(--surface))] aria-pressed:border-primary aria-pressed:bg-[color-mix(in_srgb,var(--primary)_14%,var(--surface))] aria-pressed:shadow-[inset_0_0_0_1px_var(--primary)]"
        >
          <kbd
            aria-hidden="true"
            className="inline-grid h-7 min-w-7 shrink-0 place-items-center rounded-full border border-[color-mix(in_srgb,var(--primary)_55%,transparent)] bg-surface px-1.5 font-sans text-[0.8rem] font-semibold text-primary group-aria-pressed:border-primary group-aria-pressed:bg-primary group-aria-pressed:text-primary-foreground"
          >
            {OPTION_KEYS[i]}
          </kbd>
          <span className="min-w-0 flex-1">{item.label}</span>
          <CheckIcon
            aria-hidden="true"
            className="size-[18px] shrink-0 text-primary opacity-0 group-aria-pressed:opacity-100"
          />
        </button>
      ))}
    </div>
  )
}

export function EnterHint() {
  const t = useTranslations('Onboarding')
  return (
    <span className="hidden text-[0.85rem] text-muted-foreground sm:inline">
      {t.rich('pressEnter', { b: (c) => <b>{c}</b> })}
    </span>
  )
}
