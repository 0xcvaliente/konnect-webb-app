import * as migration_20261104_233443_initial from './20261104_233443_initial';

export const migrations = [
  {
    up: migration_20261104_233443_initial.up,
    down: migration_20261104_233443_initial.down,
    name: '20261104_233443_initial'
  },
];
