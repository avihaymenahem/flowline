import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type CSSProperties, type PointerEvent } from 'react'
import { createRootRoute, createRoute, createRouter, Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { createPortal } from 'react-dom'
import {
  Activity, ArrowDownRight, ArrowUpRight, BarChart3, Bell, Camera, Check, ChevronDown, Flag,
  CircleHelp, Clock3, CloudUpload, Download, ExternalLink, Eye, Gauge, Layers3, LayoutDashboard,
  Folder, FolderPlus, GripVertical, Menu, MoreHorizontal, Pause, Play, Plus, Radio, RefreshCw, Route, Search, Settings2, Square, Video,
  Wifi, X, ZoomIn, ZoomOut, Maximize2, Minimize2, Move, Youtube, Pencil, type LucideIcon,
} from 'lucide-react'
import { api, createUploadIdempotencyKey, exportRows, formatBytes, UploadError, type Health, type Scene, type SceneLine, type Source, type SourceFolder, type SourceLibrary, type SourcePreview, type TrafficEvent } from './api'
import { containedImageRect, matchesAnalyzedFrame } from './overlayGeometry'
import { clampViewerPan, pinchViewerPan, viewerPointToImage, zoomViewerAtPoint } from './viewerGeometry'
import { analysisScopeFromNotes } from './qualityScope'
import { countByVehicleColor, countByVehicleType, vehicleColorKey, vehicleColorLabel, vehicleColorSwatch, vehicleTypeKey, vehicleTypeLabel } from './vehicleTypes'
import { ObservationTable, type ObservationRow } from './ObservationTable'
import { pageLocationFromPath, pagePathFor, pagePaths, searchAfterSourceCanonicalization, type Page } from './pageRouting'
import { filterObservationEvents, observationSessionOptions } from './observationSessions'
import { appendRecentEvent, mergeRecentEventHistory } from './eventWindow'
import { appendScenePoint, canAcceptScenePoint } from './scenePoints'
import { RecordingTimeEditor } from './RecordingTimeEditor'
import { canDropSourceIntoFolder, canReorderSources, filterAndSortSources, normalizeSourceListSearch, sourceListFiltersFromSearch, sourceSortOptions, sourceStatusOptions, sourceTypeOptions, updateSourceListSearch, type SourceListFilterPatch, type SourceListFilters } from './sourceFilters'
import { CameraLocationCard } from './CameraLocationCard'
import { OverviewLocationMap } from './OverviewLocationMap'
import { formatVideoDateTime, formatVideoPosition } from './videoTime'
import { detectionsInMonitoringScope, isCurrentDisplayedSample, lineCrossingCount } from './totalsScope'
import { createRequestGeneration } from './requestGeneration'
import { interpolatePlaybackDetections, latestPlaybackSampleFromSorted } from './playbackSamples'
import { matchingPreviewEvent, sourceMessage, updateSourceMessage, youtubeFrameReadyForAnnotation, youtubePreviewErrorMessage, youtubeVideoIdFromUrl } from './youtubeSource'
import { formatUniqueVehicleCount, sceneGeometrySignature, uniqueVehicleCompletenessNote, uniqueVehicleScopeNote, uniqueVehicleTotal, type UniqueVehicleScope } from './uniqueVehicleTotals'
import { shouldNavigateAfterSourceDelete } from './sourceDeletion'
import { mergeOrganizationSourceSnapshot, sourceIdFromDrag, sourcesInFolder, validSourceFolderView } from './sourceFolders'
import { readThemePreference, resolveColorTheme, THEME_STORAGE_KEY, type ThemePreference } from './themePreference'
import { AccuracyReviewDialog } from './AccuracyReviewDialog'
import { AccuracyReportsPanel } from './AccuracyReportsPanel'

const nav: { id: Page; label: string; icon: LucideIcon; group: string }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'Workspace' },
  { id: 'live', label: 'Live monitor', icon: Eye, group: 'Workspace' },
  { id: 'sources', label: 'Video sources', icon: Video, group: 'Workspace' },
  { id: 'observations', label: 'Observations', icon: BarChart3, group: 'Workspace' },
  { id: 'processing', label: 'Processing', icon: Activity, group: 'System' },
]
const emptyScene: Scene = { zones: [], countingLines: [] }
const time = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`
const localTime = () => new Intl.DateTimeFormat('en-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
const localZone = () => new Intl.DateTimeFormat('en-IL',{timeZone:'Asia/Jerusalem',timeZoneName:'short'}).formatToParts(new Date()).find(part=>part.type==='timeZoneName')?.value ?? 'Israel time'
const localDate = () => new Intl.DateTimeFormat('en-IL',{timeZone:'Asia/Jerusalem',weekday:'long',day:'2-digit',month:'long',year:'numeric'}).format(new Date()).toUpperCase()
const workerStatusLabel = (health: Health | null) => !health ? 'Unknown' : health.worker.available ? 'Available' : 'Not ready'

export default function App() {
  const navigate = useNavigate()
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference())
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const theme = resolveColorTheme(themePreference, media.matches)
      document.documentElement.dataset.themePreference = themePreference
      document.documentElement.dataset.theme = theme
      document.documentElement.style.colorScheme = theme
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101a24' : '#f5f8fa')
      try { window.localStorage.setItem(THEME_STORAGE_KEY, themePreference) } catch { /* Preference remains active for this page. */ }
    }
    apply()
    if (themePreference !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [themePreference])
  const pathname = useRouterState({ select: state => state.location.pathname })
  const searchStr = useRouterState({ select: state => state.location.searchStr })
  const currentPathname = useRef(pathname)
  currentPathname.current = pathname
  const pageLocation = pageLocationFromPath(pathname)
  const resolvedPage = pageLocation !== null
  const page = pageLocation?.page ?? 'overview'
  const selectedId = pageLocation?.sourceId ?? null
  const requestedFolder = new URLSearchParams(searchStr).get('folder') ?? 'all'
  const sourceFilters = sourceListFiltersFromSearch(searchStr)
  const setPage = useCallback((next: Page) => { void navigate({ to: pagePathFor(next, selectedId) }) }, [navigate, selectedId])
  const pendingSourceNavigation = useRef<string | null>(null)
  const navigateToSource = useCallback((id: string, destination: Page = page) => {
    pendingSourceNavigation.current = id
    const clearIfSuperseded = () => {
      if (pendingSourceNavigation.current === id && pageLocationFromPath(currentPathname.current)?.sourceId !== id) pendingSourceNavigation.current = null
    }
    void navigate({ to: pagePathFor(destination, id) }).then(clearIfSuperseded, clearIfSuperseded)
  }, [navigate, page])
  const [sources, setSources] = useState<Source[]>([])
  const [folders, setFolders] = useState<SourceFolder[]>([])
  const [sourcesLoaded, setSourcesLoaded] = useState(false)
  const [health, setHealth] = useState<Health | null>(null)
  const [apiError, setApiError] = useState('')
  const [events, setEvents] = useState<TrafficEvent[]>([])
  const eventsRef = useRef<TrafficEvent[]>(events)
  const [eventDataSourceId, setEventDataSourceId] = useState<string | null>(null)
  const eventDataSourceIdRef = useRef(eventDataSourceId)
  eventDataSourceIdRef.current = eventDataSourceId
  const deletedSourceIdsRef = useRef(new Set<string>())
  const [clientEventsOmitted, setClientEventsOmitted] = useState(0)
  const [eventHistoryTruncated, setEventHistoryTruncated] = useState(false)
  const [discardedEventCount, setDiscardedEventCount] = useState<number | null>(0)
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.summary>> | null>(null)
  const summaryRef = useRef(summary)
  const selectedIdRef = useRef(selectedId)
  const summaryRequestsRef = useRef(new Map<string, ReturnType<typeof api.summary>>())
  summaryRef.current = summary
  selectedIdRef.current = selectedId
  const loadSummary = useCallback((sourceId: string) => {
    const pending = summaryRequestsRef.current.get(sourceId)
    if (pending) return pending
    const request = api.summary(sourceId)
    summaryRequestsRef.current.set(sourceId, request)
    const clear = () => { if (summaryRequestsRef.current.get(sourceId) === request) summaryRequestsRef.current.delete(sourceId) }
    void request.then(clear, clear)
    return request
  }, [])
  const updateSourceName = useCallback((updated: Source) => {
    setSources(current => current.map(item => item.id === updated.id ? { ...item, name: updated.name } : item))
  }, [])
  const updateSourceLocation = useCallback((updated: Source) => {
    setSources(current => current.map(item => item.id === updated.id ? { ...item, location: updated.location } : item))
  }, [])
  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [folderNotice, setFolderNotice] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshGeneration = useRef(0)
  const libraryMutationGeneration = useRef(0)
  const libraryMutationInFlight = useRef(false)
  const [libraryMutationBusy, setLibraryMutationBusy] = useState(false)
  const previousPathname = useRef(pathname)
  const source = sources.find(s => s.id === selectedId) ?? null
  const sourceRecordingTime = source?.kind === 'upload' ? source.recordingTime : undefined
  const visibleEvents = source && eventDataSourceId === source.id ? events.filter(event => event.sourceId === source.id) : []
  const visibleSummary = source && summary?.sourceId === source.id ? summary : null
  const sourceHistoryLoaded = source !== null && eventDataSourceId === source.id
  const missingSource = sourcesLoaded && selectedId !== null && source === null
  const navSourceId = missingSource ? null : selectedId

  const refresh = useCallback(async () => {
    const request = ++refreshGeneration.current
    const [healthResult, sourcesResult] = await Promise.allSettled([api.health(), api.sourceLibrary()])
    if (request !== refreshGeneration.current) return
    if (healthResult.status === 'fulfilled') setHealth(healthResult.value)
    if (sourcesResult.status === 'fulfilled') {
      setSources(sourcesResult.value.sources.filter(source => !deletedSourceIdsRef.current.has(source.id)))
      setFolders(sourcesResult.value.folders)
      setSourcesLoaded(true)
    }
    if (healthResult.status === 'fulfilled' && sourcesResult.status === 'fulfilled') setApiError('')
    else {
      const error = healthResult.status === 'rejected' ? healthResult.reason : (sourcesResult as PromiseRejectedResult).reason
      setApiError(error instanceof Error ? error.message : 'Could not reach the local API')
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh, refreshKey])

  const mutateSourceLibrary = useCallback(async (mutation: () => Promise<SourceLibrary>) => {
    if (libraryMutationInFlight.current) throw new Error('Another folder or organization update is still saving.')
    libraryMutationInFlight.current = true
    setLibraryMutationBusy(true)
    const generation = ++libraryMutationGeneration.current
    refreshGeneration.current++
    try {
      const library = await mutation()
      if (generation === libraryMutationGeneration.current) {
        refreshGeneration.current++
        setSources(current => mergeOrganizationSourceSnapshot(current, library.sources, deletedSourceIdsRef.current))
        setFolders(library.folders)
        setSourcesLoaded(true)
      }
    } finally {
      libraryMutationInFlight.current = false
      setLibraryMutationBusy(false)
    }
  }, [])
  const createSourceFolder = useCallback((name: string) => mutateSourceLibrary(() => api.createSourceFolder(name)), [mutateSourceLibrary])
  const renameSourceFolder = useCallback((id: string, name: string) => mutateSourceLibrary(() => api.renameSourceFolder(id, name)), [mutateSourceLibrary])
  const deleteSourceFolder = useCallback((id: string) => mutateSourceLibrary(() => api.deleteSourceFolder(id)), [mutateSourceLibrary])
  const organizeSource = useCallback((id: string, folderId: string | null, beforeSourceId?: string | null) => mutateSourceLibrary(() => api.organizeSource(id, folderId, beforeSourceId)), [mutateSourceLibrary])
  const selectFolder = useCallback((folderId: string) => {
    setFolderNotice('')
    void navigate({ to: pagePathFor('sources', selectedId), search: (previous: Record<string, unknown>) => ({ ...previous, folder: folderId === 'all' ? undefined : folderId }) as never, resetScroll: false })
  }, [navigate, selectedId])
  const updateSourceFilters = useCallback((patch: SourceListFilterPatch, replace = false) => {
    void navigate({ to: pagePathFor('sources', selectedId), search: (previous: Record<string, unknown>) => updateSourceListSearch(previous, patch) as never, replace, resetScroll: false })
  }, [navigate, selectedId])
  useEffect(() => {
    if (page !== 'sources') return
    if (sourcesLoaded && !validSourceFolderView(requestedFolder, new Set(folders.map(folder => folder.id)))) return
    const params = new URLSearchParams(searchStr)
    const normalized = normalizeSourceListSearch(Object.fromEntries(params.entries()))
    const normalizedEntries = Object.entries(normalized)
    const alreadyCanonical = params.size === normalizedEntries.length && normalizedEntries.every(([key, value]) => params.getAll(key).length === 1 && params.get(key) === value)
    if (!alreadyCanonical) void navigate({ to: pagePathFor('sources', selectedId), search: normalized as never, replace: true, resetScroll: false })
  }, [folders, navigate, page, requestedFolder, searchStr, selectedId, sourcesLoaded])
  useEffect(() => {
    if (page !== 'sources' || !sourcesLoaded) return
    if (!validSourceFolderView(requestedFolder, new Set(folders.map(folder => folder.id)))) {
      setFolderNotice('That folder is no longer available. Showing all sources.')
      void navigate({ to: pagePathFor('sources', selectedId), search: (previous: Record<string, unknown>) => ({ ...previous, folder: undefined }) as never, replace: true, resetScroll: false })
    }
  }, [folders, navigate, page, requestedFolder, selectedId, sourcesLoaded])

  useEffect(() => {
    if (previousPathname.current === pathname) return
    previousPathname.current = pathname
    if (pendingSourceNavigation.current && selectedId !== pendingSourceNavigation.current) pendingSourceNavigation.current = null
  }, [pathname, selectedId])

  useEffect(() => {
    if (pendingSourceNavigation.current) {
      if (selectedId === pendingSourceNavigation.current) pendingSourceNavigation.current = null
      else return
    }
    if (!resolvedPage || !sourcesLoaded || selectedId || !sources.length) return
    void navigate({ to: pagePathFor(page, sources[0]!.id), search: (previous: Record<string, unknown>) => searchAfterSourceCanonicalization(page, previous) as never, replace: true })
  }, [navigate, page, resolvedPage, selectedId, sources, sourcesLoaded])

  useEffect(() => {
    if (!source) { eventsRef.current = []; setEvents([]); setEventDataSourceId(null); setClientEventsOmitted(0); setEventHistoryTruncated(false); setDiscardedEventCount(0); setSummary(null); return }
    const controller = new AbortController()
    void Promise.all([api.events(source.id, controller.signal), loadSummary(source.id)]).then(([history, nextSummary]) => {
      if (controller.signal.aborted || selectedIdRef.current !== source.id || deletedSourceIdsRef.current.has(source.id)) return
      const currentRealtime = eventsRef.current.filter(event => event.sourceId === source.id)
      const bounded = mergeRecentEventHistory(history.events, currentRealtime)
      eventsRef.current = bounded.events
      setEvents(bounded.events); setEventDataSourceId(source.id); setClientEventsOmitted(bounded.omitted); setEventHistoryTruncated(history.truncated); setDiscardedEventCount(history.discardedCount); setSummary(nextSummary)
    }).catch(() => { if (!controller.signal.aborted) { eventsRef.current = []; setEvents([]); setEventDataSourceId(null); setClientEventsOmitted(0); setEventHistoryTruncated(false); setDiscardedEventCount(null); setSummary(null) } })
    return () => controller.abort()
  }, [source?.id, refreshKey, loadSummary])

  useEffect(() => {
    if (!source || source.status !== 'running') return
    const stream = new EventSource(api.streamUrl(source.id))
    let summaryRequestInFlight = false
    let summaryRefreshQueued = false
    const refreshSummary = async (expectedSessionId?: string) => {
      if (selectedIdRef.current !== source.id || deletedSourceIdsRef.current.has(source.id)) return
      if (summaryRequestInFlight) { summaryRefreshQueued = true; return }
      summaryRequestInFlight = true
      try {
        const latest = await loadSummary(source.id)
        if (selectedIdRef.current === source.id) setSummary(latest)
        if (expectedSessionId && latest.sessionId !== expectedSessionId) summaryRefreshQueued = true
      } catch { /* The bounded poll or next session event will retry. */ }
      finally {
        summaryRequestInFlight = false
        if (summaryRefreshQueued && selectedIdRef.current === source.id) {
          summaryRefreshQueued = false
          window.setTimeout(() => void refreshSummary(), 0)
        }
      }
    }
    const receiveAnalysis = (message: MessageEvent) => {
      try {
        const event = JSON.parse(message.data) as TrafficEvent
        if (selectedIdRef.current !== event.sourceId || event.sourceId !== source.id || deletedSourceIdsRef.current.has(event.sourceId)) return
        const appended = appendRecentEvent(eventsRef.current.filter(item => item.sourceId === source.id), event)
        if (!appended.duplicate) { eventsRef.current = appended.events; setEvents(appended.events); setEventDataSourceId(source.id); if (appended.omitted) setClientEventsOmitted(current => current + appended.omitted) }
        const currentSummary = summaryRef.current
        if (currentSummary?.sourceId !== event.sourceId || currentSummary.sessionId !== event.sessionId) void refreshSummary(event.sessionId)
      } catch { /* Ignore malformed telemetry; the next snapshot remains available. */ }
    }
    const receiveStatus = (message: MessageEvent) => { try { const update=JSON.parse(message.data) as {source?:Source}; if(update.source){setSources(current=>current.map(item=>item.id===update.source!.id?update.source!:item));if(update.source.status!=='running')void refreshSummary()} } catch { /* Ignore malformed status payload. */ } }
    stream.addEventListener('analysis', receiveAnalysis as EventListener)
    stream.addEventListener('status', receiveStatus as EventListener)
    let active = true
    let statusRequestInFlight = false
    const statusPoll = window.setInterval(async () => {
      if (!active || statusRequestInFlight) return
      statusRequestInFlight = true
      try {
        const latest = await api.source(source.id)
        if (active) setSources(current => current.map(item => item.id === latest.id ? latest : item))
      } catch { /* Keep the SSE connection and retry on the next bounded poll. */ }
      finally { statusRequestInFlight = false }
    }, 5000)
    const summaryPoll = window.setInterval(() => void refreshSummary(), 5000)
    // EventSource retries transient disconnects automatically. Closing it here
    // would leave this running source without live updates until it is toggled.
    return () => { active = false; window.clearInterval(statusPoll); window.clearInterval(summaryPoll); stream.close() }
  }, [source?.id, source?.status, loadSummary])

  const mutateSource = async (action: 'start' | 'stop') => {
    if (!source) return
    setBusy(true)
    try {
      const next = await api[action](source.id)
      setSources(current => current.map(item => item.id === source.id ? next : item))
      setRefreshKey(value => value + 1)
    } catch (error) { setApiError(error instanceof Error ? error.message : 'Action failed') }
    finally { setBusy(false) }
  }

  const stopSourceById = async (sourceId: string) => {
    try {
      const stopped = await api.stop(sourceId)
      setSources(current => current.map(item => item.id === sourceId ? stopped : item))
      setRefreshKey(value => value + 1)
    } catch (error) { setApiError(error instanceof Error ? error.message : 'Could not stop the webcam source') }
  }

  const deleteSource = useCallback(async (sourceId: string) => {
    await api.deleteSource(sourceId)
    deletedSourceIdsRef.current.add(sourceId)
    refreshGeneration.current++
    setSources(current => current.filter(item => item.id !== sourceId))
    summaryRequestsRef.current.delete(sourceId)
    if (eventsRef.current.some(event => event.sourceId === sourceId)) {
      eventsRef.current = eventsRef.current.filter(event => event.sourceId !== sourceId)
      setEvents(current => current.filter(event => event.sourceId !== sourceId))
    }
    if (eventDataSourceIdRef.current === sourceId) {
      setEventDataSourceId(null)
      eventDataSourceIdRef.current = null
      setClientEventsOmitted(0)
      setEventHistoryTruncated(false)
      setDiscardedEventCount(null)
    }
    if (summaryRef.current?.sourceId === sourceId) {
      summaryRef.current = null
      setSummary(null)
    }
    if (shouldNavigateAfterSourceDelete(currentPathname.current, sourceId, pendingSourceNavigation.current)) {
      void navigate({ to: pagePaths.sources, search: (previous: Record<string, unknown>) => searchAfterSourceCanonicalization('sources', previous) as never })
    }
  }, [navigate])

  const download = (format: 'csv' | 'json') => {
    const text = exportRows(visibleEvents, source?.name ?? 'all sources', format, visibleSummary, sourceHistoryLoaded && eventHistoryTruncated, sourceHistoryLoaded ? discardedEventCount : null, sourceHistoryLoaded ? clientEventsOmitted : 0, sourceRecordingTime)
    const url = URL.createObjectURL(new Blob([text], { type: format === 'csv' ? 'text/csv' : 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `observations-${source?.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') ?? 'all'}.${format}`; anchor.click(); URL.revokeObjectURL(url)
  }

  const title = resolvedPage ? nav.find(item => item.id === page)?.label ?? 'Overview' : 'Page not found'
  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Route size={20} strokeWidth={2.6}/></div><div><strong>flowline</strong><span>TRAFFIC OPERATIONS</span></div><button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><X size={18}/></button></div>
      <div className="workspace-switch"><div className="workspace-avatar">I</div><div><strong>Israel</strong><span>Local workspace</span></div><ChevronDown size={15}/></div>
      <nav className="nav-list" aria-label="Main navigation">
        {['Workspace', 'System'].map(group => <div className="nav-group" key={group}><span className="nav-label">{group}</span>{nav.filter(item => item.group === group).map(item => <Link key={item.id} to={pagePathFor(item.id, navSourceId)} onClick={() => setSidebarOpen(false)} className={`nav-item ${page === item.id ? 'active' : ''}`}><item.icon size={17}/><span>{item.label}</span>{item.id === 'live' && sources.some(s => s.status === 'running') && <i className="nav-live-dot"/>}</Link>)}</div>)}
      </nav>
      <div className="sidebar-bottom"><div className="api-mini"><span className={`status-light ${apiError ? 'offline' : 'online'}`}/><span>{apiError ? 'API disconnected' : 'Local API'}</span><span className="api-mini-right">{apiError ? 'offline' : 'connected'}</span></div><div className="profile"><div className="profile-avatar">OP</div><div><strong>Local operator</strong><span>On this device</span></div><MoreHorizontal size={18}/></div></div>
    </aside>
    {sidebarOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}/>}
    <main className="main-area">
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={19}/></button><div className="breadcrumbs"><span>Operations</span><span className="crumb-slash">/</span><strong>{title}</strong></div><div className="topbar-right"><div className="clock-chip"><Clock3 size={14}/><span>{localTime()}</span><span className="timezone">{localZone()}</span></div><span className="topbar-divider"/><label className="theme-picker"><span className="sr-only">Color theme</span><select aria-label="Color theme" value={themePreference} onChange={event => setThemePreference(event.target.value as ThemePreference)}><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label><span className="icon-button" aria-label="Notifications"><Bell size={17}/></span><div className="topbar-user">LD</div></div></header>
      <div className="page-content">
        {!resolvedPage ? <div className="panel not-found-panel"><div className="eyebrow">404</div><h1>Page not found</h1><p>This address does not match a workspace page.</p><Link className="button button-primary" to={pagePaths.overview}>Go to Overview</Link></div> : missingSource ? <div className="panel not-found-panel"><div className="eyebrow">SOURCE UNAVAILABLE</div><h1>This source is no longer available</h1><p>The source ID in this address could not be found. Choose an available source to continue.</p><div className="button-group">{sources[0] && <button className="button button-primary" onClick={() => navigateToSource(sources[0]!.id)}>{`Open ${sources[0]!.name}`}</button>}<button className="button button-quiet" onClick={() => { void navigate({ to: pagePaths.sources }) }}>View sources</button></div></div> : <>
        {apiError && <div className="notice notice-danger"><Wifi size={17}/><div><strong>{health ? 'Local service request failed' : 'Local API is unavailable'}</strong><span>{apiError}{health ? '' : '. Start the API service and refresh this workspace.'}</span></div><button className="text-button" onClick={() => setRefreshKey(v => v + 1)}><RefreshCw size={14}/> Retry</button></div>}
        {health && !health.worker.available && <div className="notice notice-warn"><Activity size={17}/><div><strong>Analysis is not ready</strong><span>{health.worker.detail || 'Start analysis on a source to check the configured runtime and model. Setup errors will be shown here.'}</span><small>Starting a source checks and loads its configured model.</small></div><button className="text-button" onClick={() => setPage('processing')}>Processing status <ArrowUpRight size={14}/></button></div>}
        {page === 'overview' && <Overview health={health} sources={sources} selectedId={selectedId} events={visibleEvents} summary={visibleSummary} recordingTime={sourceRecordingTime} onPage={setPage} onAdd={() => setAddOpen(true)} onSelect={(id) => navigateToSource(id, 'live')} onRefresh={() => setRefreshKey(v => v + 1)} />}
        {page === 'live' && <LiveView sources={sources} selectedId={selectedId} onSelect={id => navigateToSource(id)} events={visibleEvents} summary={visibleSummary} onControl={mutateSource} busy={busy} onSceneSaved={() => setRefreshKey(v => v + 1)} onCameraUnmount={stopSourceById} onSourceRenamed={updateSourceName} onSourceLocationSaved={updateSourceLocation} />}
        {page === 'sources' && <SourcesView sources={sources} folders={folders} selectedFolder={requestedFolder} folderNotice={folderNotice} filters={sourceFilters} onFiltersChange={updateSourceFilters} onFolderSelect={selectFolder} onCreateFolder={createSourceFolder} onRenameFolder={renameSourceFolder} onDeleteFolder={deleteSourceFolder} onOrganizeSource={organizeSource} organizationBusy={libraryMutationBusy} onAdd={() => setAddOpen(true)} onSelect={id => navigateToSource(id, 'live')} onRefresh={() => setRefreshKey(v => v + 1)} onSourceUpdated={updated=>setSources(current=>current.map(item=>item.id===updated.id?updated:item))} onSourceRenamed={updateSourceName} onDeleteSource={deleteSource} />}
        {page === 'observations' && <ObservationsView sources={sources} selectedId={selectedId} onSelect={id => navigateToSource(id)} events={visibleEvents} summary={visibleSummary} recordingTime={sourceRecordingTime} historyTruncated={sourceHistoryLoaded && (eventHistoryTruncated || Boolean(visibleSummary?.historyTruncated))} discardedEventCount={sourceHistoryLoaded ? visibleSummary?.discardedEventCount ?? discardedEventCount : null} clientEventsOmitted={sourceHistoryLoaded ? clientEventsOmitted : 0} onDownload={download} />}
        {page === 'processing' && <ProcessingView health={health} sources={sources} events={visibleEvents} onRefresh={() => setRefreshKey(v => v + 1)} />}
        </>}
      </div>
    </main>
    {addOpen && <AddSourceModal maxUploadBytes={health?.upload?.maxBytes ?? null} onClose={() => setAddOpen(false)} onCreated={(created) => { refreshGeneration.current++; setSources(current => [created, ...current.filter(item => item.id !== created.id)]); setSourcesLoaded(true); setAddOpen(false); navigateToSource(created.id, 'live'); setRefreshKey(value => value + 1) }}/>}
  </div>
}

