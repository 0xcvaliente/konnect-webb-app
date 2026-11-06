import { type Payload, ValidationError } from 'payload'

import { isStudent, relationId } from '@/access/roles'
import type { StudentProfile, User } from '@/payload-types'

import {
  EMAIL_PATTERN,
  INTEREST_KEYS,
  LIMITS,
  PROFILE_FIELDS,
  type ProfileField,
  PROJECT_TYPE_KEYS,
  type ProfileFieldErrors,
  type ProfileFormState,
  SHARE_KEYS,
  splitSkills,
  YEARS,
} from './fields'

/**
 * The student's own profile: the onboarding, edits, sharing choices and the CV. Plain functions
 * over Payload so they can be tested without a request; the Server Actions in actions.ts call them
 * with the signed-in user.
 *
 * Every write goes through the Local API as that user with `overrideAccess: false`, so the
 * collection's access rules and hooks decide: only a student, only their own profile, never the
 * review status, and only a CV the student uploaded. The checks here come first only to give
 * clear answers. Nothing here logs form values.
 */

export type SessionUser = User & { collection: 'users' }

type Result = ProfileFormState

const ok = (): Result => ({ status: 'done', savedAt: Date.now() })
const fail = (error: NonNullable<Result['error']>): Result => ({ status: 'error', error })
const invalid = (fields: ProfileFieldErrors): Result => ({ status: 'error', fields })

