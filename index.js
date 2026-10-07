import dotenv from 'dotenv'
import { readConfig } from './src/config.js'
import { createNorthflankClient } from './src/northflank.js'
import { createS3Client, exportAddons, safeError } from './src/exporter.js'

dotenv.config({ quiet: true })

let s3
try {
  const config = readConfig(process.env)
  s3 = createS3Client(config)
  await exportAddons({
    config,
    northflank: createNorthflankClient(config.token),
    s3
  })
} catch (error) {
  console.error(`Export failed: ${safeError(error)}`)
  process.exitCode = 1
} finally {
  s3?.destroy()
}
