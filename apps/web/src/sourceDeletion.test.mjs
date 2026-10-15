import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldNavigateAfterSourceDelete } from './sourceDeletion.ts'

test('deletion recovery only navigates away while the URL still selects the deleted source', () => {
  assert.equal(shouldNavigateAfterSourceDelete('/sources/deleted-id', 'deleted-id'), true)
  assert.equal(shouldNavigateAfterSourceDelete('/live/deleted-id', 'deleted-id'), true)
  assert.equal(shouldNavigateAfterSourceDelete('/live/newer-id', 'deleted-id'), false)
  assert.equal(shouldNavigateAfterSourceDelete('/live/deleted-id', 'deleted-id', 'newer-id'), false)
  assert.equal(shouldNavigateAfterSourceDelete('/live/deleted-id', 'deleted-id', 'deleted-id'), true)
  assert.equal(shouldNavigateAfterSourceDelete('/sources', 'deleted-id'), false)
})