const text = (form: FormData, name: string): string => {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/** Several values with one name (checkbox groups), kept only when they are on the list. */
const picks = <T extends string>(form: FormData, name: string, allowed: readonly T[]): T[] => {
  const values = form.getAll(name).filter((v): v is string => typeof v === 'string')
  return allowed.filter((key) => values.includes(key))
}

const PHONE = /^\+?[0-9 ()-]{5,}$/

type About = Pick<
  StudentProfile,
  'name' | 'school' | 'programme' | 'year' | 'pitch' | 'skills' | 'interests'
> &
  Pick<StudentProfile, 'preferredProjectTypes'>

type Details = Pick<StudentProfile, 'experience' | 'highlights' | 'contactEmail' | 'phone'>

/** The questions both the onboarding and the profile page ask. */
function readAbout(form: FormData, errors: ProfileFieldErrors): About {
  const required = (name: 'name' | 'school' | 'programme', max: number) => {
    const value = text(form, name)
    if (!value) errors[name] = 'required'
    else if (value.length > max) errors[name] = 'too_long'
    return value
  }
  const name = required('name', LIMITS.name)
  const school = required('school', LIMITS.school)
  const programme = required('programme', LIMITS.programme)

  const yearText = text(form, 'year')
  const year = Number(yearText)
  if (!yearText) errors.year = 'required'
  else if (!(YEARS as readonly number[]).includes(year)) errors.year = 'invalid'

  const pitch = text(form, 'pitch')
  if (pitch.length > LIMITS.pitch) errors.pitch = 'too_long'

  const skills = splitSkills(text(form, 'skills'))
  if (skills.length > LIMITS.skills) errors.skills = 'too_many'
  else if (skills.some((s) => s.length > LIMITS.skill)) errors.skills = 'too_long'

  const interests = picks(form, 'interests', INTEREST_KEYS)
  if (!interests.length) errors.interests = 'required'

  const preferredProjectTypes = picks(form, 'preferredProjectTypes', PROJECT_TYPE_KEYS)

  return {
    name,
    school,
    programme,
    year,
    pitch: pitch || null,
    skills,
    interests,
    preferredProjectTypes,
  }
}

/** The extra details only the profile page asks for. All optional. */
function readDetails(form: FormData, errors: ProfileFieldErrors): Details {
  const optional = (name: 'experience' | 'highlights' | 'phone' | 'contactEmail', max: number) => {
    const value = text(form, name)
    if (value.length > max) errors[name] = 'too_long'
    return value
  }
  const experience = optional('experience', LIMITS.experience)
  const highlights = optional('highlights', LIMITS.highlights)
  const contactEmail = optional('contactEmail', LIMITS.contactEmail)
  if (contactEmail && !errors.contactEmail && !EMAIL_PATTERN.test(contactEmail)) {
    errors.contactEmail = 'invalid'
  }
  const phone = optional('phone', LIMITS.phone)
  if (phone && !errors.phone && !PHONE.test(phone)) errors.phone = 'invalid'
  return {
    experience: experience || null,
    highlights: highlights || null,
    contactEmail: contactEmail || null,
    phone: phone || null,
  }
}

/** Ticked boxes are sent as "on". Anything not ticked is off. */
const readPrivacy = (form: FormData): NonNullable<StudentProfile['privacy']> =>
  Object.fromEntries(SHARE_KEYS.map((key) => [key, form.get(key) === 'on']))

/** A CV id from the form: a positive whole number, `null` for none, or `undefined` if invalid. */
function readCvId(form: FormData): number | null | undefined {
  const value = text(form, 'cv')
  if (!value || value === 'none') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : undefined
}

/** The signed-in student's own profile, read as that student. */
export async function findOwnProfile(
  payload: Payload,
  user: SessionUser,
  depth = 0,
): Promise<StudentProfile | null> {
  const found = await payload.find({
    collection: 'student-profiles',
    where: { user: { equals: user.id } },
    limit: 1,
    depth,
    user,
    overrideAccess: false,
  })
  return found.docs[0] ?? null
}

/** Payload's error for a CV that is not the student's own, or a duplicate profile. */
const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined

/** True when Postgres refused a second profile for the same user (unique index on `user`). */
const isDuplicate = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if ((current as { code?: unknown }).code === '23505') return true
    const { message } = current as { message?: unknown }
    if (typeof message === 'string' && /unique|already|duplicate/i.test(message)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

const isProfileField = (path: string): path is ProfileField =>
  (PROFILE_FIELDS as readonly string[]).includes(path)

/**
 * A save Payload refused, as an answer for the page. A Server Action that throws sends the student
 * to an error page and loses every unsaved edit, so it never does: a ValidationError on a form
 * field marks that field, anything else is a general error. The log line has no form values.
 */
function refused(payload: Payload, error: unknown): Result {
  if (error instanceof ValidationError) {
    const fields: ProfileFieldErrors = {}
    for (const { path } of error.data.errors) if (isProfileField(path)) fields[path] = 'invalid'
    if (Object.keys(fields).length) return invalid(fields)
  }
  payload.logger.error({
    msg: 'Student profile save failed',
    reason: error instanceof Error ? error.name : 'unknown',
  })
  return fail('generic')
}

/** Remove a CV the student no longer uses. Best effort: the daily clean-up catches the rest. */
async function removeOldCv(payload: Payload, user: SessionUser, id: number | undefined) {
  if (!id) return
  try {
    await payload.delete({ collection: 'cvs', id, user, overrideAccess: false })
  } catch {
    // Not removable now (for example still kept on a match). The clean-up job handles it.
  }
}

/**
 * The onboarding's last step: create the profile with every answer and the sharing choices.
 * Only a student without a profile can do this, once. The profile starts waiting for review.
 */
export async function completeOnboarding(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<Result> {
  if (!user || !isStudent(user)) return fail('forbidden')

  const errors: ProfileFieldErrors = {}
  const about = readAbout(form, errors)
  const cv = readCvId(form)
  if (cv === undefined) errors.cv = 'invalid'
  if (Object.keys(errors).length) return invalid(errors)

  if (await findOwnProfile(payload, user)) return fail('exists')

  try {
    await payload.create({
      collection: 'student-profiles',
      data: { ...about, cv, privacy: readPrivacy(form), user: user.id },
      user,
      overrideAccess: false,
    })
  } catch (error) {
    if (statusOf(error) === 403 && cv) return invalid({ cv: 'invalid' })
    if (isDuplicate(error)) return fail('exists')
    return refused(payload, error)
  }
  return ok()
}

/** Save the profile page's "About you" form. Never touches the CV, sharing or review. */
export async function saveProfile(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<Result> {
  if (!user || !isStudent(user)) return fail('forbidden')
  const errors: ProfileFieldErrors = {}
  const about = readAbout(form, errors)
  const details = readDetails(form, errors)
  if (Object.keys(errors).length) return invalid(errors)

  const profile = await findOwnProfile(payload, user)
  if (!profile) return fail('no_profile')
  try {
    await payload.update({
      collection: 'student-profiles',
      id: profile.id,
      data: { ...about, ...details },
      user,
      overrideAccess: false,
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

/** Save what the student agrees to share after selection. Unticked means not shared. */
export async function savePrivacy(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<Result> {
  if (!user || !isStudent(user)) return fail('forbidden')
  const profile = await findOwnProfile(payload, user)
  if (!profile) return fail('no_profile')
  try {
    await payload.update({
      collection: 'student-profiles',
      id: profile.id,
      data: { privacy: readPrivacy(form) },
      user,
      overrideAccess: false,
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

/**
 * Put a CV the student just uploaded on their profile, or take the CV off (`cv=none`). The CV
 * that was there before is deleted, so an old CV does not linger.
 */
export async function setCv(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<Result> {
  if (!user || !isStudent(user)) return fail('forbidden')
  const cv = readCvId(form)
  if (cv === undefined) return invalid({ cv: 'invalid' })
  const profile = await findOwnProfile(payload, user)
  if (!profile) return fail('no_profile')
  const previous = relationId(profile.cv)
  if (previous === (cv ?? undefined)) return ok()

  try {
    await payload.update({
      collection: 'student-profiles',
      id: profile.id,
      data: { cv },
      user,
      overrideAccess: false,
    })
  } catch (error) {
    if (statusOf(error) === 403) return invalid({ cv: 'invalid' })
    return refused(payload, error)
  }
  await removeOldCv(payload, user, previous)
  return ok()
}
