export type Page = 'overview' | 'live' | 'sources' | 'observations' | 'processing'
export type PageLocation = { page: Page; sourceId: string | null }

export const pagePaths = {
  overview: '/overview',
  live: '/live',
  sources: '/sources',
  observations: '/observations',
  processing: '/processing',
} as const satisfies Record<Page, string>

function normalizedPath(pathname: string): string {
  const path = pathname.replace(/\/+$/, '')
  return path || '/'
}

export function pageLocationFromPath(pathname: string): PageLocation | null {
  const path = normalizedPath(pathname)
  if (path === '/') return { page: 'overview', sourceId: null }

  for (const [page, basePath] of Object.entries(pagePaths) as [Page, string][]) {
    if (path === basePath) return { page, sourceId: null }
    if (!path.startsWith(`${basePath}/`)) continue
    const segment = path.slice(basePath.length + 1)
    if (!segment || segment.includes('/')) return null
    try {
      const sourceId = decodeURIComponent(segment)
      return sourceId && !sourceId.includes('/') ? { page, sourceId } : null
    } catch {
      return null
    }
  }
  return null
}

export function pageFromPath(pathname: string): Page | null {
  return pageLocationFromPath(pathname)?.page ?? null
}

export function pagePathFor(page: Page, sourceId?: string | null): string {
  return sourceId ? `${pagePaths[page]}/${encodeURIComponent(sourceId)}` : pagePaths[page]
}

export function searchAfterSourceCanonicalization(page: Page, search: Record<string, unknown>): Record<string, unknown> {
  return page === 'sources' ? normalizeSourceListSearch(search) : {}
}
import { normalizeSourceListSearch } from './sourceFilters'
