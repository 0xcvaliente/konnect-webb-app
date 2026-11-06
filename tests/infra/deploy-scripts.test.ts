import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

/**
 * scripts/deploy/deploy.sh and restore-test.sh, run for real by bash against a fake `docker`
 * (tests/helpers/fake-docker.mjs) that models the containers, Caddy's pool and the answers of
 * PostgreSQL. No Docker needed, so this runs in CI.
 */

const repo = path.resolve(__dirname, '../..')
const project = 'konnected-scripttest'

interface FakeState {
  calls: string[][]
  violations: string[]
  containers: {
    id: string
    status: string
    networks: string[]
    aliases?: string[]
    seenHealth?: string
  }[]
  pgbackrest?: string[][]
  restoreRun?: string[]
}

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function runScript(script: string, args: string[], initial: object, env: Record<string, string>) {
  dir = mkdtempSync(path.join(os.tmpdir(), 'konnected-scripts-'))
  const bin = path.join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, 'tests/helpers/fake-docker.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  const stateFile = path.join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify(initial))
  const envFile = path.join(dir, 'settings')
  writeFileSync(envFile, 'POSTGRES_DB=konnected\nPOSTGRES_USER=konnected\n')

  const result = spawnSync('bash', [path.join(repo, 'scripts/deploy', script), ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      NODE_ENV: 'test',
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      FAKE_DOCKER_STATE: stateFile,
      DEPLOY_DIR: dir,
      ENV_FILE: envFile,
      RELEASE_FILE: path.join(dir, 'release'),
      COMPOSE_PROJECT: project,
      ...env,
    },
  })
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as FakeState
  return { status: result.status, stderr: result.stderr, state }
}

describe('deploy.sh: a new app container gets no traffic before it is healthy', () => {
  const oldApp = { id: 'old1', status: 'running', networks: ['public', 'internal'] }
  const deploy = (newHealth: 'healthy' | 'unhealthy') =>
    runScript(
      'deploy.sh',
      ['konnected-app:v2'],
      { containers: [{ ...oldApp, health: 'healthy', seenHealth: 'healthy' }], newHealth },
      { SKIP_BACKUP: '1', SKIP_MIGRATIONS: '1', DRAIN_SECONDS: '0', HEALTH_TIMEOUT: '10' },
    )

  it('joins Caddy only once healthy, and only then stops the old container', () => {
    const { status, stderr, state } = deploy('healthy')
    expect(status, stderr).toBe(0)
    expect(state.violations).toEqual([])

    const [app] = state.containers
    expect(state.containers).toHaveLength(1)
    expect(app?.id).not.toBe('old1')
    expect(app).toMatchObject({ status: 'running', aliases: ['app'] })
    expect(app?.networks).toContain('public')

    const at = (pred: (c: string[]) => boolean) => state.calls.findIndex(pred)
    const joined = at((c) => c[0] === 'network' && c[1] === 'connect')
    const oldStopped = at((c) => c[0] === 'stop' && c.includes('old1'))
    expect(joined).toBeGreaterThan(-1)
    expect(oldStopped).toBeGreaterThan(joined)
  })

  it('never puts an unhealthy new container in front of users', () => {
    // An image that starts and listens but answers 503 on /api/health (and 500 on pages).
    const { status, state } = deploy('unhealthy')
    expect(status).not.toBe(0)
    expect(state.violations).toEqual([])
    // Removed; the old container is untouched and still the only one serving.
    expect(state.containers.map((c) => [c.id, c.status])).toEqual([['old1', 'running']])
    expect(state.calls.some((c) => c[0] === 'stop')).toBe(false)
  })
})

describe('restore-test.sh: passes only when the backup holds everything up to now', () => {
  const live = 'payload_migrations 12\nprojects 40\nusers 25'
  const restore = (psql: Record<string, string>, env: Record<string, string> = {}) =>
    runScript(
      'restore-test.sh',
      [],
      {
        restoreName: `${project}-restore-test`,
        psql: { liveCounts: live, markerXid: '4294974027 6731', ...psql },
      },
      { SKIP_MEDIA: '1', ...env },
    )

  it('passes when the marker written at the start was restored and nothing is missing', () => {
    const { status, stderr, state } = restore({ restoredCounts: live, markerStatus: 'committed' })
    expect(status, stderr).toBe(0)
    // The marker's WAL is archived before the restore, and the restore stops at the marker.
    expect(state.pgbackrest?.some((a) => a.includes('check'))).toBe(true)
    expect(state.restoreRun).toEqual(
      expect.arrayContaining(['PGBACKREST_TYPE=xid', 'PGBACKREST_TARGET=6731']),
    )
  })

  it('fails when the marker transaction is not in the restored database (WAL gap)', () => {
    // pg_xact_status of an xid replay never reached: "in progress", or an error when the
    // restored database never saw that many transactions.
    for (const markerStatus of ['in progress', 'future']) {
      const { status, stderr } = restore({ restoredCounts: live, markerStatus })
      expect(status, markerStatus).toBe(1)
      expect(stderr).toMatch(/marker/)
    }
  })

  it('fails when the restored database has fewer rows than live had', () => {
    const { status, stderr } = restore({
      restoredCounts: 'payload_migrations 12\nprojects 31\nusers 25',
      markerStatus: 'committed',
    })
    expect(status).toBe(1)
    expect(stderr).toMatch(/fewer rows.*projects/)
  })

  it('tolerates a few rows deleted around the marker', () => {
    const { status, stderr } = restore({
      restoredCounts: 'payload_migrations 12\nprojects 38\nusers 26',
      markerStatus: 'committed',
    })
    expect(status, stderr).toBe(0)
  })

  it('fails when every application table is empty, even within the tolerance', () => {
    const { status, stderr } = restore(
      {
        liveCounts: 'payload_migrations 12\nprojects 3\nusers 2',
        restoredCounts: 'payload_migrations 12\nprojects 0\nusers 0',
        markerStatus: 'committed',
      },
      { RESTORE_ROW_TOLERANCE: '5' },
    )
    expect(status).toBe(1)
    expect(stderr).toMatch(/empty/)
  })

  it('fails when the marker WAL cannot be archived', () => {
    const { status, state } = runScript(
      'restore-test.sh',
      [],
      {
        restoreName: `${project}-restore-test`,
        checkExit: 1,
        psql: {
          liveCounts: live,
          markerXid: '4294974027 6731',
          restoredCounts: live,
          markerStatus: 'committed',
        },
      },
      { SKIP_MEDIA: '1' },
    )
    expect(status).not.toBe(0)
    expect(state.restoreRun).toBeUndefined()
  })
})
