import { videoTimeExportFields, type RecordingTime } from './videoTime'
import type { CameraLocation } from './cameraLocation'
import type { AnalysisContext } from '@traffic/contracts'

export type SourceKind = 'webcam' | 'upload' | 'stream' | 'youtube'
export type SourceStatus = 'idle' | 'running' | 'stopped' | 'completed' | 'error'
export type Point = { x: number; y: number }
export type SceneZone = { id: string; name: string; polygon: Point[] }
export type SceneLine = { id: string; name: string; start: Point; end: Point; directionLabels: [string, string] }
export type Scene = { zones: SceneZone[]; countingLines: SceneLine[] }
export type Detection = {
  class: string
  confidence: number
  color?: string
  colorMethod?: 'hsv_estimate' | 'classifier'
  colorSupportRatio?: number
  trackId?: string
  bbox: { x: number; y: number; width: number; height: number }
}
export type Crossing = { lineId: string; direction: string; trackId: string }
export type TrafficEvent = {
  id?: string
  frameId?: string
  sourceId: string
  sessionId: string
  sourceTimeMs: number
  frameWidth: number
  frameHeight: number
  detections: Detection[]
  crossings: Crossing[]
  type: 'analysis' | 'crossing'
  quality: { coverage: 'known' | 'unknown'; notes: string[] }
}
export type AccuracyFeedbackKind = 'duplicate' | 'missed_vehicle' | 'false_positive' | 'wrong_type' | 'wrong_color'
export type AccuracyReviewStatus = 'open' | 'reviewed' | 'dismissed'
export type AccuracyFeedbackFrame = { frameId?: string; provenance: 'analysis_source_frame' | 'verified_media_redecode' | 'unavailable'; url?: string; mimeType?: string; width?: number; height?: number }
export type AccuracyFeedbackDraft = { draftId: string; sourceId: string; sessionId: string; eventId: string; frameId?: string; frame: AccuracyFeedbackFrame; expiresAt: string }
export type NormalizedBox = { x: number; y: number; width: number; height: number }
export type CorrectedClassLabel = 'car' | 'van' | 'pickup_truck' | 'suv' | 'motorcycle' | 'bus' | 'truck' | 'bicycle' | 'other_vehicle'
export type ProposedCorrection = { class?: string; correctedClassLabel?: CorrectedClassLabel; color?: string; bbox?: NormalizedBox }
export type AccuracyFeedback = {
  id: string; sourceId: string; sessionId: string; eventId: string; sourceTimeMs: number
  frameWidth: number; frameHeight: number; analysisFrameId?: string; frame: AccuracyFeedbackFrame; kind: AccuracyFeedbackKind
  analysisContext: AnalysisContext
  detectionIndex?: number; duplicateOfDetectionIndex?: number; originalDetection?: Detection; duplicateDetection?: Detection; bbox?: NormalizedBox
  proposedCorrection?: ProposedCorrection; note?: string
  reviewStatus: AccuracyReviewStatus; reviewLabel?: string; reviewNote?: string
  evidenceAvailability: 'native_frame' | 'unavailable'; annotationCoverage: 'partial' | 'complete'; reviewHistory?: { at: string; action: string; label?: string }[]
  createdAt: string; updatedAt: string
}
export type AccuracyFeedbackPage = { reports: AccuracyFeedback[]; nextCursor?: string | null; hasMore: boolean; coverage: 'known' | 'truncated' }
export type TrackObservation = {
  eventId: string; frameId?: string; sourceTimeMs: number; frameWidth: number; frameHeight: number
  detectionIndex: number; bbox: NormalizedBox; class: string; color?: string; confidence: number
  zoneIds: string[]; zoneAttribution: 'captured_scene' | 'unavailable'; crossings: { lineId: string; direction: string }[]
}
export type TrackHistory = {
  track: { sourceId: string; sessionId: string; trackId: string; observationCount: number; coverage: 'known' | 'truncated'; firstObservedAtMs: number | null; lastObservedAtMs: number | null }
  observations: TrackObservation[]; nextCursor: string | null; hasMore: boolean
}
export type Source = {
  id: string
  name: string
  kind: SourceKind
  status: SourceStatus
  createdAt: string
  url?: string
  width?: number
  height?: number
  durationMs?: number
  recordingTime?: RecordingTime
  location?: CameraLocation
  folderId?: string
  error?: string
  youtube?: { videoId: string; title?: string; isLive?: boolean; liveStatus?: 'is_live' | 'not_live' | 'was_live' | 'post_live' | 'is_upcoming' | 'unknown' }
}
export type SourceFolder = { id: string; name: string; createdAt: string }
export type SourceLibrary = { sources: Source[]; folders: SourceFolder[] }
export type SourcePreview = { sourceId: string; sessionId: string; sourceTimeMs: number; frameId: string; width: number; height: number }
export type UniqueVehicleCompleteness = 'known' | 'partial' | 'unknown'
export type UniqueVehicleScopeTotal = { count: number | null; completeness: UniqueVehicleCompleteness }
export type UniqueVehicleSummary = {
  sessionId: string
  geometrySignature: string
  completeness: UniqueVehicleCompleteness
  note?: string
  all: UniqueVehicleScopeTotal
  zones: { zoneId: string; count: number | null; completeness: UniqueVehicleCompleteness }[]
  lines: { lineId: string; count: number | null; completeness: UniqueVehicleCompleteness }[]
}
export type Summary = { sourceId: string; sessionId?: string; visibleVehicleCount: number | null; crossings: { lineId: string; direction: string; count: number }[]; coverage: 'known' | 'unknown'; analyzedDurationMs: number | null; historyTruncated: boolean; discardedEventCount: number | null; note?: string; uniqueVehicles?: UniqueVehicleSummary }

