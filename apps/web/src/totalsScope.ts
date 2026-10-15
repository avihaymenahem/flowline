import type { Point, SceneZone, Summary, TrafficEvent } from './api'

function pointInPolygonInclusive(point: Point, polygon: Point[]) {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!, b = polygon[i]!
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x)
    const withinSegment = Math.abs(cross) < 1e-9 && point.x >= Math.min(a.x, b.x) - 1e-9 && point.x <= Math.max(a.x, b.x) + 1e-9 && point.y >= Math.min(a.y, b.y) - 1e-9 && point.y <= Math.max(a.y, b.y) + 1e-9
    if (withinSegment) return true
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Returns null until a known-coverage sample exists; an empty array is a measured zero. */
export function detectionsInLatestZoneSample(event: TrafficEvent | undefined, zone: Pick<SceneZone, 'polygon'>) {
  if (!event || event.quality.coverage !== 'known') return null
  return event.detections.filter(detection => pointInPolygonInclusive({
    x: detection.bbox.x + detection.bbox.width / 2,
    y: detection.bbox.y + detection.bbox.height / 2,
  }, zone.polygon))
}

/** Returns null while scene bounds or a known-coverage sample is unavailable. */
export function detectionsInMonitoringScope(event: TrafficEvent | undefined, zones: SceneZone[] | undefined, selectedZone?: Pick<SceneZone, 'polygon'>) {
  if (!event || event.quality.coverage !== 'known' || !zones) return null
  if (selectedZone) return detectionsInLatestZoneSample(event, selectedZone)
  if (!zones.length) return event.detections
  return event.detections.filter(detection => {
    const center = {
      x: detection.bbox.x + detection.bbox.width / 2,
      y: detection.bbox.y + detection.bbox.height / 2,
    }
    return zones.some(zone => pointInPolygonInclusive(center, zone.polygon))
  })
}

/** Rejects delayed child updates after the source or analyzed session has changed. */
export function isCurrentDisplayedSample(event: TrafficEvent | null | undefined, sourceId: string | null | undefined, sessionId: string | null | undefined) {
  return !!event && !!sourceId && !!sessionId && event.sourceId === sourceId && event.sessionId === sessionId
}

/** Uses the cumulative summary contract, independent of the retained event window. */
export function lineCrossingCount(summary: Pick<Summary, 'coverage' | 'crossings'> | null | undefined, lineId: string) {
  if (!summary || summary.coverage !== 'known') return null
  return summary.crossings.filter(crossing => crossing.lineId === lineId).reduce((total, crossing) => total + crossing.count, 0)
}
