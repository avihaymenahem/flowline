import type { AccuracyFeedback, AccuracyReviewStatus } from './api'

export function reportMatchesReviewFilter(report: Pick<AccuracyFeedback, 'reviewStatus'>, filter: 'all' | AccuracyReviewStatus) {
  return filter === 'all' || report.reviewStatus === filter
}
