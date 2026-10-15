import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronDown, Circle, LoaderCircle, RefreshCw } from 'lucide-react'
import { api, type AccuracyFeedback, type AccuracyReviewStatus } from './api'
import { formatVideoPosition } from './videoTime'
import { vehicleColorLabel, vehicleTypeLabel } from './vehicleTypes'
import { reportMatchesReviewFilter } from './accuracyReports'

const statusLabels: Record<AccuracyReviewStatus, string> = { open: 'Open', reviewed: 'Reviewed issue', dismissed: 'Dismissed' }
const kindLabels: Record<AccuracyFeedback['kind'], string> = {
  duplicate: 'Duplicate detection', missed_vehicle: 'Missed vehicle', false_positive: 'False vehicle', wrong_type: 'Wrong vehicle type', wrong_color: 'Wrong color',
}
const correctionClassLabels: Record<NonNullable<AccuracyFeedback['proposedCorrection']>['correctedClassLabel'] & string, string> = {
  car: 'Car', van: 'Van', pickup_truck: 'Pickup truck', suv: 'SUV', motorcycle: 'Motorcycle', bus: 'Bus', truck: 'Truck', bicycle: 'Bicycle', other_vehicle: 'Other vehicle',
}

export function AccuracyReportsPanel({ sourceId, sessionId, compact = false }: { sourceId: string; sessionId?: string; compact?: boolean }) {
  const [status, setStatus] = useState<'all' | AccuracyReviewStatus>('all')
  const [reports, setReports] = useState<AccuracyFeedback[]>([])
  const [loadedIdentity, setLoadedIdentity] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<'known' | 'truncated'>('known')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [errorIdentity, setErrorIdentity] = useState('')
  const [busyId, setBusyId] = useState('')
  const [retryVersion, setRetryVersion] = useState(0)
  const [expandedReportId, setExpandedReportId] = useState('')
  const identity = `${sourceId}:${sessionId ?? ''}:${status}`
  const requestKey = `${identity}:${retryVersion}`
  const identityRef = useRef(identity)
  identityRef.current = identity
  const requestKeyRef = useRef(requestKey)
  const requestGenerationRef = useRef(0)
  if (requestKeyRef.current !== requestKey) {
    requestKeyRef.current = requestKey
    requestGenerationRef.current += 1
  }

  useEffect(() => {
    const controller = new AbortController()
    const requestGeneration = requestGenerationRef.current
    let current = true
    setLoading(true); setError(''); setErrorIdentity(''); setReports([]); setCursor(null); setLoadedIdentity(''); setBusyId(''); setLoadingMore(false)
    void api.accuracyFeedback(sourceId, { sessionId, ...(status === 'all' ? {} : { reviewStatus: status }), limit: 50 }, controller.signal).then(page => {
      if (!current || requestGenerationRef.current !== requestGeneration) return
      setReports(page.reports); setCursor(page.nextCursor ?? null); setCoverage(page.coverage); setLoadedIdentity(identity)
    }).catch(reason => {
      if (current && !controller.signal.aborted && requestGenerationRef.current === requestGeneration) { setError(reason instanceof Error ? reason.message : 'Could not load accuracy reports.'); setErrorIdentity(identity) }
    }).finally(() => { if (current && requestGenerationRef.current === requestGeneration) setLoading(false) })
    return () => { current = false; controller.abort() }
  }, [sourceId, sessionId, status, retryVersion])

  const patchReport = async (report: AccuracyFeedback, patch: { reviewStatus?: AccuracyReviewStatus; reviewLabel?: string; reviewNote?: string }) => {
    if (busyId) return
    const targetSourceId = sourceId
    const targetSessionId = report.sessionId
    const targetIdentity = identity
    const targetRequestGeneration = requestGenerationRef.current
    setBusyId(report.id); setError(''); setErrorIdentity('')
    try {
      const updated = (await api.updateAccuracyFeedback(targetSourceId, report.id, patch)).report
      if (identityRef.current === targetIdentity && requestGenerationRef.current === targetRequestGeneration && updated.id === report.id && updated.sourceId === targetSourceId && updated.sessionId === targetSessionId) {
        if (!reportMatchesReviewFilter(updated, status)) {
          // Status filters use offset pagination. Refresh from the first page when a
          // report leaves the current filter so the next page cannot skip a row.
          setRetryVersion(value => value + 1)
        } else {
          setReports(current => current.map(item => item.id === report.id ? updated : item))
        }
      }
    } catch (reason) {
      if (identityRef.current === targetIdentity && requestGenerationRef.current === targetRequestGeneration) { setError(reason instanceof Error ? reason.message : 'Could not update the report.'); setErrorIdentity(targetIdentity) }
    } finally { if (identityRef.current === targetIdentity && requestGenerationRef.current === targetRequestGeneration) setBusyId('') }
  }

  const loadMore = async () => {
    if (!cursor || loadingMore) return
    const controller = new AbortController()
    const targetSourceId = sourceId
    const targetIdentity = identity
    const targetRequestGeneration = requestGenerationRef.current
    setLoadingMore(true); setError(''); setErrorIdentity('')
    try {
      const page = await api.accuracyFeedback(targetSourceId, { sessionId, ...(status === 'all' ? {} : { reviewStatus: status }), cursor, limit: 50 }, controller.signal)
      if (identityRef.current !== targetIdentity || requestGenerationRef.current !== targetRequestGeneration) return
      setReports(current => [...current, ...page.reports.filter(next => !current.some(row => row.id === next.id))])
      setCursor(page.nextCursor ?? null); setCoverage(page.coverage)
    } catch (reason) {
      if (identityRef.current === targetIdentity && requestGenerationRef.current === targetRequestGeneration) { setError(reason instanceof Error ? reason.message : 'Could not load more reports.'); setErrorIdentity(targetIdentity) }
    } finally { if (identityRef.current === targetIdentity && requestGenerationRef.current === targetRequestGeneration) setLoadingMore(false) }
  }

  return <section className={`panel accuracy-reports-panel${compact ? ' compact' : ''}`} aria-labelledby={compact ? undefined : 'accuracy-reports-title'}>
    <div className="panel-heading"><div><h2 id={compact ? undefined : 'accuracy-reports-title'}>Accuracy reports</h2><p>{sessionId ? `Session ${sessionId.slice(0, 8)}` : 'Saved reports for this source'}</p></div><label className="accuracy-report-filter"><span>Status</span><select aria-label="Filter accuracy reports by review status" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">All</option><option value="open">Open</option><option value="reviewed">Reviewed</option><option value="dismissed">Dismissed</option></select></label></div>
    {loading || (loadedIdentity !== identity && errorIdentity !== identity) ? <div className="accuracy-loading"><LoaderCircle size={15}/> Loading saved reports…</div> : errorIdentity === identity && error && !reports.length ? <div className="accuracy-report-error" role="alert"><AlertCircle size={15}/><span>{error}</span><button className="icon-button" aria-label="Retry loading reports" onClick={() => setRetryVersion(value => value + 1)}><RefreshCw size={14}/></button></div> : reports.length ? <div className="accuracy-report-list">{reports.map(report => <article className="accuracy-report-card" key={report.id}>
      <div className="accuracy-report-top"><span className="accuracy-report-kind">{kindLabels[report.kind]}</span><span className={`accuracy-review-status ${report.reviewStatus}`}>{report.reviewStatus === 'reviewed' ? <Check size={12}/> : <Circle size={10}/>} {statusLabels[report.reviewStatus]}</span></div>
      <div className="accuracy-report-meta"><span>Video position {formatVideoPosition(report.sourceTimeMs)}</span><span>·</span><span>{report.evidenceAvailability !== 'native_frame' ? 'Frame unavailable' : report.frame.provenance === 'verified_media_redecode' ? 'Verified media re-decode' : 'API-retained analyzed frame'}</span><span>·</span><span>Partial issue record</span></div>
      {report.originalDetection && <p className="accuracy-report-detection">{vehicleTypeLabel(report.originalDetection.class)} · {vehicleColorLabel(report.originalDetection.color)}{report.originalDetection.trackId ? ` · track #${report.originalDetection.trackId}` : ' · untracked'}</p>}
      {report.kind === 'duplicate' && report.duplicateDetection && <p className="accuracy-report-detection">Duplicate pair also includes {vehicleTypeLabel(report.duplicateDetection.class)} · {vehicleColorLabel(report.duplicateDetection.color)}{report.duplicateDetection.trackId ? ` · track #${report.duplicateDetection.trackId}` : ' · untracked'}</p>}
      {report.kind === 'missed_vehicle' && report.bbox && <p className="accuracy-report-detection">Suggested box · left {report.bbox.x.toFixed(3)}, top {report.bbox.y.toFixed(3)}, width {report.bbox.width.toFixed(3)}, height {report.bbox.height.toFixed(3)}</p>}
      {report.proposedCorrection && <p className="accuracy-report-correction">Suggested correction: {[report.proposedCorrection.correctedClassLabel && correctionClassLabels[report.proposedCorrection.correctedClassLabel], report.proposedCorrection.class && vehicleTypeLabel(report.proposedCorrection.class), report.proposedCorrection.color && vehicleColorLabel(report.proposedCorrection.color)].filter(Boolean).join(' · ')}</p>}
      {(report.note || report.reviewNote) && <p className="accuracy-report-note">{report.reviewNote || report.note}</p>}
      <button type="button" className="button button-quiet accuracy-report-evidence-toggle" aria-expanded={expandedReportId === report.id} onClick={() => setExpandedReportId(current => current === report.id ? '' : report.id)}>{expandedReportId === report.id ? 'Hide saved evidence' : 'View saved evidence and details'}</button>
      {expandedReportId === report.id && <AccuracyReportEvidence sourceId={sourceId} report={report}/>}
      <div className="accuracy-report-actions">{report.reviewStatus === 'open' ? <><button className="button button-quiet" disabled={!!busyId} onClick={() => void patchReport(report, { reviewStatus: 'reviewed', reviewLabel: 'Issue reviewed' })}>{busyId === report.id ? <LoaderCircle size={13}/> : <Check size={13}/>} Mark reviewed</button><button className="button button-quiet" disabled={!!busyId} onClick={() => void patchReport(report, { reviewStatus: 'dismissed', reviewLabel: 'Not actionable' })}>Dismiss</button></> : <button className="button button-quiet" disabled={!!busyId} onClick={() => void patchReport(report, { reviewStatus: 'open', reviewLabel: 'Reopened' })}>{busyId === report.id ? <LoaderCircle size={13}/> : <RefreshCw size={13}/>} Reopen</button>}</div>
    </article>)}</div> : <div className="accuracy-empty">No accuracy reports {sessionId ? 'for this session' : 'yet'}.</div>}
    {coverage === 'truncated' && <p className="accuracy-partial-note">Only the retained report history is listed.</p>}
    {errorIdentity === identity && error && reports.length > 0 && <p className="accuracy-report-error" role="alert">{error}</p>}
    {cursor && <button className="button button-quiet accuracy-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <LoaderCircle size={14}/> : <ChevronDown size={14}/>} Load older reports</button>}
  </section>
}

function AccuracyReportEvidence({ sourceId, report }: { sourceId: string; report: AccuracyFeedback }) {
  const [imageUrl, setImageUrl] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(report.evidenceAvailability === 'native_frame')
  useEffect(() => {
    if (report.evidenceAvailability !== 'native_frame') { setLoading(false); return }
    const controller = new AbortController()
    let active = true
    let objectUrl = ''
    setLoading(true); setError(''); setImageUrl('')
    void api.accuracyReportFrame(sourceId, report.id, controller.signal).then(blob => {
      if (!active) return
      objectUrl = URL.createObjectURL(blob)
      setImageUrl(objectUrl)
    }).catch(reason => {
      if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load the saved report frame.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [sourceId, report.id, report.evidenceAvailability])
  const context = report.analysisContext
  const scene = context.scene?.snapshot
  const originalBox = report.originalDetection?.bbox
  const correctedBox = report.proposedCorrection?.bbox ?? report.bbox
  const duplicateBox = report.duplicateDetection?.bbox
  return <div className="accuracy-report-evidence">
    <div className="accuracy-report-evidence-meta"><span>{report.annotationCoverage === 'partial' ? 'Partial issue record' : 'Annotation coverage unavailable'}</span><span>{report.frame.provenance === 'verified_media_redecode' ? 'Verified media re-decode' : report.frame.provenance === 'analysis_source_frame' ? 'API-retained analyzed frame' : 'Original frame unavailable'}</span><span>{report.frameWidth} × {report.frameHeight}</span></div>
    {loading ? <div className="accuracy-loading"><LoaderCircle size={15}/> Loading saved report frame…</div> : imageUrl ? <div className="accuracy-report-image-stage" style={{ aspectRatio: `${report.frame.width ?? report.frameWidth} / ${report.frame.height ?? report.frameHeight}` }}><img src={imageUrl} alt={`Saved evidence for ${kindLabels[report.kind]} at ${formatVideoPosition(report.sourceTimeMs)}`} onError={() => setError('The saved report frame could not be displayed.')}/>{originalBox && <span className="accuracy-report-image-box original" style={{ left: `${originalBox.x * 100}%`, top: `${originalBox.y * 100}%`, width: `${originalBox.width * 100}%`, height: `${originalBox.height * 100}%` }} aria-label="Original detection box"/>}{duplicateBox && <span className="accuracy-report-image-box duplicate" style={{ left: `${duplicateBox.x * 100}%`, top: `${duplicateBox.y * 100}%`, width: `${duplicateBox.width * 100}%`, height: `${duplicateBox.height * 100}%` }} aria-label="Other detection in duplicate pair"/>}{correctedBox && <span className="accuracy-report-image-box correction" style={{ left: `${correctedBox.x * 100}%`, top: `${correctedBox.y * 100}%`, width: `${correctedBox.width * 100}%`, height: `${correctedBox.height * 100}%` }} aria-label="Suggested correction box"/>}</div> : <div className="accuracy-evidence-placeholder"><AlertCircle size={18}/><strong>Saved image unavailable</strong><span>{error || 'No native image was retained for this report.'}</span></div>}
    {error && imageUrl && <p className="accuracy-inline-error" role="alert">{error}</p>}
    {originalBox && <p className="accuracy-report-evidence-caption"><span className="original-key"/> Original detection box · x {originalBox.x.toFixed(3)}, y {originalBox.y.toFixed(3)}, width {originalBox.width.toFixed(3)}, height {originalBox.height.toFixed(3)}</p>}
    {duplicateBox && <p className="accuracy-report-evidence-caption"><span className="duplicate-key"/> Other detection in duplicate pair · x {duplicateBox.x.toFixed(3)}, y {duplicateBox.y.toFixed(3)}, width {duplicateBox.width.toFixed(3)}, height {duplicateBox.height.toFixed(3)}</p>}
    {correctedBox && <p className="accuracy-report-evidence-caption"><span className="correction-key"/> Suggested box · x {correctedBox.x.toFixed(3)}, y {correctedBox.y.toFixed(3)}, width {correctedBox.width.toFixed(3)}, height {correctedBox.height.toFixed(3)}</p>}
    <details className="accuracy-report-context"><summary>Captured analysis context</summary><dl><dt>Settings snapshot</dt><dd>{context.settingsCaptured ? 'Captured with the analyzed event' : 'Not captured for this older event'}</dd><dt>Detector</dt><dd>{context.detector ? [context.detector.modelName, context.detector.backend, context.detector.device, context.detector.detectorSize].filter(Boolean).join(' · ') : 'Unavailable'}</dd><dt>Sampling / mode</dt><dd>{[context.sampling?.sampleEveryMs !== undefined ? `Every ${context.sampling.sampleEveryMs} ms` : '', context.detectionMode ?? ''].filter(Boolean).join(' · ') || 'Unavailable'}</dd><dt>Tracker</dt><dd>{context.tracker?.backend ?? 'Unavailable'}</dd><dt>Captured scene</dt><dd>{scene ? `${scene.zones.length} zones, ${scene.countingLines.length} lines · ${context.scene?.geometrySignature}` : 'Unavailable'}</dd><dt>Event quality</dt><dd>{[context.qualityCoverage ?? 'unknown', ...(context.qualityNotes ?? [])].join(' · ')}</dd></dl></details>
  </div>
}
