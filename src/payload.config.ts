import { postgresAdapter } from '@payloadcms/db-postgres'
import { en } from '@payloadcms/translations/languages/en'
import { nb } from '@payloadcms/translations/languages/nb'
import path from 'path'
import { buildConfig } from 'payload'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

import { ActivityLogs } from './collections/ActivityLogs'
import { Applications } from './collections/Applications'
import { Companies } from './collections/Companies'
import { Deliverables } from './collections/Deliverables'
import { MagicLinks } from './collections/MagicLinks'
import { Matches } from './collections/Matches'
import { Payments } from './collections/Payments'
import { Projects } from './collections/Projects'
import { StudentProfiles } from './collections/StudentProfiles'
import { Users } from './collections/Users'
import { emailAdapter } from './lib/email/adapter'

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
    Payments,
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
