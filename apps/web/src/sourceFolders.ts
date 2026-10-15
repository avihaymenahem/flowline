export type SourceFolderView = 'all' | 'ungrouped' | string

export function sourcesInFolder<T extends { folderId?: string }>(sources: T[], view: SourceFolderView): T[] {
  if (view === 'all') return sources
  if (view === 'ungrouped') return sources.filter(source => !source.folderId)
  return sources.filter(source => source.folderId === view)
}

export function validSourceFolderView(view: string, folderIds: Set<string>): boolean {
  return view === 'all' || view === 'ungrouped' || folderIds.has(view)
}

export function sourceIdFromDrag(types: string[], customValue: string, sourceIds: Set<string>): string | null {
  return types.some(type => type.toLocaleLowerCase() === 'application/x-traffic-source') && sourceIds.has(customValue) ? customValue : null
}

export function mergeOrganizationSourceSnapshot<T extends { id: string; folderId?: string }>(current: T[], incoming: T[], tombstones: Set<string> = new Set()): T[] {
  const currentById = new Map(current.map(source => [source.id, source]))
  return incoming.filter(source => !tombstones.has(source.id)).map(serverSource => {
    const latestLocal = currentById.get(serverSource.id)
    return latestLocal ? { ...serverSource, ...latestLocal, folderId: serverSource.folderId } : serverSource
  })
}
