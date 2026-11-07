import type { TaskConfig } from 'payload'

import { sendQuestionReminders } from '@/lib/questions/reminder'

import { MAINTENANCE_QUEUE } from './removeUnusedFiles'

/**
 * The owner's reminder before an Ask Konnected answer is due (lib/questions/reminder.ts). Queued
 * every 15 minutes; the work itself only happens on working days in the Oslo morning, once per
 * question, so the server's time zone does not matter. The output holds a count only.
 */
export const questionReminderTask: TaskConfig<{
  input: Record<string, never>
  output: { sent: number }
}> = {
  slug: 'questionReminder',
  label: 'Ask Konnected reminder to the project owner',
  schedule: [{ cron: '10,25,40,55 * * * *', queue: MAINTENANCE_QUEUE }],
  retries: 1,
  outputSchema: [{ name: 'sent', type: 'number', required: true }],
  handler: async ({ req }) => ({ output: { sent: await sendQuestionReminders(req.payload) } }),
}
