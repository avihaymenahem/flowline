import test from 'node:test'
import assert from 'node:assert/strict'
import { DetectionSchema } from '../dist/index.js'

const legacyDetection = {
  bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
  class: 'car',
  color: 'blue',
  confidence: 0.91,
  trackId: 'track-8',
}

test('legacy persisted detections remain valid without color provenance', () => {
  const parsed = DetectionSchema.parse(legacyDetection)
  assert.equal(parsed.color, 'blue')
  assert.equal(parsed.colorMethod, undefined)
  assert.equal(parsed.colorSupportRatio, undefined)
})

test('current HSV estimates accept bounded support metadata without treating it as confidence', () => {
  const parsed = DetectionSchema.parse({ ...legacyDetection, colorMethod: 'hsv_estimate', colorSupportRatio: 0.72 })
  assert.equal(parsed.colorMethod, 'hsv_estimate')
  assert.equal(parsed.colorSupportRatio, 0.72)
  assert.equal(DetectionSchema.safeParse({ ...legacyDetection, colorSupportRatio: 1.1 }).success, false)
  assert.equal(DetectionSchema.safeParse({ ...legacyDetection, colorMethod: 'heuristic_probability' }).success, false)
})
