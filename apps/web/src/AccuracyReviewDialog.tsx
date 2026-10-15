import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ArrowLeft, Check, FileWarning, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { api, type AccuracyFeedbackKind, type AccuracyFeedbackDraft, type CorrectedClassLabel, type Source, type TrafficEvent } from './api'
import { accuracyDraftMatchesTarget, accuracyTargetFromEvent, buildAccuracyFeedbackBody, clampNormalizedBox, hasPinnedAccuracyFrame, isNormalizedBox, type AccuracyTarget } from './accuracyReview'
import { AccuracyReportsPanel } from './AccuracyReportsPanel'
import { TrackInspector } from './TrackInspector'
import { formatVideoPosition } from './videoTime'
import { vehicleColorLabel, vehicleColorSwatch, vehicleTypeLabel } from './vehicleTypes'
import './accuracyReview.css'

const kinds: Array<{ value: AccuracyFeedbackKind; label: string; help: string }> = [
  { value: 'duplicate', label: 'Duplicate detection', help: 'Two boxes refer to the same vehicle.' },
  { value: 'missed_vehicle', label: 'Missed vehicle', help: 'Draw a box and choose the missed vehicle type.' },
  { value: 'false_positive', label: 'False vehicle', help: 'This box does not contain a vehicle.' },
  { value: 'wrong_type', label: 'Wrong vehicle type', help: 'Suggest a corrected broad vehicle type.' },
  { value: 'wrong_color', label: 'Wrong color', help: 'Suggest a corrected coarse color.' },
]
const correctedVehicleLabels: Array<{ value: CorrectedClassLabel; label: string }> = [
  { value: 'car', label: 'Car' }, { value: 'van', label: 'Van' }, { value: 'pickup_truck', label: 'Pickup truck' },
  { value: 'suv', label: 'SUV' }, { value: 'motorcycle', label: 'Motorcycle' }, { value: 'bus', label: 'Bus' },
  { value: 'truck', label: 'Truck' }, { value: 'bicycle', label: 'Bicycle' }, { value: 'other_vehicle', label: 'Other vehicle' },
]
const colors = ['black', 'blue', 'gray', 'green', 'orange', 'pink', 'purple', 'red', 'white', 'yellow', 'unknown']

function targetIdentity(target: AccuracyTarget) { return `${target.sourceId}:${target.sessionId}:${target.eventId}:${target.frameId ?? 'no-frame'}:${target.sourceTimeMs}` }

