import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceLocationSchema, SourceSchema } from '../dist/index.js'

test('source location accepts world-coordinate boundaries and trims an optional label', () => {
  assert.deepEqual(SourceLocationSchema.parse({ latitude: -90, longitude: 180, label: '  Downtown  ' }), {
    latitude: -90, longitude: 180, label: 'Downtown'
  })
  assert.deepEqual(SourceLocationSchema.parse({ latitude: 90, longitude: -180 }), { latitude: 90, longitude: -180 })
})

test('source location rejects non-finite and out-of-range coordinates and invalid labels', () => {
  for (const location of [
    { latitude: 90.01, longitude: 0 }, { latitude: -90.01, longitude: 0 },
    { latitude: 0, longitude: 180.01 }, { latitude: 0, longitude: -180.01 },
    { latitude: Number.NaN, longitude: 0 }, { latitude: 0, longitude: Number.POSITIVE_INFINITY },
    { latitude: 0, longitude: 0, label: ' \t ' }, { latitude: 0, longitude: 0, label: 'x'.repeat(121) },
    { latitude: 0, longitude: 0, extra: true }
  ]) assert.equal(SourceLocationSchema.safeParse(location).success, false)
})

test('existing sources remain valid without a saved location', () => {
  const oldSource = { id: '00000000-0000-4000-8000-000000000001', name: 'Existing camera', kind: 'webcam', status: 'stopped', createdAt: new Date(0).toISOString() }
  assert.equal(SourceSchema.parse(oldSource).location, undefined)
})
