import { spawn, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export function validateRecipient(recipient) {
  // Only accept one native X25519 public key, never an identity or plugin.
  if (!/^age1[0-9a-z]{58}$/.test(recipient)) {
    throw new Error('AGE_RECIPIENT must be one native age public key (age1...)')
  }
  const result = spawnSync('age', ['--encrypt', '--recipient', recipient], {
    input: Buffer.alloc(0),
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 10000
  })
  if (result.error)
    throw new Error('Could not run age to validate AGE_RECIPIENT')
  if (result.status !== 0)
    throw new Error('AGE_RECIPIENT is not a valid age public key')
  return recipient
}

export function encryptedSizeLimit(size) {
  // age adds a 16-byte tag per 64 KiB chunk. Allow 64 KiB for the header/nonce.
  // Enforce this bound while streaming as well as when sizing multipart uploads.
  return size + Math.ceil(size / 65536) * 16 + 65536
}

export function encryptStream(source, { recipient, sourceSize, maxBytes }) {
  async function* encrypted() {
    const child = spawn('age', ['--encrypt', '--recipient', recipient], {
      stdio: ['pipe', 'pipe', 'ignore']
    })
    let failure
    const exited = new Promise((resolve, reject) => {
      child.once('error', () =>
        reject(new Error('Could not start age encryption'))
      )
      child.once('close', (code, signal) => {
        if (code === 0) resolve()
        else
          reject(
            new Error(`age encryption failed (${signal ?? `exit ${code}`})`)
          )
      })
    })
    async function* checkedDownload(download) {
      let bytes = 0
      for await (const chunk of download) {
        bytes += chunk.length
        if (bytes > sourceSize)
          throw new Error('Download exceeds the expected backup size')
        yield chunk
      }
      if (bytes !== sourceSize)
        throw new Error('Download is empty or truncated')
    }
    const input = pipeline(source, checkedDownload, child.stdin)
    const cancel = (error) => {
      failure ??= error
      source.destroy(failure)
      child.stdout.destroy(failure)
      child.kill('SIGKILL')
    }
    // Interrupt stdout even if the download stalls or the encryptor exits early.
    input.catch(cancel)
    exited.catch(cancel)
    try {
      let bytes = 0
      for await (const chunk of child.stdout) {
        bytes += chunk.length
        if (bytes > maxBytes)
          throw new Error('Encrypted backup exceeds its size limit')
        yield chunk
      }
      // Do not end the upload body until both the checked input and age succeed.
      await Promise.all([input, exited])
    } catch (error) {
      cancel(error)
      throw failure
    } finally {
      source.destroy()
      child.stdin.destroy()
      child.stdout.destroy()
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
      await Promise.allSettled([input, exited])
    }
  }
  return Readable.from(encrypted(), { objectMode: false })
}