export function AccuracyReviewDialog({ source, event, initialDetectionIndex, onClose }: { source: Source; event: TrafficEvent; initialDetectionIndex?: number; onClose: () => void }) {
  const target = useMemo(() => accuracyTargetFromEvent(source.id, event, initialDetectionIndex), [source.id, event, initialDetectionIndex])
  const key = target ? targetIdentity(target) : `${source.id}:invalid`
  const snapshot = useMemo(() => structuredClone(event), [key])
  const snapshotTarget = useMemo(() => accuracyTargetFromEvent(source.id, snapshot, initialDetectionIndex), [source.id, snapshot, initialDetectionIndex])
  const [draft, setDraft] = useState<AccuracyFeedbackDraft | null>(null)
  const [reserveError, setReserveError] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [imageLoading, setImageLoading] = useState(false)
  const [imageError, setImageError] = useState('')
  const [draftBusy, setDraftBusy] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const [activeTab, setActiveTab] = useState<'report' | 'reports'>('report')
  const [reserveVersion, setReserveVersion] = useState(0)
  const [kind, setKind] = useState<AccuracyFeedbackKind>(initialDetectionIndex === undefined ? 'missed_vehicle' : 'duplicate')
  const [detectionIndex, setDetectionIndex] = useState(initialDetectionIndex ?? -1)
  const [duplicateOfDetectionIndex, setDuplicateOfDetectionIndex] = useState(-1)
  const [correctedClassLabel, setCorrectedClassLabel] = useState<CorrectedClassLabel | ''>('')
  const [correctedColor, setCorrectedColor] = useState('')
  const [note, setNote] = useState('')
  const [missedBox, setMissedBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [correctedBox, setCorrectedBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [correctedBoxEnabled, setCorrectedBoxEnabled] = useState(false)
  const [boxValues, setBoxValues] = useState({ x: '', y: '', width: '', height: '' })
  const [drawingStart, setDrawingStart] = useState<{ x: number; y: number } | null>(null)
  const [drawingEnd, setDrawingEnd] = useState<{ x: number; y: number } | null>(null)
  const [trackId, setTrackId] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const imageStageRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef<AccuracyFeedbackDraft | null>(null)
  const imageUrlRef = useRef('')
  const mountedRef = useRef(true)
  const generation = useRef(0)
  const requestIdentity = useRef(key)
  requestIdentity.current = key
  const selectedDetection = detectionIndex >= 0 ? snapshot.detections[detectionIndex] : undefined
  const duplicateOptions = snapshot.detections.map((detection, index) => ({ detection, index })).filter(item => item.index !== detectionIndex)
  const nativeAvailable = hasPinnedAccuracyFrame(draft?.frame)
  const canSubmit = !!snapshotTarget && !!draft && !draftBusy && !saving && !reserveError && (kind === 'missed_vehicle' ? !!missedBox && !!correctedClassLabel : !!selectedDetection && (kind !== 'duplicate' || duplicateOfDetectionIndex >= 0) && (kind !== 'wrong_type' || !!correctedClassLabel) && (kind !== 'wrong_color' || !!correctedColor) && (!correctedBoxEnabled || (correctedBox !== null && isNormalizedBox(correctedBox))))
  const isDrawingEnabled = kind === 'missed_vehicle' ? nativeAvailable : correctedBoxEnabled && nativeAvailable
  const currentKind = kinds.find(item => item.value === kind)!

  useEffect(() => {
    mountedRef.current = true
    const version = ++generation.current
    const identity = key
    const controller = new AbortController()
    draftRef.current = null
    setDraft(null); setDraftBusy(true); setReserveError(''); setImageError(''); setImageLoading(false)
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current)
    imageUrlRef.current = ''
    setImageUrl('')
    if (!snapshotTarget) { setReserveError('This event is missing a stable ID or frame dimensions, so it cannot be reported safely.'); setDraftBusy(false); return () => { mountedRef.current = false; controller.abort() } }
    void api.createAccuracyFeedbackDraft(source.id, snapshotTarget.eventId, controller.signal).then(async ({ draft: nextDraft }) => {
      if (version !== generation.current || requestIdentity.current !== identity) {
        void api.cancelAccuracyFeedbackDraft(source.id, nextDraft.draftId).catch(() => {})
        return
      }
      if (!accuracyDraftMatchesTarget(nextDraft, snapshotTarget)) {
        void api.cancelAccuracyFeedbackDraft(source.id, nextDraft.draftId).catch(() => {})
        throw new Error('The reserved evidence did not match this source, session, and event. Reopen the frame and try again.')
      }
      draftRef.current = nextDraft
      setDraft(nextDraft)
      if (!hasPinnedAccuracyFrame(nextDraft.frame)) return
      setImageLoading(true)
      const blob = await api.accuracyDraftFrame(nextDraft.frame.url, controller.signal)
      if (version !== generation.current || requestIdentity.current !== identity) return
      const url = URL.createObjectURL(blob)
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current)
      imageUrlRef.current = url
      setImageUrl(url)
    }).catch(reason => {
      if (!controller.signal.aborted && version === generation.current && requestIdentity.current === identity) setReserveError(reason instanceof Error ? reason.message : 'Could not reserve this analyzed frame.')
    }).finally(() => {
      if (version === generation.current && requestIdentity.current === identity) { setDraftBusy(false); setImageLoading(false) }
    })
    return () => {
      mountedRef.current = false
      controller.abort()
      generation.current++
      const reserved = draftRef.current
      draftRef.current = null
      if (reserved) void api.cancelAccuracyFeedbackDraft(source.id, reserved.draftId).catch(() => {})
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current)
      imageUrlRef.current = ''
    }
  }, [source.id, key, snapshotTarget, reserveVersion])

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>('[data-initial-focus]')?.focus()
  }, [])

  const close = () => { if (!saving) onClose() }
  const reserveAnotherIssue = () => {
    if (draft || draftBusy || saving) return
    setKind(initialDetectionIndex === undefined ? 'missed_vehicle' : 'duplicate')
    setDetectionIndex(initialDetectionIndex ?? -1)
    setDuplicateOfDetectionIndex(-1)
    setCorrectedClassLabel(''); setCorrectedColor(''); setNote('')
    setMissedBox(null); setCorrectedBox(null); setCorrectedBoxEnabled(false)
    setBoxValues({ x: '', y: '', width: '', height: '' })
    setError(''); setSavedMessage(''); setActiveTab('report')
    setDraftBusy(true); setReserveVersion(version => version + 1)
  }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !saving) { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')
    if (!focusable?.length) return
    const first = focusable[0], last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  const pointFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = imageStageRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return null
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
  }
  const beginBox = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDrawingEnabled || !imageUrl) return
    const point = pointFromPointer(event)
    if (!point) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrawingStart(point); setDrawingEnd(point)
  }
  const moveBox = (event: PointerEvent<HTMLDivElement>) => { if (drawingStart) setDrawingEnd(pointFromPointer(event)) }
  const finishBox = (event: PointerEvent<HTMLDivElement>) => {
    if (!drawingStart) return
    const point = pointFromPointer(event)
    if (point) {
      const box = clampNormalizedBox(drawingStart, point)
      if (kind === 'missed_vehicle') setMissedBox(box)
      else setCorrectedBox(box)
      if (box) setBoxValues({ x: box.x.toFixed(3), y: box.y.toFixed(3), width: box.width.toFixed(3), height: box.height.toFixed(3) })
    }
    setDrawingStart(null); setDrawingEnd(null)
  }

  const submit = async (eventForm: React.FormEvent) => {
    eventForm.preventDefault()
    if (!canSubmit || !draft || !snapshotTarget) return
    const built = buildAccuracyFeedbackBody(draft.draftId, snapshotTarget, { kind, detectionIndex: detectionIndex >= 0 ? detectionIndex : undefined, duplicateOfDetectionIndex: duplicateOfDetectionIndex >= 0 ? duplicateOfDetectionIndex : undefined, missedBox: missedBox ?? undefined, correctedBox: correctedBoxEnabled ? correctedBox ?? undefined : undefined, correctedClassLabel: correctedClassLabel || undefined, correctedColor, note })
    if ('error' in built) { setError(built.error); return }
    const identity = key
    setSaving(true); setError(''); setSavedMessage('')
    try {
      const result = await api.createAccuracyFeedback(source.id, { ...built, frameId: draft.frame.frameId ?? draft.frameId ?? built.frameId, draftId: draft.draftId })
      if (result.report.sourceId !== snapshotTarget.sourceId || result.report.sessionId !== snapshotTarget.sessionId || result.report.eventId !== snapshotTarget.eventId) throw new Error('The saved report did not match the frame under review. Reopen the correct source before continuing.')
      if (mountedRef.current && requestIdentity.current === identity) {
        setSavedMessage('Feedback saved as a partial review record. It does not change the original analysis or train the model.')
        setActiveTab('reports')
        draftRef.current = null
        setDraft(null)
        void api.cancelAccuracyFeedbackDraft(source.id, draft.draftId).catch(() => {})
      }
    } catch (reason) {
      if (mountedRef.current && requestIdentity.current === identity) setError(reason instanceof Error ? reason.message : 'Could not save this feedback.')
    } finally { if (mountedRef.current && requestIdentity.current === identity) setSaving(false) }
  }

  if (!target || !snapshotTarget) return null
  const boxInProgress = drawingStart && drawingEnd ? clampNormalizedBox(drawingStart, drawingEnd) : null
  const activeBox = kind === 'missed_vehicle' ? missedBox : correctedBoxEnabled ? correctedBox : null
  const previewBox = activeBox ?? boxInProgress
  const updateBoxValue = (field: keyof typeof boxValues, value: string) => {
    const next = { ...boxValues, [field]: value }
    setBoxValues(next)
    if (Object.values(next).some(item => !item.trim())) {
      if (kind === 'missed_vehicle') setMissedBox(null)
      else setCorrectedBox(null)
      return
    }
    const candidate = { x: Number(next.x), y: Number(next.y), width: Number(next.width), height: Number(next.height) }
    if (isNormalizedBox(candidate)) {
      if (kind === 'missed_vehicle') setMissedBox(candidate)
      else setCorrectedBox(candidate)
    } else {
      if (kind === 'missed_vehicle') setMissedBox(null)
      else setCorrectedBox(null)
    }
  }
  const imageFrame = draft?.frame
  const dialog = <div className="modal-backdrop accuracy-review-backdrop" onMouseDown={event => { if (!saving && event.target === event.currentTarget) close() }}>
    <section ref={dialogRef} className="modal-card accuracy-review-dialog" role="dialog" aria-modal="true" aria-labelledby="accuracy-review-title" onKeyDown={handleKeyDown}>
      <div className="modal-heading"><div><div className="eyebrow">ACCURACY REVIEW · PARTIAL REPORTING</div><h2 id="accuracy-review-title">Review analyzed frame</h2><p>{source.name} · Session {snapshotTarget.sessionId.slice(0, 8)} · Video position {formatVideoPosition(snapshotTarget.sourceTimeMs)}</p></div><button data-initial-focus type="button" className="icon-button" aria-label="Close accuracy review" disabled={saving} onClick={close}><X size={17}/></button></div>
      <div className="accuracy-review-identity"><span>Event {snapshotTarget.eventId.slice(0, 12)}</span><span>·</span><span>{snapshotTarget.frameId ? `Frame ${snapshotTarget.frameId.slice(0, 12)}` : 'No native frame ID'}</span><span>·</span><span>{snapshotTarget.frameWidth} × {snapshotTarget.frameHeight}</span><span className="accuracy-immutable-badge">Immutable evidence</span></div>
      <div className="accuracy-review-tabs" role="tablist" aria-label="Accuracy review sections"><button type="button" role="tab" aria-selected={activeTab === 'report'} onClick={() => setActiveTab('report')}>New report</button><button type="button" role="tab" aria-selected={activeTab === 'reports'} onClick={() => setActiveTab('reports')}>Saved reports</button></div>
      {reserveError && <div className="accuracy-inline-error" role="alert"><AlertCircle size={15}/><span>{reserveError}</span><button className="button button-quiet" type="button" onClick={close}>Close</button></div>}
      {activeTab === 'reports' ? <><AccuracyReportsPanel key={`${source.id}:${snapshotTarget.sessionId}`} sourceId={source.id} sessionId={snapshotTarget.sessionId} compact/>{savedMessage && <p className="accuracy-success" role="status"><Check size={14}/>{savedMessage}</p>}</> : !draft && !draftBusy && savedMessage ? <div className="accuracy-evidence-placeholder accuracy-consumed-draft" role="status"><p>This frame’s report was saved. Reserve a fresh draft to report another issue on the same exact frame.</p><button type="button" className="button button-primary" onClick={reserveAnotherIssue}>Report another issue on this frame</button></div> : <div className="accuracy-review-grid">
        <div className="accuracy-evidence-column">
          <div className="accuracy-evidence-header"><strong>Exact analyzed frame</strong>{draft?.frame.provenance === 'verified_media_redecode' ? <span>Verified re-decode at analyzed time</span> : nativeAvailable ? <span>API-retained analyzed frame</span> : draftBusy && <span><LoaderCircle size={13}/> Reserving evidence</span>}</div>
          {nativeAvailable && imageUrl ? <div className="accuracy-evidence-stage" ref={imageStageRef} style={{ aspectRatio: `${imageFrame!.width ?? snapshotTarget.frameWidth} / ${imageFrame!.height ?? snapshotTarget.frameHeight}` }} onPointerDown={beginBox} onPointerMove={moveBox} onPointerUp={finishBox} onPointerCancel={finishBox}>
            <img src={imageUrl} alt={`Exact analyzed frame at video position ${formatVideoPosition(snapshotTarget.sourceTimeMs)}`} draggable={false} onError={() => setImageError('The API-retained analyzed JPEG could not be displayed.')}/>
            <div className="accuracy-evidence-boxes" aria-hidden="true">{snapshot.detections.map((detection, index) => <span key={`${index}:${detection.trackId ?? ''}`} className={`accuracy-evidence-box${index === detectionIndex ? ' selected' : ''}`} style={{ left: `${detection.bbox.x * 100}%`, top: `${detection.bbox.y * 100}%`, width: `${detection.bbox.width * 100}%`, height: `${detection.bbox.height * 100}%` }}/>)}</div>
            {previewBox && <span className={`accuracy-missed-box${kind !== 'missed_vehicle' ? ' accuracy-correction-box' : ''}`} style={{ left: `${previewBox.x * 100}%`, top: `${previewBox.y * 100}%`, width: `${previewBox.width * 100}%`, height: `${previewBox.height * 100}%` }} aria-hidden="true"/>}
          </div> : imageLoading || draftBusy ? <div className="accuracy-evidence-placeholder"><LoaderCircle size={20}/> Reserving and loading the exact analyzed frame…</div> : <div className="accuracy-evidence-placeholder"><FileWarning size={22}/><strong>Native frame unavailable</strong><span>{imageError || 'This older event has no retained original JPEG. No reconstructed preview is shown.'}</span></div>}
          {kind === 'missed_vehicle' && nativeAvailable && <p className="accuracy-draw-help">Draw a box around the missed vehicle on the frame. This evidence remains a partial review.</p>}
          {correctedBoxEnabled && nativeAvailable && <p className="accuracy-draw-help">Draw the suggested corrected bounds on the frame, or enter normalized coordinates.</p>}
          {!!snapshot.detections.length && <div className="accuracy-detection-list"><strong>Detections in this event</strong>{snapshot.detections.map((detection, index) => <button type="button" key={`${snapshot.id}:${index}`} className={index === detectionIndex ? 'selected' : ''} onClick={() => { setDetectionIndex(index); setDuplicateOfDetectionIndex(value => value === index ? -1 : value) }}><span className="accuracy-detection-index">{index + 1}</span><span>{vehicleTypeLabel(detection.class)} · {vehicleColorLabel(detection.color)}</span>{detection.trackId ? <span>#{detection.trackId}</span> : <span>Untracked</span>}</button>)}</div>}
          {selectedDetection?.trackId && <button type="button" className="button button-quiet accuracy-track-open" onClick={() => setTrackId(selectedDetection.trackId!)}><RotateCcw size={14}/> Inspect track #{selectedDetection.trackId}</button>}
          {selectedDetection && !selectedDetection.trackId && <p className="accuracy-untracked-note">This detection has no track ID. A multi-frame trajectory cannot be shown.</p>}
        </div>
        <div className="accuracy-form-column">
          {trackId ? <TrackInspector key={`${source.id}:${snapshotTarget.sessionId}:${trackId}`} sourceId={source.id} sessionId={snapshotTarget.sessionId} trackId={trackId} onClose={() => setTrackId('')}/> : <form className="accuracy-feedback-form" onSubmit={submit}>
            <div className="accuracy-form-header"><div><strong>What should be corrected?</strong><span>Saved locally for review; never changes the analyzed event.</span></div>{draftBusy && <LoaderCircle size={15}/>}</div>
            <label className="accuracy-field">Issue type<select disabled={draftBusy || saving} value={kind} onChange={event => { const next = event.target.value as AccuracyFeedbackKind; setKind(next); setMissedBox(null); setCorrectedBox(null); setCorrectedBoxEnabled(false); setBoxValues({ x: '', y: '', width: '', height: '' }); setError('') }}>{kinds.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><small>{currentKind.help}</small></label>
            {kind !== 'missed_vehicle' && <label className="accuracy-field">Detection<select disabled={draftBusy || saving || !snapshot.detections.length} value={detectionIndex} onChange={event => { setDetectionIndex(Number(event.target.value)); setDuplicateOfDetectionIndex(-1) }}><option value={-1}>Choose a detection</option>{snapshot.detections.map((detection, index) => <option key={index} value={index}>{index + 1}. {vehicleTypeLabel(detection.class)} · {vehicleColorLabel(detection.color)}{detection.trackId ? ` · #${detection.trackId}` : ''}</option>)}</select></label>}
            {kind === 'duplicate' && <label className="accuracy-field">Also refers to<select disabled={draftBusy || saving || detectionIndex < 0} value={duplicateOfDetectionIndex} onChange={event => setDuplicateOfDetectionIndex(Number(event.target.value))}><option value={-1}>Choose the other detection</option>{duplicateOptions.map(({ detection, index }) => <option key={index} value={index}>{index + 1}. {vehicleTypeLabel(detection.class)} · {vehicleColorLabel(detection.color)}{detection.trackId ? ` · #${detection.trackId}` : ''}</option>)}</select><small>Select two boxes that appear to represent one vehicle.</small></label>}
            {(kind === 'missed_vehicle' || kind === 'wrong_type') && <label className="accuracy-field">Suggested vehicle type<select disabled={draftBusy || saving || (kind === 'missed_vehicle' && !nativeAvailable)} value={correctedClassLabel} onChange={event => setCorrectedClassLabel(event.target.value as CorrectedClassLabel | '')}><option value="">Choose a suggested type</option>{correctedVehicleLabels.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><small>Feedback label only; it does not change the model's detection class.</small></label>}
            {kind === 'wrong_color' && <label className="accuracy-field">Correct color<select disabled={draftBusy || saving} value={correctedColor} onChange={event => setCorrectedColor(event.target.value)}><option value="">Choose a color</option>{colors.map(value => <option key={value} value={value}>{vehicleColorLabel(value)}</option>)}</select></label>}
            {(kind === 'missed_vehicle' || kind === 'wrong_type' || kind === 'wrong_color') && <>
              {kind !== 'missed_vehicle' && <label className="accuracy-checkbox"><input type="checkbox" checked={correctedBoxEnabled} disabled={!nativeAvailable || draftBusy || saving} onChange={event => { setCorrectedBoxEnabled(event.target.checked); if (!event.target.checked) { setCorrectedBox(null); setBoxValues({ x: '', y: '', width: '', height: '' }) } }}/> Suggest a corrected box (optional)</label>}
              {(kind === 'missed_vehicle' || correctedBoxEnabled) && <>
                <div className="accuracy-bbox-state" role="status">{activeBox ? `Box set · x ${activeBox.x.toFixed(3)}, y ${activeBox.y.toFixed(3)}, width ${activeBox.width.toFixed(3)}, height ${activeBox.height.toFixed(3)}` : nativeAvailable ? 'No box set yet. Draw it on the frame or enter normalized coordinates.' : 'A box requires a pinned exact frame.'}</div>
                <div className="accuracy-box-coordinates" aria-label="Normalized box coordinates">{(['x', 'y', 'width', 'height'] as const).map((field, index) => <label key={field}>{['Left', 'Top', 'Width', 'Height'][index]}<input type="number" min="0" max="1" step="0.001" inputMode="decimal" disabled={!nativeAvailable || draftBusy || saving} value={boxValues[field]} onChange={event => updateBoxValue(field, event.target.value)}/></label>)}</div>
              </>}
            </>}
            <label className="accuracy-field">Review note <span className="accuracy-optional">Optional</span><textarea value={note} maxLength={1000} disabled={draftBusy || saving} onChange={event => setNote(event.target.value)} placeholder="Add context for another reviewer…"/></label>
            <div className="accuracy-partial-callout"><AlertCircle size={15}/><span>Reports are partial issue notes. Reviewed does not mean every vehicle is labeled, and reports do not train or change the model.</span></div>
            {imageError && <p className="accuracy-inline-error" role="alert">{imageError}</p>}{error && <p className="accuracy-inline-error" role="alert">{error}</p>}{savedMessage && <p className="accuracy-success" role="status"><Check size={14}/>{savedMessage}</p>}
            <div className="modal-actions"><button type="button" className="button button-quiet" onClick={close} disabled={saving}>Cancel</button><button type="submit" className="button button-primary" disabled={!canSubmit}>{saving ? <><LoaderCircle size={14}/> Saving…</> : 'Save feedback'}</button></div>
          </form>}
        </div>
      </div>}
    </section>
  </div>
  return createPortal(dialog, document.body)
}
