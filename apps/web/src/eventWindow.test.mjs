import test from 'node:test'
import assert from 'node:assert/strict'
import { appendRecentEvent, mergeRecentEventHistory, recentEventWindow } from './eventWindow.ts'

test('initial client history and appended SSE events share one bounded window', () => {
  const initial = recentEventWindow(Array.from({ length: 5 }, (_, id) => ({ id: String(id) })), 3)
  assert.deepEqual(initial.events.map(event => event.id), ['2', '3', '4'])
  assert.equal(initial.omitted, 2)
  const appended = appendRecentEvent(initial.events, { id: '5' }, 3)
  assert.deepEqual(appended.events.map(event => event.id), ['3', '4', '5'])
  assert.equal(appended.omitted, 1)
  assert.equal(appendRecentEvent(appended.events, { id: '5' }, 3).duplicate, true)
})

test('history response merging does not overwrite a newer SSE event or duplicate a shared record', () => {
  const historyEvent = { id: 'one', sourceId: 's', sessionId: 'a', sourceTimeMs: 100, type: 'analysis' }
  const realtimeEvent = { id: 'two', sourceId: 's', sessionId: 'b', sourceTimeMs: 0, type: 'analysis' }
  const merged = mergeRecentEventHistory([historyEvent], [historyEvent, realtimeEvent])
  assert.deepEqual(merged.events.map(event => event.id), ['one', 'two'])
})
