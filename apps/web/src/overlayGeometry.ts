export type ContainRect = { left: number; top: number; width: number; height: number }

export function containedImageRect(stageAspect: number, imageAspect: number): ContainRect {
  if (!(stageAspect > 0) || !(imageAspect > 0)) return { left: 0, top: 0, width: 1, height: 1 }
  if (imageAspect >= stageAspect) {
    const height = stageAspect / imageAspect
    return { left: 0, top: (1 - height) / 2, width: 1, height }
  }
  const width = imageAspect / stageAspect
  return { left: (1 - width) / 2, top: 0, width, height: 1 }
}

export function matchesAnalyzedFrame(decodedTimeMs: number, sampleTimeMs: number, toleranceMs = 25): boolean {
  return Number.isFinite(decodedTimeMs) && Number.isFinite(sampleTimeMs) && Math.abs(decodedTimeMs - sampleTimeMs) <= toleranceMs
}
