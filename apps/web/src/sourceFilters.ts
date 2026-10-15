import type { Source, SourceKind, SourceStatus } from './api'
import { sourcesInFolder, type SourceFolderView } from './sourceFolders'

export type SourceSort = 'manual' | 'name-asc' | 'name-desc' | 'newest' | 'oldest' | 'status'
export type SourceListFilters = { query: string; type: 'all' | SourceKind; status: 'all' | SourceStatus; sort: SourceSort }
export type SourceListFilterPatch = Partial<SourceListFilters>

export const sourceTypeOptions: { value: SourceKind; label: string }[] = [
  { value: 'upload', label: 'Video upload' },
  { value: 'webcam', label: 'Webcam' },
  { value: 'stream', label: 'Direct stream' },
  { value: 'youtube', label: 'YouTube' },
]
export const sourceStatusOptions: { value: SourceStatus; label: string }[] = [
  { value: 'running', label: 'Running' },
  { value: 'idle', label: 'Idle' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'completed', label: 'Completed' },
  { value: 'error', label: 'Error' },
]
export const sourceSortOptions: { value: SourceSort; label: string }[] = [
  { value: 'manual', label: 'Saved order' },
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'status', label: 'Status' },
]

const validTypes = new Set(['all', ...sourceTypeOptions.map(option => option.value)])
const validStatuses = new Set(['all', ...sourceStatusOptions.map(option => option.value)])
const validSorts = new Set<string>(sourceSortOptions.map(option => option.value))

function paramsFrom(search: string | URLSearchParams): URLSearchParams {
  return search instanceof URLSearchParams ? search : new URLSearchParams(search)
}

export function sourceListFiltersFromSearch(search: string | URLSearchParams): SourceListFilters {
  const params = paramsFrom(search)
  const type = params.get('type') ?? 'all'
  const status = params.get('status') ?? 'all'
  const sort = params.get('sort') ?? 'manual'
  return {
    query: params.get('q') ?? '',
    type: (validTypes.has(type) ? type : 'all') as SourceListFilters['type'],
    status: (validStatuses.has(status) ? status : 'all') as SourceListFilters['status'],
    sort: (validSorts.has(sort) ? sort : 'manual') as SourceSort,
  }
}

export function normalizeSourceListSearch(search: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  if (typeof search.folder === 'string' && search.folder) normalized.folder = search.folder
  const query = typeof search.q === 'string' ? search.q : ''
  if (query) normalized.q = query
  const type = typeof search.type === 'string' ? search.type : 'all'
  if (validTypes.has(type) && type !== 'all') normalized.type = type
  const status = typeof search.status === 'string' ? search.status : 'all'
  if (validStatuses.has(status) && status !== 'all') normalized.status = status
  const sort = typeof search.sort === 'string' ? search.sort : 'manual'
  if (validSorts.has(sort) && sort !== 'manual') normalized.sort = sort
  return normalized
}

export function updateSourceListSearch(search: Record<string, unknown>, patch: SourceListFilterPatch): Record<string, unknown> {
  const current = sourceListFiltersFromSearch(new URLSearchParams(Object.entries(search).filter((entry): entry is [string, string] => typeof entry[1] === 'string')))
  return normalizeSourceListSearch({ ...search, q: patch.query ?? current.query, type: patch.type ?? current.type, status: patch.status ?? current.status, sort: patch.sort ?? current.sort })
}

export function filterAndSortSources(sources: Source[], folder: SourceFolderView, filters: SourceListFilters): Source[] {
  const query = filters.query.trim().toLocaleLowerCase()
  const matching = sourcesInFolder(sources, folder).filter(source =>
    source.name.toLocaleLowerCase().includes(query) &&
    (filters.type === 'all' || source.kind === filters.type) &&
    (filters.status === 'all' || source.status === filters.status),
  )
  if (filters.sort === 'manual') return matching
  const statusOrder: Record<SourceStatus, number> = { running: 0, idle: 1, stopped: 2, completed: 3, error: 4 }
  return matching.sort((a, b) => {
    if (filters.sort === 'name-asc') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    if (filters.sort === 'name-desc') return b.name.localeCompare(a.name, undefined, { sensitivity: 'base', numeric: true })
    if (filters.sort === 'newest') return b.createdAt.localeCompare(a.createdAt)
    if (filters.sort === 'oldest') return a.createdAt.localeCompare(b.createdAt)
    return statusOrder[a.status] - statusOrder[b.status]
  })
}

export function canReorderSources(filters: SourceListFilters): boolean {
  return filters.sort === 'manual' && !filters.query.trim() && filters.type === 'all' && filters.status === 'all'
}

export function canDropSourceIntoFolder(sourceFolderId: string | null, targetFolderId: string | null, reorderAllowed: boolean): boolean {
  return sourceFolderId !== targetFolderId || reorderAllowed
}
