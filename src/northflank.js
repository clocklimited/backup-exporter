const API = 'https://api.northflank.com/v1'

export function createNorthflankClient(
  token,
  fetchImpl = fetch,
  logger = console
) {
  async function request(path, operation, body) {
    logger.log(`Northflank: ${operation}`)
    let response
    try {
      response = await fetchImpl(`${API}${path}`, {
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(30000),
        redirect: 'error'
      })
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new Error(
          `Northflank API timed out after 30 seconds: ${operation}`
        )
      }
      const code = error?.cause?.code ?? error?.name
      const detail =
        typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code)
          ? ` (${code})`
          : ''
      throw new Error(`Northflank API request failed${detail}: ${operation}`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `Northflank API returned HTTP ${response.status}: ${operation}`
      )
    }
    try {
      return await response.json()
    } catch {
      throw new Error(`Northflank API returned invalid JSON: ${operation}`)
    }
  }

  function addonPath(projectId, addonId) {
    return `/projects/${encodeURIComponent(projectId)}/addons/${encodeURIComponent(addonId)}/backups`
  }

  return {
    async createBackup(projectId, addonId) {
      const result = await request(
        addonPath(projectId, addonId),
        `create native backup for ${projectId}/${addonId}`,
        { backupType: 'dump', compressionType: 'zstd' }
      )
      if (typeof result.data?.id !== 'string' || !result.data.id) {
        throw new Error('Northflank did not return the created backup ID')
      }
      return result.data.id
    },
    async getBackup(projectId, addonId, backupId) {
      const result = await request(
        `${addonPath(projectId, addonId)}/${encodeURIComponent(backupId)}`,
        `get backup ${backupId} for ${projectId}/${addonId}`
      )
      if (result.data?.id !== backupId) {
        throw new Error('Northflank returned a different backup ID')
      }
      return result.data
    },
    async listBackups(projectId, addonId) {
      const query = new URLSearchParams({ per_page: '50', page: '1' })
      const result = await request(
        `${addonPath(projectId, addonId)}?${query}`,
        `list backups for ${projectId}/${addonId} (page 1)`
      )
      if (!Array.isArray(result.data?.backups)) {
        throw new Error('Northflank backup list is missing backups')
      }
      return result.data.backups
    },
    async downloadLink(projectId, addonId, backupId) {
      const result = await request(
        `${addonPath(projectId, addonId)}/${encodeURIComponent(backupId)}/download-link`,
        `get backup download link for ${projectId}/${addonId}`
      )
      let url
      try {
        url = new URL(result.data?.downloadLink)
      } catch {
        throw new Error(
          'Northflank did not return a valid backup download link'
        )
      }
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('Northflank backup download link must use HTTPS')
      }
      return url.href
    }
  }
}
