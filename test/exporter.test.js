import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createNorthflankClient } from '../src/northflank.js'
import {
  readConfig,
  multipartPartSize,
  createS3Client,
  exportBackup,
  exportAddons,
  selectBackup,
  safeError
} from '../src/exporter.js'
const MIB = 1024 * 1024
const MAX_OBJECT_SIZE = 5_000_000_000_000

function backup(id = 'native-backup', size = 12, overrides = {}) {
  return {
    id,
    size,
    compression: 'zstd',
    status: 'completed',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    config: {
      source: { type: 'sameAddon' },
      size: String(size),
      compressionType: 'zstd',
      addonVersion: '7.0'
    },
    ...overrides
  }
}

const env = {
  NF_PROJECT_ID: 'test-project',
  BACKUP_EXPORTER_TOKEN: 'fake-nf-token',
  S3_BUCKET: 'test-bucket',
  S3_REGION: 'eu-west-1',
  S3_ACCESS_KEY_ID: 'fake-access-key',
  S3_SECRET_ACCESS_KEY: 'fake-secret-key'
}
const downloadLink = 'https://storage.example.invalid/backup?token=DO-NOT-LOG'
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' }
  })

async function storage(t, options = {}) {
  const requests = [],
    objects = new Map()
  let firstPartResolve
  const firstPart = new Promise((resolve) => {
    firstPartResolve = resolve
  })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    requests.push({ method: req.method, url, body, headers: req.headers })
    res.setHeader('content-type', 'application/xml')
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      res.end(
        '<InitiateMultipartUploadResult><UploadId>test-upload-id</UploadId></InitiateMultipartUploadResult>'
      )
    } else if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
      if (options.rejectPart) {
        res.writeHead(403)
        res.end(
          '<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>'
        )
      } else {
        res.setHeader('etag', `"part-${url.searchParams.get('partNumber')}"`)
        res.setHeader(
          'x-amz-checksum-sha256',
          createHash('sha256').update(body).digest('base64')
        )
        res.end()
      }
      firstPartResolve()
    } else if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      if (options.rejectComplete) {
        res.writeHead(403)
        res.end(
          '<Error><Code>AccessDenied</Code><Message>Completion denied</Message></Error>'
        )
        return
      }
      const parts = requests
        .filter(
          (request) =>
            request.method === 'PUT' &&
            request.url.searchParams.has('partNumber')
        )
        .sort(
          (a, b) =>
            Number(a.url.searchParams.get('partNumber')) -
            Number(b.url.searchParams.get('partNumber'))
        )
      objects.set(url.pathname, Buffer.concat(parts.map((part) => part.body)))
      res.setHeader('x-amz-version-id', 'test-version-id')
      res.end(
        '<CompleteMultipartUploadResult><ETag>"multipart-etag"</ETag></CompleteMultipartUploadResult>'
      )
    } else if (req.method === 'DELETE' && url.searchParams.has('uploadId')) {
      res.writeHead(204)
      res.end()
    } else if (req.method === 'PUT') {
      objects.set(url.pathname, body)
      res.setHeader('x-amz-version-id', 'test-version-id')
      res.setHeader('etag', '"test-etag"')
      res.end()
    } else {
      res.writeHead(405)
      res.end('<Error><Code>MethodNotAllowed</Code></Error>')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const config = {
    ...readConfig(env),
    endpoint: `http://127.0.0.1:${server.address().port}`
  }
  const s3 = createS3Client(config)
  t.after(async () => {
    s3.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return { config, s3, requests, objects, firstPart }
}

test('single-addon configuration remains compatible; multiple IDs are explicit and deduplicated', () => {
  assert.deepEqual(readConfig(env).addonIds, ['production-database'])
  assert.deepEqual(
    readConfig({ ...env, DATABASE_ADDON_ID: 'old-addon' }).addonIds,
    ['old-addon']
  )
  assert.deepEqual(
    readConfig({ ...env, DATABASE_ADDON_IDS: 'one, two,one' }).addonIds,
    ['one', 'two']
  )
  assert.throws(
    () => readConfig({ ...env, DATABASE_ADDON_IDS: 'one,' }),
    /addon IDs/
  )
  assert.throws(
    () => readConfig({ ...env, S3_ENDPOINT: 'http://unsafe.example' }),
    /HTTPS/
  )
  assert.throws(
    () => readConfig({ ...env, BACKUP_MAX_AGE_HOURS: 'NaN' }),
    /BACKUP_MAX_AGE/
  )
})

test('400 GiB and maximum-size backups remain under the multipart limit', () => {
  for (const size of [60 * 1024 ** 3, 400 * 1024 ** 3, MAX_OBJECT_SIZE]) {
    assert.ok(Math.ceil(size / multipartPartSize(size)) <= 9999)
  }
  assert.equal(multipartPartSize(400 * 1024 ** 3), 64 * MIB)
  for (const size of [0, -1, 1.5, NaN, MAX_OBJECT_SIZE + 1]) {
    assert.throws(() => multipartPartSize(size), /Backup size/)
  }
})

test('selects newest completed native backup independent of API order; rejects stale backups', () => {
  const now = Date.now()
  const old = backup('old', 12, {
    createdAt: new Date(now - 3600000).toISOString()
  })
  const current = backup('current')
  const failed = backup('failed', 12, { status: 'failed' })
  const snapshot = backup('snapshot', 12, {
    config: { source: { type: 'snapshot' } }
  })
  assert.equal(
    selectBackup([old, failed, snapshot, current], 24, now).id,
    'current'
  )
  const defaultGzip = backup('gzip-default')
  delete defaultGzip.config.compressionType
  assert.equal(selectBackup([defaultGzip], 24, now).compression, 'gz')
  assert.throws(() => selectBackup([failed, snapshot], 24, now), /No completed/)
  assert.throws(() => selectBackup([old], 24, now + 25 * 3600000), /older than/)
})

test('Northflank pagination retrieves newer backups beyond the first page', async () => {
  const calls = []
  const nf = createNorthflankClient('fake-token', async (url, options) => {
    calls.push(new URL(url))
    assert.equal(options.headers.Authorization, 'Bearer fake-token')
    return calls.length === 1
      ? json({
          data: { backups: [backup('old')] },
          pagination: { hasNextPage: true, cursor: 'next' }
        })
      : json({
          data: { backups: [backup('new')] },
          pagination: { hasNextPage: false }
        })
  })
  assert.equal((await nf.listBackups('project', 'addon')).length, 2)
  assert.equal(calls[1].searchParams.get('cursor'), 'next')
})

test('Northflank rejects repeated cursors and non-HTTPS download URLs', async () => {
  const nf = createNorthflankClient('fake-token', async () =>
    json({
      data: { backups: [] },
      pagination: { hasNextPage: true, cursor: 'loop' }
    })
  )
  await assert.rejects(nf.listBackups('project', 'addon'), /repeated/)
  const unsafe = createNorthflankClient('fake-token', async () =>
    json({ data: { downloadLink: 'http://unsafe.example/file' } })
  )
  await assert.rejects(
    unsafe.downloadLink('project', 'addon', 'backup'),
    /HTTPS/
  )
})

test('single upload preserves bytes without read/list permissions or sidecar files', async (t) => {
  const store = await storage(t)
  const body = Buffer.from('backup-bytes')
  const key = await exportBackup({
    ...store,
    addonId: 'mongo',
    backup: backup('small', body.length),
    downloadLink,
    fetchImpl: async () => new Response(body)
  })
  assert.equal(key, 'test-project/mongo/small.zstd')
  assert.deepEqual(store.objects.get(`/test-bucket/${key}`), body)
  assert.equal(store.objects.size, 1)
  assert.ok(store.requests.every((request) => request.method === 'PUT'))
  assert.ok(
    store.requests.every(
      (request) =>
        !request.headers['x-amz-object-lock-mode'] &&
        !request.headers['x-amz-acl']
    )
  )
})

test('real SDK multipart upload preserves every byte with fixed buffering', async (t) => {
  const store = await storage(t)
  const body = Buffer.alloc(65 * MIB + 17, 42)
  const key = await exportBackup({
    ...store,
    addonId: 'postgres',
    backup: backup('large', body.length),
    downloadLink,
    fetchImpl: async () => new Response(body)
  })
  assert.deepEqual(store.objects.get(`/test-bucket/${key}`), body)
  const parts = store.requests
    .filter((request) => request.url.searchParams.has('partNumber'))
    .sort(
      (a, b) =>
        Number(a.url.searchParams.get('partNumber')) -
        Number(b.url.searchParams.get('partNumber'))
    )
  assert.equal(parts.length, 2)
  assert.equal(parts[0].body.length, 64 * MIB)
  assert.equal(parts[1].body.length, MIB + 17)
  assert.equal(store.objects.size, 1)
  assert.equal(
    store.requests.filter(
      (request) =>
        request.method === 'POST' && request.url.searchParams.has('uploadId')
    ).length,
    1
  )
})

test('HTTP errors, empty downloads and size mismatches never become backup objects', async (t) => {
  const store = await storage(t)
  for (const response of [
    new Response('<Error>Denied</Error>', { status: 403 }),
    new Response(null, { status: 204 }),
    new Response('backup-bytes', { headers: { 'content-encoding': 'gzip' } }),
    new Response('abc', { headers: { 'content-length': '3' } }),
    new Response(''),
    new Response('short'),
    new Response('way-too-many-backup-bytes')
  ]) {
    await assert.rejects(
      exportBackup({
        ...store,
        addonId: 'mongo',
        backup: { ...backup('bad', 12), size: 12 },
        downloadLink,
        fetchImpl: async () => response
      })
    )
  }
  assert.equal(store.objects.size, 0)
})

test('source failure after a part upload aborts multipart and never completes it', async (t) => {
  const store = await storage(t)
  let sent = false
  const stream = new ReadableStream({
    async pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new Uint8Array(64 * MIB + 1))
      } else {
        await store.firstPart
        controller.error(new Error('Source connection dropped'))
      }
    }
  })
  await assert.rejects(
    exportBackup({
      ...store,
      addonId: 'mongo',
      backup: { ...backup('broken', 68 * MIB), size: 68 * MIB },
      downloadLink,
      fetchImpl: async () => new Response(stream)
    })
  )
  assert.ok(
    store.requests.some(
      (request) =>
        request.method === 'DELETE' && request.url.searchParams.has('uploadId')
    )
  )
  assert.ok(
    !store.requests.some(
      (request) =>
        request.method === 'POST' && request.url.searchParams.has('uploadId')
    )
  )
  assert.equal(store.objects.size, 0)
})