const rootRoute = createRootRoute({ component: App })
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null }),
  createRoute({ getParentRoute: () => rootRoute, path: 'overview', component: () => null }),
  createRoute({ getParentRoute: () => rootRoute, path: 'overview/$sourceId', component: () => null }),
  createRoute({ getParentRoute: () => rootRoute, path: 'live', component: () => null }),
  createRoute({ getParentRoute: () => rootRoute, path: 'live/$sourceId', component: () => null }),
  createRoute({ getParentRoute: () => rootRoute, path: 'sources', component: () => null }),
  createRoute({ getParentRoute: () => rootRoute, path: 'sources/$sourceId', component: () => null }),
  createRoute({ getParentRoute: () => rootRoute, path: 'observations', component: () => null }),
  createRoute({ getParentRoute: () => rootRoute, path: 'observations/$sourceId', component: () => null }),
  createRoute({ getParentRoute: () => rootRoute, path: 'processing', component: () => null }),
  createRoute({ getParentRoute: () => rootRoute, path: 'processing/$sourceId', component: () => null }),
])
export const router = createRouter({ routeTree })
declare module '@tanstack/react-router' { interface Register { router: typeof router } }

function PageHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{actions}</div></div>
}
function Overview({ health, sources, selectedId, events, summary, recordingTime, onPage, onAdd, onSelect, onRefresh }: { health: Health | null; sources: Source[]; selectedId: string | null; events: TrafficEvent[]; summary: Awaited<ReturnType<typeof api.summary>> | null; recordingTime?: Source['recordingTime']; onPage: (page: Page) => void; onAdd: () => void; onSelect: (id: string) => void; onRefresh: () => void }) {
  const running = sources.filter(s => s.status === 'running').length
  const detections = events.reduce((sum, event) => sum + event.detections.length, 0)
  const crossings = events.reduce((sum, event) => sum + event.crossings.length, 0)
  const recent = [...sources].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4)
  return <>
    <PageHeading eyebrow={localDate()} title="Traffic operations" description="A clear view of your traffic monitoring workspace." actions={<><button className="button button-quiet" onClick={onRefresh}><RefreshCw size={15}/> Refresh</button><button className="button button-primary" onClick={onAdd}><Plus size={16}/> Add source</button></>}/>
    <section className="metric-grid" aria-label="Workspace summary"><MetricCard label="Active sources" value={String(running)} detail={`${sources.length} configured`} icon={Radio} tint="teal"/><MetricCard label="Vehicle observations" value={detections ? detections.toLocaleString() : '—'} detail={detections ? 'Loaded event records' : 'No analysis data yet'} icon={Eye} tint="blue"/><MetricCard label="Line crossings" value={crossings ? crossings.toLocaleString() : '—'} detail={crossings ? 'Loaded event records' : 'Configure a line to begin'} icon={Route} tint="violet"/><MetricCard label="Analysis worker" value={workerStatusLabel(health)} detail={health?.worker.detail || 'Check processing status'} icon={Activity} tint="amber" onClick={() => onPage('processing')}/></section>
    <OverviewLocationMap sources={sources} selectedId={selectedId} onSelect={onSelect} onAdd={onAdd}/>
    <section className="overview-grid"><div className="panel activity-panel"><div className="panel-heading"><div><h2>Traffic activity</h2><p>Vehicle observations across the selected source</p></div><button className="select-pill" onClick={() => onPage('observations')}>All observations <ChevronDown size={14}/></button></div>{events.length ? <ActivityChart events={events} recordingTime={recordingTime}/> : <EmptyChart onAdd={onAdd}/>}</div><div className="panel health-panel"><div className="panel-heading"><div><h2>System health</h2><p>Local processing pipeline</p></div><span className="health-badge"><span className={`status-light ${health?.status==='ok'?'online':'muted'}`}/>{health?.status==='ok'?'Connected':health?.status==='degraded'?'Degraded':'Unknown'}</span></div><div className="health-flow"><HealthStep icon={Camera} label="Sources" value={`${sources.length} configured`} good={sources.length > 0}/><div className="health-connector"/><HealthStep icon={Layers3} label="Analysis worker" value={health?.worker.detail || 'Status unknown'} good={Boolean(health?.worker.available)}/><div className="health-connector"/><HealthStep icon={BarChart3} label="Event records" value={events.length ? `${events.length} loaded` : 'No records loaded'} good={events.length > 0}/></div><div className="health-footer"><span>Local API health</span><button onClick={() => onPage('processing')}>View details <ArrowUpRight size={14}/></button></div></div></section>
    <section className="panel sources-panel"><div className="panel-heading"><div><h2>Video sources</h2><p>Manage cameras and uploaded footage</p></div><button className="link-button" onClick={() => onPage('sources')}>View all <ArrowUpRight size={14}/></button></div>{recent.length ? <div className="source-table-wrap"><table className="source-table"><thead><tr><th>Source</th><th>Type</th><th>Status</th><th>Resolution</th><th>Added</th><th></th></tr></thead><tbody>{recent.map(item => <tr key={item.id} onClick={() => onSelect(item.id)}><td><span className={`source-icon ${item.kind}`}><SourceIcon kind={item.kind}/></span><span className="source-name-cell"><strong>{item.name}</strong><small>{item.id.slice(0, 8)}</small></span></td><td>{kindLabel(item.kind)}</td><td><StatusPill status={item.status}/></td><td>{item.width && item.height ? `${item.width} × ${item.height}` : '—'}</td><td>{new Intl.DateTimeFormat('en-IL',{timeZone:'Asia/Jerusalem',day:'2-digit',month:'short'}).format(new Date(item.createdAt))}</td><td><ArrowUpRight size={15}/></td></tr>)}</tbody></table></div> : <EmptySources onAdd={onAdd}/>}</section>
  </>
}
function MetricCard({ label, value, detail, icon: Icon, tint, onClick }: { label: string; value: string; detail: string; icon: LucideIcon; tint: string; onClick?: () => void }) { return <button className={`metric-card tint-${tint}`} onClick={onClick} disabled={!onClick}><div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={17}/></span></div><strong>{value}</strong><small>{detail}</small></button> }
function ActivityChart({ events, recordingTime }: { events: TrafficEvent[]; recordingTime?: Source['recordingTime'] }) {
  const buckets = Array.from({ length: 12 }, (_, i) => ({ label: '', value: 0 }))
  const times=events.map(event=>event.sourceTimeMs), min=Math.min(...times), maxTime=Math.max(...times), span=Math.max(1,maxTime-min)
  for (const event of events) buckets[Math.min(11,Math.floor((event.sourceTimeMs-min)/span*12))]!.value += event.detections.length
  buckets.forEach((bucket,i)=>{bucket.label=formatVideoDateTime(recordingTime,min+span*i/12)?.split(', ').at(-1)?.slice(0,5) ?? time(min+span*i/12)})
  const max = Math.max(1, ...buckets.map(b => b.value))
  return <div className="chart"><div className="chart-legend"><span><i/> Vehicle observations</span><small>{events.length} event records</small></div><div className="chart-bars">{buckets.map((b, i) => { const offset=min+span*i/12; const absolute=formatVideoDateTime(recordingTime,offset); return <div className="chart-col" key={`${i}-${b.label}`}><div className="bar-track"><div className={`bar-fill ${b.value ? '' : 'bar-empty'}`} style={{ height: `${b.value ? Math.max(8, b.value / max * 100) : 2}%` }}/></div><small className={i % 2 ? 'hide-label' : ''} title={absolute ?? `Video position ${formatVideoPosition(offset)}`}>{b.label}</small></div>})}</div><div className="chart-footer"><span>{recordingTime ? `Video time · Asia/Jerusalem${recordingTime.provenance==='embedded_metadata'?' · embedded container metadata':''}` : 'Video position · date/time unknown'}</span><span>Loaded event data</span></div></div>
}
function EmptyChart({ onAdd }: { onAdd: () => void }) { return <div className="empty-chart"><div className="empty-chart-art"><div className="art-road"><span/><span/><span/></div><div className="art-car car-one"/><div className="art-car car-two"/></div><strong>Activity appears here when a source is running</strong><span>Connect a webcam, stream, or video file to start collecting observations.</span><button className="button button-quiet" onClick={onAdd}><Plus size={15}/> Add a video source</button></div> }
function HealthStep({ icon: Icon, label, value, good }: { icon: LucideIcon; label: string; value: string; good: boolean }) { return <div className="health-step"><span className={`health-step-icon ${good ? 'step-good' : ''}`}><Icon size={16}/></span><span><strong>{label}</strong><small>{value}</small></span><span className={`status-light ${good ? 'online' : 'muted'}`}/></div> }
function SourceNameEditor({ source, onRenamed, compact = false, initiallyEditing = false, hideTrigger = false, onDismiss }: { source: Source; onRenamed: (source: Source) => void; compact?: boolean; initiallyEditing?: boolean; hideTrigger?: boolean; onDismiss?: () => void }) {
  const [editing, setEditing] = useState(initiallyEditing)
  const [name, setName] = useState(source.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const requestGeneration = useRef(0)
  const currentSourceId = useRef(source.id)
  const previousSource = useRef({ id: source.id, name: source.name })
  currentSourceId.current = source.id
  useEffect(() => {
    if (previousSource.current.id === source.id && previousSource.current.name === source.name) return
    previousSource.current = { id: source.id, name: source.name }
    requestGeneration.current++
    setName(source.name)
    setEditing(false)
    setSaving(false)
    setError('')
    return () => { requestGeneration.current++ }
  }, [source.id, source.name])
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])
  const cancel = () => { if (saving) return; setName(source.name); setError(''); setEditing(false); onDismiss?.() }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    const nextName = name.trim()
    if (!nextName || nextName.length > 120) { setError('Enter a name from 1 to 120 characters.'); return }
    if (nextName === source.name) { setEditing(false); setError(''); onDismiss?.(); return }
    const sourceId = source.id
    const request = ++requestGeneration.current
    setSaving(true)
    setError('')
    try {
      const updated = await api.renameSource(sourceId, nextName)
      if (updated.id !== sourceId) {
        if (request === requestGeneration.current && currentSourceId.current === sourceId) setError('The server returned a different source for this rename.')
        return
      }
      onRenamed(updated)
      if (request !== requestGeneration.current || currentSourceId.current !== sourceId) return
      setEditing(false)
      onDismiss?.()
    } catch (reason) {
      if (request === requestGeneration.current && currentSourceId.current === sourceId) setError(reason instanceof Error ? reason.message : 'Could not rename this source.')
    } finally {
      if (request === requestGeneration.current && currentSourceId.current === sourceId) setSaving(false)
    }
  }
  return editing ? <form className={`source-rename-editor${compact ? ' compact' : ''}`} onSubmit={save}>
    <label>Source name<input ref={inputRef} value={name} maxLength={120} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }} aria-label={`Rename ${source.name}`} /></label>
    {error && <span className="source-rename-error" role="alert">{error}</span>}
    <div className="source-rename-actions"><button className="button button-primary" type="submit" disabled={saving || !name.trim() || name.trim().length > 120 || name.trim() === source.name}>{saving ? 'Saving…' : 'Save'}</button><button className="button button-quiet" type="button" onClick={cancel} disabled={saving}>Cancel</button></div>
  </form> : hideTrigger ? null : <button type="button" className={`button button-quiet source-rename-trigger${compact ? ' compact' : ''}`} onClick={() => { setName(source.name); setError(''); setEditing(true) }} aria-label={`Rename ${source.name}`}><Pencil size={14}/> Rename</button>
}
function SourcesView({ sources, folders, selectedFolder, folderNotice, filters, onFiltersChange, onFolderSelect, onCreateFolder, onRenameFolder, onDeleteFolder, onOrganizeSource, organizationBusy, onAdd, onSelect, onRefresh, onSourceUpdated, onSourceRenamed, onDeleteSource }: { sources: Source[]; folders: SourceFolder[]; selectedFolder: string; folderNotice: string; filters: SourceListFilters; onFiltersChange: (patch: SourceListFilterPatch, replace?: boolean) => void; onFolderSelect: (id: string) => void; onCreateFolder: (name: string) => Promise<void>; onRenameFolder: (id: string, name: string) => Promise<void>; onDeleteFolder: (id: string) => Promise<void>; onOrganizeSource: (id: string, folderId: string | null, beforeSourceId?: string | null) => Promise<void>; organizationBusy: boolean; onAdd: () => void; onSelect: (id: string) => void; onRefresh: () => void; onSourceUpdated: (source: Source) => void; onSourceRenamed: (source: Source) => void; onDeleteSource: (id: string) => Promise<void> }) {
  const [folderDialog, setFolderDialog] = useState<'create' | 'rename' | 'delete' | null>(null)
  const [folderTarget, setFolderTarget] = useState<{ id: string; name: string; sourceCount: number } | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderError, setFolderError] = useState('')
  const [folderSaving, setFolderSaving] = useState(false)
  const [organizationError, setOrganizationError] = useState('')
  const [dragTarget, setDragTarget] = useState('')
  const folderInputRef = useRef<HTMLInputElement>(null)
  const cancelFolderRef = useRef<HTMLButtonElement>(null)
  const allFolderRef = useRef<HTMLButtonElement>(null)
  const folderDialogReturnRef = useRef<HTMLElement | null>(null)
  const activeFolder = folders.find(folder => folder.id === selectedFolder)
  const baseSources = sourcesInFolder(sources, selectedFolder)
  const visibleSources = filterAndSortSources(sources, selectedFolder, filters)
  const reorderAllowed = canReorderSources(filters)
  const filterCriteriaActive = Boolean(filters.query.trim()) || filters.type !== 'all' || filters.status !== 'all'
  const filtersActive = filterCriteriaActive || filters.sort !== 'manual'
  const folderCounts = new Map<string, number>()
  for (const source of sources) if (source.folderId) folderCounts.set(source.folderId, (folderCounts.get(source.folderId) ?? 0) + 1)
  const ungroupedCount = sources.filter(source => !source.folderId).length
  useEffect(() => {
    if (!folderDialog) return
    if (folderDialog === 'delete') cancelFolderRef.current?.focus()
    else folderInputRef.current?.focus()
  }, [folderDialog])
  const openCreate = (trigger: HTMLElement) => { folderDialogReturnRef.current = trigger; setFolderTarget(null); setFolderName(''); setFolderError(''); setFolderDialog('create') }
  const openRename = (trigger: HTMLElement) => { if (!activeFolder) return; folderDialogReturnRef.current = trigger; setFolderTarget({ id: activeFolder.id, name: activeFolder.name, sourceCount: folderCounts.get(activeFolder.id) ?? 0 }); setFolderName(activeFolder.name); setFolderError(''); setFolderDialog('rename') }
  const openRemove = (trigger: HTMLElement) => { if (!activeFolder) return; folderDialogReturnRef.current = trigger; setFolderTarget({ id: activeFolder.id, name: activeFolder.name, sourceCount: folderCounts.get(activeFolder.id) ?? 0 }); setFolderError(''); setFolderDialog('delete') }
  const restoreFolderDialogFocus = () => requestAnimationFrame(() => {
    const trigger = folderDialogReturnRef.current
    if (trigger?.isConnected && !trigger.hasAttribute('disabled')) trigger.focus()
    else allFolderRef.current?.focus()
  })
  const closeFolderDialog = () => { if (!folderSaving) { setFolderDialog(null); restoreFolderDialogFocus() } }
  const handleFolderDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); closeFolderDialog(); return }
    if (event.key !== 'Tab') return
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    if (!focusable.length) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  const submitFolderDialog = async (event: React.FormEvent) => {
    event.preventDefault()
    if (folderSaving) return
    setFolderSaving(true); setFolderError('')
    try {
      if (folderDialog === 'create') await onCreateFolder(folderName.trim())
      else if (folderDialog === 'rename' && folderTarget) {
        if (!folders.some(folder => folder.id === folderTarget.id)) throw new Error('This folder was removed. Close the dialog and choose another folder.')
        await onRenameFolder(folderTarget.id, folderName.trim())
      } else if (folderDialog === 'delete' && folderTarget) {
        if (!folders.some(folder => folder.id === folderTarget.id)) throw new Error('This folder was removed. Close the dialog and choose another folder.')
        await onDeleteFolder(folderTarget.id)
      }
      setFolderDialog(null)
      setFolderTarget(null)
      restoreFolderDialogFocus()
    } catch (error) { setFolderError(error instanceof Error ? error.message : 'Could not update this folder.') }
    finally { setFolderSaving(false) }
  }
  const knownSourceIds = new Set(sources.map(source => source.id))
  const sourceFolderLabel = (source: Source) => source.folderId ? folders.find(folder => folder.id === source.folderId)?.name ?? 'Folder unavailable' : 'Ungrouped'
  const isSourceDrag = (event: React.DragEvent) => Array.from(event.dataTransfer.types).some(type => type.toLocaleLowerCase() === 'application/x-traffic-source')
  const getDraggedSourceId = (event: React.DragEvent) => sourceIdFromDrag(Array.from(event.dataTransfer.types), event.dataTransfer.getData('application/x-traffic-source'), knownSourceIds)
  const dropIntoFolder = (event: React.DragEvent, folderId: string | null) => {
    event.preventDefault(); event.stopPropagation(); setDragTarget(''); setOrganizationError('')
    const sourceId = getDraggedSourceId(event)
    if (!sourceId) return
    const draggedSource = sources.find(source => source.id === sourceId)
    if (!draggedSource || !canDropSourceIntoFolder(draggedSource.folderId ?? null, folderId, reorderAllowed)) return
    if (!organizationBusy) void onOrganizeSource(sourceId, folderId).catch(error => setOrganizationError(error instanceof Error ? error.message : 'Could not move this source.'))
  }
  const folderDialogNode = folderDialog && <div className="modal-backdrop source-folder-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeFolderDialog() }}><section className="modal-card source-folder-dialog" role="dialog" aria-modal="true" aria-labelledby="source-folder-dialog-title" onKeyDown={handleFolderDialogKeyDown}>
    <div className="modal-heading"><div><div className="eyebrow">SOURCE ORGANIZATION</div><h2 id="source-folder-dialog-title">{folderDialog === 'create' ? 'Create folder' : folderDialog === 'rename' ? `Rename ${folderTarget?.name ?? 'folder'}` : `Remove ${folderTarget?.name ?? 'folder'}?`}</h2></div><button type="button" className="icon-button" aria-label="Close folder dialog" onClick={closeFolderDialog} disabled={folderSaving}><X size={17}/></button></div>
    {folderDialog === 'delete' ? <form onSubmit={submitFolderDialog}><p>Removing <strong>{folderTarget?.name}</strong> moves its {folderTarget?.sourceCount ?? 0} source{folderTarget?.sourceCount === 1 ? '' : 's'} to Ungrouped. The sources and their saved analysis are kept.</p>{folderError && <p className="recording-time-error" role="alert">{folderError}</p>}<div className="modal-actions"><button ref={cancelFolderRef} type="button" className="button button-quiet" onClick={closeFolderDialog} disabled={folderSaving}>Cancel</button><button type="submit" className="button button-danger" disabled={folderSaving}>{folderSaving ? 'Removing…' : 'Remove folder'}</button></div></form> : <form onSubmit={submitFolderDialog}><label className="source-folder-name-field">Folder name<input ref={folderInputRef} value={folderName} onChange={event => setFolderName(event.target.value)} maxLength={120} required autoComplete="off" aria-label="Folder name"/></label>{folderError && <p className="recording-time-error" role="alert">{folderError}</p>}<div className="modal-actions"><button type="button" className="button button-quiet" onClick={closeFolderDialog} disabled={folderSaving}>Cancel</button><button type="submit" className="button button-primary" disabled={folderSaving || !folderName.trim()}>{folderSaving ? 'Saving…' : folderDialog === 'create' ? 'Create folder' : 'Save changes'}</button></div></form>}
  </section></div>
  return <>
    <PageHeading eyebrow="WORKSPACE" title="Video sources" description="Configure cameras, streams, and recorded footage for analysis." actions={<><button className="button button-quiet" onClick={onRefresh}><RefreshCw size={15}/> Refresh</button><button className="button button-quiet" onClick={event => openCreate(event.currentTarget)} disabled={organizationBusy}><FolderPlus size={15}/> New folder</button><button className="button button-primary" onClick={onAdd}><Plus size={16}/> Add source</button></>}/>
    <div className="source-toolbar" aria-label="Filter and sort sources">
      <label className="source-filter source-search-filter"><span>Search</span><div className="search-box"><span>⌕</span><input value={filters.query} onChange={event => onFiltersChange({ query: event.target.value }, true)} placeholder="Search sources…" aria-label="Search sources in this view"/></div></label>
      <label className="source-filter"><span>Type</span><select value={filters.type} onChange={event => onFiltersChange({ type: event.target.value as SourceListFilters['type'] })} aria-label="Filter sources by type"><option value="all">All types</option>{sourceTypeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className="source-filter"><span>Status</span><select value={filters.status} onChange={event => onFiltersChange({ status: event.target.value as SourceListFilters['status'] })} aria-label="Filter sources by status"><option value="all">All statuses</option>{sourceStatusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className="source-filter"><span>Sort</span><select value={filters.sort} onChange={event => onFiltersChange({ sort: event.target.value as SourceListFilters['sort'] })} aria-label="Sort sources">{sourceSortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <div className="source-filter-summary"><span className="source-count">{visibleSources.length} shown · {baseSources.length} {selectedFolder === 'all' ? 'in library' : selectedFolder === 'ungrouped' ? 'ungrouped' : 'in folder'}</span>{filtersActive && <button type="button" className="source-clear-filters" onClick={() => onFiltersChange({ query: '', type: 'all', status: 'all', sort: 'manual' })}>Clear filters</button>}</div>
    </div>
    {folderNotice && <div className="notice notice-warn source-folder-notice" role="status"><Folder size={15}/><div><span>{folderNotice}</span></div></div>}
    {organizationError && <div className="notice notice-danger source-folder-notice" role="alert"><Folder size={15}/><div><span>{organizationError}</span></div><button type="button" className="notice-dismiss" aria-label="Dismiss move error" onClick={() => setOrganizationError('')}><X size={14}/></button></div>}
    <nav className="source-folder-nav" aria-label="Source folders">
      <button ref={allFolderRef} id="source-folder-tab-all" type="button" className={`source-folder-tab${selectedFolder === 'all' ? ' active' : ''}`} aria-current={selectedFolder === 'all' ? 'page' : undefined} onClick={() => onFolderSelect('all')} onDragOver={event => { event.preventDefault(); if (!isSourceDrag(event)) event.dataTransfer.dropEffect = 'none' }} onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragTarget('') }}><Layers3 size={15}/> All sources <span>{sources.length}</span></button>
      <button id="source-folder-tab-ungrouped" type="button" className={`source-folder-tab${selectedFolder === 'ungrouped' ? ' active' : ''}${dragTarget === 'ungrouped' ? ' drag-over' : ''}`} aria-current={selectedFolder === 'ungrouped' ? 'page' : undefined} onClick={() => onFolderSelect('ungrouped')} onDragEnter={event => { if (isSourceDrag(event)) setDragTarget('ungrouped') }} onDragLeave={() => setDragTarget('')} onDragOver={event => { event.preventDefault(); if (isSourceDrag(event)) event.dataTransfer.dropEffect = 'move'; else event.dataTransfer.dropEffect = 'none' }} onDrop={event => dropIntoFolder(event, null)}><Folder size={15}/> Ungrouped <span>{ungroupedCount}</span></button>
      {folders.map(folder => <button id={`source-folder-tab-${folder.id}`} key={folder.id} type="button" className={`source-folder-tab${selectedFolder === folder.id ? ' active' : ''}${dragTarget === folder.id ? ' drag-over' : ''}`} aria-current={selectedFolder === folder.id ? 'page' : undefined} onClick={() => onFolderSelect(folder.id)} onDragEnter={event => { if (isSourceDrag(event)) setDragTarget(folder.id) }} onDragLeave={() => setDragTarget('')} onDragOver={event => { event.preventDefault(); if (isSourceDrag(event)) event.dataTransfer.dropEffect = 'move'; else event.dataTransfer.dropEffect = 'none' }} onDrop={event => dropIntoFolder(event, folder.id)}><Folder size={15}/> <span className="source-folder-tab-name">{folder.name}</span><span>{folderCounts.get(folder.id) ?? 0}</span></button>)}
    </nav>
    {organizationBusy && <p className="source-organization-saving" role="status" aria-live="polite">Saving folder changes…</p>}
    <section className="source-folder-content" aria-label={activeFolder?.name ?? (selectedFolder === 'ungrouped' ? 'Ungrouped sources' : 'All sources')}>
      <div className="source-folder-heading"><div><h2>{activeFolder?.name ?? (selectedFolder === 'ungrouped' ? 'Ungrouped sources' : 'All sources')}</h2><p>{activeFolder ? `Drag a source onto another folder to move it, or use its actions menu.${reorderAllowed ? ' Drag before another card to reorder.' : ' Reordering is available with Saved order and no active filters.'}` : selectedFolder === 'ungrouped' ? 'Sources here are not assigned to a folder.' : 'Drag a source onto a folder to move it. Open a folder to reorder its sources.'}</p></div>{activeFolder && <div className="source-folder-heading-actions"><button type="button" className="button button-quiet" onClick={event => openRename(event.currentTarget)} disabled={organizationBusy}><Pencil size={13}/> Rename</button><button type="button" className="button button-danger-quiet" onClick={event => openRemove(event.currentTarget)} disabled={organizationBusy}>Remove folder</button></div>}</div>
      {visibleSources.length ? <div className="source-cards">{visibleSources.map(item => <div className="source-card-entry" key={item.id}>
      <button type="button" className="source-card-drag" draggable={!organizationBusy} disabled={organizationBusy} aria-label={`Drag ${item.name} to ${selectedFolder !== 'all' && reorderAllowed ? 'move or reorder' : 'move to another folder'}`} title={selectedFolder !== 'all' && reorderAllowed ? 'Drag to move or reorder' : 'Drag to move to another folder'} onDragStart={event => { event.dataTransfer.setData('application/x-traffic-source', item.id); event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => setDragTarget('')}><GripVertical size={15}/></button>
      <button className={`source-card${dragTarget === `source:${item.id}` ? ' drag-over' : ''}`} onClick={() => onSelect(item.id)} onDragEnter={event => { if (selectedFolder !== 'all' && reorderAllowed && isSourceDrag(event)) setDragTarget(`source:${item.id}`) }} onDragLeave={() => setDragTarget('')} onDragOver={event => { event.preventDefault(); if (selectedFolder !== 'all' && reorderAllowed && isSourceDrag(event)) event.dataTransfer.dropEffect = 'move'; else event.dataTransfer.dropEffect = 'none' }} onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragTarget(''); setOrganizationError(''); const sourceId = getDraggedSourceId(event); if (!organizationBusy && selectedFolder !== 'all' && reorderAllowed && sourceId && sourceId !== item.id) void onOrganizeSource(sourceId, selectedFolder === 'ungrouped' ? null : selectedFolder, item.id).catch(error => setOrganizationError(error instanceof Error ? error.message : 'Could not reorder this source.')) }}><div className="source-card-top"><span className={`source-icon large ${item.kind}`}><SourceIcon kind={item.kind}/></span><StatusPill status={item.status}/></div><strong>{item.name}</strong><span className="source-card-type">{kindLabel(item.kind)}{item.width && item.height ? ` · ${item.width} × ${item.height}` : ''}</span>{selectedFolder === 'all' && <span className="source-card-folder-badge" title={`Folder: ${sourceFolderLabel(item)}`}><Folder size={12}/><span>{sourceFolderLabel(item)}</span></span>}<div className="source-card-bottom"><span>Added {new Intl.DateTimeFormat('en-IL',{timeZone:'Asia/Jerusalem',day:'2-digit',month:'short',year:'numeric'}).format(new Date(item.createdAt))}</span><span>Open <ArrowUpRight size={14}/></span></div></button>
      <SourceCardActions source={item} folders={folders} folderView={selectedFolder} organizationBusy={organizationBusy} onOrganizeSource={onOrganizeSource} onRenamed={onSourceRenamed} onSourceUpdated={onSourceUpdated} onDeleteSource={onDeleteSource}/>
    </div>)}</div> : <div className="panel source-empty-panel"><div className="empty-source-icon"><Camera size={22}/></div><h2>{filterCriteriaActive ? 'No sources match these filters' : selectedFolder === 'all' ? 'No sources configured' : 'This folder is empty'}</h2><p>{filterCriteriaActive ? 'Try adjusting or clearing the search, type, or status selections.' : selectedFolder === 'all' ? 'Add a camera or video file to begin monitoring traffic.' : 'Move a source here using its actions menu, or drag a card onto this folder.'}</p>{filterCriteriaActive ? <button type="button" className="button button-quiet" onClick={() => onFiltersChange({ query: '', type: 'all', status: 'all', sort: 'manual' })}>Clear filters</button> : selectedFolder === 'all' && <button className="button button-primary" onClick={onAdd}><Plus size={16}/> Add your first source</button>}</div>}
    </section>
    {folderDialogNode && createPortal(folderDialogNode, document.body)}
  </>
}

