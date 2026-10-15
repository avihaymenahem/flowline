import test from 'node:test'
import assert from 'node:assert/strict'
import { filterObservationEvents, observationSessionOptions } from './observationSessions.ts'

const event = (sessionId, sourceTimeMs) => ({ sessionId, sourceTimeMs })

test('defaults session options to the API latest session and lists retained sessions', () => {
  const events = [event('old-session', 1000), event('latest-run', 0), event('latest-run', 1000)]
  assert.deepEqual(observationSessionOptions(events, 'latest-run'), [
    { id: 'latest-run', label: 'Session latest-r · 2 records (current)' },
    { id: 'old-session', label: 'Session old-sess · 1 records' },
  ])
})

test('session selection filters records while all loaded remains explicit', () => {
  const events = [event('old', 0), event('current', 0)]
  assert.deepEqual(filterObservationEvents(events, 'latest', 'current'), [events[1]])
  assert.deepEqual(filterObservationEvents(events, 'old', 'current'), [events[0]])
  assert.equal(filterObservationEvents(events, 'all', 'current').length, 2)
  assert.deepEqual(filterObservationEvents(events, 'latest', undefined), [])
})