test('S3 part failures abort multipart and fail the export', async (t) => {
  const store = await storage(t, { rejectPart: true })
  const body = Buffer.alloc(65 * MIB, 42)
  await assert.rejects(
    exportBackup({
      ...store,
      addonId: 'mongo',
      backup: backup('denied', body.length),
      downloadLink,
      fetchImpl: async () => new Response(body)
    }),
    /Denied/
  )
  assert.ok(store.requests.some((request) => request.method === 'DELETE'))
  assert.equal(store.objects.size, 0)
})

test('failed multipart completion fails the export', async (t) => {
  const store = await storage(t, { rejectComplete: true })
  const body = Buffer.alloc(65 * MIB, 42)
  await assert.rejects(
    exportBackup({
      ...store,
      addonId: 'mongo',
      backup: backup('bad-complete', body.length),
      downloadLink,
      fetchImpl: async () => new Response(body)
    }),
    /Completion denied/
  )
  assert.equal(store.objects.size, 0)
})

test('one failed addon does not prevent another export, but the job fails and logs no signed URL', async (t) => {
  const store = await storage(t)
  store.config.addonIds = ['broken', 'working']
  const logs = []
  const nf = {
    listBackups: async (project, addon) =>
      addon === 'broken' ? [] : [backup('good', 3)],
    downloadLink: async () => downloadLink
  }
  await assert.rejects(
    exportAddons({
      ...store,
      northflank: nf,
      fetchImpl: async () => new Response('abc'),
      logger: {
        log: (line) => logs.push(line),
        error: (line) => logs.push(line)
      }
    }),
    /broken/
  )
  assert.equal(store.objects.size, 1)
  assert.ok(!logs.join('\n').includes('DO-NOT-LOG'))
  assert.ok(
    !safeError(new Error(`Failed ${downloadLink}`)).includes('DO-NOT-LOG')
  )
})
