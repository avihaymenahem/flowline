import test from 'node:test'
import assert from 'node:assert/strict'
import { locationMapBounds, longitudeOnVisibleWorldCopy, normalizeLongitude, parseCameraLocationInput } from './cameraLocation.ts'

test('location editor requires explicit finite coordinates in latitude and longitude ranges', () => {
  assert.deepEqual(parseCameraLocationInput({ latitude: '', longitude: '0', label: '' }), { error: 'Enter both latitude and longitude.' })
  assert.deepEqual(parseCameraLocationInput({ latitude: '   ', longitude: '0', label: '' }), { error: 'Enter both latitude and longitude.' })
  assert.match(parseCameraLocationInput({ latitude: 'NaN', longitude: '0', label: '' }).error, /Latitude/)
  assert.match(parseCameraLocationInput({ latitude: '90.01', longitude: '0', label: '' }).error, /Latitude/)
  assert.match(parseCameraLocationInput({ latitude: '0', longitude: 'Infinity', label: '' }).error, /Longitude/)
  assert.match(parseCameraLocationInput({ latitude: '0', longitude: '-180.1', label: '' }).error, /Longitude/)
})

test('valid coordinates preserve decimals and omit an empty optional label', () => {
  assert.deepEqual(parseCameraLocationInput({ latitude: ' 40.7128 ', longitude: '-74.0060', label: ' ' }), {
    location: { latitude: 40.7128, longitude: -74.006 },
  })
  assert.deepEqual(parseCameraLocationInput({ latitude: '-90', longitude: '180', label: ' South pole camera ' }), {
    location: { latitude: -90, longitude: 180, label: 'South pole camera' },
  })
  assert.match(parseCameraLocationInput({ latitude: '0', longitude: '0', label: 'x'.repeat(121) }).error, /120 characters/)
})

test('overview bounds cover nearby pins without degenerate spans and respect polar limits', () => {
  assert.equal(locationMapBounds([]), null)
  const bounds = locationMapBounds([{ latitude: 45, longitude: -73 }, { latitude: 45.0001, longitude: -73.0001 }])
  assert.ok(bounds)
  assert.ok(bounds.south <= 45 && bounds.north >= 45.0001)
  assert.ok(bounds.west <= -73 && bounds.east >= -73.0001)
  assert.ok(bounds.north > bounds.south)
  const polar = locationMapBounds([{ latitude: 90, longitude: 180 }])
  assert.ok(polar)
  assert.ok(polar.north <= 85.05112878)
  assert.ok(polar.east > polar.west)
})

test('overview uses the short antimeridian span instead of zooming across the whole world', () => {
  const bounds = locationMapBounds([{ latitude: 10, longitude: 179.999 }, { latitude: 10, longitude: -179.999 }])
  assert.ok(bounds)
  assert.ok(bounds.east > 180)
  assert.ok(bounds.east - bounds.west < 0.02)
})

test('map-picked longitudes normalize to the API range and preserve the nearest visible world copy', () => {
  assert.equal(normalizeLongitude(200), -160)
  assert.equal(normalizeLongitude(-200), 160)
  assert.equal(normalizeLongitude(180), 180)
  assert.equal(normalizeLongitude(-180), -180)
  assert.equal(longitudeOnVisibleWorldCopy(-160, 20, 200), 200)
  assert.equal(longitudeOnVisibleWorldCopy(180, 179), 180)
  assert.equal(longitudeOnVisibleWorldCopy(-180, -179), -180)
})
