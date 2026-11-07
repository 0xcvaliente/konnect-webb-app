import { postgresAdapter } from '@payloadcms/db-postgres'
import { en } from '@payloadcms/translations/languages/en'
import { nb } from '@payloadcms/translations/languages/nb'
import path from 'path'
import { buildConfig } from 'payload'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

import { ActivityLogs } from './collections/ActivityLogs'
import { AgreementPdfs } from './collections/AgreementPdfs'
import { Agreements } from './collections/Agreements'
import { AgreementTemplates } from './collections/AgreementTemplates'
import { Applications } from './collections/Applications'
import { BriefFiles } from './collections/BriefFiles'
import { Companies } from './collections/Companies'
import { CompanyLogos } from './collections/CompanyLogos'
import { Cvs } from './collections/Cvs'
import { DeliverableFiles } from './collections/DeliverableFiles'
import { Deliverables } from './collections/Deliverables'
import { Feedback } from './collections/Feedback'
import { MagicLinks } from './collections/MagicLinks'
import { Matches } from './collections/Matches'
import { Payments } from './collections/Payments'
import { ProblemReports } from './collections/ProblemReports'
import { Projects } from './collections/Projects'
import { Questions } from './collections/Questions'
import { SavedAnswers } from './collections/SavedAnswers'
import { Signatures } from './collections/Signatures'
import { StudentProfiles } from './collections/StudentProfiles'
import { TeamMembers } from './collections/TeamMembers'
import { Users } from './collections/Users'
import { isAdmin } from './access/roles'
import { AGREEMENTS_QUEUE, generateAgreementTask, sendAgreementEmailTask } from './jobs/agreements'
import { decisionReminderTask } from './jobs/decisionReminder'
import { acceptDueDeliverablesTask } from './jobs/deliverables'
import { teamMorningEmailTask } from './jobs/morningEmail'
import { questionReminderTask } from './jobs/questionReminder'
import { MAINTENANCE_QUEUE, removeUnusedFilesTask } from './jobs/removeUnusedFiles'
import { emailAdapter } from './lib/email/adapter'
import { MAX_UPLOAD_BYTES, MB } from './lib/uploads/fileRules'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// CMS collections (pages, news, FAQ) are not built: the public site is out of version 1.
export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [
    Users,
    StudentProfiles,
    Companies,
    Projects,
    Applications,
    Matches,
    Deliverables,
    Cvs,
    DeliverableFiles,
    BriefFiles,
    CompanyLogos,
    AgreementTemplates,
    Agreements,
    Signatures,
    AgreementPdfs,
    Payments,
    ProblemReports,
    Questions,
    SavedAnswers,
    Feedback,
    TeamMembers,
    ActivityLogs,
    MagicLinks,
  ],
  // Content that differs per language (none yet) is stored per locale, with English as fallback.
  localization: {
    locales: [
      { code: 'en', label: 'English' },
      { code: 'no', label: 'Norsk' },
    ],
    defaultLocale: 'en',
    fallback: true,
  },
  // The admin panel in English or Norwegian (bokmål).
  i18n: {
    supportedLanguages: { en, nb },
    fallbackLanguage: 'en',
  },
  email: emailAdapter(),
  // Background jobs: the nightly clean-up of unused files, the hourly acceptance of released work
  // whose 7 days for fixes are over, and the agreement work (making the PDF with Gotenberg, the
  // agreement emails). In development the app itself queues any job that
  // is due once an hour and runs the maintenance queue, and runs the agreements queue every 5
  // seconds (see instrumentation.ts). In production (docker-compose.prod.yml) RUN_JOBS_IN_APP=false
  // turns that off, because two app containers run side by side during a deploy; the single
  // `worker` container runs `payload jobs:run --cron ... --all-queues --handle-schedules` instead,
  // which covers both queues.
  // Only admins may queue, run or cancel jobs through the API; the jobs collection itself stays
  // closed (Payload's default).
  jobs: {
    tasks: [
      removeUnusedFilesTask,
      generateAgreementTask,
      sendAgreementEmailTask,
      acceptDueDeliverablesTask,
      teamMorningEmailTask,
      decisionReminderTask,
      questionReminderTask,
    ],
    autoRun:
      process.env.RUN_JOBS_IN_APP === 'false'
        ? []
        : [
            { cron: '0 * * * *', queue: MAINTENANCE_QUEUE },
            { cron: '*/5 * * * * *', queue: AGREEMENTS_QUEUE, disableScheduling: true },
          ],
    deleteJobOnComplete: true,
    access: {
      cancel: ({ req }) => isAdmin(req.user),
      queue: ({ req }) => isAdmin(req.user),
      run: ({ req }) => isAdmin(req.user),
    },
  },
  // Uploads: the parser stops any file above the largest per-collection limit (deliverable files,
  // 50 MB) and any request above that plus room for the form fields. Each collection then checks
  // its own, smaller limit (see lib/uploads/fileRules.ts).
  upload: {
    abortOnLimit: true,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    requestSizeLimit: MAX_UPLOAD_BYTES + MB,
  },
  // Production: never log secrets or personal data, even when a library passes them to the
  // logger (SMTP errors carry recipient addresses). Development keeps Payload's readable logs.
  logger:
    process.env.NODE_ENV === 'production'
      ? {
          options: {
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                '*.headers.authorization',
                '*.headers.cookie',
                '*.password',
                '*.token',
                '*.email',
                'email',
                'to',
                '*.to',
                'err.rejected',
                'err.rejectedErrors',
                'err.response',
              ],
              censor: '[hidden]',
            },
          },
        }
      : undefined,
  secret: process.env.PAYLOAD_SECRET ?? '',
  // Cookie-authenticated requests are accepted only from our own site.
  csrf: process.env.APP_URL ? [process.env.APP_URL.replace(/\/+$/, '')] : [],
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL ?? '',
    },
    migrationDir: path.resolve(dirname, 'migrations'),
    // Schema changes go through committed migrations everywhere: development, tests and
    // production. Never mix schema push and migrations on one database.
    push: false,
  }),
  sharp,
})
