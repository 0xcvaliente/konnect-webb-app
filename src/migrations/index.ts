import * as migration_20261104_233443_initial from './20261104_233443_initial';
import * as migration_20261105_023035_role_pending from './20261105_023035_role_pending';
import * as migration_20261105_023036_role_pending_default from './20261105_023036_role_pending_default';
import * as migration_20261106_142300_locales from './20261106_142300_locales';
import * as migration_20261106_161202_sign_in_email from './20261106_161202_sign_in_email';
import * as migration_20261106_170956_file_storage from './20261106_170956_file_storage';
import * as migration_20261106_173513_unused_file_jobs from './20261106_173513_unused_file_jobs';
import * as migration_20261106_175329_student_profile_review_and_sharing from './20261106_175329_student_profile_review_and_sharing';
import * as migration_20261106_183900_company_registration from './20261106_183900_company_registration';
import * as migration_20261106_201633_accounts_team_basics from './20261106_201633_accounts_team_basics';

export const migrations = [
  {
    up: migration_20261104_233443_initial.up,
    down: migration_20261104_233443_initial.down,
    name: '20261104_233443_initial',
  },
  {
    up: migration_20261105_023035_role_pending.up,
    down: migration_20261105_023035_role_pending.down,
    name: '20261105_023035_role_pending',
  },
  {
    up: migration_20261105_023036_role_pending_default.up,
    down: migration_20261105_023036_role_pending_default.down,
    name: '20261105_023036_role_pending_default',
  },
  {
    up: migration_20261106_142300_locales.up,
    down: migration_20261106_142300_locales.down,
    name: '20261106_142300_locales',
  },
  {
    up: migration_20261106_161202_sign_in_email.up,
    down: migration_20261106_161202_sign_in_email.down,
    name: '20261106_161202_sign_in_email',
  },
  {
    up: migration_20261106_170956_file_storage.up,
    down: migration_20261106_170956_file_storage.down,
    name: '20261106_170956_file_storage',
  },
  {
    up: migration_20261106_173513_unused_file_jobs.up,
    down: migration_20261106_173513_unused_file_jobs.down,
    name: '20261106_173513_unused_file_jobs',
  },
  {
    up: migration_20261106_175329_student_profile_review_and_sharing.up,
    down: migration_20261106_175329_student_profile_review_and_sharing.down,
    name: '20261106_175329_student_profile_review_and_sharing',
  },
  {
    up: migration_20261106_183900_company_registration.up,
    down: migration_20261106_183900_company_registration.down,
    name: '20261106_183900_company_registration',
  },
  {
    up: migration_20261106_201633_accounts_team_basics.up,
    down: migration_20261106_201633_accounts_team_basics.down,
    name: '20261106_201633_accounts_team_basics'
  },
];