function SourceCardActions({ source, folders, folderView, organizationBusy, onOrganizeSource, onRenamed, onSourceUpdated, onDeleteSource }: { source: Source; folders: SourceFolder[]; folderView: string; organizationBusy: boolean; onOrganizeSource: (id: string, folderId: string | null, beforeSourceId?: string | null) => Promise<void>; onRenamed: (source: Source) => void; onSourceUpdated: (source: Source) => void; onDeleteSource: (id: string) => Promise<void> }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [moveMenuOpen, setMoveMenuOpen] = useState(false)
  const [moveError, setMoveError] = useState('')
  const [action, setAction] = useState<'rename' | 'recording-time' | 'delete' | null>(null)
  const [deleting, setDeleting] = useState(false)
  const deleteInFlightRef = useRef(false)
  const [deleteError, setDeleteError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const dialogCloseRef = useRef<HTMLButtonElement>(null)
  const cancelDeleteRef = useRef<HTMLButtonElement>(null)
  const menuId = `source-actions-${source.id}`
  const dialogTitleId = `source-action-title-${source.id}`
  const canDelete = source.status !== 'running' && !deleting
  const moveItemIndex = source.kind === 'upload' ? 2 : 1
  const folderDestinations: { id: string | null; name: string }[] = [{ id: null, name: 'Ungrouped' }, ...folders.map(folder => ({ id: folder.id, name: folder.name }))]
  const deleteItemIndex = moveItemIndex + 1 + folderDestinations.length
  const closeMenu = () => { setMenuOpen(false); setMoveMenuOpen(false) }

  useEffect(() => {
    if (!menuOpen) return
    menuItemRefs.current[0]?.focus()
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeMenu()
    }
    document.addEventListener('pointerdown', dismissOutside)
    return () => document.removeEventListener('pointerdown', dismissOutside)
  }, [menuOpen])
  useEffect(() => {
    if (moveMenuOpen) menuItemRefs.current[moveItemIndex + 1]?.focus()
  }, [moveItemIndex, moveMenuOpen])
  useEffect(() => {
    if (action === 'delete') cancelDeleteRef.current?.focus()
    else if (action === 'recording-time') dialogCloseRef.current?.focus()
  }, [action])

  const openAction = (next: 'rename' | 'recording-time' | 'delete') => {
    closeMenu()
    setDeleteError('')
    setAction(next)
  }
  const moveToFolder = async (folderId: string | null) => {
    if (organizationBusy || folderId === (source.folderId ?? null)) return
    setMoveError('')
    try {
      await onOrganizeSource(source.id, folderId)
      closeMenu()
      requestAnimationFrame(() => {
        if (triggerRef.current?.isConnected) triggerRef.current.focus()
        else document.getElementById(`source-folder-tab-${folderView}`)?.focus()
      })
    }
    catch (error) { setMoveError(error instanceof Error ? error.message : 'Could not move this source.') }
  }
  const closeAction = () => {
    if (deleting) return
    setAction(null)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = menuItemRefs.current.filter((item): item is HTMLButtonElement => !!item && !item.disabled)
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    let next = current
    if (event.key === 'ArrowDown') next = (current + 1 + items.length) % items.length
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'Escape') { event.preventDefault(); closeMenu(); triggerRef.current?.focus(); return }
    else return
    event.preventDefault()
    items[next]?.focus()
  }
  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); closeAction(); return }
    if (event.key !== 'Tab') return
    const container = event.currentTarget
    const focusable = [...container.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    if (!focusable.length) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  const confirmDelete = async () => {
    if (!canDelete || deleteInFlightRef.current) return
    deleteInFlightRef.current = true
    setDeleting(true)
    setDeleteError('')
    try {
      await onDeleteSource(source.id)
      setAction(null)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not delete this source.')
    } finally { deleteInFlightRef.current = false; setDeleting(false) }
  }

  const dialog = action && <div className="modal-backdrop source-action-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeAction() }}>
    <section className="modal-card source-action-dialog" role="dialog" aria-modal="true" aria-labelledby={dialogTitleId} onKeyDown={handleDialogKeyDown}>
      <div className="modal-heading"><div><div className="eyebrow">SOURCE ACTION</div><h2 id={dialogTitleId}>{action === 'rename' ? `Rename ${source.name}` : action === 'recording-time' ? 'Video date/time' : 'Delete source?'}</h2></div><button ref={dialogCloseRef} type="button" className="icon-button" aria-label="Close dialog" onClick={closeAction} disabled={deleting}><X size={17}/></button></div>
      {action === 'rename' && <SourceNameEditor source={source} onRenamed={onRenamed} initiallyEditing hideTrigger onDismiss={closeAction}/>}
      {action === 'recording-time' && <RecordingTimeEditor source={source} onSourceUpdated={onSourceUpdated} dialogMode/>}
      {action === 'delete' && <div className="source-delete-confirm"><p><strong>{source.name}</strong> and its saved zones, analysis results{source.kind === 'upload' ? ', and uploaded video' : ''} will be permanently removed.</p><p>This cannot be undone.</p>{source.status === 'running' && <p role="status">Stop analysis before deleting this source.</p>}{deleteError && <p className="recording-time-error" role="alert">{deleteError}</p>}<div className="modal-actions"><button ref={cancelDeleteRef} type="button" className="button button-quiet" onClick={closeAction} disabled={deleting}>Cancel</button><button type="button" className="button button-danger" onClick={() => void confirmDelete()} disabled={!canDelete}>{deleting ? 'Deleting…' : 'Delete source'}</button></div></div>}
    </section>
  </div>

  return <>
  <div className={`source-card-actions${menuOpen ? ' is-open' : ''}`} ref={rootRef}>
    <button ref={triggerRef} type="button" className="source-card-actions-trigger" aria-label={`Actions for ${source.name}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} onClick={() => menuOpen ? closeMenu() : setMenuOpen(true)}><MoreHorizontal size={18}/></button>
    {menuOpen && <div className="source-card-menu" id={menuId} role="menu" aria-label={`${source.name} actions`} onKeyDown={handleMenuKeyDown} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu() }}>
      <button type="button" role="menuitem" tabIndex={-1} ref={element => { menuItemRefs.current[0] = element }} onClick={() => openAction('rename')}><Pencil size={14}/> Rename</button>
      {source.kind === 'upload' && <button type="button" role="menuitem" tabIndex={-1} ref={element => { menuItemRefs.current[1] = element }} onClick={() => openAction('recording-time')}><Clock3 size={14}/> Video date/time</button>}
      <button type="button" role="menuitem" tabIndex={-1} aria-expanded={moveMenuOpen} ref={element => { menuItemRefs.current[moveItemIndex] = element }} disabled={organizationBusy} onClick={() => { setMoveError(''); setMoveMenuOpen(value => !value) }}><Folder size={14}/> Move to folder <ChevronDown size={13}/></button>
      {moveMenuOpen && <div className="source-card-move-options" role="group" aria-label="Choose destination folder">{folderDestinations.map((destination, index) => <button key={destination.id ?? 'ungrouped'} type="button" role="menuitemradio" aria-checked={(source.folderId ?? null) === destination.id} tabIndex={-1} ref={element => { menuItemRefs.current[moveItemIndex + 1 + index] = element }} disabled={organizationBusy || (source.folderId ?? null) === destination.id} onClick={() => void moveToFolder(destination.id)}>{destination.id === null ? <Folder size={13}/> : <Folder size={13}/>}<span>{destination.name}{(source.folderId ?? null) === destination.id && <small>Current folder</small>}</span></button>)}{moveError && <p className="source-card-menu-error" role="alert">{moveError}</p>}</div>}
      <button type="button" role="menuitem" tabIndex={-1} className="source-card-menu-danger" ref={element => { menuItemRefs.current[deleteItemIndex] = element }} disabled={source.status === 'running'} aria-describedby={source.status === 'running' ? `${menuId}-delete-help` : undefined} onClick={() => openAction('delete')}><X size={14}/><span>Delete source{source.status === 'running' && <small className="source-card-menu-help" id={`${menuId}-delete-help`}>Stop analysis before deleting.</small>}</span></button>
    </div>}
  </div>
  {dialog && createPortal(dialog, document.body)}
  </>
}

function LiveSourcePicker({ sources, selectedId, onSelect }: { sources: Source[]; selectedId: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(selectedId)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const selectedSource = sources.find(item => item.id === selectedId)
  const filteredSources = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return sources.filter(item => !normalized || item.name.toLocaleLowerCase().includes(normalized))
  }, [query, sources])
  const listId = 'live-source-options'
  const matchedActiveIndex = filteredSources.findIndex(item => item.id === activeId)
  const safeActiveIndex = matchedActiveIndex >= 0 ? matchedActiveIndex : 0
  const activeSource = filteredSources[safeActiveIndex]

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !popoverRef.current?.contains(event.target)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('pointerdown', dismissOutside)
    return () => document.removeEventListener('pointerdown', dismissOutside)
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    const positionPopover = () => {
      const anchor = inputRef.current?.getBoundingClientRect()
      if (!anchor) return
      const margin = 12
      const width = Math.max(0, Math.min(360, window.innerWidth - margin * 2, Math.max(anchor.width, 280)))
      const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))
      const maxHeight = Math.min(380, Math.max(160, window.innerHeight - margin * 2))
      const below = window.innerHeight - anchor.bottom - margin
      const above = anchor.top - margin
      const placeAbove = below < Math.min(220, maxHeight) && above > below
      const availableHeight = placeAbove ? above : below
      const fittedHeight = Math.max(96, Math.min(maxHeight, availableHeight))
      const fittedTop = placeAbove ? anchor.top - fittedHeight - 6 : anchor.bottom + 6
      setPopoverStyle({ position: 'fixed', top: Math.max(margin, Math.min(fittedTop, window.innerHeight - fittedHeight - margin)), left, width, maxHeight: fittedHeight, zIndex: 35 })
    }
    positionPopover()
    window.addEventListener('resize', positionPopover)
    window.addEventListener('scroll', positionPopover, true)
    return () => {
      window.removeEventListener('resize', positionPopover)
      window.removeEventListener('scroll', positionPopover, true)
    }
  }, [open])
  useEffect(() => {
    if (!open || !activeSource) return
    [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(option => option.id === `${listId}-option-${activeSource.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeSource, listId, open])
  useEffect(() => {
    if (activeSource?.id !== activeId) setActiveId(activeSource?.id ?? '')
  }, [activeId, activeSource])

  const show = () => {
    const currentIndex = sources.findIndex(item => item.id === selectedId)
    setQuery('')
    setActiveId(sources[currentIndex]?.id ?? sources[0]?.id ?? '')
    setOpen(true)
  }
  const close = (restoreFocus = false) => {
    setOpen(false)
    setQuery('')
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const choose = (sourceId: string) => {
    close(true)
    if (sourceId !== selectedId) onSelect(sourceId)
  }
  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveId(filteredSources.length ? filteredSources[(safeActiveIndex + 1) % filteredSources.length]!.id : '')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveId(filteredSources.length ? filteredSources[(safeActiveIndex - 1 + filteredSources.length) % filteredSources.length]!.id : '')
    } else if (event.key === 'Enter' && activeSource) {
      event.preventDefault()
      choose(activeSource.id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    }
  }

  return <div className="live-source-picker" ref={rootRef} onBlur={event => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && (event.currentTarget.contains(nextTarget) || popoverRef.current?.contains(nextTarget))) return
    close()
  }}>
    {open ? <div className="live-source-picker-search"><Search size={15}/><input ref={inputRef} type="search" role="combobox" aria-label="Search sources by name" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeSource ? `${listId}-option-${activeSource.id}` : undefined} placeholder="Search sources…" value={query} onChange={event => { setQuery(event.target.value); setActiveId('') }} onKeyDown={handleInputKeyDown}/>{query && <button type="button" aria-label="Clear source search" onMouseDown={event => event.preventDefault()} onClick={() => { setQuery(''); setActiveId(''); inputRef.current?.focus() }}><X size={14}/></button>}</div> : <button ref={triggerRef} type="button" className="live-source-picker-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={`Select source. Current source: ${selectedSource?.name ?? 'Unknown'}`} onClick={show} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show() } }}>
      {selectedSource && <span className={`source-icon ${selectedSource.kind}`}><SourceIcon kind={selectedSource.kind}/></span>}
      <span className="live-source-picker-current"><strong>{selectedSource?.name ?? 'Select source'}</strong><StatusPill status={selectedSource?.status ?? 'idle'}/></span>
      <ChevronDown size={14}/>
    </button>}
    {open && createPortal(<div className="live-source-picker-popover" style={popoverStyle} ref={popoverRef}>
      <div className="live-source-picker-results" id={listId} role="listbox" aria-label="Available sources" ref={listRef}>
        {filteredSources.map((item, index) => <div key={item.id} id={`${listId}-option-${item.id}`} role="option" aria-selected={item.id === selectedId} aria-posinset={index + 1} aria-setsize={filteredSources.length} className={`live-source-picker-option${item.id === selectedId ? ' selected' : ''}${index === safeActiveIndex ? ' active' : ''}`} onMouseEnter={() => setActiveId(item.id)} onMouseDown={event => event.preventDefault()} onClick={() => choose(item.id)}>
          <span className={`source-icon ${item.kind}`}><SourceIcon kind={item.kind}/></span><span className="live-source-picker-option-copy"><strong>{item.name}</strong><small>{kindLabel(item.kind)}</small></span><StatusPill status={item.status}/>{item.id === selectedId && <Check size={14} className="live-source-picker-check"/>}
        </div>)}
        {!filteredSources.length && <div className="live-source-picker-empty"><span>No sources match “{query}”. Clear search above to see all sources.</span></div>}
      </div>
    </div>, document.body)}
  </div>
}

