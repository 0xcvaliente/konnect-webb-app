import { APIError, type CollectionConfig, type PayloadRequest } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { isAdmin, relationId } from '@/access/roles'
import { writeActivity } from '@/hooks/logActivity'
import { storedToDay } from '@/lib/projects/fields'
import { AWAY_MAX_DAYS } from '@/lib/team/memberFields'
import { addDays } from '@/lib/workingDays'

/** The user must be on the team: role admin and on the ADMIN_EMAILS list. */
async function assertTeamUser(req: PayloadRequest, id: number | undefined, what: string) {
  if (!id) return
  // Bypass: the server reads the user's role and address to check that they are on the team.
  // Only the role and the address are used, and only admins reach this hook.
  const user = await req.payload.findByID({
    collection: 'users',
    id,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!user || user.role !== 'admin' || !isAdminEmail(user.email)) {
    throw new APIError(`Team member: ${what} is not on the team`, 400)
  }
}

/**
 * The Konnected team's own settings, one row per team member (Kanban cards "Team split" and
 * "Team page: workload, owners and away cover"): the days a member is away and who covers for
 * them, and the day their morning email last went out.
 *
 * Only the team reads or writes these rows; students and companies never can, through any API.
 * Every team member may change every row (ownership and cover route the work, they never limit
 * access). A change of away dates or cover is written to the activity log.
 */
export const TeamMembers: CollectionConfig = {
  slug: 'team-members',
  admin: { useAsTitle: 'id', defaultColumns: ['user', 'awayFrom', 'awayUntil', 'coveredBy'] },
  access: {
    read: ({ req: { user } }) => isAdmin(user),
    create: ({ req: { user } }) => isAdmin(user),
    update: ({ req: { user } }) => isAdmin(user),
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        const userId = relationId(data.user ?? originalDoc?.user)
        if (operation === 'update' && relationId(data.user) !== relationId(originalDoc?.user)) {
          if (data.user !== undefined) {
            throw new APIError('Team member: the user cannot change', 400)
          }
        }
        if (operation === 'create') await assertTeamUser(req, userId, 'the user')

        const from = storedToDay(
          data.awayFrom === undefined ? originalDoc?.awayFrom : data.awayFrom,
        )
        const until = storedToDay(
          data.awayUntil === undefined ? originalDoc?.awayUntil : data.awayUntil,
        )
        const cover = relationId(
          data.coveredBy === undefined ? originalDoc?.coveredBy : data.coveredBy,
        )
        // Away dates come as a pair, the last day not before the first, and not for ever.
        if (Boolean(from) !== Boolean(until)) {
          throw new APIError('Team member: give both the first and the last day away', 400)
        }
        if (from && until) {
          if (until < from) throw new APIError('Team member: the last day is before the first', 400)
          if (until > addDays(from, AWAY_MAX_DAYS)) {
            throw new APIError('Team member: away for at most 90 days at a time', 400)
          }
        }
        if (!from && cover) data.coveredBy = null
        if (cover && cover === userId) {
          throw new APIError('Team member: someone else must cover', 400)
        }
        if (cover && relationId(data.coveredBy) !== relationId(originalDoc?.coveredBy)) {
          await assertTeamUser(req, cover, 'the cover')
        }
        return data
      },
    ],
    afterChange: [
      async ({ doc, previousDoc, operation, req, context }) => {
        if (context?.skipActivityLog) return doc
        const key = (d: typeof doc | undefined) =>
          [storedToDay(d?.awayFrom), storedToDay(d?.awayUntil), relationId(d?.coveredBy)].join('|')
        if (operation === 'create' ? !doc.awayFrom : key(doc) === key(previousDoc)) return doc
        // Only days and a user id: no notes, nothing personal beyond who covers.
        await writeActivity(req, {
          action: 'away_change',
          targetCollection: 'team-members',
          targetId: String(doc.id),
          field: 'away',
          fromStatus:
            previousDoc?.awayFrom && operation === 'update'
              ? `${storedToDay(previousDoc.awayFrom)}..${storedToDay(previousDoc.awayUntil)}`
              : undefined,
          toStatus: doc.awayFrom
            ? `${storedToDay(doc.awayFrom)}..${storedToDay(doc.awayUntil)}`
            : undefined,
        })
        return doc
      },
    ],
  },
  fields: [
    {
      // The team member (a user with the admin role, on ADMIN_EMAILS). One row each.
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      unique: true,
      index: true,
    },
    // The first and the last day away (Oslo days, both included). Empty when not away.
    { name: 'awayFrom', label: 'Away from', type: 'date' },
    { name: 'awayUntil', label: 'Away until', type: 'date' },
    {
      // Who covers while the member is away: the member's new items show on the cover's list.
      name: 'coveredBy',
      label: 'Covered by',
      type: 'relationship',
      relationTo: 'users',
      index: true,
    },
    {
      // The Oslo day the member's morning email last went out (`YYYY-MM-DD`), so a day never
      // gets two. Written by the morning email job only.
      name: 'morningEmailOn',
      type: 'text',
      admin: { readOnly: true },
    },
  ],
}
