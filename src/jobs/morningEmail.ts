import type { TaskConfig } from 'payload'

import { sendMorningEmails } from '@/lib/team/morningEmail'

import { MAINTENANCE_QUEUE } from './removeUnusedFiles'

/**
 * The team's morning email (lib/team/morningEmail.ts). Queued every 15 minutes; the work itself
 * only happens on working days in Oslo from 07:30, once per team member and day, so the time
 * zone of the server does not matter. The output holds a count only.
 */
export const teamMorningEmailTask: TaskConfig<{
  input: Record<string, never>
  output: { sent: number }
}> = {
  slug: 'teamMorningEmail',
  label: 'Team morning email',
  schedule: [{ cron: '*/15 * * * *', queue: MAINTENANCE_QUEUE }],
  retries: 1,
  outputSchema: [{ name: 'sent', type: 'number', required: true }],
  handler: async ({ req }) => ({ output: { sent: await sendMorningEmails(req.payload) } }),
}