function ObservationsView({ sources, selectedId, onSelect, events, summary, recordingTime, historyTruncated, discardedEventCount, clientEventsOmitted, onDownload }: { sources: Source[]; selectedId: string | null; onSelect: (id: string) => void; events: TrafficEvent[]; summary: Awaited<ReturnType<typeof api.summary>> | null; recordingTime?: Source['recordingTime']; historyTruncated: boolean; discardedEventCount: number | null; clientEventsOmitted: number; onDownload: (format: 'csv' | 'json') => void }) {
  const [sessionFilter, setSessionFilter] = useState('latest')
  const [classFilter, setClassFilter] = useState('all')
  const [colorFilter, setColorFilter] = useState('all')
  const [accuracyTarget, setAccuracyTarget] = useState<{ sourceId: string; event: TrafficEvent; detectionIndex: number } | null>(null)
  const [reportsRefreshVersion, setReportsRefreshVersion] = useState(0)
  const selectedSource = sources.find(source => source.id === selectedId) ?? null
  const latestSessionId = summary?.sessionId ?? events.at(-1)?.sessionId
  const sessions = useMemo(() => observationSessionOptions(events, latestSessionId), [events, latestSessionId])
  const sessionEvents = useMemo(() => filterObservationEvents(events, sessionFilter, latestSessionId), [events, sessionFilter, latestSessionId])
  const rows = useMemo<ObservationRow[]>(() => sessionEvents.flatMap(event => event.detections.map((d, i) => ({ event, d, key: `${event.id ?? `${event.sessionId}-${event.sourceTimeMs}`}-${i}` }))).reverse(), [sessionEvents])
  const observedColors = useMemo(() => [...new Set(rows.map(({ d }) => vehicleColorKey(d.color)).filter(Boolean))].sort((a, b) => vehicleColorLabel(a).localeCompare(vehicleColorLabel(b))), [rows])
  const observedTypes = useMemo(() => [...new Set(rows.map(({ d }) => vehicleTypeKey(d.class)).filter(Boolean))].sort((a, b) => vehicleTypeLabel(a).localeCompare(vehicleTypeLabel(b))), [rows])
  const hasRecordsAcrossSessions = events.some(event => event.detections.length > 0)
  useEffect(() => { setSessionFilter('latest'); setClassFilter('all'); setColorFilter('all'); setAccuracyTarget(null) }, [selectedId])
  return <><PageHeading eyebrow="ANALYSIS" title="Observations" description="Review detections and line crossings returned by the analysis service." actions={<div className="button-group"><button className="button button-quiet" onClick={() => onDownload('csv')} disabled={!events.length}><Download size={15}/> Export CSV</button><button className="button button-quiet" onClick={() => onDownload('json')} disabled={!events.length}>JSON</button></div>}/><div className="observation-summary"><div className="panel observation-note"><div className="summary-label">CURRENT SOURCE</div><select value={selectedId ?? ''} onChange={e => onSelect(e.target.value)} aria-label="Select source">{sources.length ? sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>) : <option value="">No sources</option>}</select><span className="coverage-note">{historyTruncated ? summary?.note ?? 'Only the newest retained events are listed; session crossing totals remain cumulative.' : summary?.coverage === 'known' ? 'Only sampled frames were analyzed; this does not represent full video coverage.' : summary?.note ?? 'Coverage is unknown until analysis data is available.'}</span></div><div className="summary-tile"><span>Visible detections</span><strong>{summary?.visibleVehicleCount ?? '—'}</strong><small>Latest analyzed sample · not distinct vehicles</small></div><div className="summary-tile"><span>Line crossings</span><strong>{summary ? summary.crossings.reduce((sum, x) => sum + x.count, 0) : '—'}</strong><small>{summary?.coverage === 'known' ? 'From sampled frames' : 'No analyzed frames'}</small></div></div>{historyTruncated && <div className="notice notice-warn"><Activity size={17}/><div><strong>Server history contains only the newest retained events{discardedEventCount === null ? '' : `; ${discardedEventCount} older server records discarded`}</strong><span>Crossing totals remain cumulative for the latest session.</span></div></div>}{clientEventsOmitted > 0 && <div className="notice notice-warn"><Activity size={17}/><div><strong>Showing the newest 500 browser event records; {clientEventsOmitted} earlier records are omitted</strong><span>Exports include this same browser window. Choose All sessions to inspect every session still in it.</span></div></div>}<p className="observation-type-note">The detector uses broad labels. Van vs car classification is not available yet; color is a coarse estimate and can be unknown. Session and type/color filters affect this view only; exports include all loaded source records.</p><ObservationTable key={selectedId ?? 'no-source'} rows={rows} sourceId={selectedId ?? ''} onReport={(event, detectionIndex) => { if (selectedSource && event.sourceId === selectedSource.id) setAccuracyTarget({ sourceId: selectedSource.id, event, detectionIndex }) }} recordingTime={recordingTime} classFilter={classFilter} colorFilter={colorFilter} onClassFilter={setClassFilter} onColorFilter={setColorFilter} observedTypes={observedTypes} observedColors={observedColors} sessionFilter={sessionFilter} sessions={sessions} onSessionFilter={setSessionFilter} hasRecordsAcrossSessions={hasRecordsAcrossSessions}/>{summary?.crossings?.length ? <div className="crossings-footer observation-crossings"><strong>Directional line crossings</strong>{summary.crossings.map((item,i)=><span key={`${item.lineId}-${item.direction}-${i}`}>{item.direction}<b>{item.count}</b></span>)}</div> : null}{selectedId && <AccuracyReportsPanel key={`${selectedId}:${sessionFilter}:${reportsRefreshVersion}`} sourceId={selectedId} sessionId={sessionFilter === 'latest' ? latestSessionId : sessionFilter === 'all' ? undefined : sessionFilter}/>} {accuracyTarget && accuracyTarget.sourceId === selectedId && selectedSource && <AccuracyReviewDialog key={`${accuracyTarget.event.id}:${accuracyTarget.event.sessionId}:${accuracyTarget.detectionIndex}`} source={selectedSource} event={accuracyTarget.event} initialDetectionIndex={accuracyTarget.detectionIndex} onClose={() => { setAccuracyTarget(null); setReportsRefreshVersion(value => value + 1) }}/>}</> }
function ProcessingView({ health, sources, events, onRefresh }: { health: Health | null; sources: Source[]; events: TrafficEvent[]; onRefresh: () => void }) { return <><PageHeading eyebrow="SYSTEM" title="Processing status" description="Local services and analysis coverage for this workspace." actions={<button className="button button-quiet" onClick={onRefresh}><RefreshCw size={15}/> Check status</button>}/><div className="processing-grid"><div className="panel processing-main"><div className="panel-heading"><div><h2>Pipeline status</h2><p>Services running on this device</p></div><span className={`status-pill ${health?.status === 'ok' ? 'status-running' : 'status-error'}`}><span className="status-light"/>{health?.status ?? 'Unknown'}</span></div><div className="service-row"><div className="service-icon"><Wifi size={18}/></div><div className="service-text"><strong>Local API</strong><span>HTTP service · /api</span></div><span className={`service-state ${health ? 'state-ok' : 'state-down'}`}><i/>{health ? 'Connected' : 'Unreachable'}</span></div><div className="service-row"><div className="service-icon"><Activity size={18}/></div><div className="service-text"><strong>Analysis worker</strong><span>{health?.worker.detail || 'Status supplied by the API health check'}</span></div><span className={`service-state ${health?.worker.available ? 'state-ok' : 'state-warn'}`}><i/>{workerStatusLabel(health)}</span></div><div className="service-row"><div className="service-icon"><Layers3 size={18}/></div><div className="service-text"><strong>Event history</strong><span>Per-source records from the local API</span></div><span className="service-state state-neutral"><i/>{events.length} loaded</span></div><div className="worker-note"><Activity size={17}/><span>Starting analysis on a source checks and loads its configured runtime and model. The dashboard reports only detections returned by the worker and displays sampled-frame coverage. Speed and plate recognition are unavailable.</span></div></div><div className="panel processing-side"><div className="panel-heading"><div><h2>Source status</h2><p>Current source states</p></div></div>{sources.length ? sources.map(s=><div className="compact-source" key={s.id}><span className={`source-icon ${s.kind}`}><SourceIcon kind={s.kind}/></span><span><strong>{s.name}</strong><small>{kindLabel(s.kind)}</small></span><StatusPill status={s.status}/></div>) : <div className="compact-empty">No sources configured.</div>}</div></div></> }
function StatusPill({ status }: { status: Source['status'] }) { const labels: Record<Source['status'],string>={idle:'Idle',running:'Running',stopped:'Stopped',completed:'Completed',error:'Error'}; return <span className={`status-pill status-${status}`}><span className="status-light"/>{labels[status]}</span> }
function SourceIcon({ kind }: { kind: Source['kind'] }) { return kind === 'webcam' ? <Camera size={16}/> : kind === 'upload' ? <Video size={16}/> : kind === 'youtube' ? <Youtube size={16}/> : <Radio size={16}/> }
function kindLabel(kind: Source['kind']) { return kind === 'webcam' ? 'Webcam' : kind === 'upload' ? 'Video upload' : kind === 'youtube' ? 'YouTube' : 'Direct stream' }
function EmptySources({ onAdd }: { onAdd: () => void }) { return <div className="empty-table"><div className="empty-source-icon"><Camera size={21}/></div><strong>Connect your first source</strong><span>Upload a recording, select a webcam, add a browser supported direct stream, or connect a public YouTube video.</span><button className="button button-primary" onClick={onAdd}><Plus size={15}/> Add source</button></div> }