const root = '/api'
export type Health = { status: 'ok' | 'degraded'; worker: { available: boolean; detail: string }; upload: { maxBytes: number } }
export type UploadProgress = { loaded: number; total: number }
export class UploadError extends Error { constructor(message: string,readonly status?: number){super(message);this.name='UploadError'} }
export function createUploadIdempotencyKey(randomValues:(bytes:Uint8Array)=>Uint8Array=bytes=>crypto.getRandomValues(bytes)) {
  const bytes=randomValues(new Uint8Array(16))
  bytes[6]=(bytes[6]!&0x0f)|0x40;bytes[8]=(bytes[8]!&0x3f)|0x80
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB','MiB','GiB','TiB']
  let value=bytes/1024, unit=0
  while(value>=1024&&unit<units.length-1){value/=1024;unit++}
  return `${value.toFixed(value>=10?1:2)} ${units[unit]}`
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${root}${path}`, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error((typeof body?.error === 'string' ? body.error : body?.error?.message) ?? body?.message ?? `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}
export const api = {
  health: () => request<Health>('/health'),
  sources: async () => (await request<{ sources: Source[] }>('/sources')).sources,
  sourceLibrary: async (): Promise<SourceLibrary> => {
    // Older API versions return only { sources }; keep the sources page usable
    // during staged deployments where folder support has not been promoted yet.
    const library = await request<{ sources: Source[]; folders?: SourceFolder[] }>('/sources')
    return { sources: library.sources, folders: library.folders ?? [] }
  },
  createSourceFolder: (name: string) => request<SourceLibrary>('/source-folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
  renameSourceFolder: (id: string, name: string) => request<SourceLibrary>(`/source-folders/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
  deleteSourceFolder: (id: string) => request<SourceLibrary>(`/source-folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  organizeSource: (id: string, folderId: string | null, beforeSourceId?: string | null) => request<SourceLibrary>(`/sources/${encodeURIComponent(id)}/organization`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId, ...(beforeSourceId !== undefined ? { beforeSourceId } : {}) }) }),
  source: async (id: string) => (await request<{ source: Source }>(`/sources/${encodeURIComponent(id)}`)).source,
  deleteSource: async (id: string) => {
    const response = await fetch(`${root}/sources/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error((typeof body?.error === 'string' ? body.error : body?.error?.message) ?? body?.message ?? `Request failed (${response.status})`)
    }
  },
  renameSource: async (id: string, name: string) => (await request<{ source: Source }>(`/sources/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).source,
  setSourceLocation: async (id: string, location: CameraLocation | null) => (await request<{ source: Source }>(`/sources/${encodeURIComponent(id)}/location`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location }) })).source,
  setRecordingTime: async (id: string, manualStartAt: string | null) => (await request<{ source: Source }>(`/sources/${encodeURIComponent(id)}/recording-time`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manualStartAt }) })).source,
  refreshSourceMetadata: async (id: string) => (await request<{ source: Source }>(`/sources/${encodeURIComponent(id)}/metadata/refresh`, { method: 'POST' })).source,
  scene: async (id: string) => (await request<{ scene: Scene }>(`/sources/${encodeURIComponent(id)}/scene`)).scene,
  addSource: async (body: { name: string; kind: 'webcam' | 'stream' | 'youtube'; url?: string }) =>
    (await request<{ source: Source }>('/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).source,
  latestPreview: async (id: string) => (await request<{ preview: SourcePreview | null }>(`/sources/${encodeURIComponent(id)}/preview`, { cache: 'no-store' })).preview,
  refreshPreview: async (id: string) => request<{ source: Source; preview: SourcePreview }>(`/sources/${encodeURIComponent(id)}/preview`, { method: 'POST' }),
  previewFrameUrl: (id: string, preview: SourcePreview) => `${root}/sources/${encodeURIComponent(id)}/preview/${encodeURIComponent(preview.sessionId)}/${encodeURIComponent(preview.frameId)}`,
  previewFrame: async (id: string, preview: SourcePreview, signal?: AbortSignal) => {
    const response = await fetch(api.previewFrameUrl(id, preview), { signal, cache: 'no-store' })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error((typeof body?.error === 'string' ? body.error : body?.error?.message) ?? body?.message ?? `Preview frame request failed (${response.status})`)
    }
    return response.blob()
  },
  upload: (file: File, name: string, options: { signal: AbortSignal; idempotencyKey: string; onProgress: (progress: UploadProgress) => void }) => new Promise<Source>((resolve,reject)=>{
    const xhr=new XMLHttpRequest()
    const form=new FormData();form.append('file',file);form.append('name',name)
    const cleanup=()=>options.signal.removeEventListener('abort',abort)
    const abort=()=>xhr.abort()
    xhr.open('POST',`${root}/uploads`)
    xhr.setRequestHeader('Idempotency-Key',options.idempotencyKey)
    xhr.upload.onprogress=event=>options.onProgress({loaded:event.loaded,total:event.lengthComputable?event.total:file.size})
    xhr.onload=()=>{
      cleanup()
      let body:any=null
      try{body=JSON.parse(xhr.responseText)}catch{}
      if(xhr.status<200||xhr.status>=300){reject(new UploadError((typeof body?.error==='string'?body.error:body?.error?.message)??body?.message??`Upload failed (${xhr.status})`,xhr.status));return}
      if(!body?.source){reject(new UploadError('The server accepted the upload but returned no source record.',xhr.status));return}
      resolve(body.source as Source)
    }
    xhr.onerror=()=>{cleanup();reject(new UploadError('Upload connection failed. Check the local API connection and retry.'))}
    xhr.onabort=()=>{cleanup();reject(new DOMException('Upload cancelled','AbortError'))}
    xhr.ontimeout=()=>{cleanup();reject(new UploadError('Upload timed out. Check the local API connection and retry.'))}
    options.signal.addEventListener('abort',abort,{once:true})
    if(options.signal.aborted){cleanup();reject(new DOMException('Upload cancelled','AbortError'));return}
    xhr.send(form)
  }),
  saveScene: async (id: string, scene: Scene) => (await request<{ scene: Scene }>(`/sources/${encodeURIComponent(id)}/scene`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scene) })).scene,
  start: async (id: string) => (await request<{ source: Source }>(`/sources/${encodeURIComponent(id)}/start`, { method: 'POST' })).source,
  stop: async (id: string) => (await request<{ source: Source }>(`/sources/${encodeURIComponent(id)}/stop`, { method: 'POST' })).source,
  events: async (id: string, signal?: AbortSignal) => request<{ events: TrafficEvent[]; truncated: boolean; discardedCount: number | null }>(`/sources/${encodeURIComponent(id)}/events`, { signal }),
  summary: async (id: string) => (await request<{ summary: Summary }>(`/sources/${encodeURIComponent(id)}/summary`)).summary,
  accuracyFeedback: (id: string, options: { sessionId?: string; reviewStatus?: AccuracyReviewStatus; cursor?: string; limit?: number } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams()
    if (options.sessionId) query.set('sessionId', options.sessionId)
    if (options.reviewStatus) query.set('reviewStatus', options.reviewStatus)
    if (options.cursor) query.set('cursor', options.cursor)
    if (options.limit) query.set('limit', String(options.limit))
    const suffix = query.size ? `?${query.toString()}` : ''
    return request<AccuracyFeedbackPage>(`/sources/${encodeURIComponent(id)}/feedback${suffix}`, { cache: 'no-store', signal })
  },
  createAccuracyFeedbackDraft: (id: string, eventId: string, signal?: AbortSignal) => request<{ draft: AccuracyFeedbackDraft }>(`/sources/${encodeURIComponent(id)}/feedback/drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId }), signal }),
  accuracyDraftFrame: async (url: string, signal?: AbortSignal) => {
    const resolved = new URL(url, window.location.origin)
    if (resolved.origin !== window.location.origin) throw new Error('The pinned frame URL must be served by this dashboard.')
    const response = await fetch(resolved, { signal, cache: 'no-store' })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error((typeof body?.error === 'string' ? body.error : body?.error?.message) ?? body?.message ?? `Reserved analyzed frame request failed (${response.status})`)
    }
    return response.blob()
  },
  cancelAccuracyFeedbackDraft: async (id: string, draftId: string) => {
    const response = await fetch(`${root}/sources/${encodeURIComponent(id)}/feedback/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error((typeof body?.error === 'string' ? body.error : body?.error?.message) ?? body?.message ?? `Evidence reservation cleanup failed (${response.status})`)
    }
  },
  createAccuracyFeedback: (id: string, body: { draftId: string; eventId: string; frameId?: string; kind: AccuracyFeedbackKind; detectionIndex?: number; duplicateOfDetectionIndex?: number; bbox?: NormalizedBox; proposedCorrection?: ProposedCorrection; note?: string }) =>
    request<{ report: AccuracyFeedback }>(`/sources/${encodeURIComponent(id)}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  updateAccuracyFeedback: (id: string, reportId: string, body: { reviewStatus?: AccuracyReviewStatus; reviewLabel?: string; reviewNote?: string }) =>
    request<{ report: AccuracyFeedback }>(`/sources/${encodeURIComponent(id)}/feedback/${encodeURIComponent(reportId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  accuracyReportFrame: async (id: string, reportId: string, signal?: AbortSignal) => {
    const response = await fetch(`${root}/sources/${encodeURIComponent(id)}/feedback/${encodeURIComponent(reportId)}/frame`, { signal, cache: 'no-store' })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error((typeof body?.error === 'string' ? body.error : body?.error?.message) ?? body?.message ?? `Saved report frame request failed (${response.status})`)
    }
    return response.blob()
  },
  trackHistory: (id: string, trackId: string, sessionId: string, cursor?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ sessionId, limit: '50' })
    if (cursor) query.set('cursor', cursor)
    return request<TrackHistory>(`/sources/${encodeURIComponent(id)}/tracks/${encodeURIComponent(trackId)}?${query.toString()}`, { cache: 'no-store', signal })
  },
  analysisFrameUrl: (id: string, frameId: string) => `${root}/sources/${encodeURIComponent(id)}/frames/${encodeURIComponent(frameId)}`,
  analysisFrame: async (id: string, frameId: string, signal?: AbortSignal) => {
    const response = await fetch(api.analysisFrameUrl(id, frameId), { signal, cache: 'no-store' })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error((typeof body?.error === 'string' ? body.error : body?.error?.message) ?? body?.message ?? `Analyzed frame request failed (${response.status})`)
    }
    return response.blob()
  },
  frame: async (id: string, blob: Blob, sourceTimeMs: number) => {
    const data = new FormData(); data.append('file', blob, 'frame.jpg'); data.append('sourceTimeMs', String(sourceTimeMs))
    return request(`/sources/${encodeURIComponent(id)}/frame`, { method: 'POST', body: data })
  },
  videoUrl: (id: string) => `${root}/sources/${encodeURIComponent(id)}/video`,
  streamUrl: (id: string) => `${root}/sources/${encodeURIComponent(id)}/stream`,
}

