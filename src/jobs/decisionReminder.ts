import type { TaskConfig } from 'payload'

import { sendDecisionReminders } from '@/lib/team/decisionReminder'

import { MAINTENANCE_QUEUE } from './removeUnusedFiles'

/**
 * The owner's reminder before a decision is due (lib/team/decisionReminder.ts). Queued every 15
 * minutes; the work itself only happens on working days in the Oslo morning, once per project and
 * decision day, so the server's time zone does not matter. The output holds a count only.
 */
export const decisionReminderTask: TaskConfig<{
  input: Record<string, never>
  output: { sent: number }
}> = {
  slug: 'decisionReminder',
  label: 'Decision reminder to the project owner',
  schedule: [{ cron: '5,20,35,50 * * * *', queue: MAINTENANCE_QUEUE }],
  retries: 1,
  outputSchema: [{ name: 'sent', type: 'number', required: true }],
  handler: async ({ req }) => ({ output: { sent: await sendDecisionReminders(req.payload) } }),
}