function LiveView({ sources, selectedId, onSelect, events, summary, onControl, busy, onSceneSaved, onCameraUnmount, onSourceRenamed, onSourceLocationSaved }: { sources: Source[]; selectedId: string | null; onSelect: (id: string) => void; events: TrafficEvent[]; summary: Awaited<ReturnType<typeof api.summary>> | null; onControl: (action: 'start'|'stop') => void; busy: boolean; onSceneSaved: () => void; onCameraUnmount: (sourceId: string) => void; onSourceRenamed: (source: Source) => void; onSourceLocationSaved: (source: Source) => void }) {
  const source = sources.find(s => s.id === selectedId) ?? null
  const sourceEvents = events.filter(e => !source || e.sourceId === source.id)
  const currentSummary = source && summary?.sourceId === source.id ? summary : null
  const sessionEvents = currentSummary?.sessionId ? sourceEvents.filter(event => event.sessionId === currentSummary.sessionId) : []
  const latestSourceEventSessionId = sourceEvents.at(-1)?.sessionId
  const latestSessionEvent = sessionEvents.reduce<TrafficEvent | undefined>((latest, event) => !latest || event.sourceTimeMs > latest.sourceTimeMs ? event : latest, undefined)
  const latestQualityNotes = latestSessionEvent?.quality.notes ?? []
  const analysisScope = analysisScopeFromNotes(latestQualityNotes)
  const visibleCountIsLineScoped = analysisScope.scope === 'counting_line_regions'
  const visibleCountIsFullFrame = analysisScope.scope === 'full_frame_tiled'
  const includesUntrackedObservations = analysisScope.includesUntrackedObservations
  const [lineSceneState, setLineSceneState] = useState<{ sourceId: string; scene: Scene } | null>(null)
  const lineScene = source && lineSceneState?.sourceId === source.id ? lineSceneState.scene : null
  const sceneRequestGeneration = useRef(createRequestGeneration<string | null>())
  const currentSceneSourceId = useRef<string | null>(source?.id ?? null)
  currentSceneSourceId.current = source?.id ?? null
  const [totalScope, setTotalScope] = useState('all')
  const [displayedSampleState, setDisplayedSampleState] = useState<{ sourceId: string; sessionId: string; event: TrafficEvent } | null>(null)
  const [frameState, setFrameState] = useState<{ sourceId: string | null; ready: boolean }>({ sourceId: null, ready: false })
  const [viewerMode, setViewerMode] = useState<'navigate' | 'annotate'>('navigate')
  const [pointLimit, setPointLimit] = useState(2)
  const frameReady = !!source && frameState.sourceId === source.id && frameState.ready
  useEffect(() => { setViewerMode('navigate'); setPointLimit(2) }, [source?.id])
  useEffect(() => { setTotalScope('all') }, [source?.id])
  useEffect(() => {
    const request = sceneRequestGeneration.current.begin(source?.id ?? null)
    setLineSceneState(null)
    if (source) void api.scene(source.id).then(next => {
      if (sceneRequestGeneration.current.isCurrent(request, currentSceneSourceId.current)) setLineSceneState({ sourceId: source.id, scene: next })
    }).catch(() => {
      if (sceneRequestGeneration.current.isCurrent(request, currentSceneSourceId.current)) setLineSceneState(null)
    })
    return () => { sceneRequestGeneration.current.invalidate() }
  }, [source?.id])
  useEffect(() => { setDisplayedSampleState(null) }, [source?.id, currentSummary?.sessionId])
  const refreshScene = () => {
    if (!source || currentSceneSourceId.current !== source.id) return
    onSceneSaved()
    setLineSceneState(null)
    const request = sceneRequestGeneration.current.begin(source.id)
    void api.scene(source.id).then(next => {
      if (sceneRequestGeneration.current.isCurrent(request, currentSceneSourceId.current)) setLineSceneState({ sourceId: source.id, scene: next })
    }).catch(() => {
      if (sceneRequestGeneration.current.isCurrent(request, currentSceneSourceId.current)) setLineSceneState(null)
    })
  }
  const selectedZone = totalScope.startsWith('zone:') ? lineScene?.zones.find(zone => zone.id === totalScope.slice(5)) : undefined
  const selectedLine = totalScope.startsWith('line:') ? lineScene?.countingLines.find(line => line.id === totalScope.slice(5)) : undefined
  useEffect(() => {
    if (totalScope === 'all' || !lineScene) return
    if (totalScope.startsWith('zone:') && !lineScene.zones.some(zone => zone.id === totalScope.slice(5))) setTotalScope('all')
    if (totalScope.startsWith('line:') && !lineScene.countingLines.some(line => line.id === totalScope.slice(5))) setTotalScope('all')
  }, [lineScene, totalScope])
  const displayedSampleEvent = isCurrentDisplayedSample(displayedSampleState?.event, source?.id, currentSummary?.sessionId)
    ? displayedSampleState?.event
    : undefined
  const scopedSampleDetections = detectionsInMonitoringScope(displayedSampleEvent, lineScene?.zones, selectedZone)
  const scopedDetections = scopedSampleDetections ?? []
  const scopedDetectionCount = selectedZone
    ? scopedSampleDetections?.length ?? '—'
    : selectedLine
      ? lineCrossingCount(currentSummary, selectedLine.id) ?? '—'
      : scopedSampleDetections?.length ?? '—'
  const scopedCrossingCount = selectedZone
    ? '—'
    : selectedLine
      ? lineCrossingCount(currentSummary, selectedLine.id) ?? '—'
      : currentSummary?.coverage === 'known' ? currentSummary.crossings.reduce((sum, item) => sum + item.count, 0) : '—'
  const uniqueVehicleScope: UniqueVehicleScope = totalScope === 'all'
    ? { kind: 'all' }
    : totalScope.startsWith('zone:')
      ? { kind: 'zone', zoneId: totalScope.slice(5) }
      : { kind: 'line', lineId: totalScope.slice(5) }
  const uniqueVehicleTotalForScope = uniqueVehicleTotal(
    currentSummary,
    source && currentSummary?.sessionId && lineScene && (!latestSourceEventSessionId || latestSourceEventSessionId === currentSummary.sessionId)
      ? { sourceId: source.id, sessionId: currentSummary.sessionId, geometrySignature: sceneGeometrySignature(lineScene) }
      : null,
    uniqueVehicleScope,
  )
  const uniqueVehicleCountLabel = formatUniqueVehicleCount(uniqueVehicleTotalForScope)
  const displayedSampleTypes = countByVehicleType(scopedDetections)
  const displayedSampleColors = countByVehicleColor(scopedDetections)
  const handleDisplayedSampleChange = useCallback((event: TrafficEvent | null) => {
    if (!event) {
      setDisplayedSampleState(previous => previous && previous.sourceId === source?.id && previous.sessionId === currentSummary?.sessionId ? null : previous)
      return
    }
    if (isCurrentDisplayedSample(event, source?.id, currentSummary?.sessionId)) {
      setDisplayedSampleState({ sourceId: source!.id, sessionId: currentSummary!.sessionId!, event })
    }
  }, [source?.id, currentSummary?.sessionId])
  return <>
    <PageHeading eyebrow="WORKSPACE" title="Live monitor" description="Inspect a source, review analysis overlays, and annotate its scene." actions={source && <><StatusPill status={source.status}/>{source.status === 'running' ? <button className="button button-quiet" onClick={() => onControl('stop')} disabled={busy}><Square size={14}/> Stop</button> : <button className="button button-primary" onClick={() => onControl('start')} disabled={busy}><Play size={15}/> Start analysis{source.kind==='upload'||source.kind==='youtube'?' · 2 fps':''}</button>}</>}/>
    <div className="live-layout">
      <div className="live-main">{source ? <>
        <div className="panel live-player-panel"><div className="player-toolbar"><LiveSourcePicker sources={sources} selectedId={source.id} onSelect={onSelect}/><SourceNameEditor source={source} onRenamed={onSourceRenamed} compact/><span className="player-resolution">{source.width && source.height ? `${source.width} × ${source.height}` : 'Resolution pending'}</span><button className="icon-button small" title="Refresh source list" onClick={refreshScene}><RefreshCw size={15}/></button></div><VideoStage source={source} events={sessionEvents} sessionId={currentSummary?.sessionId} monitoringScene={lineScene} totalScope={totalScope} onDisplayedSampleChange={handleDisplayedSampleChange} onSaved={refreshScene} onCameraUnmount={onCameraUnmount} onReadyChange={ready => setFrameState({ sourceId: source.id, ready })} interactionMode={viewerMode} canPlacePoints={!!source&&source.status!=='running'&&frameReady} pointLimit={pointLimit}/></div>
        <div className="panel live-events"><div className="panel-heading"><div><h2>Latest observations</h2><p>{currentSummary?.sessionId ? `${sessionEvents.length} event records for the latest session` : 'No analyzed session yet'}</p></div><span className="coverage-pill">{sessionEvents.some(e => e.quality.coverage === 'known') ? <><Check size={13}/> Sampled frames</> : 'Coverage unknown'}</span></div>{sessionEvents.length ? <div className="event-list">{sessionEvents.slice(-5).reverse().map((event,i)=>{const videoOrigin=source?.kind==='upload'?source.recordingTime:undefined;const absolute=formatVideoDateTime(videoOrigin,event.sourceTimeMs);const scopedPreview=detectionsInMonitoringScope(event,lineScene?.zones,selectedZone);return <div className="event-row" key={event.id ?? `${event.sourceTimeMs}-${i}`}><span className="event-time" title={absolute?`${absolute} · ${videoOrigin?.provenance==='embedded_metadata'?'Embedded container metadata; may reflect an export date.':'Manual video-time origin.'}`:'Video date/time unavailable'}>{absolute??'Date/time unknown'}<small>Video position {formatVideoPosition(event.sourceTimeMs)}</small></span><span className="event-content">{scopedPreview === null ? event.quality.coverage !== 'known' ? 'Coverage unknown' : 'Saved zone scope loading' : scopedPreview.length ? <>{scopedPreview.length} {scopedPreview.length === 1 ? 'vehicle' : 'vehicles'} observed</> : 'Analysis frame processed'}{event.crossings.length > 0 && <small>{event.crossings.length} line crossing{event.crossings.length===1?'':'s'}</small>}</span><span className="event-quality">{event.quality.coverage === 'known' ? 'Sampled' : 'Unknown'}</span></div>})}</div> : <div className="compact-empty">No analysis events for the latest session.</div>}</div>
      </> : <div className="panel no-source"><div className="empty-source-icon"><Camera size={22}/></div><h2>Select a video source</h2><p>Add a webcam, direct stream, or upload a file to view it here.</p></div>}</div>
      <aside className="live-aside">{source && <CameraLocationCard key={source.id} source={source} onSaved={onSourceLocationSaved} onSelect={onSelect}/>}<div className="panel scene-panel"><div className="panel-heading"><div><h2>Scene setup</h2><p>Normalized scene annotations</p></div><Settings2 size={16}/></div>{source ? <SceneEditor key={source.id} source={source} frameReady={frameReady} interactionMode={viewerMode} onInteractionModeChange={setViewerMode} onPointLimitChange={setPointLimit} onSaved={refreshScene}/> : <p className="aside-copy">Select a source to configure its counting lines and zones.</p>}</div><div className="panel live-stat-panel"><div className="panel-heading"><div><h2>Latest session totals</h2><p>{currentSummary?.sessionId ? <span title={currentSummary.sessionId}>Session {currentSummary.sessionId.slice(0, 8)}</span> : 'No analyzed session yet'}</p></div></div><label className="totals-scope-picker">Scope<select aria-label="Totals scope" value={totalScope} onChange={event => setTotalScope(event.target.value)}><option value="all">{lineScene?.zones.length ? 'All zones' : 'All'}</option><optgroup label="Zones">{lineScene?.zones.map(zone=><option key={`zone:${zone.id}`} value={`zone:${zone.id}`}>{zone.name}</option>)}</optgroup><optgroup label="Lines">{lineScene?.countingLines.map(line=><option key={`line:${line.id}`} value={`line:${line.id}`}>{line.name}</option>)}</optgroup></select></label>{selectedLine ? <div className="scope-note">Line totals use saved crossing events for this line. Detection counts are not assigned to individual lines.</div> : selectedZone ? <div className="scope-note">Zone totals count detections in the displayed analyzed sample whose center falls inside this zone. Line crossings are not assigned to zones.</div> : lineScene?.zones.length ? <div className="scope-note">All zones counts each detection once when its center falls inside any saved zone. Counts follow the displayed analyzed sample.</div> : null}{!selectedLine&&<div className="live-stat"><span>{selectedZone ? `${selectedZone.name} detections` : lineScene?.zones.length ? 'Detections in all zones' : visibleCountIsFullFrame ? 'Visible detections' : visibleCountIsLineScoped ? 'Vehicles near saved lines' : 'Visible vehicles'}</span><strong>{scopedDetectionCount}</strong>{source?.kind==='upload'&&sessionEvents.length>0&&!displayedSampleEvent&&<div className="scope-note">Pause on an analyzed frame or use Previous / Next to view sampled counts.</div>}</div>}{!selectedZone&&!selectedLine&&visibleCountIsFullFrame&&!lineScene?.zones.length&&<div className="scope-note">Each sampled analysis frame covers the full image with overlapping tiles.{includesUntrackedObservations ? ' Some detections have no confirmed track ID, so this is not a distinct-vehicle count.' : ' Samples are intermittent, not continuous tracking.'}</div>}{!selectedZone&&!selectedLine&&visibleCountIsLineScoped&&!lineScene?.zones.length&&<div className="scope-note">This is sampled detection within the saved counting-line regions, not full-frame occupancy.</div>}<div className="live-stat unique-vehicle-stat"><div className="unique-vehicle-heading"><span>Unique tracked vehicles</span><strong>{uniqueVehicleCountLabel}</strong></div><p>Distinct tracked IDs observed in sampled frames in the latest session, not the displayed frame. {uniqueVehicleScopeNote(uniqueVehicleScope, !!lineScene?.zones.length)}</p><p>{uniqueVehicleCompletenessNote(uniqueVehicleTotalForScope.completeness)}</p></div>{!selectedLine&&displayedSampleEvent&&currentSummary?.coverage==='known'&&lineScene&&scopedSampleDetections!==null&&<div className="sample-breakdown"><div className="sample-breakdown-heading">Displayed analyzed sample</div>{scopedDetections.length ? <><div className="sample-count-row" aria-label="Displayed sample counts by vehicle type">{displayedSampleTypes.map(item=><span key={item.key}>{item.label}<b>{item.count}</b></span>)}</div><div className="sample-count-row sample-color-row" aria-label="Displayed sample counts by estimated color">{displayedSampleColors.map(item=><span key={item.key}><i style={{backgroundColor:item.swatch}}/>{item.label}<b>{item.count}</b></span>)}</div><p>Counts are detection boxes in this one sampled frame, not unique vehicles. Color is a coarse image estimate. Van vs car classification is not available yet.</p></> : <p>No vehicle detections in the displayed analyzed sample.</p>}</div>}{!selectedLine&&<div className="live-stat"><span>{selectedZone ? 'Line crossings in this zone' : 'Line crossings'}</span><strong>{scopedCrossingCount}</strong></div>}<LineCountBreakdown scene={lineScene} summary={currentSummary} selectedLine={selectedLine} hide={!!selectedZone}/><div className="limit-note">{currentSummary?.note || (currentSummary?.coverage === 'known' ? 'Counts are for sampled frames in this session.' : 'Counts remain unknown until frames are analyzed.')+' No speed estimates or plate recognition are available.'}</div></div></aside>
    </div>
  </>
}

function LineCountBreakdown({ scene, summary, selectedLine, hide = false }: { scene: Scene | null; summary: Awaited<ReturnType<typeof api.summary>> | null; selectedLine?: SceneLine; hide?: boolean }) {
  if (hide) return null
  if (!scene) return <div className="line-count-breakdown"><strong>Counts by line</strong><span className="line-count-note">Loading saved counting lines…</span></div>
  if (!scene.countingLines.length) return <div className="line-count-breakdown"><strong>Counts by line</strong><span className="line-count-note">No counting lines are saved for this source.</span></div>
  return <div className="line-count-breakdown" aria-label="Latest-session counts by saved line">
    <strong>Counts by line</strong>
    {!summary?.sessionId && <span className="line-count-note">No analyzed session yet. Counts are unknown.</span>}
    {scene.countingLines.filter(line => !selectedLine || line.id === selectedLine.id).map(line => {
      const crossings = summary?.crossings.filter(item => item.lineId === line.id) ?? []
      const total = summary?.coverage === 'known' ? crossings.reduce((sum, item) => sum + item.count, 0) : '—'
      return <div className="line-count-row" key={line.id}>
        <div className="line-count-heading"><span>{line.name}</span><b>{total}</b></div>
        <div className="line-count-directions">{line.directionLabels.map(direction => {
          const observed = crossings.find(item => item.direction === direction)
          const count = observed ? observed.count : summary?.coverage === 'known' ? 0 : '—'
          return <span key={direction}>{direction}<b>{count}</b></span>
        })}</div>
      </div>
    })}
    {summary?.coverage !== 'known' && <span className="line-count-note">Missing counts stay unknown until frames are analyzed.</span>}
  </div>
}

