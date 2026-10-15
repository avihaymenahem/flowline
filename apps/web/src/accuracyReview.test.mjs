import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accuracyDraftMatchesTarget, accuracyTargetFromEvent, buildAccuracyFeedbackBody, clampNormalizedBox, hasPinnedAccuracyFrame, isNormalizedBox } from './accuracyReview.ts'

const event = {
  id: 'event-1', frameId: 'frame-1', sourceId: 'source-a', sessionId: 'session-a', sourceTimeMs: 1200,
  frameWidth: 1920, frameHeight: 1080, detections: [{}, {}], crossings: [], type: 'analysis', quality: { coverage: 'known', notes: [] },
}

test('accuracy target requires exact source/session event identity and valid detection index', () => {
  const target = accuracyTargetFromEvent('source-a', event, 1)
  assert.equal(target?.frameId, 'frame-1')
  assert.equal(target?.detectionIndex, 1)
  assert.equal(accuracyTargetFromEvent('source-b', event), null)
  assert.equal(accuracyTargetFromEvent('source-a', { ...event, id: undefined }), null)
  assert.equal(accuracyTargetFromEvent('source-a', { ...event, frameWidth: 0 }), null)
  assert.equal(accuracyTargetFromEvent('source-a', event, 2), null)
})

test('draft pin must match the immutable source, session, event and frame before use', () => {
  const target = accuracyTargetFromEvent('source-a', event)
  assert.ok(target)
  assert.equal(accuracyDraftMatchesTarget({ sourceId: 'source-a', sessionId: 'session-a', eventId: 'event-1', frameId: 'frame-1' }, target), true)
  assert.equal(accuracyDraftMatchesTarget({ sourceId: 'source-b', sessionId: 'session-a', eventId: 'event-1', frameId: 'frame-1' }, target), false)
  assert.equal(accuracyDraftMatchesTarget({ sourceId: 'source-a', sessionId: 'session-b', eventId: 'event-1', frameId: 'frame-1' }, target), false)
  assert.equal(accuracyDraftMatchesTarget({ sourceId: 'source-a', sessionId: 'session-a', eventId: 'event-2', frameId: 'frame-1' }, target), false)
  assert.equal(accuracyDraftMatchesTarget({ sourceId: 'source-a', sessionId: 'session-a', eventId: 'event-1', frameId: 'frame-2' }, target), false)
  assert.equal(accuracyDraftMatchesTarget({ sourceId: 'source-a', sessionId: 'session-a', eventId: 'event-1', frame: { frameId: 'frame-1' } }, target), true)
})

test('only URL-bearing pinned evidence with recognized provenance can be displayed', () => {
  assert.equal(hasPinnedAccuracyFrame({ frameId: 'f1', url: '/api/pinned.jpg', provenance: 'analysis_source_frame' }), true)
  assert.equal(hasPinnedAccuracyFrame({ url: '/api/pinned.jpg', provenance: 'verified_media_redecode' }), true)
  assert.equal(hasPinnedAccuracyFrame({ frameId: 'f1', provenance: 'analysis_source_frame' }), false)
  assert.equal(hasPinnedAccuracyFrame({ frameId: 'f1', url: '/api/pinned.jpg', provenance: 'unavailable' }), false)
})

test('missed and duplicate reports require their spatial and comparison evidence', () => {
  const target = accuracyTargetFromEvent('source-a', event, 0)
  assert.ok(target)
  assert.deepEqual(buildAccuracyFeedbackBody('draft', target, { kind: 'missed_vehicle', correctedClassLabel: 'car' }), { error: 'Draw a box around the missed vehicle.' })
  assert.deepEqual(buildAccuracyFeedbackBody('draft', target, { kind: 'duplicate', detectionIndex: 0 }), { error: 'Select the other detection that overlaps this duplicate.' })
  assert.deepEqual(buildAccuracyFeedbackBody('draft', target, { kind: 'duplicate', detectionIndex: 0, duplicateOfDetectionIndex: 0 }), { error: 'Select the other detection that overlaps this duplicate.' })
  assert.deepEqual(buildAccuracyFeedbackBody('draft', target, { kind: 'missed_vehicle', detectionIndex: 0, missedBox: { x: .1, y: .2, width: .3, height: .2 }, correctedClassLabel: 'van' }), {
    eventId: 'event-1', frameId: 'frame-1', kind: 'missed_vehicle', bbox: { x: .1, y: .2, width: .3, height: .2 }, proposedCorrection: { correctedClassLabel: 'van' },
  })
})

test('wrong labels need proposed values and notes are trimmed and bounded', () => {
  const target = accuracyTargetFromEvent('source-a', event, 1)
  assert.ok(target)
  assert.deepEqual(buildAccuracyFeedbackBody('draft', target, { kind: 'wrong_color', detectionIndex: 1 }), { error: 'Choose the corrected color.' })
  const built = buildAccuracyFeedbackBody('draft', target, { kind: 'wrong_type', detectionIndex: 1, correctedClassLabel: 'pickup_truck', note: '  checked  ' })
  assert.deepEqual(built, { eventId: 'event-1', frameId: 'frame-1', kind: 'wrong_type', detectionIndex: 1, proposedCorrection: { correctedClassLabel: 'pickup_truck' }, note: 'checked' })
  const bounded = buildAccuracyFeedbackBody('draft', target, { kind: 'false_positive', detectionIndex: 1, note: 'x'.repeat(1200) })
  assert.equal(bounded.note?.length, 1000)
  assert.deepEqual(buildAccuracyFeedbackBody('', target, { kind: 'false_positive', detectionIndex: 0 }), { error: 'Reserve the analyzed frame before saving feedback.' })
  assert.deepEqual(buildAccuracyFeedbackBody('draft', target, { kind: 'wrong_type', detectionIndex: 1, correctedClassLabel: 'suv', correctedBox: { x: .2, y: .1, width: .3, height: .4 } }), {
    eventId: 'event-1', frameId: 'frame-1', kind: 'wrong_type', detectionIndex: 1, proposedCorrection: { correctedClassLabel: 'suv', bbox: { x: .2, y: .1, width: .3, height: .4 } },
  })
})

test('drawn boxes clamp to the image and reject zero-size/out-of-range boxes', () => {
  assert.deepEqual(clampNormalizedBox({ x: -.2, y: .4 }, { x: .3, y: 1.2 }), { x: 0, y: .4, width: .3, height: .6 })
  assert.equal(isNormalizedBox({ x: .8, y: .2, width: .3, height: .1 }), false)
  assert.equal(isNormalizedBox({ x: .2, y: .2, width: 0, height: .1 }), false)
})
