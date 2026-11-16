import { setTimeout as sleep } from 'node:timers/promises'

export async function waitForNativeBackup({
  northflank,
  projectId,
  addonId,
  backupId,
  timeoutMs,
  logger = console,
  now = Date.now,
  wait = sleep
}) {
  const deadline = now() + timeoutMs
  let lastStatus
  while (now() < deadline) {
    const backup = await northflank.getBackup(projectId, addonId, backupId)
    if (backup.id !== backupId)
      throw new Error('Northflank returned a different backup ID')
    if (backup.status !== lastStatus) {
      logger.log(`Native backup ${backupId}: ${backup.status}`)
      lastStatus = backup.status
    }
    if (backup.status === 'completed') return backup
    if (!['scheduled', 'in-progress'].includes(backup.status)) {
      throw new Error(
        `Native backup ${backupId} ended with status ${backup.status}`
      )
    }
    await wait(Math.max(0, Math.min(30000, deadline - now())))
  }
  throw new Error(
    `Timed out waiting for native backup ${backupId}; inspect it before retrying with BACKUP_ID`
  )
}
