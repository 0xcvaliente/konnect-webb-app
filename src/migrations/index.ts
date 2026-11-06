import * as migration_20261104_233443_initial from './20261104_233443_initial';
import * as migration_20261105_023035_role_pending from './20261105_023035_role_pending';
import * as migration_20261105_023036_role_pending_default from './20261105_023036_role_pending_default';

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
];
