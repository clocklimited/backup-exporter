import { Readable } from 'node:stream'

export async function downloadStream({ url, size, timeoutMs, fetchImpl }) {
  const abort = new AbortController()
  let timer
  async function waitForDownload(operation) {
    try {
      return await Promise.race([
        operation,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(
              `Backup download timed out after ${timeoutMs / 1000} seconds without progress`
            )
            reject(error)
            abort.abort(error)
          }, timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  const response = await waitForDownload(
    fetchImpl(url, {
      redirect: 'error',
      headers: { 'Accept-Encoding': 'identity' },
      signal: abort.signal
    })
  )
  const encoding = response.headers.get('content-encoding')
  const length = response.headers.get('content-length')
  if (
    response.status !== 200 ||
    !response.body ||
    (encoding && encoding !== 'identity') ||
    (length !== null && Number(length) !== size)
  ) {
    await response.body?.cancel()
    throw new Error(`Backup download is invalid (HTTP ${response.status})`)
  }

  const reader = response.body.getReader()
  let cancelled = false
  return Readable.fromWeb(
    new ReadableStream(
      {
        async pull(controller) {
          try {
            const { done, value } = await waitForDownload(reader.read())
            if (cancelled) return
            if (done) controller.close()
            else controller.enqueue(value)
          } catch (error) {
            if (!cancelled) controller.error(error)
            await reader.cancel(error).catch(() => {})
          }
        },
        async cancel(reason) {
          cancelled = true
          clearTimeout(timer)
          abort.abort(reason)
          await reader.cancel(reason).catch(() => {})
        }
      },
      // Only time reads requested by the consumer, not downstream backpressure.
      { highWaterMark: 0 }
    )
  )
}
