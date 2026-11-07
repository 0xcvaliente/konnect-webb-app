import type { Payload, Where } from 'payload'

import { isStudent } from '@/access/roles'
import type { CompanyLogo, Project, User } from '@/payload-types'

import { type BrowseFilters, PAGE_SIZE, SKILL_CHIPS, searchWords, WORKLOADS } from './browseFields'
import { type PayChoice, storedToDay, todayInOslo, type WorkMode } from './fields'

/**
 * The student project list and project page: only published projects whose applications are
 * still open, searched and filtered on the server, a fixed page size, newest first.
 *
 * Every read goes through the Local API as the student with `overrideAccess: false`, so the
 * Projects access rule (students read `published` only) and its field rules (never the price,
 * Konnected's note or the company relation) decide what comes back. The status condition is
 * repeated in the query so the list stays right even for a caller with wider access. Only project
 * fields leave this file: nothing here reads a student, a company record or a brief attachment.
 */

export type SessionUser = User & { collection: 'users' }

/** One project on the list, as a card shows it. Dates are `YYYY-MM-DD`. */
export type ProjectCard = {
  id: number
  title: string
  companyName: string
  logoUrl: string | null
  description: string | null
  skills: string[]
  workloadHours: number | null
  durationWeeks: number | null
  workMode: WorkMode | null
  location: string | null
  paidOrUnpaid: PayChoice | null
  /** What the student is paid, when Konnected has set it. */
  studentPay: number | null
  unpaidBenefit: string | null
  deadline: string | null
}

/** The project page: the card plus the rest of the brief (never the attachments). */
export type ProjectPage = ProjectCard & {
  tasks: string | null
  deliverable: string | null
  startDate: string | null
  /** Applications are open: the deadline is today or later (or not set). */
  open: boolean
}

export type SkillOption = { label: string; count: number }

export type BrowseResult = {
  cards: ProjectCard[]
  totalDocs: number
  totalPages: number
  page: number
  /** The most common skills on open projects, for the skill chips. */
  skills: SkillOption[]
}

const CARD_SELECT = {
  title: true,
  companyName: true,
  companyLogo: true,
  description: true,
  desiredSkills: true,
  workloadHours: true,
  durationWeeks: true,
  workMode: true,
  location: true,
  paidOrUnpaid: true,
  studentPay: true,
  unpaidBenefit: true,
  deadline: true,
} as const

const PAGE_SELECT = { ...CARD_SELECT, tasks: true, deliverable: true, startDate: true } as const

/** Only the logo's address comes with the project. */
const POPULATE = { 'company-logos': { url: true } } as const

/** Published, and applications close today or later (or no closing day is set). */
const openWhere = (today: string): Where => ({
  and: [
    { status: { equals: 'published' } },
    {
      or: [
        { deadline: { exists: false } },
        // Days are stored at noon UTC; the start of today (UTC) keeps today's projects in.
        { deadline: { greater_than_equal: `${today}T00:00:00.000Z` } },
      ],
    },
  ],
})

const logoUrlOf = (logo: Project['companyLogo']): string | null =>
  typeof logo === 'object' && logo !== null ? ((logo as CompanyLogo).url ?? null) : null

const toCard = (project: Project): ProjectCard => ({
  id: project.id,
  title: project.title,
  companyName: project.companyName ?? '',
  logoUrl: logoUrlOf(project.companyLogo),
  description: project.description ?? null,
  skills: project.desiredSkills ?? [],
  workloadHours: project.workloadHours ?? null,
  durationWeeks: project.durationWeeks ?? null,
  workMode: project.workMode ?? null,
  location: project.location ?? null,
  paidOrUnpaid: project.paidOrUnpaid ?? null,
  studentPay: project.paidOrUnpaid === 'paid' ? (project.studentPay ?? null) : null,
  unpaidBenefit: project.paidOrUnpaid === 'unpaid' ? (project.unpaidBenefit ?? null) : null,
  deadline: storedToDay(project.deadline),
})

/**
 * The skills on open projects, most common first, for the chips. Case is ignored when counting;
 * each skill keeps the spelling most projects use, and remembers every spelling for the filter.
 * Bounded: reads at most 200 projects, only their skills.
 */
