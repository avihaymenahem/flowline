import test from 'node:test'
import assert from 'node:assert/strict'
import { compareNumeric, matchesObservationFilters, stableObservationKey, virtualObservationIndexes } from './observationTableUtils.ts'

const event = { id: 'event-1', sessionId: 'session-a', sourceTimeMs: 1000 }
const row = (key, type, color) => ({ key, event, d: { class: type, color } })

test('type and color filters combine while absent colors use the shared unknown bucket', () => {
  assert.equal(matchesObservationFilters(row('a', 'Car', 'Blue'), 'car', 'blue'), true)
  assert.equal(matchesObservationFilters(row('b', 'car', undefined), 'car', 'unknown'), true)
  assert.equal(matchesObservationFilters(row('c', 'truck', 'blue'), 'car', 'blue'), false)
  assert.equal(matchesObservationFilters(row('d', 'car', 'red'), 'all', 'blue'), false)
  assert.equal(matchesObservationFilters(row('e', 'car', 'blue'), 'car', 'all'), true)
})

test('observation keys remain stable per event and detection index', () => {
  assert.equal(stableObservationKey(event, 0), 'event-1-0')
  assert.equal(stableObservationKey(event, 1), 'event-1-1')
  assert.notEqual(stableObservationKey(event, 0), stableObservationKey({ ...event, id: 'event-2' }, 0))
  assert.equal(stableObservationKey({ sessionId: 'session-b', sourceTimeMs: 2000 }, 0), 'session-b-2000-0')
})

test('numeric table sorting compares numbers rather than formatted labels', () => {
  assert.ok(compareNumeric(1200, 9850) < 0)
  assert.ok(compareNumeric(9850, 1200) > 0)
  assert.equal(compareNumeric(1200, 1200), 0)
})

test('virtual index extraction bounds a 14,420-row dataset to the visible window plus overscan', () => {
  const indexes = virtualObservationIndexes(14_420, 100, 112, 8)
  assert.equal(indexes.length, 29)
  assert.equal(indexes[0], 92)
  assert.equal(indexes.at(-1), 120)
  assert.equal(virtualObservationIndexes(14_420, 0, 5, 8).length, 14)
  assert.deepEqual(virtualObservationIndexes(0, 0, 0), [])
})
