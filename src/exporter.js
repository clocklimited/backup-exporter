import { Readable } from 'node:stream'
import { S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import {
  validateRecipient,
  encryptedSizeLimit,
  encryptStream
} from './encryption.js'

const MIB = 1024 * 1024

export function readConfig(env) {
  const required = (name) => {
    if (!env[name]?.trim()) throw new Error(`${name} is required`)
    return env[name].trim()
  }
  const addonIds = [
    ...new Set(
      (env.DATABASE_ADDON_IDS ?? env.DATABASE_ADDON_ID ?? 'production-database')
        .split(',')
        .map((id) => id.trim())
    )
  ]
  if (addonIds.some((id) => !/^[a-zA-Z0-9-]+$/.test(id))) {
    throw new Error('DATABASE_ADDON_IDS must contain comma-separated addon IDs')
  }
  const endpoint = env.S3_ENDPOINT?.trim() || undefined
  if (endpoint && new URL(endpoint).protocol !== 'https:') {
    throw new Error('S3_ENDPOINT must use HTTPS')
  }
  const maxBackupAgeHours = Number(env.BACKUP_MAX_AGE_HOURS ?? 24)
  if (!Number.isFinite(maxBackupAgeHours) || maxBackupAgeHours <= 0) {
    throw new Error('BACKUP_MAX_AGE_HOURS must be a positive number')
  }
  return {
    projectId: required('NF_PROJECT_ID'),
    token: required('BACKUP_EXPORTER_TOKEN'),
    addonIds,
    endpoint,
    maxBackupAgeHours,
    region: required('S3_REGION'),
    bucket: required('S3_BUCKET'),
    ageRecipient: validateRecipient(required('AGE_RECIPIENT')),
    credentials: {
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY')
    }
  }
}

export function createS3Client(config) {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  })
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const result = await next(args)
      const response = result.response
      if (
        context.commandName === 'CreateMultipartUploadCommand' &&
        response?.statusCode === 200
      ) {
        // Some stores repeat this unused lifecycle hint in both headers and XML.
        delete response.headers?.['x-amz-abort-date']
        if (response.body) {
          const bytes =
            typeof response.body === 'string' ||
            response.body instanceof Uint8Array
              ? response.body
              : await client.config.streamCollector(response.body)
          response.body = Buffer.from(
            Buffer.from(bytes)
              .toString('utf8')
              .replace(
                /<((?:[\w.-]+:)?AbortDate)\b[^>]*>[\s\S]*?<\/\1\s*>/g,
                ''
              )
          )
        }
      }
      return result
    },
    { step: 'deserialize', priority: 'low', name: 'ignoreMultipartAbortDate' }
  )
  return client
}

export function safeError(error) {
  return String(error?.message || 'Unknown failure')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/[\r\n]/g, ' ')
}

export function multipartPartSize(size) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 5_000_000_000_000) {
    throw new Error(
      'Backup size must be a positive integer no larger than 5 TB'
    )
  }
  return Math.max(64 * MIB, Math.ceil(size / (9999 * MIB)) * MIB)
}

export function selectBackup(backups, maxAgeHours, now = Date.now()) {
  const backup = backups
    .filter(
      (item) =>
        item.status === 'completed' && item.config?.source?.type === 'sameAddon'
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
  if (!backup) throw new Error('No completed native backup is available')
  const createdAt = Date.parse(backup.createdAt)
  if (!Number.isFinite(createdAt) || createdAt > now + 300000) {
    throw new Error('Backup has an invalid creation timestamp')
  }
  if (now - createdAt > maxAgeHours * 3600000) {
    throw new Error(
      `Newest completed native backup is older than ${maxAgeHours} hours`
    )
  }
  if (!backup.id) throw new Error('Backup is missing its ID')
  const size = Number(backup.config.size)
  multipartPartSize(size)
  multipartPartSize(encryptedSizeLimit(size))
  const compression = backup.config.compressionType ?? 'gz'
  if (!['gz', 'zstd'].includes(compression)) {
    throw new Error('Backup has an unsupported compression format')
  }
  return { ...backup, size, compression }
}

export async function exportBackup({
  config,
  addonId,
  backup,
  downloadLink,
  s3,
  fetchImpl = fetch
}) {
  const maxEncryptedSize = encryptedSizeLimit(backup.size)
  const partSize = multipartPartSize(maxEncryptedSize)
  const response = await fetchImpl(downloadLink, {
    redirect: 'error',
    headers: { 'Accept-Encoding': 'identity' }
  })
  const encoding = response.headers.get('content-encoding')
  const length = response.headers.get('content-length')
  if (
    response.status !== 200 ||
    !response.body ||
    (encoding && encoding !== 'identity') ||
    (length !== null && Number(length) !== backup.size)
  ) {
    await response.body?.cancel()
    throw new Error(`Backup download is invalid (HTTP ${response.status})`)
  }
  const source = Readable.fromWeb(response.body)
  const body = encryptStream(source, {
    recipient: config.ageRecipient,
    sourceSize: backup.size,
    maxBytes: maxEncryptedSize
  })
  const extension = backup.compression === 'zstd' ? 'zst' : backup.compression
  const key = [config.projectId, addonId, `${backup.id}.${extension}.age`]
    .map(encodeURIComponent)
    .join('/')
  try {
    const upload = new Upload({
      client: {
        config: s3.config,
        async send(command) {
          try {
            return await s3.send(command)
          } catch (error) {
            // Release multipart workers waiting for more download bytes.
            source.destroy(error)
            throw error
          }
        }
      },
      queueSize: 2,
      partSize,
      leavePartsOnError: false,
      params: {
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
        ChecksumAlgorithm: 'SHA256'
      }
    })
    await upload.done()
    return key
  } finally {
    source.destroy()
    body.destroy()
  }
}

export async function exportAddons({
  config,
  northflank,
  s3,
  fetchImpl = fetch,
  logger = console
}) {
  const failures = []
  for (const addonId of config.addonIds) {
    try {
      const backups = await northflank.listBackups(config.projectId, addonId)
      const backup = selectBackup(backups, config.maxBackupAgeHours)
      logger.log(
        `Exporting ${config.projectId}/${addonId}: ${backup.id}, ${backup.size} bytes`
      )
      const downloadLink = await northflank.downloadLink(
        config.projectId,
        addonId,
        backup.id
      )
      const key = await exportBackup({
        config,
        addonId,
        backup,
        downloadLink,
        s3,
        fetchImpl
      })
      logger.log(`Exported ${key}`)
    } catch (error) {
      failures.push(addonId)
      logger.error(`Export failed for ${addonId}: ${safeError(error)}`)
    }
  }
  if (failures.length)
    throw new Error(`Export failed for: ${failures.join(', ')}`)
}
