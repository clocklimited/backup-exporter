import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForNativeBackup } from '../src/native-backup.js'
import { createNorthflankClient } from '../src/northflank.js'

const quiet = { log() {} }
const json = (value) => new Response(JSON.stringify({ data: value }))

test('native dump creation explicitly requests zstd dump and polls the returned ID', async () => {
  const calls = []
  const client = createNorthflankClient(
    'test-token',
    async (url, options) => {
      calls.push({ url, options })
      if (options.method === 'POST')
        return json({ id: 'new-dump', status: 'scheduled' })
      return json({ id: 'new-dump', status: 'completed' })
    },
    quiet
  )
  assert.equal(await client.createBackup('tigers', 'darkroom'), 'new-dump')
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    backupType: 'dump',
    compressionType: 'zstd'
  })
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
  assert.equal(
    (await client.getBackup('tigers', 'darkroom', 'new-dump')).status,
    'completed'
  )
  assert.equal(
    calls[1].url,
    'https://api.northflank.com/v1/projects/tigers/addons/darkroom/backups/new-dump'
  )
  assert.equal(calls[1].options.method, 'GET')
})

test('ambiguous creation timeout is surfaced without automatically creating another dump', async () => {
  let calls = 0
  const client = createNorthflankClient(
    'test-token',
    async () => {
      calls++
      throw new DOMException('timeout', 'TimeoutError')
    },
    quiet
  )
  await assert.rejects(
    client.createBackup('tigers', 'darkroom'),
    /timed out.*create native backup/
  )
  assert.equal(calls, 1)
})

test('missing or mismatched backup IDs fail closed', async () => {
  const client = createNorthflankClient(
    'test-token',
    async () => json({ id: 'wrong' }),
    quiet
  )
  await assert.rejects(
    client.getBackup('p', 'a', 'expected'),
    /different backup ID/
  )
  const missing = createNorthflankClient(
    'test-token',
    async () => json({}),
    quiet
  )
  await assert.rejects(missing.createBackup('p', 'a'), /created backup ID/)
})

test('waits through scheduled and in-progress states without listing other backups', async () => {
  let clock = 0
  const statuses = ['scheduled', 'in-progress', 'completed']
  const ids = []
  const result = await waitForNativeBackup({
    northflank: {
      getBackup: async (p, a, id) => {
        ids.push(id)
        return { id, status: statuses.shift() }
      }
    },
    projectId: 'p',
    addonId: 'a',
    backupId: 'expected',
    timeoutMs: 90000,
    now: () => clock,
    wait: async (ms) => {
      clock += ms
    },
    logger: quiet
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(ids, ['expected', 'expected', 'expected'])
  assert.equal(clock, 60000)
})

for (const status of [
  'failed',
  'aborted',
  'aborting',
  'not-supported',
  'unexpected'
]) {
  test(`does not export or wait indefinitely for ${status} dump`, async () => {
    await assert.rejects(
      waitForNativeBackup({
        northflank: { getBackup: async () => ({ id: 'expected', status }) },
        projectId: 'p',
        addonId: 'a',
        backupId: 'expected',
        timeoutMs: 1000,
        logger: quiet,
        wait: async () => {
          throw new Error('must not wait')
        }
      }),
      new RegExp(`ended with status ${status}`)
    )
  })
}

test('waiting is bounded and timeout reports the dump ID for safe retry', async () => {
  let clock = 0
  let calls = 0
  await assert.rejects(
    waitForNativeBackup({
      northflank: {
        getBackup: async () => {
          calls++
          return { id: 'expected', status: 'in-progress' }
        }
      },
      projectId: 'p',
      addonId: 'a',
      backupId: 'expected',
      timeoutMs: 45000,
      now: () => clock,
      wait: async (ms) => {
        clock += ms
      },
      logger: quiet
    }),
    /Timed out.*expected.*BACKUP_ID/
  )
  assert.equal(clock, 45000)
  assert.equal(calls, 2)
})
