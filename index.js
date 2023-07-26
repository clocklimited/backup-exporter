import * as dotenv from 'dotenv'
dotenv.config()
import {
  ApiClient,
  ApiClientInMemoryContextProvider
} from '@northflank/js-client'
import fetch from 'node-fetch'
import AWS from 'aws-sdk'

const addonId = process.env.DATABASE_ADDON_ID || 'production-database'
const projectId = process.env.NF_PROJECT_ID

const s3Endpoint = process.env.S3_ENDPOINT
const s3AccessKeyId = process.env.S3_ACCESS_KEY_ID
const s3SecretAccessKey = process.env.S3_SECRET_ACCESS_KEY
const s3Region = process.env.S3_REGION
const s3Bucket = process.env.S3_BUCKET

;(async () => {
  const contextProvider = new ApiClientInMemoryContextProvider()
  await contextProvider.addContext({
    name: 'backup-exporter',
    token: process.env.BACKUP_EXPORTER_TOKEN
  })

  const apiClient = new ApiClient(contextProvider)

  AWS.config.update({
    endpoint: s3Endpoint,
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    region: s3Region
  })

  const s3 = new AWS.S3()

  try {
    console.log('Validating AWS credentials')
    await s3.headBucket({ Bucket: s3Bucket }).promise()
  } catch (error) {
    console.error('No access to s3 bucket', error)
    process.exit(1)
  }
  console.log('AWS credentials valid!')

  console.log('Validating NF credentials')
  const project = (
    await apiClient.get.project({
      parameters: { projectId: process.env.NF_PROJECT_ID }
    })
  ).data

  if (!project) {
    console.error(
      `BACKUP_EXPORTER_TOKEN does not have access to project "${projectId}"!`
    )
    process.exit(2)
  }
  console.log('NF credentials valid!')
  console.log('Getting database addon')
  const databaseAddon = project.addons.find(({ id }) => id === addonId)

  if (!databaseAddon) {
    console.error(`No database addon with id "${addonId}" found!`)
    process.exit(1)
  }

  console.log('Getting backups')
  const { backups } = (
    await apiClient.get.addon.backups({
      parameters: { projectId, addonId }
    })
  ).data
  const [backupToExport] = backups.filter(
    (b) => b.config.source.type === 'sameAddon'
  )
  if (!backupToExport) {
    console.error('No backup to export!')
    process.exit(3)
  }
  console.log(`Got backup ${backupToExport.id}`, backupToExport)
  console.log('Getting download link')
  const { downloadLink } = (
    await apiClient.get.addon.backup.download({
      parameters: { projectId, addonId, backupId: backupToExport.id }
    })
  ).data
  console.log('Download link:', downloadLink)
  console.log('Streaming backup to AWS')

  const backupDownloadStream = await fetch(downloadLink).then((res) => res.body)
  const params = {
    Bucket: s3Bucket,
    Key: `${projectId}/${backupToExport.id}`,
    Body: backupDownloadStream
  }
  await s3.upload(params).promise()
  console.log(`Finished`)
})()

process.on('unhandledRejection', async (reason) => {
  console.error('unhandledRejection!', reason)
  process.exit(1)
})
process.on('uncaughtException', async (error) => {
  console.error('uncaughtException!', error)
  process.exit(1)
})
