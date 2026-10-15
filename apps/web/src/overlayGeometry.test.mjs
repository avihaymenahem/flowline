import test from 'node:test'
import assert from 'node:assert/strict'
import { containedImageRect, matchesAnalyzedFrame } from './overlayGeometry.ts'

test('contained image geometry accounts for both kinds of letterboxing', () => {
  assert.deepEqual(containedImageRect(16 / 9, 16 / 9), { left: 0, top: 0, width: 1, height: 1 })
  const portraitInWideStage = containedImageRect(16 / 9, 4 / 3)
  assert.ok(Math.abs(portraitInWideStage.left - 0.125) < 1e-10)
  assert.equal(portraitInWideStage.top, 0)
  assert.equal(portraitInWideStage.height, 1)
  const ultrawideInWideStage = containedImageRect(16 / 9, 21 / 9)
  assert.equal(ultrawideInWideStage.left, 0)
  assert.ok(Math.abs(ultrawideInWideStage.top - 5 / 42) < 1e-10)
  assert.equal(ultrawideInWideStage.width, 1)
})

test('sample matching accepts verified frame-time rounding but rejects nearby playback frames', () => {
  assert.equal(matchesAnalyzedFrame(5005.93, 5000), true)
  assert.equal(matchesAnalyzedFrame(5025, 5000), true)
  assert.equal(matchesAnalyzedFrame(5025.01, 5000), false)
  assert.equal(matchesAnalyzedFrame(Number.NaN, 5000), false)
})
