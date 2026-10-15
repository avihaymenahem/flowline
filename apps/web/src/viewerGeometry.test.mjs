import test from 'node:test'
import assert from 'node:assert/strict'
import { clampViewerPan, pinchViewerPan, viewerPointToImage, zoomViewerAtPoint } from './viewerGeometry.ts'

const bounds = { left: 100, top: 50, width: 800, height: 450 }
const contain = { left: 0, top: 0, width: 1, height: 1 }

test('annotation coordinates invert viewer zoom and pan', () => {
  const pan = zoomViewerAtPoint(1, 4, 0, 0, 600, 250, bounds, contain)
  const imagePoint = { x: 0.625, y: 0.4444444444444444 }
  const screenPoint = {
    x: bounds.left + bounds.width / 2 + pan.x + (imagePoint.x - 0.5) * bounds.width * 4,
    y: bounds.top + bounds.height / 2 + pan.y + (imagePoint.y - 0.5) * bounds.height * 4,
  }
  const restored = viewerPointToImage(screenPoint.x, screenPoint.y, bounds, 4, pan.x, pan.y, contain)
  assert.ok(restored)
  assert.ok(Math.abs(restored.x - imagePoint.x) < 1e-10)
  assert.ok(Math.abs(restored.y - imagePoint.y) < 1e-10)
})

test('focal zoom retains the selected image point and pan stays within image bounds', () => {
  const initial = { x: 35, y: -20 }
  const next = zoomViewerAtPoint(2, 4, initial.x, initial.y, 650, 300, bounds, contain)
  const limited = clampViewerPan(1900, -900, 4, bounds, contain)
  assert.deepEqual(limited, { x: 1200, y: -675 })
  const before = (650 - bounds.width / 2 - initial.x) / 2 + bounds.width / 2
  const after = (650 - bounds.width / 2 - next.x) / 4 + bounds.width / 2
  const beforeY = (300 - bounds.height / 2 - initial.y) / 2 + bounds.height / 2
  const afterY = (300 - bounds.height / 2 - next.y) / 4 + bounds.height / 2
  assert.ok(Math.abs(before - after) < 1e-10)
  assert.ok(Math.abs(beforeY - afterY) < 1e-10)
})

test('pan clamp respects the visible content edge for letterboxed video', () => {
  const portrait = { left: 0.125, top: 0, width: 0.75, height: 1 }
  assert.deepEqual(clampViewerPan(1000, 1000, 4, bounds, portrait), { x: 800, y: 675 })
  const landscapeInTallStage = { left: 0, top: 0.125, width: 1, height: 0.75 }
  assert.deepEqual(clampViewerPan(-1900, -1000, 4, bounds, landscapeInTallStage), { x: -1200, y: -450 })
})

test('pinch zoom preserves the image point while the midpoint moves', () => {
  const pan = pinchViewerPan(2, 3, 40, -15, { x: 350, y: 220 }, { x: 390, y: 250 }, bounds, contain)
  const before = { x: (350 - bounds.width / 2 - 40) / 2, y: (220 - bounds.height / 2 + 15) / 2 }
  const after = { x: (390 - bounds.width / 2 - pan.x) / 3, y: (250 - bounds.height / 2 - pan.y) / 3 }
  assert.ok(Math.abs(before.x - after.x) < 1e-10)
  assert.ok(Math.abs(before.y - after.y) < 1e-10)
})

test('letterboxed points in bars are rejected after inverse transform', () => {
  const portrait = { left: 0.125, top: 0, width: 0.75, height: 1 }
  assert.equal(viewerPointToImage(105, 275, bounds, 1, 0, 0, portrait), null)
  assert.deepEqual(viewerPointToImage(200, 275, bounds, 1, 0, 0, portrait), { x: 0, y: 0.5 })
})
