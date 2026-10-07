export const MIB = 1024 * 1024
export const MAX_OBJECT_SIZE = 5_000_000_000_000

function required(env, name) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function number(env, name, fallback, min, max) {
  const value = env[name] === undefined ? fallback : Number(env[name])
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return value
}

export function readConfig(env) {
  const ids =
    env.DATABASE_ADDON_IDS ?? env.DATABASE_ADDON_ID ?? 'production-database'
  const addonIds = [...new Set(ids.split(',').map((id) => id.trim()))]
  if (addonIds.some((id) => !/^[a-zA-Z0-9-]+$/.test(id))) {
    throw new Error('DATABASE_ADDON_IDS must contain comma-separated addon IDs')
  }
  const endpoint = env.S3_ENDPOINT?.trim() || undefined
  if (endpoint && new URL(endpoint).protocol !== 'https:') {
    throw new Error('S3_ENDPOINT must use HTTPS')
  }
  const pathStyle = env.S3_FORCE_PATH_STYLE ?? 'true'
  if (!['true', 'false'].includes(pathStyle)) {
    throw new Error('S3_FORCE_PATH_STYLE must be true or false')
  }
  const concurrency = number(env, 'S3_UPLOAD_CONCURRENCY', 2, 1, 8)
  const partSizeMiB = number(env, 'S3_MULTIPART_PART_SIZE_MB', 64, 5, 5120)
  if (!Number.isInteger(concurrency) || !Number.isInteger(partSizeMiB)) {
    throw new Error('Upload concurrency and part size must be whole numbers')
  }
  return {
    projectId: required(env, 'NF_PROJECT_ID'),
    token: required(env, 'BACKUP_EXPORTER_TOKEN'),
    addonIds,
    endpoint,
    region: required(env, 'S3_REGION'),
    bucket: required(env, 'S3_BUCKET'),
    credentials: {
      accessKeyId: required(env, 'S3_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'S3_SECRET_ACCESS_KEY')
    },
    forcePathStyle: pathStyle === 'true',
    keyPrefix: (env.S3_KEY_PREFIX || '').replace(/^\/+|\/+$/g, ''),
    maxBackupAgeHours: number(env, 'BACKUP_MAX_AGE_HOURS', 24, 1, 8760),
    exportTimeoutMs:
      number(env, 'EXPORT_TIMEOUT_HOURS', 24, 0.01, 168) * 3600000,
    partSize: partSizeMiB * MIB,
    concurrency
  }
}

export function multipartPartSize(size, minimum = 64 * MIB) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_OBJECT_SIZE) {
    throw new Error(
      'Backup size must be a positive integer no larger than 5 TB'
    )
  }
  return Math.max(minimum, Math.ceil(size / (9999 * MIB)) * MIB)
}
