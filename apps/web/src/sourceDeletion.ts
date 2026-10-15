import { pageLocationFromPath } from './pageRouting'

export function shouldNavigateAfterSourceDelete(pathname: string, deletedSourceId: string, pendingSourceId: string | null = null): boolean {
  if (pendingSourceId && pendingSourceId !== deletedSourceId) return false
  return pageLocationFromPath(pathname)?.sourceId === deletedSourceId
}
