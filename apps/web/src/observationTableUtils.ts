import type { TrafficEvent } from './api'
import { vehicleColorKey, vehicleTypeKey } from './vehicleTypes'
import type { ObservationRow } from './ObservationTable'

export function stableObservationKey(event: TrafficEvent, detectionIndex: number): string {
  return `${event.id ?? `${event.sessionId}-${event.sourceTimeMs}`}-${detectionIndex}`
}

export function matchesObservationFilters(row: ObservationRow, classFilter: string, colorFilter: string): boolean {
  return (classFilter === 'all' || vehicleTypeKey(row.d.class) === classFilter)
    && (colorFilter === 'all' || vehicleColorKey(row.d.color) === colorFilter)
}

export function virtualObservationIndexes(count: number, startIndex: number, endIndex: number, overscan = 8): number[] {
  if (count <= 0 || endIndex < startIndex) return []
  const start = Math.max(0, Math.floor(startIndex) - Math.max(0, overscan))
  const end = Math.min(count - 1, Math.ceil(endIndex) + Math.max(0, overscan))
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index)
}

export function compareNumeric(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1
}
