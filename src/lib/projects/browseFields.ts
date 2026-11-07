/**
 * The student project list's search and filters, read from the page's address. Shared by the page
 * (server) and the filter form (client), so nothing here imports server code. Labels live in the
 * message files (StudentProjects).
 *
 * Everything comes from the address bar, so it is read as untrusted text and bounded: a search
 * of at most SEARCH_MAX characters and SEARCH_WORDS words, at most SKILLS_MAX skills, known
 * options only, and a page number within PAGE_MAX.
 */

import {
  DURATION_WEEKS,
  LIMITS,
  PAY_CHOICES,
  type PayChoice,
  WORK_MODES,
  type WorkMode,
} from './fields'

/** Projects per page. Fixed on the server; the address cannot change it. */
export const PAGE_SIZE = 12
export const PAGE_MAX = 500
export const SEARCH_MAX = 80
export const SEARCH_WORDS = 6
export const SKILLS_MAX = 5
/** The skill chips: the most common skills on open projects. */
export const SKILL_CHIPS = 12

/** Workload ranges, in hours (whole numbers, as the project form stores them). */
export const WORKLOADS = {
  upTo20: [LIMITS.hoursMin, 20],
  from21To40: [21, 40],
  from41To80: [41, 80],
  over80: [81, LIMITS.hoursMax],
} as const satisfies Record<string, readonly [number, number]>
export type WorkloadKey = keyof typeof WORKLOADS
export const WORKLOAD_KEYS = Object.keys(WORKLOADS) as WorkloadKey[]

export type BrowseFilters = {
  /** The search as typed (trimmed and bounded). */
  q: string
  skills: string[]
  pay: PayChoice | null
  mode: WorkMode | null
  weeks: (typeof DURATION_WEEKS)[number] | null
  load: WorkloadKey | null
  page: number
}

export const NO_FILTERS: BrowseFilters = {
  q: '',
  skills: [],
  pay: null,
  mode: null,
  weeks: null,
  load: null,
  page: 1,
}

type Params = Record<string, string | string[] | undefined>

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value)?.trim() ?? ''

const all = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((v) => v.trim())

const oneOf = <T extends string | number>(options: readonly T[], value: string): T | null =>
  options.find((option) => String(option) === value) ?? null

/** One skill as typed on a project: single spaces, at most the length a project allows. */
export const cleanSkill = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, LIMITS.skill)

/** Read the address's search parameters. Anything unknown or too long is dropped or cut. */
export function readBrowseParams(params: Params): BrowseFilters {
  const q = first(params.q).replace(/\s+/g, ' ').slice(0, SEARCH_MAX).trim()

  const skills: string[] = []
  for (const raw of all(params.skill)) {
    const skill = cleanSkill(raw)
    if (skill && !skills.some((s) => s.toLowerCase() === skill.toLowerCase())) skills.push(skill)
    if (skills.length === SKILLS_MAX) break
  }

  const pageNumber = Number(first(params.page))
  const page = Number.isInteger(pageNumber) && pageNumber >= 1 ? Math.min(pageNumber, PAGE_MAX) : 1

  return {
    q,
    skills,
    pay: oneOf(PAY_CHOICES, first(params.pay)),
    mode: oneOf(WORK_MODES, first(params.mode)),
    weeks: oneOf(DURATION_WEEKS, first(params.weeks)),
    load: oneOf(WORKLOAD_KEYS, first(params.load)),
    page,
  }
}

/** The filters as an address query (`?q=…&skill=…`), without empty values. */
export function browseQuery(filters: BrowseFilters, page = filters.page): string {
  const out = new URLSearchParams()
  if (filters.q) out.set('q', filters.q)
  for (const skill of filters.skills) out.append('skill', skill)
  if (filters.pay) out.set('pay', filters.pay)
  if (filters.mode) out.set('mode', filters.mode)
  if (filters.weeks) out.set('weeks', String(filters.weeks))
  if (filters.load) out.set('load', filters.load)
  if (page > 1) out.set('page', String(page))
  const text = out.toString()
  return text ? `?${text}` : ''
}

/** Whether any search or filter is on (the empty state then offers to clear them). */
export const hasFilters = (filters: BrowseFilters): boolean =>
  Boolean(
    filters.q ||
    filters.skills.length ||
    filters.pay ||
    filters.mode ||
    filters.weeks ||
    filters.load,
  )

/** The words of a search, for matching: wildcards removed, at most SEARCH_WORDS. */
export const searchWords = (q: string): string[] =>
  q
    .replace(/[%_\\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, SEARCH_WORDS)
