import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export async function verifyBackup(manifest, filePath) {
  if (
    manifest.formatVersion !== 1 ||
    !Number.isSafeInteger(manifest.object?.sizeBytes) ||
    manifest.object.sizeBytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(manifest.object?.sha256)
  ) {
    throw new Error('Invalid backup manifest')
  }
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length
    hash.update(chunk)
  }
  if (bytes !== manifest.object.sizeBytes)
    throw new Error('Backup size does not match manifest')
  const digest = hash.digest('hex')
  if (digest !== manifest.object.sha256)
    throw new Error('Backup SHA256 does not match manifest')
  return { sizeBytes: bytes, sha256: digest }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [, , manifestPath, backupPath] = process.argv
    if (!manifestPath || !backupPath)
      throw new Error('Usage: npm run verify -- manifest.json dump.gz')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const result = await verifyBackup(manifest, backupPath)
    console.log(`Verified ${result.sizeBytes} bytes; SHA256 ${result.sha256}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
