import test from 'node:test'
import assert from 'node:assert/strict'
import { appendScenePoint, canAcceptScenePoint } from './scenePoints.ts'

test('line drafts accept two finite points, then retain the capped draft', () => {
  const first = appendScenePoint([], { x: 0.2, y: 0.3 }, 2)
  const second = appendScenePoint(first, { x: 0.8, y: 0.7 }, 2)
  const third = appendScenePoint(second, { x: 0.5, y: 0.5 }, 2)
  assert.equal(first.length, 1)
  assert.equal(second.length, 2)
  assert.strictEqual(third, second)
})

test('zone drafts can continue past the line limit and reject invalid normalized points', () => {
  const points = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }]
  assert.equal(appendScenePoint(points, { x: 0.8, y: 0.8 }, 128).length, 3)
  assert.strictEqual(appendScenePoint(points, { x: Number.NaN, y: 0.4 }, 128), points)
})

test('point permission rejects stale mode, readiness, running, seek, and source state', () => {
  const ready = { sourceId: 'a', eventSourceId: 'a', armed: true, canEdit: true, sourceRunning: false, mediaReady: true, isUpload: true, mediaPaused: true, mediaSeeking: false, point: { x: 0.4, y: 0.6 } }
  assert.equal(canAcceptScenePoint(ready), true)
  for (const patch of [
    { armed: false }, { canEdit: false }, { sourceRunning: true }, { mediaReady: false },
    { mediaPaused: false }, { mediaSeeking: true }, { eventSourceId: 'b' },
  ]) assert.equal(canAcceptScenePoint({ ...ready, ...patch }), false)
  assert.equal(canAcceptScenePoint({ ...ready, point: { x: 1.01, y: 0.5 } }), false)
})
