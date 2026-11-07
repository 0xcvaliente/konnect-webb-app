import type { TaskConfig } from 'payload'

import { acceptDueDeliverables } from '@/lib/deliverables/autoAccept'

import { MAINTENANCE_QUEUE } from './removeUnusedFiles'

/**
 * Every hour, record released work whose 7 days for fixes are over as accepted
 * (lib/deliverables/autoAccept.ts). Runs on the maintenance queue, like the nightly clean-up. The
 * output holds a count only.
 */
export const acceptDueDeliverablesTask: TaskConfig<{
  input: Record<string, never>
  output: { accepted: number }
}> = {
  slug: 'acceptDueDeliverables',
  label: 'Accept released work after 7 days',
  schedule: [{ cron: '20 * * * *', queue: MAINTENANCE_QUEUE }],
  retries: 2,
  outputSchema: [{ name: 'accepted', type: 'number', required: true }],
  handler: async ({ req }) => ({
    output: { accepted: await acceptDueDeliverables(req.payload, req) },
  }),
}