function VideoStage({ source, events, sessionId, monitoringScene, totalScope, onDisplayedSampleChange, onSaved, onCameraUnmount, onReadyChange, interactionMode, canPlacePoints, pointLimit }: { source: Source; events: TrafficEvent[]; sessionId?: string; monitoringScene: Scene | null; totalScope: string; onDisplayedSampleChange: (event: TrafficEvent | null) => void; onSaved: () => void; onCameraUnmount: (sourceId: string) => void; onReadyChange: (ready: boolean) => void; interactionMode: 'navigate' | 'annotate'; canPlacePoints: boolean; pointLimit: number }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const youtubeImageRef = useRef<HTMLImageElement>(null)
  const liveRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const playerFrameRef = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ kind: 'pan'; pointerId: number; x: number; y: number; panX: number; panY: number } | { kind: 'pinch'; distance: number; zoom: number; panX: number; panY: number; centerX: number; centerY: number } | null>(null)
  const [cameraErrors, setCameraErrors] = useState<Record<string, string>>({})
  const cameraError = sourceMessage(cameraErrors, source.id)
  const setCameraError = (text: string) => setCameraErrors(current => updateSourceMessage(current, source.id, text))
  const [youtubePreview, setYoutubePreview] = useState<SourcePreview | null>(null)
  const [loadedYoutubePreview, setLoadedYoutubePreview] = useState<SourcePreview | null>(null)
  const [youtubeImageUrl, setYoutubeImageUrl] = useState('')
  const [youtubeImageCandidate, setYoutubeImageCandidate] = useState<SourcePreview | null>(null)
  const [youtubeRefreshing, setYoutubeRefreshing] = useState(false)
  const [videoTime, setVideoTime] = useState(0)
  const [smoothClock, setSmoothClock] = useState(0)
  const [smoothMovementOn, setSmoothMovementOn] = useState(true)
  const [videoDimensions, setVideoDimensions] = useState({ width: source.width ?? 16, height: source.height ?? 9 })
  const [duration, setDuration] = useState(source.durationMs ?? 0)
  const [videoPaused, setVideoPaused] = useState(true)
  const [videoBuffering, setVideoBuffering] = useState(false)
  const [isSeeking, setIsSeeking] = useState(false)
  const [reviewedSourceTimeMs, setReviewedSourceTimeMs] = useState<number | null>(null)
  const [seekReviewMessage, setSeekReviewMessage] = useState('')
  const [showDetectionLabels, setShowDetectionLabels] = useState(false)
  const [showDetectionBoxes, setShowDetectionBoxes] = useState(true)
  const [showCountingLines, setShowCountingLines] = useState(true)
  const [showZones, setShowZones] = useState(true)
  const [labelSize, setLabelSize] = useState<'regular'|'large'>('regular')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  zoomRef.current = zoom
  panRef.current = pan
  const [stageSize, setStageSize] = useState({ width: 16, height: 9 })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [webcamClock, setWebcamClock] = useState(0)
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [sampleFps, setSampleFps] = useState(1)
  const [analysisWidth, setAnalysisWidth] = useState(960)
  const [captureErrors, setCaptureErrors] = useState<Record<string, string>>({})
  const captureError = sourceMessage(captureErrors, source.id)
  const setCaptureError = (text: string) => setCaptureErrors(current => updateSourceMessage(current, source.id, text))
  const [accuracyTargetState, setAccuracyTargetState] = useState<{ sourceId: string; event: TrafficEvent; detectionIndex?: number } | null>(null)
  const onDisplayedSampleChangeRef = useRef(onDisplayedSampleChange)
  onDisplayedSampleChangeRef.current = onDisplayedSampleChange
  const [selectedPoints, setSelectedPoints] = useState<{x:number;y:number}[]>([])
  const inFlight = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const seekGeneration = useRef(0)
  const youtubeRequestGeneration = useRef(0)
  const youtubeImageUrlRef = useRef('')
  const youtubeInFlight = useRef(false)
  const youtubePreviewRef = useRef<SourcePreview | null>(null)
  const loadedYoutubePreviewRef = useRef<SourcePreview | null>(null)
  const youtubeSourceIdRef = useRef(source.id)
  youtubeSourceIdRef.current = source.id
  youtubePreviewRef.current = youtubePreview
  loadedYoutubePreviewRef.current = loadedYoutubePreview
  useEffect(() => () => {
    youtubeRequestGeneration.current++
    if (youtubeImageUrlRef.current) URL.revokeObjectURL(youtubeImageUrlRef.current)
  }, [])
  const seekFallbackTimer = useRef<number | null>(null)
  const firstFrameAt = useRef<number | null>(null)
  const cameraEnabledRef = useRef(false)
  const sourceStatusRef = useRef(source.status)
  const stopOnUnmountRef = useRef(onCameraUnmount)
  sourceStatusRef.current = source.status
  stopOnUnmountRef.current = onCameraUnmount
  const isUpload = source.kind === 'upload'
  const isWebcam = source.kind === 'webcam'
  const isYoutube = source.kind === 'youtube'
  const pointInputState = useRef({ interactionMode, canPlacePoints, pointLimit, sourceStatus: source.status, isUpload, isWebcam, isYoutube })
  pointInputState.current = { interactionMode, canPlacePoints, pointLimit, sourceStatus: source.status, isUpload, isWebcam, isYoutube }
  const reviewToleranceMs = 25
  const reviewEvents = useMemo(() => [...events].sort((a, b) => a.sourceTimeMs - b.sourceTimeMs), [events])
  const reviewedEvent = reviewedSourceTimeMs === null ? undefined : reviewEvents.find(event => event.sourceTimeMs === reviewedSourceTimeMs)
  const uploadVideo = videoRef.current
  const mediaTimeMs = uploadVideo ? uploadVideo.currentTime * 1000 : videoTime
  const isActivePlayback = isUpload && !videoPaused && !videoBuffering && !isSeeking
  const playbackTime = isActivePlayback ? smoothMovementOn ? Math.min(smoothClock, mediaTimeMs) : Math.min(videoTime, mediaTimeMs) : videoTime
  const playbackEvent = latestPlaybackSampleFromSorted(reviewEvents, playbackTime, source.id, sessionId)
  const reviewedDateTime = reviewedEvent ? formatVideoDateTime(source.kind === 'upload' ? source.recordingTime : undefined, reviewedEvent.sourceTimeMs) : null
  const decodedFrameReady = !!uploadVideo && uploadVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && uploadVideo.videoWidth > 0 && uploadVideo.videoHeight > 0
  const showReviewedDetections = isUpload && decodedFrameReady && !uploadVideo?.seeking && videoPaused && !isSeeking && !!reviewedEvent && matchesAnalyzedFrame(videoTime, reviewedEvent.sourceTimeMs, reviewToleranceMs)
  const showPlaybackDetections = isUpload && decodedFrameReady && !uploadVideo?.seeking && !videoPaused && !videoBuffering && !isSeeking && !!playbackEvent
  const latestWebcamEvent = isWebcam ? reviewEvents[reviewEvents.length - 1] : undefined
  const webcamEventKey = latestWebcamEvent ? `${latestWebcamEvent.sessionId}:${latestWebcamEvent.sourceTimeMs}` : ''
  const webcamEventSeenAt = useRef(0)
  const previousWebcamEventKey = useRef('')
  const liveVideo = liveRef.current
  const decodedLiveFrameReady = !!liveVideo && liveVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && liveVideo.videoWidth > 0 && liveVideo.videoHeight > 0
  const showWebcamDetections = isWebcam && decodedLiveFrameReady && cameraEnabled && source.status === 'running' && !!latestWebcamEvent && webcamClock - webcamEventSeenAt.current < 1500
  const youtubeOverlayEvent = matchingPreviewEvent(loadedYoutubePreview, reviewEvents, source.id, sessionId)
  const reportableEvent = isYoutube ? youtubeOverlayEvent : isWebcam ? showWebcamDetections ? latestWebcamEvent : undefined : isUpload && showReviewedDetections ? reviewedEvent : undefined
  const accuracyTargetStateCurrent = accuracyTargetState?.sourceId === source.id && accuracyTargetState.event.sourceId === source.id && accuracyTargetState.event.sessionId === sessionId ? accuracyTargetState : null
  useEffect(() => { setAccuracyTargetState(null) }, [source.id, sessionId])
  const youtubePreviewFailure = isYoutube ? youtubePreviewErrorMessage({ sourceStatus: source.status, sourceError: source.error, requestError: cameraError || captureError, previewAvailable: loadedYoutubePreview?.sourceId === source.id && !!youtubeImageUrl }) : ''
  useEffect(() => {
    if (!isYoutube) return
    const image = youtubeImageRef.current
    onReadyChange(youtubeFrameReadyForAnnotation({
      sourceId: source.id,
      sourceStatus: source.status,
      imageComplete: !!image?.complete,
      imageSourceMatches: !!image && image.src === youtubeImageUrl && image.src === youtubeImageUrlRef.current,
      imageWidth: image?.naturalWidth ?? 0,
      imageHeight: image?.naturalHeight ?? 0,
      loadedPreview: loadedYoutubePreview,
      frameCandidate: youtubeImageCandidate,
    }))
  }, [isYoutube, source.id, source.status, youtubeImageUrl, loadedYoutubePreview, youtubeImageCandidate])
  const renderedEvent = isWebcam ? showWebcamDetections ? latestWebcamEvent : undefined : isYoutube ? youtubeOverlayEvent : showReviewedDetections ? reviewedEvent : showPlaybackDetections ? playbackEvent : undefined
  const selectedZoneForOverlay = totalScope.startsWith('zone:') ? monitoringScene?.zones.find(zone => zone.id === totalScope.slice(5)) : undefined
  const visualDetections = showPlaybackDetections && smoothMovementOn
    ? interpolatePlaybackDetections(reviewEvents, playbackEvent, playbackTime, source.id, sessionId)
    : renderedEvent?.detections ?? []
  const visualEvent = renderedEvent && visualDetections !== renderedEvent.detections ? { ...renderedEvent, detections: visualDetections } : renderedEvent
  const displayedDetections = detectionsInMonitoringScope(visualEvent, monitoringScene?.zones, selectedZoneForOverlay) ?? []
  useLayoutEffect(() => { onDisplayedSampleChangeRef.current(renderedEvent ?? null) }, [renderedEvent])
  const pendingReviewSourceTime = useRef<number | null>(null)
  useEffect(() => { setVideoTime(0); setSmoothClock(0); setDuration(source.durationMs ?? 0); setVideoDimensions({ width: source.width ?? 16, height: source.height ?? 9 }); setReviewedSourceTimeMs(null); setSeekReviewMessage(''); pendingReviewSourceTime.current = null; seekGeneration.current++; if(seekFallbackTimer.current!==null)window.clearTimeout(seekFallbackTimer.current); seekFallbackTimer.current=null; setIsSeeking(false); setZoom(1); setPan({x:0,y:0}); setShowDetectionBoxes(true); setShowCountingLines(true); setShowZones(true); setShowDetectionLabels(false); setIsExpanded(false); pointers.current.clear(); gesture.current=null; setYoutubePreview(null); setLoadedYoutubePreview(null); setYoutubeImageCandidate(null); setCameraError(''); youtubeRequestGeneration.current++; youtubeInFlight.current=false; if(youtubeImageUrlRef.current){URL.revokeObjectURL(youtubeImageUrlRef.current);youtubeImageUrlRef.current=''} setYoutubeImageUrl('') }, [source.id])
  const requestYoutubePreview = async (refresh = false) => {
    if (!isYoutube || youtubeInFlight.current) return
    youtubeInFlight.current = true
    const request = ++youtubeRequestGeneration.current
    try {
      if (refresh) setYoutubeRefreshing(true)
      const metadata = refresh ? (await api.refreshPreview(source.id)).preview : await api.latestPreview(source.id)
      if (request !== youtubeRequestGeneration.current || youtubeSourceIdRef.current !== source.id) return
      setCameraError('')
      setYoutubePreview(metadata)
      if (!metadata) { setLoadedYoutubePreview(null); setYoutubePreview(null); setYoutubeImageCandidate(null); if(youtubeImageUrlRef.current){URL.revokeObjectURL(youtubeImageUrlRef.current);youtubeImageUrlRef.current=''} setYoutubeImageUrl(''); onReadyChange(false); return }
      const key = `${metadata.sessionId}:${metadata.frameId}`
      const currentPreview = loadedYoutubePreviewRef.current
      const currentKey = currentPreview ? `${currentPreview.sessionId}:${currentPreview.frameId}` : ''
      if (key === currentKey) { if (refresh) onSaved(); return }
      const blob = await api.previewFrame(source.id, metadata)
      if (request !== youtubeRequestGeneration.current || youtubeSourceIdRef.current !== source.id) return
      const url = URL.createObjectURL(blob)
      try {
        const decoded = new Image()
        decoded.src = url
        await decoded.decode()
        if (request !== youtubeRequestGeneration.current || youtubeSourceIdRef.current !== source.id) { URL.revokeObjectURL(url); return }
        if (decoded.naturalWidth !== metadata.width || decoded.naturalHeight !== metadata.height) {
          URL.revokeObjectURL(url)
          setCameraError('The sampled frame dimensions did not match the preview metadata.')
          return
        }
        const previousUrl = youtubeImageUrlRef.current
        youtubeImageUrlRef.current = url
        setVideoDimensions({ width: decoded.naturalWidth, height: decoded.naturalHeight })
        setYoutubeImageCandidate(metadata)
        setLoadedYoutubePreview(metadata)
        setYoutubeImageUrl(url)
        onReadyChange(source.status !== 'running')
        if (previousUrl) URL.revokeObjectURL(previousUrl)
      } catch (error) {
        URL.revokeObjectURL(url)
        throw error
      }
      if (refresh) onSaved()
      setCameraError('')
    } catch (error) {
      if (request === youtubeRequestGeneration.current && youtubeSourceIdRef.current === source.id) setCameraError(error instanceof Error ? error.message : 'Could not load the YouTube preview.')
    } finally {
      if (refresh) setYoutubeRefreshing(false)
      if (request === youtubeRequestGeneration.current) youtubeInFlight.current = false
    }
  }
  useEffect(() => {
    if (!isYoutube) return
    void requestYoutubePreview()
    if (source.status !== 'running') return
    const timer = window.setInterval(() => void requestYoutubePreview(), 500)
    return () => { window.clearInterval(timer); youtubeRequestGeneration.current++; youtubeInFlight.current=false }
  }, [isYoutube, source.id, source.status])
  useEffect(() => {
    const video = isWebcam ? cameraEnabled ? liveRef.current : null : videoRef.current
    if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
      setVideoDimensions({ width: video.videoWidth, height: video.videoHeight })
    } else {
      setVideoDimensions({ width: source.width ?? 16, height: source.height ?? 9 })
    }
    if (video && Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration * 1000)
    else setDuration(source.durationMs ?? 0)
  }, [source.id, source.durationMs, source.width, source.height, isWebcam, cameraEnabled])
  useEffect(() => { setReviewedSourceTimeMs(null); setSeekReviewMessage(''); pendingReviewSourceTime.current = null; seekGeneration.current++; if(seekFallbackTimer.current!==null)window.clearTimeout(seekFallbackTimer.current); seekFallbackTimer.current=null; setIsSeeking(false) }, [source.id, reviewEvents[0]?.sessionId])
  useEffect(() => {
    if (!webcamEventKey) return
    const isNewEvent = previousWebcamEventKey.current !== webcamEventKey
    previousWebcamEventKey.current = webcamEventKey
    if (isWebcam && cameraEnabled && source.status === 'running' && isNewEvent) webcamEventSeenAt.current = Date.now()
  }, [isWebcam, cameraEnabled, source.status, webcamEventKey])
  useEffect(() => {
    if (!isWebcam || !cameraEnabled || source.status !== 'running') return
    setWebcamClock(Date.now())
    const timer = window.setInterval(() => setWebcamClock(Date.now()), 400)
    return () => window.clearInterval(timer)
  }, [isWebcam, cameraEnabled, source.status])
  useEffect(() => {
    const video = videoRef.current
    if (!isUpload || !smoothMovementOn || videoPaused || videoBuffering || isSeeking || !video) return
    let frame = 0
    let lastUpdate = 0
    const tick = (now: number) => {
      if (now - lastUpdate >= 33) {
        lastUpdate = now
        setSmoothClock(video.currentTime * 1000)
      }
      if (!video.paused && !video.seeking && !video.ended) frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [isUpload, smoothMovementOn, videoPaused, videoBuffering, isSeeking, source.id, sessionId])
  useEffect(() => {
    if (!isUpload || !decodedFrameReady || uploadVideo?.seeking || !videoPaused || isSeeking || reviewedSourceTimeMs !== null) return
    const matchingFrame = reviewEvents.find(event => matchesAnalyzedFrame(videoTime, event.sourceTimeMs, reviewToleranceMs))
    if (matchingFrame) setReviewedSourceTimeMs(matchingFrame.sourceTimeMs)
  }, [isUpload, decodedFrameReady, videoPaused, isSeeking, reviewedSourceTimeMs, reviewEvents, videoTime])
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect && rect.width > 0 && rect.height > 0) setStageSize({ width: rect.width, height: rect.height })
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [source.id, isFullscreen, isExpanded])
  useEffect(() => {
    const sync = () => setIsFullscreen(document.fullscreenElement === playerFrameRef.current)
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') setIsExpanded(false) }
    document.addEventListener('fullscreenchange', sync)
    window.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('fullscreenchange', sync); window.removeEventListener('keydown', keydown) }
  }, [])
  useEffect(() => {
    onReadyChange(false)
    setCameraEnabled(false)
    return () => {
      const stopAnalysis = isWebcam && cameraEnabledRef.current && sourceStatusRef.current === 'running'
      streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current=null; cameraEnabledRef.current=false
      if(liveRef.current)liveRef.current.srcObject=null
      onReadyChange(false)
      if(stopAnalysis)void stopOnUnmountRef.current(source.id)
    }
  }, [source.id])
  useEffect(() => {
    setSelectedPoints([])
    const receive=(event:Event)=>{
      const detail=(event as CustomEvent<{sourceId:string;x:number;y:number}>).detail
      const current=pointInputState.current
      const video=current.isWebcam?liveRef.current:current.isYoutube?null:videoRef.current
      const image=current.isYoutube?youtubeImageRef.current:null
      const mediaReady=current.isYoutube?!!image?.complete&&image.naturalWidth>0&&image.naturalHeight>0&&!!loadedYoutubePreviewRef.current:!!video&&video.readyState>=HTMLMediaElement.HAVE_CURRENT_DATA&&video.videoWidth>0&&video.videoHeight>0
      if((!video&&!image)||!canAcceptScenePoint({sourceId:source.id,eventSourceId:detail.sourceId,armed:current.interactionMode==='annotate',canEdit:current.canPlacePoints,sourceRunning:current.sourceStatus==='running',mediaReady,isUpload:current.isUpload,mediaPaused:video?.paused??true,mediaSeeking:video?.seeking??false,point:detail}))return
      setSelectedPoints(points=>appendScenePoint(points,detail,current.pointLimit))
    }
    const saved=(event:Event)=>{const detail=(event as CustomEvent<{sourceId:string}>).detail;if(detail.sourceId===source.id)setSelectedPoints([])}
    const draftReset=(event:Event)=>{const detail=(event as CustomEvent<{sourceId:string}>).detail;if(detail.sourceId===source.id)setSelectedPoints([])}
    window.addEventListener('flowline-scene-point',receive);window.addEventListener('flowline-scene-saved',saved);window.addEventListener('flowline-scene-draft-reset',draftReset); return ()=>{window.removeEventListener('flowline-scene-point',receive);window.removeEventListener('flowline-scene-saved',saved);window.removeEventListener('flowline-scene-draft-reset',draftReset)}
  },[source.id])
  const loadDevices = async () => {
    try { if(!navigator.mediaDevices?.enumerateDevices)throw new Error(); const list = await navigator.mediaDevices.enumerateDevices(); const cams = list.filter(x => x.kind === 'videoinput'); setDevices(cams); if (!deviceId && cams[0]) setDeviceId(cams[0].deviceId) } catch { setCameraError('Camera devices are not available in this browser context.') }
  }
  useEffect(()=>{if(isWebcam)void loadDevices()},[isWebcam,source.id])
  const startCamera = async () => {
    setCameraError(''); setCaptureError(''); firstFrameAt.current=null
    try {
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('Camera access requires a browser that supports getUserMedia on localhost or HTTPS.')
      streamRef.current?.getTracks().forEach(t => t.stop())
      const stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      streamRef.current = stream
      if (liveRef.current) { liveRef.current.srcObject = stream; await liveRef.current.play() }
      cameraEnabledRef.current=true; setCameraEnabled(true); await loadDevices()
    } catch (error) { cameraEnabledRef.current=false; setCameraEnabled(false); setCameraError(error instanceof Error ? `${error.name}: ${error.message}` : 'Camera access was denied. Check browser permission and whether another app is using it.') }
  }
  const stopCamera = () => { streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null; firstFrameAt.current=null; cameraEnabledRef.current=false; if (liveRef.current) liveRef.current.srcObject = null; onReadyChange(false); setCameraEnabled(false) }
  useEffect(() => {
    if (!cameraEnabled || source.status !== 'running') return
    const interval = window.setInterval(async () => {
      if (inFlight.current || !liveRef.current || liveRef.current.readyState < 2) return
      inFlight.current = true
      try {
        const video = liveRef.current
        if (!video.videoWidth || !video.videoHeight) throw new Error('Waiting for a camera frame. Check that the camera is uncovered and available.')
        const scale = Math.min(1, analysisWidth / video.videoWidth)
        const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
        const context = canvas.getContext('2d'); if (!context) throw new Error('Could not prepare camera frame')
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not encode camera frame')), 'image/jpeg', .78))
        firstFrameAt.current ??= Date.now()
        await api.frame(source.id, blob, Math.max(0, Date.now()-firstFrameAt.current))
        setCaptureError('')
      } catch (error) { setCaptureError(error instanceof Error ? error.message : 'Frame submission failed') }
      finally { inFlight.current = false }
    }, Math.max(400, 1000 / sampleFps))
    return () => window.clearInterval(interval)
  }, [cameraEnabled, source.status, source.id, sampleFps, analysisWidth])
  const videoSource = isUpload ? api.videoUrl(source.id) : isYoutube ? '' : source.url
  useEffect(() => {
    const video = isWebcam ? cameraEnabled ? liveRef.current : null : videoRef.current
    const ready = !!video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0 && (!isUpload || (video.paused && !video.seeking))
    onReadyChange(ready)
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      setDuration(video.duration * 1000)
      setVideoTime(video.currentTime * 1000)
    }
  }, [source.id, videoSource, isWebcam, cameraEnabled])
  const seekToAnalyzedFrame = (eventTimeMs: number) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(eventTimeMs)) return
    video.pause()
    setVideoPaused(true)
    setReviewedSourceTimeMs(null)
    setSeekReviewMessage('')
    seekGeneration.current++
    if (seekFallbackTimer.current !== null) window.clearTimeout(seekFallbackTimer.current)
    pendingReviewSourceTime.current = eventTimeMs
    setIsSeeking(true)
    video.currentTime = Math.max(0, eventTimeMs) / 1000
  }
  const stepAnalyzedFrame = (direction: -1 | 1) => {
    if (!reviewEvents.length) return
    let nextIndex: number
    if (reviewedSourceTimeMs !== null) {
      nextIndex = reviewEvents.findIndex(event => event.sourceTimeMs === reviewedSourceTimeMs) + direction
    } else if (direction > 0) {
      nextIndex = reviewEvents.findIndex(event => event.sourceTimeMs > videoTime)
    } else {
      nextIndex = -1
      for (let index = reviewEvents.length - 1; index >= 0; index--) {
        if (reviewEvents[index].sourceTimeMs < videoTime) { nextIndex = index; break }
      }
    }
    if (nextIndex < 0) nextIndex = 0
    if (nextIndex >= reviewEvents.length) nextIndex = reviewEvents.length - 1
    const next = reviewEvents[nextIndex]
    if (next) seekToAnalyzedFrame(next.sourceTimeMs)
  }
  const finishSeek = (video: HTMLVideoElement) => {
    if (video.seeking) return
    const requestedTimeMs = pendingReviewSourceTime.current
    const generation = seekGeneration.current
    let completed = false
    const complete = (decodedTimeMs: number, allowUnmatched = false) => {
      if (completed || generation !== seekGeneration.current || videoRef.current !== video || video.seeking || pendingReviewSourceTime.current !== requestedTimeMs) return
      const matched = requestedTimeMs !== null && matchesAnalyzedFrame(decodedTimeMs, requestedTimeMs, reviewToleranceMs)
      if (requestedTimeMs !== null && !matched && !allowUnmatched) return
      completed = true
      if (seekFallbackTimer.current !== null) window.clearTimeout(seekFallbackTimer.current)
      seekFallbackTimer.current = null
      setVideoTime(decodedTimeMs)
      setSmoothClock(decodedTimeMs)
      setIsSeeking(false)
      pendingReviewSourceTime.current = null
      setReviewedSourceTimeMs(matched ? requestedTimeMs : null)
      onReadyChange(video.paused && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0)
      setSeekReviewMessage(requestedTimeMs !== null && !matched ? 'The decoded frame did not match an analyzed sample; detections are hidden.' : '')
    }
    const frameVideo = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number }
    if (frameVideo.requestVideoFrameCallback) {
      frameVideo.requestVideoFrameCallback((_now, metadata) => complete(metadata.mediaTime * 1000))
      seekFallbackTimer.current = window.setTimeout(() => complete(video.currentTime * 1000, true), 200)
    } else complete(video.currentTime * 1000, true)
  }
  const syncVideoDimensions = (video: HTMLVideoElement) => {
    if (video.videoWidth > 0 && video.videoHeight > 0) setVideoDimensions({ width: video.videoWidth, height: video.videoHeight })
  }
  const videoAspect = videoDimensions.width / Math.max(1, videoDimensions.height)
  const normalizedImageHeight = 1000 / videoAspect
  const stageAspect = stageSize.width / Math.max(1, stageSize.height)
  const imageRect = containedImageRect(stageAspect, videoAspect)
  const imageWidthPercent = imageRect.width * 100
  const imageHeightPercent = imageRect.height * 100
  const imageLeftPercent = imageRect.left * 100
  const imageTopPercent = imageRect.top * 100
  useEffect(() => {
    const bounds = stageRef.current?.getBoundingClientRect()
    if (bounds) setPan(current => clampViewerPan(current.x, current.y, zoom, bounds, imageRect))
  }, [stageSize.width, stageSize.height, zoom, imageRect.width, imageRect.height])
  const mediaTransform = `translate3d(${pan.x}px,${pan.y}px,0) scale(${zoom})`
  const mediaStyle = { transform: mediaTransform } as CSSProperties
  const zoomTo = (nextZoom: number, point?: { x: number; y: number }) => {
    const bounds = stageRef.current?.getBoundingClientRect()
    if (!bounds) return
    const focus = point ?? { x: bounds.width / 2, y: bounds.height / 2 }
    const nextPan = zoomViewerAtPoint(zoomRef.current, nextZoom, panRef.current.x, panRef.current.y, focus.x, focus.y, bounds, imageRect)
    setZoom(Math.max(1, Math.min(8, nextZoom)))
    setPan(nextPan)
  }
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); pointers.current.clear(); gesture.current = null }
  const toggleFullscreen = async () => {
    const target = playerFrameRef.current
    if (!target) return
    if (isExpanded) { setIsExpanded(false); return }
    if (document.fullscreenElement === target) { await document.exitFullscreen().catch(() => setIsExpanded(false)); return }
    try {
      if (target.requestFullscreen) await target.requestFullscreen()
      else setIsExpanded(true)
    } catch { setIsExpanded(true) }
  }
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (interactionMode !== 'navigate' || (event.target as HTMLElement).closest('button,input,select,.accuracy-reportable-box')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const points = [...pointers.current.values()]
    if (points.length >= 2) {
      const [a, b] = points
      const bounds = stageRef.current?.getBoundingClientRect()
      gesture.current = { kind: 'pinch', distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: zoomRef.current, panX: panRef.current.x, panY: panRef.current.y, centerX: bounds ? (a.x+b.x)/2-bounds.left : 0, centerY: bounds ? (a.y+b.y)/2-bounds.top : 0 }
    } else {
      gesture.current = { kind: 'pan', pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: panRef.current.x, panY: panRef.current.y }
    }
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (interactionMode !== 'navigate' || !pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const bounds = stageRef.current?.getBoundingClientRect()
    if (!bounds) return
    const activeGesture = gesture.current
    if (activeGesture?.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
      const nextZoom = Math.max(1, Math.min(8, activeGesture.zoom * distance / activeGesture.distance))
      const focus = { x: (a.x + b.x) / 2 - bounds.left, y: (a.y + b.y) / 2 - bounds.top }
      const nextPan = pinchViewerPan(activeGesture.zoom, nextZoom, activeGesture.panX, activeGesture.panY, {x:activeGesture.centerX,y:activeGesture.centerY}, focus, bounds, imageRect)
      setZoom(nextZoom); setPan(nextPan)
    } else if (activeGesture?.kind === 'pan' && activeGesture.pointerId === event.pointerId && zoomRef.current > 1) {
      setPan(clampViewerPan(activeGesture.panX + event.clientX - activeGesture.x, activeGesture.panY + event.clientY - activeGesture.y, zoomRef.current, bounds, imageRect))
    }
  }
  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId)
    const remaining = [...pointers.current.entries()]
    if (!remaining.length) { gesture.current = null; return }
    const [pointerId, point] = remaining[0]
    gesture.current = { kind: 'pan', pointerId, x: point.x, y: point.y, panX: panRef.current.x, panY: panRef.current.y }
  }
  return <div ref={playerFrameRef} className={`video-player-frame${isExpanded ? ' expanded' : ''}`}>
    <div className="viewer-toolbar" aria-label="Video view controls">
      <div className="viewer-zoom-controls"><button aria-label="Zoom out" title="Zoom out" disabled={zoom <= 1} onClick={()=>zoomTo(zoom <= 2 ? 1 : zoom / 2)}><ZoomOut size={14}/></button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" title="Zoom in" disabled={zoom >= 8} onClick={()=>zoomTo(zoom >= 4 ? 8 : zoom * 2)}><ZoomIn size={14}/></button><button className="viewer-fit" onClick={resetView} disabled={zoom===1&&pan.x===0&&pan.y===0}>Fit</button></div>
      <div className="viewer-overlay-controls" aria-label="Visible overlays">{isUpload&&<button aria-pressed={smoothMovementOn} title="Estimate box movement between analyzed samples" onClick={()=>{const next=!smoothMovementOn;if(next&&videoRef.current)setSmoothClock(videoRef.current.currentTime*1000);setSmoothMovementOn(next)}}>Smooth movement {smoothMovementOn?'On':'Off'}</button>}<button aria-pressed={showDetectionBoxes} onClick={()=>setShowDetectionBoxes(value=>!value)}>Boxes {showDetectionBoxes?'On':'Off'}</button><button aria-pressed={showDetectionLabels} onClick={()=>setShowDetectionLabels(value=>!value)}>Labels {showDetectionLabels?'On':'Off'}</button>{showDetectionLabels&&<label className="viewer-label-size">Label size<select aria-label="Detection label size" value={labelSize} onChange={e=>setLabelSize(e.target.value as 'regular'|'large')}><option value="regular">Regular</option><option value="large">Large</option></select></label>}<button aria-pressed={showCountingLines} onClick={()=>setShowCountingLines(value=>!value)}>Lines {showCountingLines?'On':'Off'}</button><button aria-pressed={showZones} onClick={()=>setShowZones(value=>!value)}>Zones {showZones?'On':'Off'}</button>{reportableEvent && <button type="button" className="viewer-report-frame" disabled={!reportableEvent.id} title={!reportableEvent.id ? 'This event has no stable identifier and cannot be reported safely' : 'Report an issue with this exact analyzed frame'} onClick={()=>setAccuracyTargetState({sourceId:source.id,event:reportableEvent})}><Flag size={12}/> Report frame</button>}</div>
      <button className="viewer-expand" onClick={()=>void toggleFullscreen()} aria-label={isFullscreen||isExpanded?'Exit expanded view':'Expand video'} title={isFullscreen||isExpanded?'Exit expanded view':'Expand video'}>{isFullscreen||isExpanded?<Minimize2 size={14}/>:<Maximize2 size={14}/>}<span>{isFullscreen||isExpanded?'Close':'Expand'}</span></button>
    </div>
    <div ref={stageRef} className={`video-stage${interactionMode==='navigate'&&zoom>1?' is-zoomed':''}${interactionMode==='annotate'?' is-annotating':''}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onClick={e=>{
      if((e.target as HTMLElement).closest('.camera-controls,button,input,select,.accuracy-reportable-box')) return
      const video=isWebcam?liveRef.current:isYoutube?null:videoRef.current
      const image=isYoutube?youtubeImageRef.current:null
      if(!video&&!image)return
      const bounds=stageRef.current?.getBoundingClientRect();if(!bounds)return
      const point=viewerPointToImage(e.clientX,e.clientY,bounds,zoom,pan.x,pan.y,imageRect)
      const mediaReady=isYoutube?!!image?.complete&&image.naturalWidth>0&&image.naturalHeight>0&&!!loadedYoutubePreviewRef.current:!!video&&video.readyState>=HTMLMediaElement.HAVE_CURRENT_DATA&&video.videoWidth>0&&video.videoHeight>0
      if(!point||!canAcceptScenePoint({sourceId:source.id,eventSourceId:source.id,armed:interactionMode==='annotate',canEdit:canPlacePoints,sourceRunning:source.status==='running',mediaReady,isUpload,mediaPaused:video?.paused??true,mediaSeeking:video?.seeking??false,point}))return
      window.dispatchEvent(new CustomEvent('flowline-scene-point',{detail:{sourceId:source.id,...point}}))
    }}>
      {isWebcam ? <>{cameraEnabled ? <video ref={liveRef} autoPlay muted playsInline className="stage-video" style={mediaStyle} onLoadedData={e=>{syncVideoDimensions(e.currentTarget);const video=e.currentTarget;onReadyChange(video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0)}} onError={()=>onReadyChange(false)}/> : <div className="video-empty"><div className="video-empty-grid"/><div className="video-empty-icon"><Camera size={24}/></div><strong>Camera preview is off</strong><span>Turn it on when you are ready. The browser will ask for camera permission.</span><button className="button button-primary" onClick={startCamera}><Camera size={15}/> Turn on webcam</button></div>}</> : isYoutube ? (youtubeImageUrl ? <img ref={youtubeImageRef} src={youtubeImageUrl} alt={source.status==="running"?(youtubeOverlayEvent?"Current analyzed YouTube frame":"YouTube preview while analysis starts"):youtubeOverlayEvent?"Last analyzed YouTube frame":"YouTube preview frame"} className="stage-video" style={mediaStyle} onLoad={e=>{const image=e.currentTarget;const candidate=youtubeImageCandidate;if(image.src!==youtubeImageUrl||!candidate||candidate.sourceId!==source.id||youtubeSourceIdRef.current!==source.id)return;if(image.naturalWidth!==candidate.width||image.naturalHeight!==candidate.height){setCameraError("The sampled frame dimensions did not match the preview metadata.");onReadyChange(false);return}setVideoDimensions({width:image.naturalWidth,height:image.naturalHeight});setLoadedYoutubePreview(candidate);onReadyChange(source.status!=="running"&&image.naturalWidth>0&&image.naturalHeight>0)}} onError={e=>{const image=e.currentTarget;if(image.src!==youtubeImageUrl||youtubeImageCandidate?.sourceId!==source.id||youtubeSourceIdRef.current!==source.id)return;setLoadedYoutubePreview(null);onReadyChange(false);setCameraError("The sampled YouTube frame could not be decoded.")}}/> : <div className="video-empty"><div className="video-empty-grid"/><div className="video-empty-icon"><Youtube size={24}/></div><strong>Sampled YouTube preview</strong><span>{cameraError||"A public frame preview will appear when the source is available."}</span></div>) : videoSource ? <video key={videoSource} ref={videoRef} src={videoSource} muted playsInline className="stage-video" style={mediaStyle} onTimeUpdate={e => setVideoTime(e.currentTarget.currentTime * 1000)} onWaiting={()=>setVideoBuffering(true)} onCanPlay={()=>setVideoBuffering(false)} onPlaying={e=>{const video=e.currentTarget;setSmoothClock(video.currentTime*1000);setVideoBuffering(false)}} onSeeking={e => {setIsSeeking(true);setReviewedSourceTimeMs(null);onReadyChange(false)}} onSeeked={e => { const video=e.currentTarget; setVideoPaused(video.paused); onReadyChange(video.paused && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0); finishSeek(video) }} onLoadedMetadata={e => {setDuration(e.currentTarget.duration * 1000);syncVideoDimensions(e.currentTarget)}} onLoadedData={e=>{syncVideoDimensions(e.currentTarget);const video=e.currentTarget;onReadyChange(video.paused && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0)}} onPlay={e=>{const video=e.currentTarget;setSmoothClock(video.currentTime*1000);seekGeneration.current++;if(seekFallbackTimer.current!==null)window.clearTimeout(seekFallbackTimer.current);seekFallbackTimer.current=null;setIsSeeking(false);setVideoPaused(false);setVideoBuffering(false);onReadyChange(false);setReviewedSourceTimeMs(null);setSeekReviewMessage('');pendingReviewSourceTime.current=null}} onPause={e=>{setVideoPaused(true);const video=e.currentTarget;onReadyChange(!video.seeking&&video.readyState>=HTMLMediaElement.HAVE_CURRENT_DATA&&video.videoWidth>0&&video.videoHeight>0)}} onEnded={e=>{const video=e.currentTarget;const endedTimeMs=video.currentTime*1000;setVideoPaused(true);setVideoBuffering(false);setIsSeeking(false);setSmoothClock(endedTimeMs);setVideoTime(endedTimeMs);onReadyChange(!video.seeking&&video.readyState>=HTMLMediaElement.HAVE_CURRENT_DATA&&video.videoWidth>0&&video.videoHeight>0)}} onError={() => {onReadyChange(false);setCameraError('This source cannot be previewed in the browser. The analysis service may still accept the stream URL.')}}/> : <div className="video-empty"><div className="video-empty-grid"/><div className="video-empty-icon"><Radio size={24}/></div><strong>Preview not available</strong><span>{source.kind === 'stream' ? 'The stream URL is not available to the browser.' : 'Source preview will appear when available.'}</span></div>}
      <div className="video-overlay" style={mediaStyle}><div className="video-image-overlay" style={{left:`${imageLeftPercent}%`,top:`${imageTopPercent}%`,width:`${imageWidthPercent}%`,height:`${imageHeightPercent}%`}}><svg viewBox={`0 0 1000 ${normalizedImageHeight}`} preserveAspectRatio="none" aria-hidden="true">{showZones&&monitoringScene?.zones.map(zone=><polygon key={zone.id} points={zone.polygon.map(p=>`${p.x*1000},${p.y*normalizedImageHeight}`).join(' ')} vectorEffect="non-scaling-stroke" className="zone-overlay" style={{strokeWidth:`${2/zoom}px`}}/>)}{showCountingLines&&monitoringScene?.countingLines.map(line=><g key={line.id}><line x1={line.start.x*1000} y1={line.start.y*normalizedImageHeight} x2={line.end.x*1000} y2={line.end.y*normalizedImageHeight} vectorEffect="non-scaling-stroke" className="line-overlay" style={{strokeWidth:`${2/zoom}px`,strokeDasharray:`${12/zoom}px ${8/zoom}px`}}/><text x={(line.start.x+line.end.x)*500} y={(line.start.y+line.end.y)*normalizedImageHeight/2} vectorEffect="non-scaling-stroke" className="line-label" style={{fontSize:24/zoom,strokeWidth:`${3/zoom}px`}}>{line.name}</text></g>)}{showDetectionBoxes&&displayedDetections.map((d,i)=><rect key={`box-${d.trackId}-${i}`} x={d.bbox.x*1000} y={d.bbox.y*normalizedImageHeight} width={d.bbox.width*1000} height={d.bbox.height*normalizedImageHeight} vectorEffect="non-scaling-stroke" className={`detection-rect ${d.trackId ? 'tracked' : 'untracked'}`} style={{strokeWidth:`${1.6/zoom}px`}}/>)}</svg>{showDetectionBoxes&&displayedDetections.map((d,i)=>{const detectionIndex=reportableEvent?.detections.indexOf(d)??-1;const reportable=!!reportableEvent?.id&&detectionIndex>=0;return <div key={`${d.trackId}-${i}`} className={`detection-box${reportable?' accuracy-reportable-box':''}`} style={{left:`${d.bbox.x*100}%`,top:`${d.bbox.y*100}%`,width:`${d.bbox.width*100}%`,height:`${d.bbox.height*100}%`,pointerEvents:reportable?'auto':'none'}} role={reportable?'button':undefined} tabIndex={reportable?0:undefined} title={reportable?'Open accuracy review':undefined} onClick={event=>{if(!reportableEvent||detectionIndex<0)return;event.stopPropagation();setAccuracyTargetState({sourceId:source.id,event:reportableEvent,detectionIndex})}} onKeyDown={event=>{if(reportable&&(event.key==='Enter'||event.key===' ')){event.preventDefault();event.stopPropagation();setAccuracyTargetState({sourceId:source.id,event:reportableEvent!,detectionIndex})}}} aria-label={d.trackId ? `${vehicleTypeLabel(d.class)}, ${vehicleColorLabel(d.color)}, track ${d.trackId}` : `Untracked ${vehicleTypeLabel(d.class)}, color ${vehicleColorLabel(d.color)}`}>{showDetectionLabels && <span style={{fontSize:`${labelSize==='large'?14:11}px`,transform:`scale(${1/zoom})`,transformOrigin:'left bottom',left:`${-1/zoom}px`}}><i style={{backgroundColor:vehicleColorSwatch(d.color)}}/>{vehicleTypeLabel(d.class)} · {vehicleColorLabel(d.color)}{d.trackId ? ` · #${d.trackId}` : ' · untracked'}</span>}</div>})}{selectedPoints.length>0&&<svg className="draft-point-overlay" viewBox={`0 0 1000 ${normalizedImageHeight}`} preserveAspectRatio="none" aria-hidden="true">{selectedPoints.map((point,i)=><g key={`draft-point-${i}`}><circle cx={point.x*1000} cy={point.y*normalizedImageHeight} r={6/zoom} vectorEffect="non-scaling-stroke" className="point-overlay" style={{strokeWidth:`${2/zoom}px`}}/><text x={point.x*1000} y={point.y*normalizedImageHeight} textAnchor="middle" dominantBaseline="central" style={{fontSize:`${9/zoom}px`}}>{i+1}</text></g>)}</svg>}</div></div>
    </div>
    {isYoutube && <div className="youtube-preview-controls"><span>{source.status==='running'?(youtubeOverlayEvent?`${source.youtube?.isLive===true?'Live analyzed frames':'YouTube analyzed frames'} · 2 FPS target`:`${source.youtube?.isLive===true?'Live preview':'YouTube preview'} · analysis starting`):youtubeOverlayEvent?'Last analyzed frame':`${source.youtube?.isLive===true?'Live camera preview':'YouTube preview'} · counts unknown until analysis`}</span><div>{source.url&&<a href={source.url} target="_blank" rel="noreferrer" className="button button-quiet"><ExternalLink size={13}/> Open YouTube</a>}<button className="button button-quiet" disabled={source.status==='running'||youtubeRefreshing} onClick={()=>void requestYoutubePreview(true)}><RefreshCw size={13}/> {youtubeRefreshing?'Refreshing…':'Refresh preview'}</button></div></div>}
    {isUpload && duration > 0 && <div className="video-seek"><div><button className="video-play-toggle" aria-label={videoPaused ? 'Play video' : 'Pause video'} onClick={()=>{const video=videoRef.current;if(!video)return;if(video.paused)void video.play();else video.pause()}}>{videoPaused?<Play size={14}/>:<Pause size={14}/>}</button><button className="review-step" aria-label="Previous analyzed frame" title="Previous analyzed frame" disabled={!reviewEvents.length || videoTime <= reviewEvents[0]?.sourceTimeMs} onClick={()=>stepAnalyzedFrame(-1)}>Previous</button><span className="video-position-readout" title="Elapsed position within video">Video position {formatVideoPosition(videoTime)}</span><input aria-label="Seek video position" type="range" min="0" max={duration} value={Math.min(videoTime,duration)} onChange={e => { const next=Number(e.target.value); seekGeneration.current++;if(seekFallbackTimer.current!==null)window.clearTimeout(seekFallbackTimer.current);seekFallbackTimer.current=null;pendingReviewSourceTime.current=null;setSeekReviewMessage('');setReviewedSourceTimeMs(null);setIsSeeking(Math.abs((videoRef.current?.currentTime??0)*1000-next)>1);setVideoTime(next);setSmoothClock(next);if(videoRef.current)videoRef.current.currentTime=next/1000 }}/><span title="Video duration">{time(duration)}</span><button className="review-step" aria-label="Next analyzed frame" title="Next analyzed frame" disabled={!reviewEvents.length || videoTime >= reviewEvents[reviewEvents.length-1]?.sourceTimeMs} onClick={()=>stepAnalyzedFrame(1)}>Next</button></div><small>{isSeeking ? 'Seeking to analyzed frame…' : videoBuffering ? 'Buffering video…' : seekReviewMessage || (!videoPaused && !playbackEvent ? 'No analyzed sample is available at this position yet.' : showPlaybackDetections ? `${smoothMovementOn ? `Estimated movement · totals from analyzed sample · sample at video position ${formatVideoPosition(playbackEvent!.sourceTimeMs)}` : `Sampled overlay · may trail moving vehicles · sample at video position ${formatVideoPosition(playbackEvent!.sourceTimeMs)}`}` : showReviewedDetections ? `Sampled detections · ${reviewedDateTime ?? 'Video date/time unknown'} · video position ${formatVideoPosition(reviewedEvent!.sourceTimeMs)}` : 'Paused overlays appear on exact analyzed frames. Use Previous / Next to review, or play to keep the latest sample visible.')}</small></div>}
    {isWebcam && <div className="camera-controls"><div className="camera-control-row"><button className={`button ${cameraEnabled ? 'button-danger-quiet':'button-quiet'}`} onClick={cameraEnabled ? stopCamera : startCamera}>{cameraEnabled ? <><Square size={13}/> Turn off camera</> : <><Camera size={14}/> Turn on webcam</>}</button><label>Camera<select disabled={!devices.length} value={deviceId} onFocus={loadDevices} onChange={e => setDeviceId(e.target.value)}>{devices.length ? devices.map((device,i)=><option value={device.deviceId} key={device.deviceId}>{device.label || `Camera ${i+1}`}</option>) : <option>Choose device</option>}</select></label><label>Sample<select value={sampleFps} onChange={e=>setSampleFps(Number(e.target.value))}><option value="0.5">0.5 fps</option><option value="1">1 fps</option><option value="2">2 fps</option></select></label><label>Analysis width<select value={analysisWidth} onChange={e=>setAnalysisWidth(Number(e.target.value))}><option value="640">640 px</option><option value="960">960 px</option><option value="1280">1280 px</option></select></label></div><div className="camera-footnote">{showWebcamDetections ? "Latest sampled detections only; boxes can trail the live preview." : "Frames are sampled while analysis is running. This is low frame rate sampling, not full video processing."}</div></div>}
    {isYoutube && youtubePreviewFailure ? <div className="inline-error youtube-preview-error" role="alert"><div><strong>YouTube preview unavailable</strong><span>{youtubePreviewFailure}</span><small>Use Refresh preview to try again, or Open YouTube to check whether the link is available.</small></div>{(cameraError || captureError) && <button aria-label="Dismiss" onClick={()=>{setCameraError('');setCaptureError('')}}><X size={14}/></button>}</div> : (cameraError || captureError) && <div className="inline-error"><span>{cameraError || captureError}</span><button aria-label="Dismiss" onClick={()=>{setCameraError('');setCaptureError('')}}><X size={14}/></button></div>}
    {accuracyTargetStateCurrent && <AccuracyReviewDialog key={`${accuracyTargetStateCurrent.event.id}:${accuracyTargetStateCurrent.event.sessionId}:${accuracyTargetStateCurrent.detectionIndex ?? 'frame'}`} source={source} event={accuracyTargetStateCurrent.event} initialDetectionIndex={accuracyTargetStateCurrent.detectionIndex} onClose={() => setAccuracyTargetState(null)}/> }
  </div>
}

