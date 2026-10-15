import test from 'node:test'
import assert from 'node:assert/strict'
import { exportRows } from './api.ts'

test('CSV preserves additive estimated-color metadata with aligned detection and crossing columns', () => {
  const event = {
    sourceId: 'source', sessionId: 'session', sourceTimeMs: 1200, frameWidth: 1920, frameHeight: 1080,
    type: 'analysis', quality: { coverage: 'known', notes: [] },
    detections: [{ class: 'car', confidence: 0.8, color: 'blue', colorMethod: 'hsv_estimate', colorSupportRatio: 0.6, bbox: { x: 0.1, y: 0.2, width: 0.03, height: 0.04 } }],
    crossings: [{ lineId: 'north', direction: 'Inbound', trackId: '12' }],
  }
  const lines = exportRows([event], 'North road', 'csv', null, false, 0, 12).split('\n').map(line => line.slice(1, -1).split('","'))
  assert.equal(new Set(lines.map(line => line.length)).size, 1)
  const header = lines[0]
  const detection = lines[2]
  assert.equal(detection[header.indexOf('color_method')], 'hsv_estimate')
  assert.equal(detection[header.indexOf('color_support_ratio')], '0.6')
  assert.equal(detection[header.indexOf('client_events_omitted')], '12')
  assert.match(detection[header.indexOf('event_window')], /omitted from this browser window/)
  const crossing = lines[3]
  assert.equal(crossing[header.indexOf('line_id')], 'north')
  assert.equal(crossing[header.indexOf('direction')], 'Inbound')
})

test('video-time exports add absolute timestamps while preserving source-relative milliseconds', () => {
  const event = {
    sourceId: 'source', sessionId: 'session', sourceTimeMs: 1200, frameWidth: 1920, frameHeight: 1080,
    type: 'analysis', quality: { coverage: 'known', notes: [] },
    detections: [{ class: 'car', confidence: 0.8, bbox: { x: 0.1, y: 0.2, width: 0.03, height: 0.04 } }],
    crossings: [{ lineId: 'north', direction: 'Inbound', trackId: '12' }],
  }
  const recordingTime = { effectiveStartAt: '2026-10-12T11:46:25.000Z', provenance: 'embedded_metadata', embeddedField: 'mvhd_creation_time' }
  const csv = exportRows([event], 'North road', 'csv', null, false, 0, 0, recordingTime).split('\n').map(line => line.slice(1, -1).split('","'))
  const [header, , detection, crossing] = csv
  assert.equal(detection[header.indexOf('source_time_ms')], '1200')
  assert.equal(detection[header.indexOf('video_time_utc')], '2026-10-12T11:46:26.200Z')
  assert.equal(detection[header.indexOf('video_time_local')], '2026-10-12T14:46:26.200+03:00')
  assert.equal(detection[header.indexOf('video_time_zone')], 'Asia/Jerusalem')
  assert.equal(detection[header.indexOf('video_time_provenance')], 'embedded_metadata')
  assert.equal(detection[header.indexOf('video_time_origin_utc')], '2026-10-12T11:46:25.000Z')
  assert.equal(detection[header.indexOf('video_time_origin_field')], 'mvhd_creation_time')
  assert.equal(crossing[header.indexOf('source_time_ms')], '1200')
  assert.equal(crossing[header.indexOf('video_time_utc')], '2026-10-12T11:46:26.200Z')
  assert.equal(csv[1][header.indexOf('video_time_origin_utc')], '2026-10-12T11:46:25.000Z')

  const json = JSON.parse(exportRows([event], 'North road', 'json', null, false, 0, 0, recordingTime))
  assert.equal(json.events[0].sourceTimeMs, 1200)
  assert.equal(json.events[0].sourceId, 'source')
  assert.deepEqual(json.events[0].videoTime, {
    utc: '2026-10-12T11:46:26.200Z',
    local: '2026-10-12T14:46:26.200+03:00',
    timeZone: 'Asia/Jerusalem',
    provenance: 'embedded_metadata',
    origin: {
      effectiveStartAt: '2026-10-12T11:46:25.000Z',
      provenance: 'embedded_metadata',
      embeddedField: 'mvhd_creation_time',
    },
  })
  assert.equal(json.metadata.videoTimeOrigin.effectiveStartAt, recordingTime.effectiveStartAt)
  assert.equal(json.metadata.videoTimeOrigin.displayTimeZone, 'Asia/Jerusalem')
})
