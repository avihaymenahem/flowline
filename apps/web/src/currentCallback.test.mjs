import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callCurrent } from './currentCallback.ts'

test('a memoized row action calls the latest source callback after async source loading', () => {
  const firstCalls = []
  const currentCalls = []
  const handler = { current: (...args) => firstCalls.push(args) }
  const memoizedCellAction = (...args) => callCurrent(handler, ...args)

  handler.current = (...args) => currentCalls.push(args)
  memoizedCellAction({ id: 'event-current' }, 2)

  assert.equal(firstCalls.length, 0)
  assert.deepEqual(currentCalls, [[{ id: 'event-current' }, 2]])
})