function SceneEditor({ source, frameReady, interactionMode, onInteractionModeChange, onPointLimitChange, onSaved }: { source: Source; frameReady: boolean; interactionMode: 'navigate'|'annotate'; onInteractionModeChange: (mode: 'navigate'|'annotate') => void; onPointLimitChange: (limit: number) => void; onSaved: () => void }) {
  const [scene, setScene] = useState<Scene>(emptyScene)
  const sceneRequest = useRef(createRequestGeneration<string>())
  const currentSceneSourceId = useRef(source.id)
  currentSceneSourceId.current = source.id
  const [mode, setMode] = useState<'line'|'zone'>('line')
  const armed = interactionMode === 'annotate'
  const [points, setPoints] = useState<{x:number;y:number}[]>([])
  const pointsRef = useRef(points)
  pointsRef.current = points
  const [zoneName, setZoneName] = useState('Monitoring zone')
  const [lineName, setLineName] = useState('Counting line')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const canEdit = source.status !== 'running' && frameReady
  const pointInputState = useRef({ sourceId: source.id, armed, canEdit, mode })
  pointInputState.current = { sourceId: source.id, armed, canEdit, mode }
  const resetDraft = () => { pointsRef.current=[]; setPoints([]); window.dispatchEvent(new CustomEvent('flowline-scene-draft-reset',{detail:{sourceId:source.id}})) }
  useEffect(()=>{
    const request = sceneRequest.current.begin(source.id)
    pointsRef.current=[]; setPoints([]); setScene(emptyScene); setMessage(''); onInteractionModeChange('navigate')
    void api.scene(source.id).then(next=>{
      if(sceneRequest.current.isCurrent(request,currentSceneSourceId.current))setScene(next)
    }).catch(error=>{
      if(sceneRequest.current.isCurrent(request,currentSceneSourceId.current))setMessage(error instanceof Error?error.message:'Could not load scene')
    })
    return ()=>sceneRequest.current.invalidate()
  },[source.id])
  useEffect(()=>{
    if (source.status === 'running') { resetDraft(); onInteractionModeChange('navigate') }
  },[source.id,source.status])
  useEffect(()=>{
    const receive=(event:Event)=>{
      const detail=(event as CustomEvent<{sourceId:string;x:number;y:number}>).detail
      const current=pointInputState.current
      if(detail.sourceId!==current.sourceId||!current.armed||!current.canEdit||!Number.isFinite(detail.x)||!Number.isFinite(detail.y))return
      const maximum=current.mode==='line'?2:128
      const currentPoints=pointsRef.current
      if(currentPoints.length>=maximum){setMessage(current.mode==='line'?'Two points selected. Add the line or reset the draft to start again.':'Zone point limit reached. Add the zone or reset the draft.');return}
      const nextPoints=appendScenePoint(currentPoints,detail,maximum)
      pointsRef.current=nextPoints
      setPoints(nextPoints)
      setMessage('')
    }
    window.addEventListener('flowline-scene-point',receive)
    return ()=>window.removeEventListener('flowline-scene-point',receive)
  },[source.id])
  const chooseTool=(nextMode:'line'|'zone')=>{
    if(mode!==nextMode){setMode(nextMode);resetDraft()}
    onPointLimitChange(nextMode==='line'?2:128)
    onInteractionModeChange('annotate')
  }
  const save = async (next: Scene) => { setSaving(true); setMessage(''); try { const saved=await api.saveScene(source.id,next); setScene(saved); setMessage('Scene saved'); window.dispatchEvent(new CustomEvent('flowline-scene-saved',{detail:{sourceId:source.id,scene:saved}})); onSaved() } catch(error) { setMessage(error instanceof Error ? error.message : 'Could not save scene') } finally { setSaving(false) } }
  const add = () => {
    if (!canEdit) return setMessage(source.status === 'running' ? 'Stop this source before changing its scene.' : 'Wait for a video frame to appear before adding scene points.')
    if (mode === 'line' ? points.length !== 2 : points.length < 3) return setMessage(mode === 'line' ? 'Select exactly two points on the preview first.' : 'Select at least three points on the preview first.')
    if (mode === 'line') { const [start,end] = points; if (!start || !end) return; const next={...scene,countingLines:[...scene.countingLines,{id:createUploadIdempotencyKey(),name:lineName,start,end,directionLabels:['A to B','B to A'] as [string,string]}]}; void save(next) }
    else { const next={...scene,zones:[...scene.zones,{id:createUploadIdempotencyKey(),name:zoneName,polygon:points}]}; void save(next) }
    resetDraft();onInteractionModeChange('navigate')
  }
  const remove = (id:string, kind:'line'|'zone') => { const next={...scene,countingLines:kind==='line'?scene.countingLines.filter(x=>x.id!==id):scene.countingLines,zones:kind==='zone'?scene.zones.filter(x=>x.id!==id):scene.zones}; void save(next) }
  const minimumPoints=mode==='line'?2:3
  const pointCount=mode==='line'?Math.min(points.length,2):points.length
  const pointStatus=mode==='line'?`${pointCount} of 2 points selected`:points.length>=3?`${points.length} points selected (minimum 3)`:`${points.length} of 3 minimum points selected`
  const blockedReason=source.status==='running'?'Stop this source before adding or changing its scene.':!frameReady?(source.kind==='upload'?'Pause the video after a frame has loaded before editing annotations.':'Wait for a video frame.'):!armed?'Navigation mode is on. Choose Line or Zone to place points.':points.length<minimumPoints?`Select ${minimumPoints-points.length} more point${minimumPoints-points.length===1?'':'s'} on the preview.`:''
  return <>{source.status==='running'&&<div className="scene-message">Analysis is running. Stop this source before editing its scene.</div>}{!frameReady&&source.status!=='running'&&<div className="scene-message">{source.kind==='upload'?'Pause the video after a frame has loaded before editing annotations.':'A decoded video frame is required. Wait for the preview to load before adding or changing annotations.'}</div>}<div className="scene-tabs"><button className={interactionMode==='navigate'?'selected':''} aria-pressed={interactionMode==='navigate'} onClick={()=>onInteractionModeChange('navigate')}><Move size={14}/> Navigate</button><button disabled={!canEdit} className={mode==='line'&&armed&&canEdit?'selected':''} aria-pressed={mode==='line'&&armed&&canEdit} onClick={()=>chooseTool('line')}><Route size={14}/> Line</button><button disabled={!canEdit} className={mode==='zone'&&armed&&canEdit?'selected':''} aria-pressed={mode==='zone'&&armed&&canEdit} onClick={()=>chooseTool('zone')}><Layers3 size={14}/> Zone</button></div><p className="scene-instruction">{!canEdit?blockedReason:armed?mode==='line'?'Annotate mode: tap or click two points on the paused video. Use Fit/zoom, then place points.':'Annotate mode: tap or click at least three points on the video to outline a zone.':'Navigate mode: drag or pinch to move around; choose Line or Zone to place points.'}<span className="point-status" aria-live="polite">{pointCount} {mode==='line'?'of 2 points selected':`points selected (minimum ${minimumPoints})`}{armed&&pointCount>=minimumPoints?'. Ready to add.':'.'}</span></p><div className="scene-form"><label>{mode==='line'?'Line name':'Zone name'}<input disabled={!canEdit} value={mode==='line'?lineName:zoneName} onChange={e=>mode==='line'?setLineName(e.target.value):setZoneName(e.target.value)}/></label><div className="scene-actions"><button className="button button-quiet button-full" onClick={add} disabled={!canEdit||!armed||saving || (mode==='line'?points.length!==2:points.length<3)} title={blockedReason||undefined} aria-describedby="scene-add-reason">{saving?'Saving…':`Add ${mode}`}</button><button className="scene-clear" onClick={resetDraft} disabled={!points.length}>Reset draft</button></div><span id="scene-add-reason" className="scene-add-reason">{saving?'Saving scene…':blockedReason||`Ready: ${pointStatus}.`}</span></div><div className="annotation-list"><div className="annotation-heading">Counting lines <span>{scene.countingLines.length}</span></div>{scene.countingLines.map(item=><div className="annotation-item" key={item.id}><span className="annotation-swatch line-swatch"/><span><strong>{item.name}</strong><small>{item.directionLabels.join(' · ')}</small></span><button disabled={!canEdit} aria-label={`Remove ${item.name}`} onClick={()=>remove(item.id,'line')}><X size={14}/></button></div>)}<div className="annotation-heading zone-heading">Zones <span>{scene.zones.length}</span></div>{scene.zones.map(item=><div className="annotation-item" key={item.id}><span className="annotation-swatch zone-swatch"/><span><strong>{item.name}</strong><small>{item.polygon.length} points</small></span><button disabled={!canEdit} aria-label={`Remove ${item.name}`} onClick={()=>remove(item.id,'zone')}><X size={14}/></button></div>)}{!scene.countingLines.length&&!scene.zones.length&&<span className="annotations-empty">No annotations saved.</span>}</div>{message&&<div className={message==='Scene saved'?'scene-success':'scene-message'}>{message}</div>}</>
}

