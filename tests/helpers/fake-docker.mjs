// A stand-in for the `docker` command, for tests of the scripts in scripts/deploy. Run as
// `node fake-docker.mjs <docker arguments>`; tests/infra/deploy-scripts.test.ts puts a `docker`
// wrapper for it first on PATH.
//
// It keeps its state in the JSON file named by FAKE_DOCKER_STATE: the app containers (status and
// networks), the answers to give, every call, and every rule the script broke. Only what the
// deploy and restore-test scripts use is modelled.
//
// The rule that matters for deploys: Caddy sends traffic to every running app container on the
// "public" network (Docker's DNS name "app"). A container may be there only after the script has
// seen its health check report "healthy". Anything else is recorded as a violation.
import { readFileSync, writeFileSync } from 'node:fs'

const stateFile = process.env.FAKE_DOCKER_STATE
if (!stateFile) {
  console.error('fake docker: FAKE_DOCKER_STATE is not set')
  process.exit(2)
}
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
state.calls ??= []
state.violations ??= []
state.containers ??= []
state.nextId ??= 1

const args = process.argv.slice(2)
state.calls.push(args)

let out = ''
let code = 0

const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2))
const find = (id) => state.containers.find((c) => c.id === id || c.name === id)
const inCaddyPool = (c) => c.status === 'running' && c.networks.includes('public')

/** Record a violation for every app container Caddy can reach before it was seen healthy. */
function checkPool(step) {
  for (const c of state.containers) {
    if (inCaddyPool(c) && c.seenHealth !== 'healthy') {
      state.violations.push(`${c.id} in Caddy's pool (${step}) before it was seen healthy`)
    }
  }
}

/** Value of a flag such as `--name x`, or undefined. */
const flag = (list, name) => {
  const i = list.indexOf(name)
  return i >= 0 ? list[i + 1] : undefined
}

/** The SQL passed with -c, if any. */
const sqlOf = (list) => flag(list, '-c') ?? ''

/** Answer a psql call, on the live database ("live") or the restored one ("restored"). */
function psql(where, list) {
  const sql = sqlOf(list)
  const answers = state.psql ?? {}
  if (/count\(\*\)/.test(sql)) return void (out = answers[`${where}Counts`] ?? '')
  if (where === 'live' && /pg_current_xact_id/.test(sql)) return void (out = answers.markerXid)
  if (where === 'restored') {
    if (/pg_is_in_recovery/.test(sql)) return void (out = 'f')
    if (/pg_last_xact_replay_timestamp/.test(sql)) return void (out = '2026-11-06 12:00:00+00')
    if (/pg_xact_status/.test(sql)) {
      if (answers.markerStatus === 'future') {
        console.error('ERROR:  transaction ID is in the future')
        code = 1
        return
      }
      return void (out = answers.markerStatus)
    }
  }
  console.error(`fake docker: unexpected psql on ${where}: ${sql}`)
  code = 3
}

/** docker compose <global flags> <command> ... */
function compose(list) {
  const rest = [...list]
  while (rest.length && rest[0].startsWith('-')) {
    // Every global flag the scripts use takes a value.
    rest.splice(0, 2)
  }
  const [command, ...cmdArgs] = rest
  if (command === 'up') {
    const services = cmdArgs.filter(
      (a, i) => !a.startsWith('-') && !cmdArgs[i - 1]?.match(/^--(scale|wait-timeout)$/),
    )
    if (!services.includes('app')) return
    const apps = state.containers
    const scale = flag(cmdArgs, '--scale')
    const wanted = scale ? Number(scale.split('=')[1]) : Math.max(apps.length, 1)
    const start = !cmdArgs.includes('--no-start')
    for (let n = apps.length; n < wanted; n++) {
      const id = `new${state.nextId++}`
      // A container Compose creates is on every network of its service.
      state.containers.push({
        id,
        status: start ? 'running' : 'created',
        networks: ['public', 'internal'],
        health: state.newHealth ?? 'healthy',
        healthChecks: 0,
      })
    }
    // `up --wait` only returns once the service is healthy.
    if (cmdArgs.includes('--wait')) {
      for (const c of state.containers) if (c.health === 'healthy') c.seenHealth = 'healthy'
    }
    checkPool(`compose up ${cmdArgs.join(' ')}`)
    return
  }
  if (command === 'exec') {
    if (cmdArgs.includes('psql')) return psql('live', cmdArgs)
    if (cmdArgs.includes('pgbackrest')) {
      state.pgbackrest ??= []
      state.pgbackrest.push(cmdArgs.slice(cmdArgs.indexOf('pgbackrest') + 1))
      code = cmdArgs.includes('check') ? (state.checkExit ?? 0) : 0
      return
    }
  }
  if (command === 'run') {
    // The restore-test container: remember the environment it was started with.
    state.restoreRun = cmdArgs
    return
  }
}

const [command, ...rest] = args
switch (command) {
  case 'compose':
    compose(rest)
    break
  case 'image':
  case 'pull':
    break
  case 'ps': {
    const all = rest.includes('-a') || rest.includes('-aq')
    const filters = rest.filter((_, i) => rest[i - 1] === '--filter')
    const status = filters.find((f) => f.startsWith('status='))?.slice('status='.length)
    out = state.containers
      .filter((c) => (status ? c.status === status : all || c.status === 'running'))
      .map((c) => c.id)
      .join('\n')
    break
  }
  case 'inspect': {
    const format = flag(rest, '-f') ?? ''
    const c = find(rest[rest.length - 1])
    if (rest[rest.length - 1] === state.restoreName) {
      out = format ? 'true' : '{}'
      break
    }
    if (!c) {
      code = 1
      break
    }
    if (format.includes('Health.Status')) {
      // "starting" on the first look, then the container's real state.
      c.healthChecks++
      c.seenHealth = c.healthChecks > 1 ? c.health : 'starting'
      out = c.seenHealth
    } else if (format.includes('Health.Log')) {
      out = '1 {"status":"unavailable"}'
    }
    break
  }
  case 'network': {
    const [sub, ...netArgs] = rest
    const [network, id] = netArgs.filter(
      (a, i) => !a.startsWith('-') && netArgs[i - 1] !== '--alias',
    )
    const c = find(id)
    if (!c || !network?.endsWith('_public')) {
      console.error(`fake docker: unexpected network call: ${rest.join(' ')}`)
      code = 1
      break
    }
    if (sub === 'disconnect') c.networks = c.networks.filter((n) => n !== 'public')
    if (sub === 'connect') {
      c.networks.push('public')
      c.aliases = netArgs.filter((_, i) => netArgs[i - 1] === '--alias')
      checkPool(`network connect ${id}`)
    }
    break
  }
  case 'start': {
    const c = find(rest[0])
    if (c) c.status = 'running'
    checkPool(`start ${rest[0]}`)
    break
  }
  case 'stop': {
    const c = find(rest[rest.length - 1])
    if (c) c.status = 'exited'
    break
  }
  case 'rm': {
    const force = rest.includes('-f')
    for (const id of rest.filter((a) => !a.startsWith('-'))) {
      const c = find(id)
      if (c && (force || c.status !== 'running')) {
        state.containers = state.containers.filter((x) => x !== c)
      }
    }
    break
  }
  case 'exec':
    if (rest[0] === state.restoreName && rest.includes('psql')) psql('restored', rest)
    break
  case 'logs':
    out = 'FATAL:  recovery ended before configured recovery target was reached'
    break
  default:
    console.error(`fake docker: unexpected command: ${args.join(' ')}`)
    code = 3
}

save()
if (out) process.stdout.write(`${out}\n`)
process.exit(code)
