import test from 'node:test'
import assert from 'node:assert/strict'
import { detectionsInLatestZoneSample, detectionsInMonitoringScope, isCurrentDisplayedSample, lineCrossingCount } from './totalsScope.ts'
import { countByVehicleColor, countByVehicleType } from './vehicleTypes.ts'

const detection = (centerX, centerY, vehicleClass = 'car', color = 'blue') => ({
  class: vehicleClass,
  confidence: 0.9,
  color,
  bbox: { x: centerX - 0.05, y: centerY - 0.05, width: 0.1, height: 0.1 },
})

const event = (detections, coverage = 'known') => ({ detections, quality: { coverage, notes: [] } })

test('zone scope uses bbox centers, accepts polygon boundaries, and respects concave cutouts', () => {
  const zone = { polygon: [
    { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 },
    { x: 1, y: 1 }, { x: 1, y: 4 }, { x: 0, y: 4 },
  ] }
  const sample = event([
    detection(0.5, 3, 'car'),          // inside lower stem
    detection(1, 2, 'truck'),          // on the concave polygon boundary
    detection(3, 3, 'bus'),            // in the concavity, outside the zone
    detection(4.1, 0.5, 'motorcycle'), // outside the outer boundary
  ])

  assert.deepEqual(detectionsInLatestZoneSample(sample, zone).map(item => item.class), ['car', 'truck'])
})

test('zone type and color breakdowns sum over exactly the filtered detections', () => {
  const zone = { polygon: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }] }
  const selected = detectionsInLatestZoneSample(event([
    detection(0.5, 0.5, 'car', 'blue'),
    detection(1, 1, 'truck', 'blue'),
    detection(3, 3, 'bus', 'red'),
  ]), zone)

  assert.equal(selected.length, 2)
  assert.equal(countByVehicleType(selected).reduce((sum, item) => sum + item.count, 0), selected.length)
  assert.equal(countByVehicleColor(selected).reduce((sum, item) => sum + item.count, 0), selected.length)
  assert.deepEqual(countByVehicleType(selected).map(item => [item.key, item.count]), [['car', 1], ['truck', 1]])
  assert.deepEqual(countByVehicleColor(selected).map(item => [item.key, item.count]), [['blue', 2]])
})

test('known empty latest sample is zero while a missing or unknown sample is unavailable', () => {
  const zone = { polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }
  assert.deepEqual(detectionsInLatestZoneSample(event([]), zone), [])
  assert.equal(detectionsInLatestZoneSample(undefined, zone), null)
  assert.equal(detectionsInLatestZoneSample(event([], 'unknown'), zone), null)
})

test('All zones is a union, counts overlapping zones once, and falls back to full frame only when none exist', () => {
  const zones = [
    { polygon: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }] },
    { polygon: [{ x: 1, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }, { x: 1, y: 2 }] },
  ]
  const sample = event([detection(0.5, 1), detection(1.5, 1), detection(2.5, 1), detection(4, 1)])

  assert.equal(detectionsInMonitoringScope(sample, zones).length, 3)
  assert.equal(detectionsInMonitoringScope(sample, zones, zones[0]).length, 2)
  assert.equal(detectionsInMonitoringScope(sample, []).length, 4)
  assert.equal(detectionsInMonitoringScope(sample, undefined), null)
})

test('sample counts follow the displayed matched frame, not the latest event, and reject stale context', () => {
  const north = { polygon: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }] }
  const displayed = { ...event([detection(0.5, 1), detection(3, 1)]), sourceId: 'source-a', sessionId: 'session-a', sourceTimeMs: 0 }
  const later = { ...event([detection(0.5, 1), detection(1, 1), detection(1.5, 1), detection(3, 1)]), sourceId: 'source-a', sessionId: 'session-a', sourceTimeMs: 180889 }

  assert.equal(detectionsInMonitoringScope(displayed, [north]).length, 1)
  assert.equal(detectionsInMonitoringScope(later, [north]).length, 3)
  assert.equal(isCurrentDisplayedSample(displayed, 'source-a', 'session-a'), true)
  assert.equal(isCurrentDisplayedSample(displayed, 'source-b', 'session-a'), false)
  assert.equal(isCurrentDisplayedSample(displayed, 'source-a', 'session-b'), false)
  assert.equal(isCurrentDisplayedSample(null, 'source-a', 'session-a'), false)
})

test('line scope uses cumulative summary counts for that line, independent of retained events', () => {
  const retainedEventWindow = []
  const summary = {
    coverage: 'known',
    crossings: [
      { lineId: 'north', direction: 'Inbound', count: 7 },
      { lineId: 'north', direction: 'Outbound', count: 4 },
      { lineId: 'south', direction: 'Inbound', count: 99 },
    ],
  }

  assert.equal(retainedEventWindow.length, 0)
  assert.equal(lineCrossingCount(summary, 'north'), 11)
  assert.equal(lineCrossingCount(summary, 'south'), 99)
  assert.equal(lineCrossingCount(summary, 'missing-line'), 0)
  assert.equal(lineCrossingCount({ ...summary, coverage: 'unknown' }, 'north'), null)
  assert.equal(lineCrossingCount(undefined, 'north'), null)
})