function AddSourceModal({ onClose, onCreated, maxUploadBytes }: { onClose: () => void; onCreated: (source: Source) => void; maxUploadBytes: number | null }) {
  const [kind,setKind]=useState<'webcam'|'stream'|'upload'|'youtube'>('upload')
  const [name,setName]=useState('')
  const [url,setUrl]=useState('')
  const [file,setFile]=useState<File|null>(null)
  const [uploadKey,setUploadKey]=useState<string|null>(null)
  const [error,setError]=useState('')
  const [loading,setLoading]=useState(false)
  const [effectiveLimit,setEffectiveLimit]=useState<number|null>(maxUploadBytes)
  const [limitReady,setLimitReady]=useState(maxUploadBytes!==null)
  const [transfer,setTransfer]=useState<{loaded:number;percent:number;finishing:boolean}|null>(null)
  const inputRef=useRef<HTMLInputElement>(null)
  const controllerRef=useRef<AbortController|null>(null)
  const busyRef=useRef(false)
  const requestIdRef=useRef(0)
  useEffect(()=>{
    if(maxUploadBytes!==null){setEffectiveLimit(maxUploadBytes);setLimitReady(true);return}
    let active=true
    void api.health().then(result=>{if(active){setEffectiveLimit(result.upload.maxBytes);setLimitReady(true)}}).catch(()=>{if(active)setLimitReady(false)})
    return ()=>{active=false}
  },[maxUploadBytes])
  const tooLargeMessage=(selected:File)=>effectiveLimit!==null&&selected.size>effectiveLimit?`This file is ${formatBytes(selected.size)}. The current server limit is ${formatBytes(effectiveLimit)}. Choose a smaller file.`:''
  const chooseFile=(selected:File|undefined)=>{
    if(!selected)return
    setFile(selected);setUploadKey(createUploadIdempotencyKey());setError(tooLargeMessage(selected));setTransfer(null)
  }
  const cancelUpload=()=>{
    if(!controllerRef.current)return
    requestIdRef.current++
    controllerRef.current.abort();controllerRef.current=null;busyRef.current=false
    setLoading(false);setTransfer(null);setError('Upload cancelled. The selected file is ready to retry.')
  }
  const submit=async(e:FormEvent)=>{
    e.preventDefault()
    if(busyRef.current)return
    setError('')
    if(kind==='upload'){
      if(!file){setError('Choose a video file to upload.');return}
      if(effectiveLimit===null){setError('The server upload limit is unavailable. Refresh the workspace connection, then try again.');return}
      const tooLarge=tooLargeMessage(file);if(tooLarge){setError(tooLarge);return}
    }
    busyRef.current=true;setLoading(true)
    const requestId=++requestIdRef.current
    try {
      let source:Source
      if(kind==='upload'){
        const controller=new AbortController();controllerRef.current=controller;setTransfer({loaded:0,percent:0,finishing:false})
        if(!uploadKey)throw new Error('Select the video file again before uploading.')
        source=await api.upload(file!,name.trim()||file!.name,{signal:controller.signal,idempotencyKey:uploadKey,onProgress:progress=>{
          if(requestId!==requestIdRef.current)return
          const loaded=Math.min(progress.loaded,file!.size),percent=Math.min(99,Math.floor(loaded/file!.size*100))
          setTransfer({loaded,percent,finishing:progress.total>0&&progress.loaded>=progress.total})
        }})
      }
      else if(kind==='webcam')source=await api.addSource({name:name.trim()||'Local webcam',kind})
      else if(kind==='youtube'){
        if(!youtubeVideoIdFromUrl(url))throw new Error('Enter a valid YouTube watch, live, or youtu.be URL.')
        source=await api.addSource({name:name.trim()||'YouTube live source',kind,url:url.trim()})
      }
      else {if(!url.trim())throw new Error('Enter a stream URL.');source=await api.addSource({name:name.trim()||'Direct stream',kind,url:url.trim()})}
      if(requestId===requestIdRef.current)onCreated(source)
    } catch(err) {
      if(requestId!==requestIdRef.current)return
      if(err instanceof DOMException&&err.name==='AbortError')setError('Upload cancelled. The selected file is ready to retry.')
      else if(err instanceof UploadError&&err.status===413&&effectiveLimit!==null)setError(`This file is ${formatBytes(file?.size??0)}. The current server limit is ${formatBytes(effectiveLimit)}. Choose a smaller file.`)
      else setError(err instanceof Error?err.message:'Could not add source')
    } finally {
      if(requestId===requestIdRef.current){controllerRef.current=null;busyRef.current=false;setLoading(false);setTransfer(null)}
    }
  }
  const selectKind=(next:'webcam'|'stream'|'upload'|'youtube')=>{if(loading)return;setKind(next);setError('')}
  return <div className="modal-backdrop" onMouseDown={e=>{if(!loading&&e.target===e.currentTarget)onClose()}}><section role="dialog" aria-modal="true" aria-labelledby="add-source-title" className="modal-card"><div className="modal-heading"><div><div className="eyebrow">SOURCE SETUP</div><h2 id="add-source-title">Add a video source</h2></div><button className="icon-button" aria-label="Close dialog" disabled={loading} onClick={onClose}><X size={18}/></button></div><div className="source-type-tabs"><button disabled={loading} className={kind==='upload'?'selected':''} onClick={()=>selectKind('upload')}><CloudUpload size={16}/> Upload</button><button disabled={loading} className={kind==='webcam'?'selected':''} onClick={()=>selectKind('webcam')}><Camera size={16}/> Webcam</button><button disabled={loading} className={kind==='stream'?'selected':''} onClick={()=>selectKind('stream')}><Radio size={16}/> Stream</button><button disabled={loading} className={kind==='youtube'?'selected':''} onClick={()=>selectKind('youtube')}><Youtube size={16}/> YouTube</button></div><form onSubmit={submit}><label className="form-label">Source name<input disabled={loading} value={name} onChange={e=>setName(e.target.value)} placeholder={kind==='upload'?'Morning traffic recording':kind==='webcam'?'North gate camera':kind==='youtube'?'Downtown live camera':'Highway 1 eastbound'}/></label>{kind==='upload' ? <><div className={`file-drop ${file?'has-file':''} ${loading?'uploading':''}`} onClick={()=>!loading&&inputRef.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!loading)chooseFile(e.dataTransfer.files[0])}}><input ref={inputRef} type="file" accept="video/*,.mp4,.mov,.webm,.mkv,.avi" hidden disabled={loading} onChange={e=>chooseFile(e.target.files?.[0])}/><span className="upload-icon">{file?<Video size={20}/>:<CloudUpload size={20}/>}</span><strong>{file?file.name:'Choose a video file'}</strong><span>{file?`${formatBytes(file.size)} · ${file.type||'video file'}`:'MP4, MOV, WebM, MKV, or AVI'}</span><span className="file-browse">{loading?'Transfer in progress':'Browse files'}</span></div>{effectiveLimit!==null&&<div className="upload-limit">Maximum file size: <strong>{formatBytes(effectiveLimit)}</strong> <span>· set by the local API</span></div>}{!limitReady&&<div className="upload-limit">Checking the upload limit from the local API…</div>}{loading&&transfer&&<div className="upload-progress"><div className="upload-progress-label"><span>{transfer.finishing?'Transfer sent · validating on the server':'Uploading'} · {formatBytes(transfer.loaded)} of {formatBytes(file?.size??0)}</span><strong>{transfer.percent}%</strong></div><div className="upload-progress-track" role="progressbar" aria-label="Video upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={transfer.percent}><span style={{width:`${transfer.percent}%`}}/></div><small>The source appears after the server validates and saves the video.</small></div>}</> : kind==='stream' || kind==='youtube' ? <label className="form-label">{kind==='youtube'?'YouTube video URL':'Direct stream URL'}<input disabled={loading} value={url} onChange={e=>setUrl(e.target.value)} placeholder={kind==='youtube'?'https://www.youtube.com/watch?v=…':'https://… or rtsp://…'}/><small>{kind==='youtube'?'Public YouTube videos and live streams are supported. The preview updates with each analyzed frame.':'Browser preview depends on format. The local service handles supported analysis streams.'}</small></label> : <div className="webcam-explainer"><Camera size={18}/><span>Your browser will ask for camera permission when you turn on the preview. It will stay off until you start it.</span></div>}{error&&<div className="form-error"><X size={14}/>{error}</div>}<div className="modal-actions">{loading&&kind==='upload'?<button className="button button-danger-quiet" type="button" onClick={cancelUpload}>Cancel upload</button>:<button className="button button-quiet" type="button" onClick={onClose}>Cancel</button>}<button className="button button-primary" type="submit" disabled={loading||(kind==='upload'&&!limitReady)}>{loading?transfer?'Uploading…':'Adding…':kind==='upload'?'Upload video':kind==='webcam'?'Add webcam':kind==='youtube'?'Add YouTube':'Add stream'}</button></div></form></section></div>
}
