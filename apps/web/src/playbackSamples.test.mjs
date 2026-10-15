import test from 'node:test'
import assert from 'node:assert/strict'
import { interpolatePlaybackDetections, latestPlaybackSample } from './playbackSamples.ts'

const samples = [
  { id: 'later', sourceId: 'upload-a', sessionId: 'run-1', sourceTimeMs: 1000, type: 'analysis' },
  { id: 'first', sourceId: 'upload-a', sessionId: 'run-1', sourceTimeMs: 0, type: 'analysis' },
  { id: 'crossing', sourceId: 'upload-a', sessionId: 'run-1', sourceTimeMs: 1500, type: 'crossing', detections: [{ trackId: 'track-1' }] },
  { id: 'empty', sourceId: 'upload-a', sessionId: 'run-1', sourceTimeMs: 1750, type: 'analysis', detections: [] },
  { id: 'other-source', sourceId: 'upload-b', sessionId: 'run-1', sourceTimeMs: 2000, type: 'analysis' },
  { id: 'other-session', sourceId: 'upload-a', sessionId: 'run-2', sourceTimeMs: 2000, type: 'analysis' },
]

test('holds the latest eligible analyzed sample without selecting a future sample', () => {
  assert.equal(latestPlaybackSample(samples, 0, 'upload-a', 'run-1')?.id, 'first')
  assert.equal(latestPlaybackSample(samples, 1200, 'upload-a', 'run-1')?.id, 'later')
  assert.equal(latestPlaybackSample(samples, 1400, 'upload-a', 'run-1')?.id, 'later')
  assert.equal(latestPlaybackSample(samples, 1500, 'upload-a', 'run-1')?.id, 'crossing')
  assert.deepEqual(latestPlaybackSample(samples, 1800, 'upload-a', 'run-1')?.detections, [])
})

test('returns no overlay before the first sample or when the timeline has no valid sample', () => {
  assert.equal(latestPlaybackSample(samples, -1, 'upload-a', 'run-1'), undefined)
  assert.equal(latestPlaybackSample([], 500, 'upload-a', 'run-1'), undefined)
  assert.equal(latestPlaybackSample(samples, 500, 'upload-a', undefined), undefined)
  assert.equal(latestPlaybackSample(samples, Number.NaN, 'upload-a', 'run-1'), undefined)
})

test('isolates samples by source and session, independent of input ordering', () => {
  assert.equal(latestPlaybackSample(samples, 2500, 'upload-a', 'run-1')?.id, 'empty')
  assert.equal(latestPlaybackSample(samples, 2500, 'upload-b', 'run-1')?.id, 'other-source')
  assert.equal(latestPlaybackSample(samples, 2500, 'upload-a', 'run-2')?.id, 'other-session')
})

test('supports older sessions without imposing a sample-age cutoff', () => {
  const oldRun = [{ id: 'old', sourceId: 'upload-a', sessionId: 'old-run', sourceTimeMs: 1000, type: 'analysis' }]
  assert.equal(latestPlaybackSample(oldRun, 60_000, 'upload-a', 'old-run')?.id, 'old')
})

const box = (trackId, x, extra = {}) => ({ class: 'car', trackId, bbox: { x, y: 0.2, width: 0.1, height: 0.1 }, ...extra })
const analyzed = (sourceTimeMs, detections, extra = {}) => ({ sourceId: 'upload-a', sessionId: 'run-1', sourceTimeMs, type: 'analysis', detections, ...extra })

test('interpolates unique same-class tracks linearly and preserves actual detection metadata', () => {
  const first = analyzed(0, [box('track-1', 0.1)])
  const next = analyzed(1000, [box('track-1', 0.18)])
  const result = interpolatePlaybackDetections([first, next], first, 500, 'upload-a', 'run-1')
  assert.equal(result[0].bbox.x, 0.14)
  assert.equal(result[0].trackId, 'track-1')
  assert.equal(result[0].class, 'car')
  assert.equal(interpolatePlaybackDetections([first, next], first, 1000, 'upload-a', 'run-1')[0].bbox.x, 0.18)
})

test('holds boxes for untracked, new, disappearing, class-changed, and duplicate tracks', () => {
  const first = analyzed(0, [box(undefined, 0.05), box('stays', 0.1), box('leaves', 0.2), box('changes', 0.3), box('dup', 0.4), box('dup', 0.42)])
  const next = analyzed(1000, [box('stays', 0.2), box('new', 0.3), box('changes', 0.4, { class: 'truck' }), box('dup', 0.5)])
  const result = interpolatePlaybackDetections([first, next], first, 500, 'upload-a', 'run-1')
  assert.deepEqual(result.map(item => Number(item.bbox.x.toFixed(2))), [0.05, 0.15, 0.2, 0.3, 0.4, 0.42])
})

test('holds on large jumps, long gaps, absent future samples, or invalid normalized boxes', () => {
  const first = analyzed(0, [box('track', 0.1)])
  assert.equal(interpolatePlaybackDetections([first, analyzed(1000, [box('track', 0.8)])], first, 500, 'upload-a', 'run-1')[0].bbox.x, 0.1)
  assert.equal(interpolatePlaybackDetections([first, analyzed(2001, [box('track', 0.2)])], first, 500, 'upload-a', 'run-1')[0].bbox.x, 0.1)
  assert.ok(Math.abs(interpolatePlaybackDetections([first, analyzed(1016, [box('track', 0.2)])], first, 508, 'upload-a', 'run-1')[0].bbox.x - 0.15) < 1e-12)
  assert.equal(interpolatePlaybackDetections([first], first, 500, 'upload-a', 'run-1')[0].bbox.x, 0.1)
  const invalid = analyzed(0, [{ ...box('track', 0.95), bbox: { x: 0.95, y: 0.2, width: 0.1, height: 0.1 } }])
  assert.equal(interpolatePlaybackDetections([invalid, analyzed(500, [box('track', 0.8)])], invalid, 250, 'upload-a', 'run-1')[0].bbox.x, 0.95)
})