export function exportRows(events: TrafficEvent[], sourceName: string, format: 'csv' | 'json', summary?: Summary | null, historyTruncated = false, discardedEventCount?: number | null, clientEventsOmitted = 0, recordingTime?: RecordingTime | null) {
  const serverHistoryTruncated = historyTruncated || summary?.historyTruncated === true
  const truncated = serverHistoryTruncated || clientEventsOmitted > 0
  const discardedCount = summary?.discardedEventCount ?? discardedEventCount ?? (truncated ? null : 0)
  const eventWindow = [serverHistoryTruncated ? discardedCount === null ? 'newest server-retained event window; server discard count unavailable' : `${discardedCount} older server records discarded` : 'all server-retained event records', clientEventsOmitted > 0 ? `${clientEventsOmitted} older records omitted from this browser window` : ''].filter(Boolean).join('; ')
  if (format === 'json') return JSON.stringify({
    metadata: {
      source: sourceName,
      exportedAt: new Date().toISOString(),
      retainedEventCount: events.length,
      historyTruncated: truncated,
      discardedEventCount: discardedCount,
      clientEventsOmitted,
      eventWindow,
      latestSessionId: summary?.sessionId ?? null,
      cumulativeSessionCrossings: summary?.crossings ?? [],
      analyzedDurationMs: summary?.analyzedDurationMs ?? null,
      videoTimeOrigin: recordingTime ? { ...recordingTime, displayTimeZone: 'Asia/Jerusalem' } : null,
    },
    events: events.map(event => {
      const timestamp = videoTimeExportFields(recordingTime, event.sourceTimeMs)
      const videoTime = timestamp.utc ? {
        utc: timestamp.utc,
        local: timestamp.local,
        timeZone: timestamp.timeZone,
        provenance: timestamp.provenance,
        origin: {
          effectiveStartAt: timestamp.originUtc,
          provenance: timestamp.originProvenance,
          embeddedField: timestamp.originField || undefined,
        },
      } : null
      return { ...event, videoTime }
    }),
  }, null, 2)
  const headers = ['record_type','source','source_time_ms','video_time_utc','video_time_local','video_time_zone','video_time_provenance','video_time_origin_utc','video_time_origin_provenance','video_time_origin_field','track_id','class','confidence','color','color_method','color_support_ratio','bbox_x','bbox_y','bbox_width','bbox_height','line_id','direction','history_truncated','discarded_event_count','client_events_omitted','event_window']
  const rows = [headers]
  const exportFields = [String(truncated), discardedCount === null ? '' : String(discardedCount), String(clientEventsOmitted), eventWindow]
  const metadataRow = Array<string>(headers.length).fill('')
  metadataRow[0] = 'metadata'; metadataRow[1] = sourceName
  const timeOrigin = videoTimeExportFields(recordingTime, 0)
  metadataRow[5] = timeOrigin.timeZone; metadataRow[6] = timeOrigin.provenance
  metadataRow[7] = timeOrigin.originUtc; metadataRow[8] = timeOrigin.originProvenance; metadataRow[9] = timeOrigin.originField
  metadataRow.splice(headers.length - exportFields.length, exportFields.length, ...exportFields)
  rows.push(metadataRow)
  for (const event of events) {
    const absoluteTime = videoTimeExportFields(recordingTime, event.sourceTimeMs)
    for (const detection of event.detections ?? []) {
      const row = ['detection',sourceName,String(event.sourceTimeMs),absoluteTime.utc,absoluteTime.local,absoluteTime.timeZone,absoluteTime.provenance,absoluteTime.originUtc,absoluteTime.originProvenance,absoluteTime.originField,detection.trackId ?? '',detection.class,String(detection.confidence),detection.color ?? '',detection.colorMethod ?? '',detection.colorSupportRatio === undefined ? '' : String(detection.colorSupportRatio),String(detection.bbox.x),String(detection.bbox.y),String(detection.bbox.width),String(detection.bbox.height),'','',...exportFields]
      rows.push(row)
    }
    for (const crossing of event.crossings ?? []) {
      const row = Array<string>(headers.length).fill('')
      row[0] = 'crossing'; row[1] = sourceName; row[2] = String(event.sourceTimeMs); row[3] = absoluteTime.utc; row[4] = absoluteTime.local; row[5] = absoluteTime.timeZone; row[6] = absoluteTime.provenance; row[7] = absoluteTime.originUtc; row[8] = absoluteTime.originProvenance; row[9] = absoluteTime.originField; row[10] = crossing.trackId
      row[20] = crossing.lineId; row[21] = crossing.direction
      row.splice(headers.length - exportFields.length, exportFields.length, ...exportFields)
      rows.push(row)
    }
  }
  return rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\n')
}
