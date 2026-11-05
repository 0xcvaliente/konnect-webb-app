import { postgresAdapter } from '@payloadcms/db-postgres'
import path from 'path'
import { buildConfig } from 'payload'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

import { ActivityLogs } from './collections/ActivityLogs'
import { Applications } from './collections/Applications'
import { Companies } from './collections/Companies'
import { Deliverables } from './collections/Deliverables'
import { Matches } from './collections/Matches'
import { Payments } from './collections/Payments'
import { Projects } from './collections/Projects'
import { StudentProfiles } from './collections/StudentProfiles'
import { Users } from './collections/Users'

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
  ],
  secret: process.env.PAYLOAD_SECRET ?? '',
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
