import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { downloadStream } from '../src/download.js'

for (const headersSent of [false, true]) {
  test(
    `timeout aborts a real HTTP download with headers ${headersSent ? 'sent' : 'stalled'}`,
    { timeout: 5000 },
    async (t) => {
      const server = createServer((req, res) => {
        if (headersSent) {
          res.writeHead(200, { 'content-length': '3' })
          res.write('a')
        }
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      t.after(() => {
        server.closeAllConnections()
        server.close()
      })
      let socketClosed
      server.once('connection', (socket) => {
        socketClosed = once(socket, 'close')
      })
      await assert.rejects(async () => {
        const source = await downloadStream({
          url: `http://127.0.0.1:${server.address().port}`,
          size: 3,
          timeoutMs: 200,
          fetchImpl: fetch
        })
        for await (const chunk of source) assert.equal(chunk.toString(), 'a')
      }, /Backup download timed out/)
      assert.ok(socketClosed)
      await socketClosed
    }
  )
}

test('ongoing progress can exceed the idle timeout in total', async () => {
  let sent = 0
  const source = await downloadStream({
    url: 'https://example.invalid',
    size: 8,
    timeoutMs: 200,
    fetchImpl: async () =>
      new Response(
        new ReadableStream(
          {
            async pull(controller) {
              await delay(50)
              if (sent++ < 8) controller.enqueue(new Uint8Array([42]))
              else controller.close()
            }
          },
          { highWaterMark: 0 }
        )
      )
  })
  const chunks = []
  for await (const chunk of source) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(8, 42))
})

test('downstream backpressure does not consume the download timeout', async () => {
  let reads = 0
  const chunkSize = 1024 * 1024
  const source = await downloadStream({
    url: 'https://example.invalid',
    size: 4 * chunkSize,
    timeoutMs: 100,
    fetchImpl: async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (reads++ < 4)
                controller.enqueue(new Uint8Array(chunkSize).fill(42))
              else controller.close()
            }
          },
          { highWaterMark: 0 }
        )
      )
  })
  await delay(250)
  assert.equal(reads, 0)
  const chunks = []
  for await (const chunk of source) {
    chunks.push(chunk)
    await delay(250)
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(4 * chunkSize, 42))
})
