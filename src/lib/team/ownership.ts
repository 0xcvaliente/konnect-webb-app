import type { Payload } from 'payload'

import { isAdmin, relationId } from '@/access/roles'
import { POOL_TAKE } from '@/access/team'

import type { SessionUser } from './approvals'
import {
  isPoolCollection,
  REASSIGN_NOTE_MAX,
  REASSIGN_NOTE_MIN,
  type TeamFormState,
  teamDone,
  teamFail,
} from './memberFields'
import { listTeam } from './members'

/**
 * Who owns the work (Kanban card "Team split: company owners and the shared pool"): take an item
 * from the shared pool, and move a company or a single project to another team member. Ownership
 * decides whose list an item lands on; every team member can still see and do everything, so
 * nothing here is an access rule.
 *
 * Every write goes through the Local API as the team member with `overrideAccess: false`. The
 * collection hooks check that the new owner is on the team and write each change to the activity
 * log with the note, so a reassignment is never silent. Projects follow their company's owner
 * (Companies hook). Nothing here logs the note or a name.
 */

const asActor = (actor: SessionUser) => ({ user: actor, overrideAccess: false as const })

const text = (form: FormData, name: string): string => {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

const idFrom = (form: FormData, name: string): number | undefined => {
  const id = Number(text(form, name))
  return Number.isInteger(id) && id > 0 ? id : undefined
}

/**
 * "Take it": the team member takes a new company, student profile or project from the shared
 * pool (form: `collection`, `id`). Refused when someone on the team took it, or owns it, already;
 * an owner who has left the team does not count, so their work can be taken over. The collection
 * hook checks again under a row lock, so two people pressing at once cannot both get it.
 */
export async function takeFromPool(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<TeamFormState> {
  if (!actor || !isAdmin(actor)) return teamFail('notFound')
  const collection = text(form, 'collection')
  const id = idFrom(form, 'id')
  if (!isPoolCollection(collection) || !id) return teamFail('notFound')
  const doc = (await payload.findByID({
    collection,
    id,
    depth: 0,
    disableErrors: true,
    ...asActor(actor),
  })) as { takenBy?: unknown; teamOwner?: unknown; owner?: unknown } | null
  if (!doc) return teamFail('notFound')
  const team = new Set(((await listTeam(payload, actor)) ?? []).map((m) => m.id))
  const onTeam = (value: unknown) => team.has(relationId(value as number) ?? 0)
  if (onTeam(doc.takenBy) || onTeam(doc.teamOwner) || onTeam(doc.owner)) return teamFail('taken')
  // A company whose owner left the team: the taker becomes its owner (and its projects follow).
  const data =
    collection === 'projects'
      ? { takenBy: actor.id, owner: actor.id }
      : collection === 'companies' && relationId(doc.teamOwner as number)
        ? { takenBy: actor.id, teamOwner: actor.id }
        : { takenBy: actor.id }
  try {
    await payload.update({
      collection,
      id,
      data,
      context: { [POOL_TAKE]: true },
      ...asActor(actor),
    })
    return teamDone()
  } catch (error) {
    // 409: someone else took it a moment earlier (the collection hook checked under a lock).
    return (error as { status?: number }).status === 409 ? teamFail('taken') : teamFail('failed')
  }
}

/** The note that goes with a reassignment, or null when it is missing or too long. */
const noteFrom = (form: FormData): string | null => {
  const note = text(form, 'note')
  return note.length >= REASSIGN_NOTE_MIN && note.length <= REASSIGN_NOTE_MAX ? note : null
}

/**
 * Move a company (with every open project that followed its owner) or one project to another
 * team member (form: `collection` = companies | projects, `id`, `ownerId`, `note`). The note is
 * required: it is kept with the change in the activity log.
 */
export async function reassign(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<TeamFormState> {
  if (!actor || !isAdmin(actor)) return teamFail('notFound')
  const collection = text(form, 'collection')
  const id = idFrom(form, 'id')
  if ((collection !== 'companies' && collection !== 'projects') || !id) {
    return teamFail('notFound')
  }
  const team = (await listTeam(payload, actor)) ?? []
  const ownerId = idFrom(form, 'ownerId')
  if (!ownerId || !team.some((m) => m.id === ownerId)) return teamFail('owner')
  const note = noteFrom(form)
  if (!note) return teamFail('note')
  const field = collection === 'companies' ? 'teamOwner' : 'owner'
  const doc = (await payload.findByID({
    collection,
    id,
    depth: 0,
    disableErrors: true,
    ...asActor(actor),
  })) as Record<string, unknown> | null
  if (!doc) return teamFail('notFound')
  if (relationId(doc[field] as number) === ownerId) return teamDone()
  try {
    await payload.update({
      collection,
      id,
      data: { [field]: ownerId },
      context: { activityNote: note },
      ...asActor(actor),
    })
    return teamDone()
  } catch {
    return teamFail('failed')
  }
}
