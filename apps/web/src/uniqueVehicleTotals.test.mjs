import test from 'node:test'
import assert from 'node:assert/strict'
import { formatUniqueVehicleCount, sceneGeometrySignature, uniqueVehicleCompletenessNote, uniqueVehicleScopeNote, uniqueVehicleTotal } from './uniqueVehicleTotals.ts'

const scene = {
  zones: [
    { id: 'z-b', name: 'Second name', polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] },
    { id: 'z-a', name: 'First name', polygon: [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }] },
  ],
  countingLines: [{ id: 'l-1', name: 'North', directionLabels: ['in', 'out'], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }],
}
const signature = sceneGeometrySignature(scene)
const summary = {
  sourceId: 'source-1',
  sessionId: 'session-7',
  coverage: 'known',
  uniqueVehicles: {
    sessionId: 'session-7',
    geometrySignature: signature,
    completeness: 'partial',
    note: 'Distinct tracked IDs observed in sampled frames; IDs may fragment or be reused.',
    all: { count: 5, completeness: 'partial' },
    zones: [
      { zoneId: 'z-a', count: 2, completeness: 'known' },
      { zoneId: 'z-b', count: 0, completeness: 'known' },
    ],
    lines: [{ lineId: 'l-1', count: 3, completeness: 'partial' }],
  },
}
const expected = { sourceId: 'source-1', sessionId: 'session-7', geometrySignature: signature }

test('scene geometry signature is order and label stable but changes with geometry', () => {
  const reordered = {
    zones: [...scene.zones].reverse().map(zone => ({ ...zone, name: `renamed ${zone.name}` })),
    countingLines: scene.countingLines.map(line => ({ ...line, name: 'renamed', directionLabels: ['left', 'right'] })),
  }
  assert.equal(sceneGeometrySignature(reordered), signature)
  const moved = { ...reordered, zones: reordered.zones.map(zone => zone.id === 'z-a' ? { ...zone, polygon: [{ x: 2.1, y: 2 }, ...zone.polygon.slice(1)] } : zone) }
  assert.notEqual(sceneGeometrySignature(moved), signature)
})

test('reads known zero, per-zone, line, and partial session-wide counts from the exact owner', () => {
  assert.deepEqual(uniqueVehicleTotal(summary, expected, { kind: 'all' }), { count: 5, completeness: 'partial' })
  assert.deepEqual(uniqueVehicleTotal(summary, expected, { kind: 'zone', zoneId: 'z-a' }), { count: 2, completeness: 'known' })
  assert.deepEqual(uniqueVehicleTotal(summary, expected, { kind: 'zone', zoneId: 'z-b' }), { count: 0, completeness: 'known' })
  assert.deepEqual(uniqueVehicleTotal(summary, expected, { kind: 'line', lineId: 'l-1' }), { count: 3, completeness: 'partial' })
  assert.equal(formatUniqueVehicleCount(uniqueVehicleTotal(summary, expected, { kind: 'zone', zoneId: 'z-b' })), '0')
  assert.equal(formatUniqueVehicleCount(uniqueVehicleTotal(summary, expected, { kind: 'line', lineId: 'l-1' })), 'At least 3')
})

test('hides absent, unknown, stale-source/session/geometry, and deleted-scope totals instead of showing zero', () => {
  const unknown = { completeness: 'unknown', count: null }
  assert.deepEqual(uniqueVehicleTotal(null, expected, { kind: 'all' }), unknown)
  assert.deepEqual(uniqueVehicleTotal(summary, null, { kind: 'all' }), unknown)
  assert.deepEqual(uniqueVehicleTotal(summary, { ...expected, sourceId: 'other' }, { kind: 'all' }), unknown)
  assert.deepEqual(uniqueVehicleTotal(summary, { ...expected, sessionId: 'old-session' }, { kind: 'all' }), unknown)
  assert.deepEqual(uniqueVehicleTotal(summary, { ...expected, geometrySignature: 'g1:stale' }, { kind: 'all' }), unknown)
  assert.deepEqual(uniqueVehicleTotal(summary, expected, { kind: 'zone', zoneId: 'removed-zone' }), unknown)
  assert.deepEqual(uniqueVehicleTotal({ ...summary, uniqueVehicles: { ...summary.uniqueVehicles, all: { count: 0, completeness: 'unknown' } } }, expected, { kind: 'all' }), unknown)
  assert.equal(formatUniqueVehicleCount(unknown), '—')
})

test('scope explanations preserve union and direction semantics', () => {
  assert.match(uniqueVehicleScopeNote({ kind: 'all' }, true), /Union across all zones/)
  assert.match(uniqueVehicleScopeNote({ kind: 'all' }, false), /available sampled analysis/)
  assert.doesNotMatch(uniqueVehicleScopeNote({ kind: 'all' }, false), /full-frame/)
  assert.match(uniqueVehicleScopeNote({ kind: 'zone', zoneId: 'z-a' }, true), /more than one zone/)
  assert.match(uniqueVehicleScopeNote({ kind: 'line', lineId: 'l-1' }, true), /both directions counted once/)
})

test('partial and complete copy explains lower bounds and tracker limitations without overstating the cause', () => {
  const partial = uniqueVehicleCompletenessNote('partial')
  assert.match(partial, /analysis history or monitoring coverage is incomplete/)
  assert.match(partial, /lower bound/)
  assert.match(partial, /Untracked detections are excluded/)
  assert.match(partial, /fragment or be reused/)
  assert.doesNotMatch(partial, /previous scene geometry/)
})
