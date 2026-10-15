import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, LoaderCircle, RefreshCw, Route, X } from 'lucide-react'
import { api, type TrackHistory, type TrackObservation } from './api'
import { formatVideoPosition } from './videoTime'
import { vehicleColorLabel, vehicleColorSwatch, vehicleTypeLabel } from './vehicleTypes'

export function TrackInspector({ sourceId, sessionId, trackId, onClose }: { sourceId: string; sessionId: string; trackId: string; onClose: () => void }) {
  const [history, setHistory] = useState<TrackHistory | null>(null)
  const [observations, setObservations] = useState<TrackObservation[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [requestVersion, setRequestVersion] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const identity = `${sourceId}:${sessionId}:${trackId}`
  const identityRef = useRef(identity)
  identityRef.current = identity
  const newestFirst = useMemo(() => [...observations].sort((a, b) => b.sourceTimeMs - a.sourceTimeMs), [observations])
  const oldestFirst = useMemo(() => [...observations].sort((a, b) => a.sourceTimeMs - b.sourceTimeMs), [observations])
  const types = useMemo(() => [...new Set(observations.map(item => vehicleTypeLabel(item.class)))], [observations])
  const colors = useMemo(() => [...new Set(observations.map(item => vehicleColorLabel(item.color)))], [observations])
  const zones = useMemo(() => [...new Set(observations.flatMap(item => item.zoneIds))], [observations])
  const unknownZoneAttributions = useMemo(() => observations.filter(item => item.zoneAttribution === 'unavailable').length, [observations])
  const crossings = useMemo(() => [...new Map(observations.flatMap(item => item.crossings.map(crossing => [`${crossing.lineId}:${crossing.direction}`, crossing] as const))).values()], [observations])
  const plotted = useMemo(() => {
    if (oldestFirst.length < 2) return ''
    return oldestFirst.map((item, index) => {
      const x = 8 + ((item.bbox.x + item.bbox.width / 2) * 84)
      const y = 8 + ((item.bbox.y + item.bbox.height / 2) * 84)
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
    }).join(' ')
  }, [oldestFirst])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true); setError(''); setHistory(null); setObservations([]); setNextCursor(null)
    void api.trackHistory(sourceId, trackId, sessionId, undefined, controller.signal).then(page => {
      if (!active) return
      setHistory(page); setObservations(page.observations); setNextCursor(page.nextCursor ?? null)
    }).catch(reason => {
      if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load this track history.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [sourceId, sessionId, trackId, requestVersion])

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    const cursor = nextCursor
      const targetIdentity = identity
    const controller = new AbortController()
    setLoadingMore(true); setError('')
    try {
      const page = await api.trackHistory(sourceId, trackId, sessionId, cursor, controller.signal)
      if (targetIdentity !== identityRef.current) return
      setObservations(current => [...current, ...page.observations.filter(next => !current.some(row => row.eventId === next.eventId && row.detectionIndex === next.detectionIndex))])
      setHistory(page); setNextCursor(page.nextCursor ?? null)
    } catch (reason) {
      if (targetIdentity === identityRef.current) setError(reason instanceof Error ? reason.message : 'Could not load more track history.')
    } finally { if (targetIdentity === identityRef.current) setLoadingMore(false) }
  }

  return <section className="accuracy-track-inspector" aria-labelledby="accuracy-track-title">
    <div className="accuracy-inspector-heading"><div><div className="eyebrow">TRACK INSPECTOR</div><h3 id="accuracy-track-title">Track #{trackId}</h3><p>Only this source and analysis session</p></div><button type="button" className="icon-button" aria-label="Close track inspector" onClick={onClose}><X size={17}/></button></div>
    <div className="accuracy-identity-note"><Route size={15}/><span>Track IDs are temporary analysis labels. A vehicle can receive a new ID after occlusion, and an ID can be reused.</span></div>
    {loading ? <div className="accuracy-loading"><LoaderCircle size={16}/> Loading sampled observations…</div> : error && !history ? <div className="accuracy-inline-error" role="alert"><AlertCircle size={15}/>{error}<button type="button" className="button button-quiet" onClick={() => setRequestVersion(value => value + 1)}><RefreshCw size={13}/> Retry</button></div> : !history || history.track.observationCount === 0 ? <div className="accuracy-empty">No retained observations are available for this track.</div> : <>
      <div className="accuracy-track-summary"><span><strong>{history.track.observationCount}</strong> sampled observations</span><span className={`accuracy-coverage ${history.track.coverage}`}>{history.track.coverage === 'truncated' ? 'History is partial' : 'Retained history'}</span><span>{history.track.firstObservedAtMs == null ? '—' : formatVideoPosition(history.track.firstObservedAtMs)} – {history.track.lastObservedAtMs == null ? '—' : formatVideoPosition(history.track.lastObservedAtMs)}</span></div>
      {history.track.coverage === 'truncated' && <p className="accuracy-partial-note">Older event history has been trimmed. This inspector shows retained observations only.</p>}
      <div className="accuracy-track-contributions"><div><strong>Types in loaded samples</strong><span>{types.join(', ') || 'Unknown'}</span></div><div><strong>Colors in loaded samples</strong><span>{colors.map(color => <span className="accuracy-color-observation" key={color}><i style={{ backgroundColor: vehicleColorSwatch(color) }}/>{color}</span>)}</span></div><div><strong>Zones in loaded samples</strong><span>{zones.length ? zones.join(', ') : unknownZoneAttributions === observations.length ? 'Unavailable for retained observations' : 'No saved zone contribution'}{unknownZoneAttributions > 0 && unknownZoneAttributions < observations.length ? ` · unavailable for ${unknownZoneAttributions} loaded samples` : ''}</span></div><div><strong>Line crossings</strong><span>{crossings.length ? crossings.map(crossing => `${crossing.direction} (${crossing.lineId.slice(0, 8)})`).join(', ') : 'No recorded crossing'}</span></div></div>
      {oldestFirst.length > 1 && <div className="accuracy-trajectory"><strong>Sampled path within the frame</strong><svg viewBox="0 0 100 100" role="img" aria-label={`${oldestFirst.length} sampled vehicle positions within frame coordinates`}><path d={plotted} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke"/><circle cx={8 + (oldestFirst[0]!.bbox.x + oldestFirst[0]!.bbox.width / 2) * 84} cy={8 + (oldestFirst[0]!.bbox.y + oldestFirst[0]!.bbox.height / 2) * 84} r="2.5"/><circle cx={8 + (oldestFirst.at(-1)!.bbox.x + oldestFirst.at(-1)!.bbox.width / 2) * 84} cy={8 + (oldestFirst.at(-1)!.bbox.y + oldestFirst.at(-1)!.bbox.height / 2) * 84} r="2.5"/></svg><small>Relative positions from sampled boxes; no path is inferred between samples.</small></div>}
      <div className="accuracy-observation-list"><strong>Sampled history ({observations.length} loaded)</strong>{newestFirst.map(item => <div className="accuracy-observation-row" key={`${item.eventId}:${item.detectionIndex}`}><span className="accuracy-observation-time">{formatVideoPosition(item.sourceTimeMs)}</span><span>{vehicleTypeLabel(item.class)} · {vehicleColorLabel(item.color)}</span><span>{Math.round(item.confidence * 100)}%</span><span>{item.zoneAttribution === 'unavailable' ? 'Zone attribution unavailable' : item.zoneIds.length ? `Zones: ${item.zoneIds.join(', ')}` : 'No zone'}</span>{item.crossings.length > 0 && <small>Crossed {item.crossings.map(value => value.direction).join(', ')}</small>}</div>)}</div>
      {nextCursor && <button className="button button-quiet accuracy-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <LoaderCircle size={14}/> : <ChevronDown size={14}/>} Load more observations</button>}
      {error && <p className="accuracy-inline-error" role="alert">{error}</p>}
    </>}
  </section>
}