async function skillTally(payload: Payload, user: SessionUser, today: string) {
  const found = await payload.find({
    collection: 'projects',
    where: openWhere(today),
    select: { desiredSkills: true },
    sort: '-publishedAt',
    limit: 200,
    depth: 0,
    user,
    overrideAccess: false,
  })
  const tally = new Map<string, { spellings: Map<string, number>; count: number }>()
  for (const project of found.docs) {
    for (const skill of project.desiredSkills ?? []) {
      const key = skill.toLowerCase()
      const entry = tally.get(key) ?? { spellings: new Map(), count: 0 }
      entry.count += 1
      entry.spellings.set(skill, (entry.spellings.get(skill) ?? 0) + 1)
      tally.set(key, entry)
    }
  }
  return tally
}

/** The query for the filters. Exported for the tests. */
export function browseWhere(
  filters: BrowseFilters,
  today: string,
  spellingsOf: (skill: string) => string[] = (skill) => [skill],
): Where {
  const and: Where[] = [openWhere(today)]
  // Every word must appear in the title, the company name, the description or a skill.
  for (const word of searchWords(filters.q)) {
    and.push({
      or: [
        { title: { contains: word } },
        { companyName: { contains: word } },
        { description: { contains: word } },
        { desiredSkills: { contains: word } },
      ],
    })
  }
  // Any of the chosen skills (each in every spelling used on a project).
  if (filters.skills.length) {
    and.push({ desiredSkills: { in: [...new Set(filters.skills.flatMap(spellingsOf))] } })
  }
  if (filters.pay) and.push({ paidOrUnpaid: { equals: filters.pay } })
  if (filters.mode) and.push({ workMode: { equals: filters.mode } })
  if (filters.weeks) and.push({ durationWeeks: { equals: filters.weeks } })
  if (filters.load) {
    const [min, max] = WORKLOADS[filters.load]
    and.push({ workloadHours: { greater_than_equal: min } })
    and.push({ workloadHours: { less_than_equal: max } })
  }
  return { and }
}

/**
 * One page of open projects for the signed-in student. Null for anyone else: companies and
 * signed-out visitors never get the student list.
 */
export async function browseOpenProjects(
  payload: Payload,
  user: SessionUser | null,
  filters: BrowseFilters,
  today: string = todayInOslo(),
): Promise<BrowseResult | null> {
  if (!user || !isStudent(user)) return null

  const tally = await skillTally(payload, user, today)
  const spellingsOf = (skill: string) => [
    skill,
    ...(tally.get(skill.toLowerCase())?.spellings.keys() ?? []),
  ]

  const found = await payload.find({
    collection: 'projects',
    where: browseWhere(filters, today, spellingsOf),
    select: CARD_SELECT,
    populate: POPULATE,
    // Newest first; the id breaks ties so pages never overlap.
    sort: ['-publishedAt', '-id'],
    limit: PAGE_SIZE,
    page: filters.page,
    depth: 1,
    user,
    overrideAccess: false,
  })

  const skills = [...tally.values()]
    .map(({ spellings, count }) => ({
      label: [...spellings.entries()].sort((a, b) => b[1] - a[1])[0]![0],
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, SKILL_CHIPS)

  return {
    cards: found.docs.map((doc) => toCard(doc as Project)),
    totalDocs: found.totalDocs,
    totalPages: found.totalPages,
    page: found.page ?? filters.page,
    skills,
  }
}

/**
 * One published project for the signed-in student, or null (not a student, not published, or no
 * such project). A published project whose applications have closed is still shown, marked
 * closed. Never the attachments: those are for the selected student only.
 */
export async function findProjectForStudent(
  payload: Payload,
  user: SessionUser | null,
  id: number,
  today: string = todayInOslo(),
): Promise<ProjectPage | null> {
  if (!user || !isStudent(user) || !Number.isInteger(id) || id <= 0) return null
  const found = await payload.find({
    collection: 'projects',
    where: { and: [{ id: { equals: id } }, { status: { equals: 'published' } }] },
    select: PAGE_SELECT,
    populate: POPULATE,
    limit: 1,
    depth: 1,
    user,
    overrideAccess: false,
  })
  const project = found.docs[0] as Project | undefined
  if (!project) return null
  const deadline = storedToDay(project.deadline)
  return {
    ...toCard(project),
    tasks: project.tasks ?? null,
    deliverable: project.deliverable ?? null,
    startDate: storedToDay(project.startDate),
    open: !deadline || deadline >= today,
  }
}
