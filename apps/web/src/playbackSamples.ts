import type { Detection } from './api'

type TimedSample = {
  sourceId: string
  sessionId: string
  sourceTimeMs: number
  type?: string
}

type PlaybackDetection = Detection

type DetectionSample = TimedSample & {
  detections: readonly PlaybackDetection[]
  quality?: { coverage?: 'known' | 'unknown'; notes?: readonly string[] }
}

const MAX_INTERPOLATION_GAP_MS = 1_500
const MAX_CENTER_STEP = 0.1
const DISCONTINUITY_NOTES = new Set(['sampling_gap_detected', 'source_clock_reset'])
const analysisTimelineCache = new WeakMap<readonly DetectionSample[], Map<string, DetectionSample[]>>()

function analysisTimeline(samples: readonly DetectionSample[], sourceId: string, sessionId: string) {
  let byScope = analysisTimelineCache.get(samples)
  if (!byScope) {
    byScope = new Map()
    analysisTimelineCache.set(samples, byScope)
  }
  const key = `${sourceId}\0${sessionId}`
  let ordered = byScope.get(key)
  if (!ordered) {
    ordered = samples
      .filter(sample => sample.sourceId === sourceId && sample.sessionId === sessionId && Number.isFinite(sample.sourceTimeMs))
      .slice()
      .sort((a, b) => a.sourceTimeMs - b.sourceTimeMs)
    byScope.set(key, ordered)
  }
  return ordered
}

function validNormalizedBox(box: PlaybackDetection['bbox']) {
  return Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.width) && Number.isFinite(box.height)
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
    && box.x + box.width <= 1 && box.y + box.height <= 1
}

/** Interpolates only uniquely tracked objects between adjacent samples in one upload session. */
export function interpolatePlaybackDetections<T extends DetectionSample>(
  samples: readonly T[],
  currentSample: T | undefined,
  videoTimeMs: number,
  sourceId: string,
  sessionId: string | null | undefined,
): PlaybackDetection[] {
  if (!currentSample) return []
  const held = currentSample.detections.map(detection => ({ ...detection, bbox: { ...detection.bbox } }))
  if (!sessionId || currentSample.sourceId !== sourceId || currentSample.sessionId !== sessionId
    || !Number.isFinite(videoTimeMs) || videoTimeMs <= currentSample.sourceTimeMs) return held

  const ordered = analysisTimeline(samples, sourceId, sessionId)
  let low = 0, high = ordered.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (ordered[middle]!.sourceTimeMs < currentSample.sourceTimeMs) low = middle + 1
    else high = middle
  }
  let currentIndex = -1
  for (let i = low; i < ordered.length && ordered[i]!.sourceTimeMs === currentSample.sourceTimeMs; i++) {
    if (ordered[i] === currentSample) { currentIndex = i; break }
  }
  if (currentIndex < 0) return held
  const next = ordered[currentIndex + 1]
  if (!next || next.sourceTimeMs <= currentSample.sourceTimeMs || next.sourceTimeMs - currentSample.sourceTimeMs > MAX_INTERPOLATION_GAP_MS) return held
  if (currentSample.quality?.coverage === 'unknown' || next.quality?.coverage === 'unknown') return held
  if ([...(currentSample.quality?.notes ?? []), ...(next.quality?.notes ?? [])].some(note => DISCONTINUITY_NOTES.has(note))) return held

  const fraction = Math.max(0, Math.min(1, (videoTimeMs - currentSample.sourceTimeMs) / (next.sourceTimeMs - currentSample.sourceTimeMs)))
  if (fraction <= 0) return held
  const counts = (detections: readonly PlaybackDetection[]) => {
    const result = new Map<string, { detection: PlaybackDetection; count: number }>()
    for (const detection of detections) {
      if (!detection.trackId) continue
      const existing = result.get(detection.trackId)
      result.set(detection.trackId, { detection, count: (existing?.count ?? 0) + 1 })
    }
    return result
  }
  const currentById = counts(currentSample.detections)
  const nextById = counts(next.detections)
  return held.map(detection => {
    if (!detection.trackId) return detection
    const current = currentById.get(detection.trackId)
    const future = nextById.get(detection.trackId)
    if (!current || current.count !== 1 || !future || future.count !== 1 || detection.class !== future.detection.class
      || !validNormalizedBox(detection.bbox) || !validNormalizedBox(future.detection.bbox)) return detection
    const from = detection.bbox
    const to = future.detection.bbox
    const fromX = from.x + from.width / 2, fromY = from.y + from.height / 2
    const toX = to.x + to.width / 2, toY = to.y + to.height / 2
    const centerStep = Math.hypot(toX - fromX, toY - fromY)
    const fromDiagonal = Math.hypot(from.width, from.height)
    const toDiagonal = Math.hypot(to.width, to.height)
    const relativeLimit = 4 * ((fromDiagonal + toDiagonal) / 2) + 1e-9
    if (centerStep > MAX_CENTER_STEP + 1e-9 || centerStep > relativeLimit
      || Math.max(from.width, to.width) / Math.min(from.width, to.width) > 2
      || Math.max(from.height, to.height) / Math.min(from.height, to.height) > 2) return detection
    const bbox = {
      x: from.x + (to.x - from.x) * fraction,
      y: from.y + (to.y - from.y) * fraction,
      width: from.width + (to.width - from.width) * fraction,
      height: from.height + (to.height - from.height) * fraction,
    }
    return validNormalizedBox(bbox) ? { ...detection, bbox } : detection
  })
}

/** Returns the most recent analyzed sample at or before the current video time. */
export function latestPlaybackSample<T extends TimedSample>(
  samples: readonly T[],
  videoTimeMs: number,
  sourceId: string,
  sessionId: string | null | undefined,
): T | undefined {
  if (!Number.isFinite(videoTimeMs) || !sessionId) return undefined

  let latest: T | undefined
  for (const sample of samples) {
    if (sample.sourceId !== sourceId || sample.sessionId !== sessionId) continue
    if (!Number.isFinite(sample.sourceTimeMs) || sample.sourceTimeMs > videoTimeMs) continue
    if (!latest || sample.sourceTimeMs > latest.sourceTimeMs) latest = sample
  }
  return latest
}

/** Binary-searches a timeline already ordered by sourceTimeMs. */
export function latestPlaybackSampleFromSorted<T extends TimedSample>(
  samples: readonly T[],
  videoTimeMs: number,
  sourceId: string,
  sessionId: string | null | undefined,
): T | undefined {
  if (!Number.isFinite(videoTimeMs) || !sessionId) return undefined
  let low = 0, high = samples.length - 1, latest: T | undefined
  while (low <= high) {
    const middle = (low + high) >>> 1
    const sample = samples[middle]!
    if (!Number.isFinite(sample.sourceTimeMs) || sample.sourceTimeMs > videoTimeMs) high = middle - 1
    else {
      if (sample.sourceId === sourceId && sample.sessionId === sessionId) latest = sample
      low = middle + 1
    }
  }
  if (latest) return latest
  for (let i = Math.min(high, samples.length - 1); i >= 0; i--) {
    const sample = samples[i]!
    if (sample.sourceTimeMs <= videoTimeMs && sample.sourceId === sourceId && sample.sessionId === sessionId) return sample
  }
  return undefined
}
