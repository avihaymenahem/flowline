import test from 'node:test'
import assert from 'node:assert/strict'
import { reportMatchesReviewFilter } from './accuracyReports.ts'

test('review status changes are checked against the active report filter', () => {
  assert.equal(reportMatchesReviewFilter({ reviewStatus: 'reviewed' }, 'all'), true)
  assert.equal(reportMatchesReviewFilter({ reviewStatus: 'open' }, 'open'), true)
  assert.equal(reportMatchesReviewFilter({ reviewStatus: 'reviewed' }, 'open'), false)
  assert.equal(reportMatchesReviewFilter({ reviewStatus: 'open' }, 'reviewed'), false)
})
