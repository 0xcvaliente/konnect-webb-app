import type { TaskConfig } from 'payload'

import { removeUnusedFiles } from '@/lib/uploads/unused'

/** The queue for Konnected's own housekeeping jobs. */
export const MAINTENANCE_QUEUE = 'maintenance'

/**
 * Every night at 03:15 (server time), remove uploaded files nothing has used for 7 days. The
 * scheduler in payload.config.ts queues and runs it in the app's own process; no outside cron is
 * needed. The output holds counts only.
 */
export const removeUnusedFilesTask: TaskConfig<{
  input: Record<string, never>
  output: { cvs: number; briefFiles: number; deliverableFiles: number; companyLogos: number }
}> = {
  slug: 'removeUnusedFiles',
  label: 'Remove unused files',
  schedule: [{ cron: '15 3 * * *', queue: MAINTENANCE_QUEUE }],
  retries: 2,
  outputSchema: [
    { name: 'cvs', type: 'number', required: true },
    { name: 'briefFiles', type: 'number', required: true },
    { name: 'deliverableFiles', type: 'number', required: true },
    { name: 'companyLogos', type: 'number', required: true },
  ],
  handler: async ({ req }) => {
    const removed = await removeUnusedFiles(req)
    return {
      output: {
        cvs: removed.cvs,
        briefFiles: removed['brief-files'],
        deliverableFiles: removed['deliverable-files'],
        companyLogos: removed['company-logos'],
      },
    }
  },
}
