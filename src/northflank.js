const API = 'https://api.northflank.com/v1'

export function createNorthflankClient(token, fetchImpl = fetch) {
  async function get(path) {
    let response
    try {
      response = await fetchImpl(`${API}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(30000),
        redirect: 'error'
      })
    } catch {
      throw new Error('Northflank API request failed or timed out')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Northflank API returned HTTP ${response.status}`)
    }
    try {
      return await response.json()
    } catch {
      throw new Error('Northflank API returned invalid JSON')
    }
  }

  function addonPath(projectId, addonId) {
    return `/projects/${encodeURIComponent(projectId)}/addons/${encodeURIComponent(addonId)}/backups`
  }

  return {
    async listBackups(projectId, addonId) {
      const backups = []
      const seenCursors = new Set()
      let cursor
      for (let page = 1; page <= 1000; page++) {
        const query = new URLSearchParams({ per_page: '100' })
        if (cursor) query.set('cursor', cursor)
        else query.set('page', String(page))
        const result = await get(`${addonPath(projectId, addonId)}?${query}`)
        if (!Array.isArray(result.data?.backups)) {
          throw new Error('Northflank backup list is missing backups')
        }
        backups.push(...result.data.backups)
        if (!result.pagination?.hasNextPage) return backups
        cursor = result.pagination.cursor
        if (cursor && seenCursors.has(cursor)) {
          throw new Error('Northflank returned a repeated pagination cursor')
        }
        if (cursor) seenCursors.add(cursor)
      }
      throw new Error('Northflank backup pagination exceeded 1000 pages')
    },
    async downloadLink(projectId, addonId, backupId) {
      const result = await get(
        `${addonPath(projectId, addonId)}/${encodeURIComponent(backupId)}/download-link`
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
