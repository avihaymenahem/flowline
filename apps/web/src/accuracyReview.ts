import type { AccuracyFeedbackFrame, AccuracyFeedbackKind, CorrectedClassLabel, NormalizedBox, TrafficEvent } from './api'

export type AccuracyTarget = {
  sourceId: string
  sessionId: string
  eventId: string
  frameId?: string
  sourceTimeMs: number
  frameWidth: number
  frameHeight: number
  detectionIndex?: number
}

export type AccuracyDraftValues = {
  kind: AccuracyFeedbackKind
  detectionIndex?: number
  duplicateOfDetectionIndex?: number
  missedBox?: NormalizedBox
  correctedBox?: NormalizedBox
  correctedClassLabel?: CorrectedClassLabel
  correctedColor?: string
  note?: string
}

export type AccuracyFeedbackBody = {
  eventId: string
  frameId?: string
  kind: AccuracyFeedbackKind
  detectionIndex?: number
  duplicateOfDetectionIndex?: number
  bbox?: NormalizedBox
  proposedCorrection?: { class?: string; correctedClassLabel?: CorrectedClassLabel; color?: string; bbox?: NormalizedBox }
  note?: string
}

export function accuracyTargetFromEvent(sourceId: string, event: TrafficEvent, detectionIndex?: number): AccuracyTarget | null {
  if (!event.id || event.sourceId !== sourceId || !event.sessionId || !Number.isFinite(event.sourceTimeMs)) return null
  if (!(event.frameWidth > 0 && event.frameHeight > 0)) return null
  if (detectionIndex !== undefined && (!Number.isInteger(detectionIndex) || detectionIndex < 0 || detectionIndex >= event.detections.length)) return null
  return {
    sourceId,
    sessionId: event.sessionId,
    eventId: event.id,
    ...(event.frameId ? { frameId: event.frameId } : {}),
    sourceTimeMs: event.sourceTimeMs,
    frameWidth: event.frameWidth,
    frameHeight: event.frameHeight,
    ...(detectionIndex !== undefined ? { detectionIndex } : {}),
  }
}

export function accuracyTargetKey(target: AccuracyTarget): string {
  return [target.sourceId, target.sessionId, target.eventId, target.frameId ?? '', target.sourceTimeMs, target.detectionIndex ?? ''].join(':')
}

export function accuracyDraftMatchesTarget(draft: { sourceId: string; sessionId: string; eventId: string; frameId?: string; frame?: { frameId?: string } }, target: AccuracyTarget): boolean {
  const draftFrameId = draft.frameId ?? draft.frame?.frameId
  return draft.sourceId === target.sourceId && draft.sessionId === target.sessionId && draft.eventId === target.eventId && (!target.frameId || draftFrameId === target.frameId)
}

export function hasPinnedAccuracyFrame(frame: AccuracyFeedbackFrame | undefined): frame is AccuracyFeedbackFrame & { url: string; provenance: 'analysis_source_frame' | 'verified_media_redecode' } {
  return !!frame && (frame.provenance === 'analysis_source_frame' || frame.provenance === 'verified_media_redecode')
    && !!frame.url?.trim()
}

export function isNormalizedBox(box: NormalizedBox | undefined): box is NormalizedBox {
  return !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
    && box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001
}

export function clampNormalizedBox(start: { x: number; y: number }, end: { x: number; y: number }): NormalizedBox | null {
  const x = Math.max(0, Math.min(start.x, end.x))
  const y = Math.max(0, Math.min(start.y, end.y))
  const right = Math.min(1, Math.max(start.x, end.x))
  const bottom = Math.min(1, Math.max(start.y, end.y))
  const box = { x, y, width: right - x, height: bottom - y }
  return isNormalizedBox(box) ? box : null
}

export function buildAccuracyFeedbackBody(draftId: string, target: AccuracyTarget, values: AccuracyDraftValues): AccuracyFeedbackBody | { error: string } {
  if (!draftId.trim()) return { error: 'Reserve the analyzed frame before saving feedback.' }
  const body: AccuracyFeedbackBody = {
    eventId: target.eventId,
    ...(target.frameId ? { frameId: target.frameId } : {}),
    kind: values.kind,
    ...(values.kind !== 'missed_vehicle' && values.detectionIndex !== undefined ? { detectionIndex: values.detectionIndex } : {}),
  }
  if (values.kind === 'missed_vehicle') {
    if (!isNormalizedBox(values.missedBox)) return { error: 'Draw a box around the missed vehicle.' }
    if (!values.correctedClassLabel) return { error: 'Choose the suggested vehicle type for the missed vehicle.' }
    body.bbox = values.missedBox
    body.proposedCorrection = { correctedClassLabel: values.correctedClassLabel }
  } else {
    if (values.detectionIndex === undefined || !Number.isInteger(values.detectionIndex) || values.detectionIndex < 0) return { error: 'Select a detection to report.' }
    if (values.kind === 'duplicate') {
      const other = values.duplicateOfDetectionIndex
      if (other === undefined || !Number.isInteger(other) || other < 0 || other === values.detectionIndex) return { error: 'Select the other detection that overlaps this duplicate.' }
      body.duplicateOfDetectionIndex = other
    }
    if (values.kind === 'wrong_type') {
      if (!values.correctedClassLabel) return { error: 'Choose the suggested vehicle type.' }
      body.proposedCorrection = { correctedClassLabel: values.correctedClassLabel, ...(isNormalizedBox(values.correctedBox) ? { bbox: values.correctedBox } : {}) }
    }
    if (values.kind === 'wrong_color') {
      if (!values.correctedColor?.trim()) return { error: 'Choose the corrected color.' }
      body.proposedCorrection = { color: values.correctedColor.trim(), ...(isNormalizedBox(values.correctedBox) ? { bbox: values.correctedBox } : {}) }
    }
  }
  const note = values.note?.trim()
  if (note) body.note = note.slice(0, 1000)
  return body
}
