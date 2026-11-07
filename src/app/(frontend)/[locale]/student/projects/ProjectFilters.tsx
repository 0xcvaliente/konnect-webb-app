'use client'

import {
  ChevronDownIcon,
  LoaderCircleIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useRouter } from '@/i18n/navigation'
import {
  type BrowseFilters,
  browseQuery,
  hasFilters,
  NO_FILTERS,
  SEARCH_MAX,
  SKILLS_MAX,
  WORKLOAD_KEYS,
} from '@/lib/projects/browseFields'
import { DURATION_WEEKS, PAY_CHOICES, WORK_MODES } from '@/lib/projects/fields'
import { cn } from '@/lib/utils'

const ALL = 'all'

/**
 * Search and filters for the student project list ("Final pass" mockup, Projects). Everything
 * lives in the address, so the server reads it, a filtered list can be shared or reloaded, and
 * Back works. A change to a chip or a menu shows the new list at once; the search runs on Enter
 * or the Search button. Without JavaScript the form still submits as a plain GET.
 */
export function ProjectFilters({
  filters,
  skillOptions,
}: {
  filters: BrowseFilters
  /** The skill chips: the most common skills on open projects. */
  skillOptions: string[]
}) {
  const t = useTranslations('StudentProjects')
  const tf = useTranslations('ProjectFields')
  const router = useRouter()
  const base = useId()
  const [pending, startTransition] = useTransition()
  // How many filters are on (not the search), for the phone's Filters button.
  const active =
    filters.skills.length +
    [filters.pay, filters.mode, filters.weeks, filters.load].filter(Boolean).length
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState(filters.q)
  // Back, Forward or a link changed the search in the address: show that one.
  const [shownQ, setShownQ] = useState(filters.q)
  if (shownQ !== filters.q) {
    setShownQ(filters.q)
    setQ(filters.q)
  }

  // Chosen skills stay visible as chips even when no open project lists them any more.
  const chips = [
    ...skillOptions,
    ...filters.skills.filter((s) => !skillOptions.some((o) => o.toLowerCase() === s.toLowerCase())),
  ]
  const chosen = (skill: string) =>
    filters.skills.some((s) => s.toLowerCase() === skill.toLowerCase())

  const go = (next: Partial<BrowseFilters>) => {
    // Any change starts again on the first page.
    const query = browseQuery({ ...filters, q, ...next, page: 1 })
    startTransition(() => router.push(`/student/projects${query}`, { scroll: false }))
  }

  const toggleSkill = (skill: string) =>
    go({
      skills: chosen(skill)
        ? filters.skills.filter((s) => s.toLowerCase() !== skill.toLowerCase())
        : [...filters.skills, skill].slice(-SKILLS_MAX),
    })

  const menu = <K extends 'pay' | 'mode' | 'weeks' | 'load'>(
    key: K,
    label: string,
    allLabel: string,
    options: readonly { value: string; label: string }[],
  ) => (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={`${base}-${key}`}>{label}</Label>
      <Select
        name={key}
        value={filters[key] === null ? ALL : String(filters[key])}
        onValueChange={(value) =>
          go({
            [key]:
              value === ALL ? null : key === 'weeks' ? (Number(value) as never) : (value as never),
          } as Partial<BrowseFilters>)
        }
      >
        <SelectTrigger id={`${base}-${key}`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <form
      role="search"
      method="get"
      aria-label={t('search')}
      aria-busy={pending || undefined}
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        go({ q: q.trim() })
      }}
    >
      <div className="flex gap-2.5">
        <div className="relative min-w-0 flex-1">
          <Label htmlFor={`${base}-q`} className="sr-only">
            {t('search')}
          </Label>
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={`${base}-q`}
            name="q"
            type="search"
            value={q}
            maxLength={SEARCH_MAX}
            onChange={(event) => setQ(event.target.value)}
            placeholder={t('searchPlaceholder')}
            autoComplete="off"
            enterKeyHint="search"
            className="pl-10 placeholder:text-muted-foreground"
          />
        </div>
        <Button type="submit" variant="normal" aria-busy={pending || undefined}>
          {pending ? (
            <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
          ) : null}
          {t('searchButton')}
        </Button>
      </div>

      {/* Phones: the filters fold away so the list starts on the first screen. */}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="w-fit sm:hidden"
        aria-expanded={open}
        aria-controls={`${base}-filters`}
        onClick={() => setOpen((value) => !value)}
      >
        <SlidersHorizontalIcon aria-hidden="true" />
        {active ? t('filtersCount', { count: active }) : t('filters')}
        <ChevronDownIcon
          aria-hidden="true"
          className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-180')}
        />
      </Button>

      <div id={`${base}-filters`} className={cn('gap-5 sm:grid', open ? 'grid' : 'hidden')}>
        {chips.length > 0 && (
          <fieldset className="grid gap-2">
            <legend className="pb-2 text-[0.88rem] font-semibold">{t('skills')}</legend>
            <div className="flex flex-wrap gap-2">
              {chips.map((skill) => {
                const on = chosen(skill)
                return (
                  <label
                    key={skill}
                    className={cn(
                      'inline-flex min-h-11 max-w-full cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-line bg-surface px-4 text-[0.88rem] font-medium has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-2 sm:min-h-9',
                      on && 'border-transparent bg-tint text-tint-foreground',
                    )}
                  >
                    <input
                      type="checkbox"
                      name="skill"
                      value={skill}
                      checked={on}
                      onChange={() => toggleSkill(skill)}
                      className="sr-only"
                    />
                    <span className="truncate">{skill}</span>
                    {on && <XIcon aria-hidden="true" className="size-3.5 shrink-0" />}
                  </label>
                )
              })}
            </div>
          </fieldset>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {menu(
            'pay',
            t('pay'),
            t('payAll'),
            PAY_CHOICES.map((value) => ({ value, label: t(`payOption.${value}`) })),
          )}
          {menu(
            'mode',
            t('mode'),
            t('modeAll'),
            WORK_MODES.map((value) => ({ value, label: t(`modeOption.${value}`) })),
          )}
          {menu(
            'weeks',
            t('weeks'),
            t('weeksAll'),
            DURATION_WEEKS.map((value) => ({
              value: String(value),
              label: tf('weeks', { count: value }),
            })),
          )}
          {menu(
            'load',
            t('load'),
            t('loadAll'),
            WORKLOAD_KEYS.map((value) => ({ value, label: t(`loadOption.${value}`) })),
          )}
        </div>
      </div>

      {hasFilters(filters) && (
        <div>
          <Button
            type="button"
            variant="text"
            size="sm"
            className="px-0"
            onClick={() => {
              setQ('')
              startTransition(() =>
                router.push(`/student/projects${browseQuery(NO_FILTERS)}`, { scroll: false }),
              )
            }}
          >
            <XIcon aria-hidden="true" />
            {t('clear')}
          </Button>
        </div>
      )}
    </form>
  )
}
