import type { Scene, Summary, UniqueVehicleCompleteness } from './api'

export type UniqueVehicleScope = { kind: 'all' } | { kind: 'zone'; zoneId: string } | { kind: 'line'; lineId: string }
export type UniqueVehicleDisplay = { completeness: UniqueVehicleCompleteness; count: number | null }

function compareTupleIds(a: readonly unknown[], b: readonly unknown[]) {
  const firstA = String(a[0] ?? '')
  const firstB = String(b[0] ?? '')
  if (firstA < firstB) return -1
  if (firstA > firstB) return 1
  const jsonA = JSON.stringify(a)
  const jsonB = JSON.stringify(b)
  return jsonA < jsonB ? -1 : jsonA > jsonB ? 1 : 0
}

/** Must stay byte-for-byte compatible with the API's canonical g1 scene geometry signature. */
export function sceneGeometrySignature(scene: Scene) {
  const zones = scene.zones.map(zone => [zone.id, zone.polygon.map(point => [point.x, point.y])]).sort(compareTupleIds)
  const lines = scene.countingLines.map(line => [line.id, [line.start.x, line.start.y], [line.end.x, line.end.y]]).sort(compareTupleIds)
  return `g1:${JSON.stringify([zones, lines])}`
}

export function uniqueVehicleTotal(
  summary: Summary | null | undefined,
  expected: { sourceId: string; sessionId: string; geometrySignature: string } | null,
  scope: UniqueVehicleScope,
): UniqueVehicleDisplay {
  const unknown: UniqueVehicleDisplay = { completeness: 'unknown', count: null }
  const unique = summary?.uniqueVehicles
  if (!expected || !summary || summary.sourceId !== expected.sourceId || summary.sessionId !== expected.sessionId ||
      !unique || unique.sessionId !== expected.sessionId || unique.geometrySignature !== expected.geometrySignature) return unknown

  const value = scope.kind === 'all'
    ? unique.all
    : scope.kind === 'zone'
      ? unique.zones.find(item => item.zoneId === scope.zoneId)
      : unique.lines.find(item => item.lineId === scope.lineId)
  if (!value || (value.completeness !== 'known' && value.completeness !== 'partial') ||
      typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0) return unknown
  return { completeness: value.completeness, count: value.count }
}

export function formatUniqueVehicleCount(total: UniqueVehicleDisplay) {
  if (total.completeness === 'unknown' || total.count === null) return '—'
  return total.completeness === 'partial' ? `At least ${total.count}` : String(total.count)
}

export function uniqueVehicleCompletenessNote(completeness: UniqueVehicleCompleteness) {
  if (completeness === 'partial') return 'At least this many; some analysis history or monitoring coverage is incomplete, so this is a lower bound. Untracked detections are excluded; track IDs may fragment or be reused.'
  if (completeness === 'unknown') return 'Unavailable until counts are confirmed for the current source, session, and scene. Untracked detections are excluded.'
  return 'Untracked detections are excluded. Track identities are approximate and may fragment or be reused.'
}

export function uniqueVehicleScopeNote(scope: UniqueVehicleScope, hasZones: boolean) {
  if (scope.kind === 'line') return 'Distinct track IDs in this line’s crossing events, both directions counted once.'
  if (scope.kind === 'zone') return 'Distinct track IDs seen in this zone across the latest session. A track can appear in more than one zone.'
  if (hasZones) return 'Union across all zones; each track ID counts once even when it appears in multiple zones.'
  return 'Distinct track IDs observed in available sampled analysis in the latest session.'
}
