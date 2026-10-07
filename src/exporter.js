import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  S3Client,
  PutObjectCommand,
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { multipartPartSize } from './config.js'

export function createS3Client(config) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: config.forcePathStyle,
    maxAttempts: 3,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: 10000, requestTimeout: 300000 }
  })
}

export function safeError(error) {
  return String(error?.message || 'Unknown failure')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/[\r\n]/g, ' ')
}

export function selectBackup(backups, maxAgeHours, now = Date.now()) {
  const eligible = backups.filter(
    (backup) =>
      backup.status === 'completed' &&
      backup.config?.source?.type === 'sameAddon'
  )
  if (!eligible.length)
    throw new Error('No completed native backup is available')
  if (
    eligible.some((backup) => !Number.isFinite(Date.parse(backup.createdAt)))
  ) {
    throw new Error(
      'A completed native backup has an invalid creation timestamp'
    )
  }
  const backup = eligible.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
  )[0]
  const age = now - Date.parse(backup.createdAt)
  if (age < -300000)
    throw new Error('Backup creation timestamp is in the future')
  if (age > maxAgeHours * 3600000) {
    throw new Error(
      `Newest completed native backup is older than ${maxAgeHours} hours`
    )
  }
  if (!backup.id || !backup.uid)
    throw new Error('Backup is missing its ID or UID')
  const compressionType = backup.config.compressionType ?? 'gz'
  if (!['gz', 'zstd'].includes(compressionType)) {
    throw new Error('Backup has an unsupported or missing compression format')
  }
  const size = Number(backup.config.size)
  multipartPartSize(size)
  return { ...backup, size, config: { ...backup.config, compressionType } }
}

function objectKey(config, addonId, backup) {
  const timestamp = new Date(backup.createdAt)
    .toISOString()
    .replace(/[:.]/g, '-')
  const components = [config.projectId, addonId, timestamp, backup.uid]
  const path = components.map(encodeURIComponent).join('/')
  return `${config.keyPrefix ? `${config.keyPrefix}/` : ''}${path}/dump.${backup.config.compressionType}`
}

export async function exportBackup({
  config,
  addonId,
  backup,
  downloadLink,
  s3,
  fetchImpl = fetch
}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.exportTimeoutMs)
  let source
  let verifier
  try {
    let response
    try {
      response = await fetchImpl(downloadLink, {
        signal: controller.signal,
        redirect: 'error',
        headers: { 'Accept-Encoding': 'identity' }
      })
    } catch {
      throw new Error('Backup download failed or timed out')
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel()
      throw new Error(`Backup download returned HTTP ${response.status}`)
    }
    const encoding = response.headers.get('content-encoding')
    if (encoding && encoding !== 'identity') {
      await response.body.cancel()
      throw new Error('Backup download must not be transparently decompressed')
    }
    const length = response.headers.get('content-length')
    if (length !== null && Number(length) !== backup.size) {
      await response.body.cancel()
      throw new Error(
        'Download Content-Length does not match the Northflank backup size'
      )
    }
    const hash = createHash('sha256')
    let bytes = 0
    verifier = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length
        if (bytes > backup.size) {
          callback(new Error('Download exceeds the expected backup size'))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
      flush(callback) {
        callback(
          bytes === backup.size && bytes > 0
            ? null
            : new Error('Download is empty or truncated')
        )
      }
    })
    source = Readable.fromWeb(response.body)
    const key = objectKey(config, addonId, backup)
    let uploadId
    let multipartComplete = false
    let multipartAborted = false
    // Abort in-flight SDK requests as well as the source stream. Keep cleanup
    // separate so an expired export deadline does not cancel the abort request.
    const uploadClient = {
      config: s3.config,
      async send(command) {
        const signal =
          command instanceof AbortMultipartUploadCommand
            ? AbortSignal.timeout(30000)
            : controller.signal
        const result = await s3.send(command, { abortSignal: signal })
        if (command instanceof CreateMultipartUploadCommand)
          uploadId = result.UploadId
        if (command instanceof CompleteMultipartUploadCommand)
          multipartComplete = true
        if (command instanceof AbortMultipartUploadCommand)
          multipartAborted = true
        return result
      }
    }
    const upload = new Upload({
      client: uploadClient,
      queueSize: config.concurrency,
      partSize: multipartPartSize(backup.size, config.partSize),
      leavePartsOnError: false,
      params: {
        Bucket: config.bucket,
        Key: key,
        Body: verifier,
        ContentLength: backup.size,
        ContentType: 'application/octet-stream',
        ChecksumAlgorithm: 'SHA256',
        Metadata: {
          'backup-id': backup.id,
          'backup-uid': backup.uid,
          'backup-created-at': backup.createdAt,
          'compression-type': backup.config.compressionType
        }
      }
    })
    const pump = pipeline(source, verifier, { signal: controller.signal })
    const transfer = upload.done()
    let result
    try {
      ;[, result] = await Promise.all([pump, transfer])
    } catch (error) {
      controller.abort()
      await Promise.allSettled([pump, transfer])
      // lib-storage handles source/part failures, but failed completion requests
      // also need cleanup. Abort never deletes a completed object.
      if (uploadId && !multipartComplete && !multipartAborted) {
        try {
          await s3.send(
            new AbortMultipartUploadCommand({
              Bucket: config.bucket,
              Key: key,
              UploadId: uploadId
            }),
            { abortSignal: AbortSignal.timeout(30000) }
          )
        } catch (cleanupError) {
          throw new Error(
            `${safeError(error)}; multipart cleanup also failed: ${safeError(cleanupError)}`
          )
        }
      }
      throw error
    }
    const manifest = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      projectId: config.projectId,
      addonId,
      backupId: backup.id,
      backupUid: backup.uid,
      backupCreatedAt: backup.createdAt,
      backupCompletedAt: backup.completedAt,
      addonVersion: backup.config.addonVersion,
      compressionType: backup.config.compressionType,
      object: {
        bucket: config.bucket,
        key,
        versionId: result.VersionId,
        sizeBytes: bytes,
        sha256: hash.digest('hex')
      }
    }
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: `${key}.manifest.json`,
        Body: JSON.stringify(manifest, null, 2) + '\n',
        ContentType: 'application/json',
        ChecksumAlgorithm: 'SHA256'
      }),
      { abortSignal: controller.signal }
    )
    return manifest
  } finally {
    clearTimeout(timer)
    controller.abort()
    source?.destroy()
    verifier?.destroy()
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
  const manifests = []
  for (const addonId of config.addonIds) {
    try {
      const backups = await northflank.listBackups(config.projectId, addonId)
      const backup = selectBackup(backups, config.maxBackupAgeHours)
      logger.log(
        `Exporting ${config.projectId}/${addonId}: backup ${backup.id}, ${backup.size} bytes`
      )
      const downloadLink = await northflank.downloadLink(
        config.projectId,
        addonId,
        backup.id
      )
      const manifest = await exportBackup({
        config,
        addonId,
        backup,
        downloadLink,
        s3,
        fetchImpl
      })
      manifests.push(manifest)
      logger.log(
        `Exported ${manifest.object.key}: ${manifest.object.sizeBytes} bytes, SHA256 ${manifest.object.sha256}`
      )
    } catch (error) {
      failures.push(addonId)
      logger.error(
        `Export failed for ${config.projectId}/${addonId}: ${safeError(error)}`
      )
    }
  }
  if (failures.length)
    throw new Error(`Exports failed for: ${failures.join(', ')}`)
  return manifests
}
