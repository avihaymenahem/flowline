import test from 'node:test'
import assert from 'node:assert/strict'
import { formatVideoDateTime, formatVideoPosition, localDateTimeCandidates, localDateTimeInput, videoTimeExportFields } from './videoTime.ts'

test('formats an offset from embedded UTC metadata in Israel time', () => {
  const origin = { effectiveStartAt: '2026-10-12T11:46:25.000Z', provenance: 'embedded_metadata' }
  assert.equal(formatVideoDateTime(origin), '12 Oct 2026, 14:46:25')
  assert.equal(formatVideoDateTime(origin, 1500), '12 Oct 2026, 14:46:26')
})

test('formats explicit elapsed position and converts an instant for an editable timezone field', () => {
  assert.equal(formatVideoPosition(35021), '00:35.021')
  assert.equal(localDateTimeInput('2026-10-12T11:46:25.000Z', 'Asia/Jerusalem'), '2026-10-12T14:46:25')
  assert.equal(localDateTimeInput('2026-10-12T11:46:25.000Z', 'UTC'), '2026-10-12T11:46:25')
})

test('resolves selected wall time only when it exists in the explicitly selected zone', () => {
  const israel = localDateTimeCandidates('2026-10-12T14:46:25', 'Asia/Jerusalem')
  const utc = localDateTimeCandidates('2026-10-12T11:46:25', 'UTC')
  assert.equal(israel.length, 1)
  assert.equal(israel[0].iso, '2026-10-12T14:46:25+03:00')
  assert.equal(utc[0].iso, '2026-10-12T11:46:25+00:00')
  assert.equal(localDateTimeCandidates('2026-10-12T14:46', 'Asia/Jerusalem')[0].iso, '2026-10-12T14:46:00+03:00')
})

test('reports daylight-saving gaps and repeated wall times without silently choosing', () => {
  assert.equal(localDateTimeCandidates('2026-03-08T02:30', 'America/New_York').length, 0)
  const repeated = localDateTimeCandidates('2026-11-01T01:30', 'America/New_York')
  assert.equal(repeated.length, 2)
  assert.deepEqual(repeated.map(candidate => candidate.iso), [
    '2026-11-01T01:30:00-04:00',
    '2026-11-01T01:30:00-05:00',
  ])
})

test('exports additive UTC and local absolute timestamps and provenance without changing elapsed offsets', () => {
  const start = { effectiveStartAt: '2026-10-12T11:46:25.000Z', provenance: 'manual_override', embeddedField: 'mvhd_creation_time' }
  assert.deepEqual(videoTimeExportFields(start, 1200), {
    utc: '2026-10-12T11:46:26.200Z',
    local: '2026-10-12T14:46:26.200+03:00',
    timeZone: 'Asia/Jerusalem',
    provenance: 'manual_override',
    originUtc: '2026-10-12T11:46:25.000Z',
    originProvenance: 'manual_override',
    originField: 'mvhd_creation_time',
  })
  assert.deepEqual(videoTimeExportFields(undefined, 1200), { utc: '', local: '', timeZone: '', provenance: '', originUtc: '', originProvenance: '', originField: '' })
})