test('uses adjacent samples including crossing frames and isolates source and session', () => {
  const first = analyzed(0, [box('track', 0.1)])
  const crossing = { ...analyzed(400, [box('track', 0.14)]), type: 'crossing' }
  const next = analyzed(800, [box('track', 0.18)])
  const firstToCrossing = interpolatePlaybackDetections([first, crossing, next], first, 200, 'upload-a', 'run-1')[0]
  const crossingToNext = interpolatePlaybackDetections([first, crossing, next], crossing, 600, 'upload-a', 'run-1')[0]
  assert.ok(Math.abs(firstToCrossing.bbox.x - 0.12) < 1e-12)
  assert.ok(Math.abs(crossingToNext.bbox.x - 0.16) < 1e-12)
  assert.equal(interpolatePlaybackDetections([first, { ...next, sourceId: 'upload-b' }], first, 400, 'upload-a', 'run-1')[0].bbox.x, 0.1)
  assert.equal(interpolatePlaybackDetections([first, { ...next, sessionId: 'run-2' }], first, 400, 'upload-a', 'run-1')[0].bbox.x, 0.1)
  assert.equal(interpolatePlaybackDetections([first, next], first, 500, 'upload-a', 'run-2')[0].bbox.x, 0.1)
})

test('holds on quality-reported gaps and clock resets in either endpoint', () => {
  const first = analyzed(0, [box('track', 0.1)])
  const next = analyzed(1000, [box('track', 0.18)])
  for (const note of ['sampling_gap_detected', 'source_clock_reset']) {
    assert.equal(interpolatePlaybackDetections([first, { ...next, quality: { notes: [note] } }], first, 500, 'upload-a', 'run-1')[0].bbox.x, 0.1)
    assert.equal(interpolatePlaybackDetections([{ ...first, quality: { notes: [note] } }, next], first, 500, 'upload-a', 'run-1')[0].bbox.x, 0.1)
  }
})

test('holds when either sample has unknown coverage', () => {
  const first = analyzed(0, [box('track', 0.1)], { quality: { coverage: 'known', notes: [] } })
  const next = analyzed(1000, [box('track', 0.18)], { quality: { coverage: 'unknown', notes: [] } })
  assert.equal(interpolatePlaybackDetections([first, next], first, 500, 'upload-a', 'run-1')[0].bbox.x, 0.1)
  const unknownFirst = { ...first, quality: { coverage: 'unknown', notes: [] } }
  const knownNext = { ...next, quality: { coverage: 'known', notes: [] } }
  assert.equal(interpolatePlaybackDetections([unknownFirst, knownNext], unknownFirst, 500, 'upload-a', 'run-1')[0].bbox.x, 0.1)
})

test('accepts plausible motion but holds large steps relative to tiny boxes and large size changes', () => {
  const normalStart = analyzed(0, [{ ...box('normal', 0.1), bbox: { x: 0.1, y: 0.2, width: 0.04, height: 0.04 } }])
  const normalEnd = analyzed(1000, [{ ...box('normal', 0.18), bbox: { x: 0.18, y: 0.2, width: 0.04, height: 0.04 } }])
  assert.ok(Math.abs(interpolatePlaybackDetections([normalStart, normalEnd], normalStart, 500, 'upload-a', 'run-1')[0].bbox.x - 0.14) < 1e-12)

  const tinyStart = analyzed(0, [{ ...box('tiny', 0.1), bbox: { x: 0.1, y: 0.2, width: 0.01, height: 0.01 } }])
  const tinyEnd = analyzed(1000, [{ ...box('tiny', 0.18), bbox: { x: 0.18, y: 0.2, width: 0.01, height: 0.01 } }])
  assert.equal(interpolatePlaybackDetections([tinyStart, tinyEnd], tinyStart, 500, 'upload-a', 'run-1')[0].bbox.x, 0.1)

  const sizeStart = analyzed(0, [{ ...box('size', 0.2), bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } }])
  const sizeEnd = analyzed(1000, [{ ...box('size', 0.15), bbox: { x: 0.15, y: 0.2, width: 0.21, height: 0.1 } }])
  assert.equal(interpolatePlaybackDetections([sizeStart, sizeEnd], sizeStart, 500, 'upload-a', 'run-1')[0].bbox.x, 0.2)
})

test('does not mutate the analyzed samples and never includes future-only detections', () => {
  const first = analyzed(0, [box('track', 0.1)])
  const futureOnly = box('future-only', 0.4)
  const next = analyzed(1000, [box('track', 0.18), futureOnly])
  const original = structuredClone([first, next])
  const result = interpolatePlaybackDetections([first, next], first, 500, 'upload-a', 'run-1')
  assert.equal(result.length, 1)
  assert.equal(result[0].bbox.x, 0.14)
  assert.deepEqual([first, next], original)
  assert.equal(latestPlaybackSample([first, next], 500, 'upload-a', 'run-1'), first)
})
