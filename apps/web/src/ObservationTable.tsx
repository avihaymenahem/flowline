import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Detection, TrafficEvent } from './api'
import { formatVideoDateTime, formatVideoPosition, type RecordingTime } from './videoTime'
import {
  vehicleColorKey,
  vehicleColorLabel,
  vehicleColorSwatch,
  vehicleTypeKey,
  vehicleTypeLabel,
} from './vehicleTypes'
import { compareNumeric, virtualObservationIndexes } from './observationTableUtils'
import { TrackInspector } from './TrackInspector'
import { callCurrent } from './currentCallback'
import './ObservationTable.css'

export type ObservationRow = { key: string; event: TrafficEvent; d: Detection }

export type ObservationTableProps = {
  rows: ObservationRow[]
  recordingTime?: RecordingTime
  sessionFilter: string
  sessions: Array<{ id: string; label: string }>
  onSessionFilter: (value: string) => void
  hasRecordsAcrossSessions: boolean
  classFilter: string
  colorFilter: string
  onClassFilter: (value: string) => void
  onColorFilter: (value: string) => void
  observedTypes: string[]
  observedColors: string[]
  sourceId: string
  onReport: (event: TrafficEvent, detectionIndex: number) => void
}
const VIRTUAL_OVERSCAN = 8

export function ObservationTable({
  rows,
  recordingTime,
  sessionFilter,
  sessions,
  onSessionFilter,
  hasRecordsAcrossSessions,
  classFilter,
  colorFilter,
  onClassFilter,
  onColorFilter,
  observedTypes,
  observedColors,
  sourceId,
  onReport,
}: ObservationTableProps) {
  const [inspectedTrack, setInspectedTrack] = useState<{ sessionId: string; trackId: string } | null>(null)
  const onReportRef = useRef(onReport)
  onReportRef.current = onReport
  const scrollElementRef = useRef<HTMLDivElement>(null)
  const [sorting, setSorting] = useState<SortingState>([{ id: 'sourceTimeMs', desc: true }])
  const columnFilters = useMemo(() => [
    ...(classFilter !== 'all' ? [{ id: 'class', value: classFilter }] : []),
    ...(colorFilter !== 'all' ? [{ id: 'color', value: colorFilter }] : []),
  ], [classFilter, colorFilter])
  const getRowId = useCallback((row: ObservationRow) => row.key, [])
  const rangeExtractor = useCallback((range: { count: number; startIndex: number; endIndex: number }) =>
    virtualObservationIndexes(range.count, range.startIndex, range.endIndex, VIRTUAL_OVERSCAN), [])
  const setSortingAndScroll = useCallback((updater: Parameters<typeof setSorting>[0]) => {
    setSorting(updater)
    scrollElementRef.current?.scrollTo({ top: 0 })
  }, [])
  useEffect(() => {
    scrollElementRef.current?.scrollTo({ top: 0 })
  }, [classFilter, colorFilter, sessionFilter])
  useEffect(() => { setInspectedTrack(null) }, [sourceId])
  const columns = useMemo<ColumnDef<ObservationRow>[]>(() => [
    ...(sessionFilter === 'all' ? [{
      id: 'session',
      accessorFn: (row: ObservationRow) => row.event.sessionId,
      header: 'Session',
      cell: (context: { row: { original: ObservationRow } }) => <span title={context.row.original.event.sessionId}>{context.row.original.event.sessionId.slice(0, 8)}</span>,
      sortingFn: 'alphanumeric' as const,
      size: 95,
    }] : []),
    {
      id: 'class',
      accessorFn: row => vehicleTypeKey(row.d.class),
      header: 'Type',
      cell: context => <span className="observation-class-chip"><i aria-hidden="true" />{vehicleTypeLabel(context.row.original.d.class)}</span>,
      filterFn: (row, _columnId, filterValue: string) => filterValue === 'all' || vehicleTypeKey(row.original.d.class) === filterValue,
      sortingFn: 'alphanumeric',
      size: 130,
    },
    {
      id: 'trackId',
      accessorFn: row => row.d.trackId ?? '',
      header: 'Track',
      cell: context => {
        const row = context.row.original
        return row.d.trackId
          ? <button type="button" className="observation-action-link" aria-label={`Inspect track ${row.d.trackId} from this analysis session`} onClick={() => setInspectedTrack({ sessionId: row.event.sessionId, trackId: row.d.trackId! })}>{row.d.trackId}</button>
          : '—'
      },
      size: 90,
    },
    {
      id: 'review',
      header: 'Review',
      enableSorting: false,
      cell: context => {
        const row = context.row.original
        const eligible = !!row.event.id && row.event.frameWidth > 0 && row.event.frameHeight > 0
        return <button type="button" className="button button-quiet observation-report-action" disabled={!eligible} title={eligible ? 'Open a report for this exact saved event and detection' : 'This event is missing a stable ID or frame dimensions'} onClick={() => callCurrent(onReportRef, row.event, row.event.detections.indexOf(row.d))}>Report</button>
      },
      size: 90,
    },
    {
      id: 'color',
      accessorFn: row => vehicleColorKey(row.d.color),
      header: 'Estimated color',
      cell: context => {
        const detection = context.row.original.d
        const color = detection.color
        const label = vehicleColorKey(color) === 'unknown'
          ? 'Too little or mixed color information'
          : 'Estimated from image; lighting or glare can affect color'
        return <span className="observation-color-chip" title={label} aria-label={label}><i style={{ backgroundColor: vehicleColorSwatch(color) }} aria-hidden="true" />{vehicleColorLabel(color)}</span>
      },
      filterFn: (row, _columnId, filterValue: string) => filterValue === 'all' || vehicleColorKey(row.original.d.color) === filterValue,
      size: 150,
    },
    {
      id: 'confidence',
      accessorFn: row => row.d.confidence,
      header: 'Model score',
      cell: context => `${Math.round(context.getValue<number>() * 100)}%`,
      sortingFn: (rowA, rowB, columnId) => compareNumeric(rowA.getValue<number>(columnId), rowB.getValue<number>(columnId)),
      size: 110,
    },
    {
      id: 'position',
      accessorFn: row => row.d.bbox,
      header: 'Frame position',
      cell: context => {
        const { x, y } = context.getValue<Detection['bbox']>()
        return `${Math.round(x * 100)}%, ${Math.round(y * 100)}%`
      },
      enableSorting: false,
      size: 140,
    },
    {
      id: 'sourceTimeMs',
      accessorFn: row => row.event.sourceTimeMs,
      header: 'Video date/time',
      cell: context => {
        const sourceTimeMs = context.getValue<number>()
        const absolute = formatVideoDateTime(recordingTime, sourceTimeMs)
        const provenance = recordingTime?.provenance === 'embedded_metadata'
          ? 'Embedded container metadata; it may reflect an export date and is not verified capture time.'
          : recordingTime ? 'Manual video-time origin.' : 'No video date/time metadata is available.'
        return <span className="observation-video-time" title={provenance}><strong>{absolute ?? 'Date/time unknown'}</strong><small>Video position {formatVideoPosition(sourceTimeMs)}</small></span>
      },
      sortingFn: (rowA, rowB, columnId) => compareNumeric(rowA.getValue<number>(columnId), rowB.getValue<number>(columnId)),
      size: 175,
    },
  ], [sessionFilter, recordingTime])
  const getScrollElement = useCallback(() => scrollElementRef.current, [])

  const table = useReactTable({
    data: rows,
    columns,
    state: {
      sorting,
      columnFilters,
    },
    onSortingChange: setSortingAndScroll,
    autoResetPageIndex: false,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })
  const tableRows = table.getRowModel().rows
  const getVirtualItemKey = useCallback((index: number) => tableRows[index]?.id ?? index, [tableRows])
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement,
    estimateSize: () => 42,
    overscan: VIRTUAL_OVERSCAN,
    rangeExtractor,
    getItemKey: getVirtualItemKey,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const activeFilters = classFilter !== 'all' || colorFilter !== 'all'

  return <section className="observation-table-section" aria-label="Detection records">
    <div className="observation-table-toolbar">
      <div>
        <h2>Detection records</h2>
        <p>{rows.length.toLocaleString()} observations · {tableRows.length.toLocaleString()} shown</p>
      </div>
      <div className="observation-table-controls">
        <label>Session
          <select aria-label="Filter by analysis session" value={sessionFilter} onChange={event => onSessionFilter(event.target.value)}>
            <option value="latest">Latest session</option>
            <option value="all">All sessions</option>
            {sessions.map(session => <option value={session.id} key={session.id}>{session.label}</option>)}
          </select>
        </label>
        <label>Type
          <select aria-label="Filter by detected vehicle type" value={classFilter} onChange={event => onClassFilter(event.target.value)}>
            <option value="all">All types</option>
            {observedTypes.map(type => <option value={type} key={type}>{vehicleTypeLabel(type)}</option>)}
          </select>
        </label>
        <label>Color
          <select aria-label="Filter by estimated vehicle color" value={colorFilter} onChange={event => onColorFilter(event.target.value)}>
            <option value="all">All colors</option>
            {observedColors.map(color => <option value={color} key={color}>{vehicleColorLabel(color)}</option>)}
          </select>
        </label>
        {activeFilters && <button className="observation-clear-filters" type="button" onClick={() => { onClassFilter('all'); onColorFilter('all') }}>Clear filters</button>}
      </div>
    </div>
    <p className="observation-export-scope">Filters change this view only. Exports include all loaded observations.</p>
    {tableRows.length ? <div ref={scrollElementRef} className="observation-virtual-scroll" role="region" aria-label="Scrollable detection records" tabIndex={0}>
      <table className="observation-virtual-table" style={{ minWidth: sessionFilter === 'all' ? '935px' : '840px' }}>
        <thead>
          {table.getHeaderGroups().map(headerGroup => <tr key={headerGroup.id}>
            {headerGroup.headers.map(header => {
              const sorted = header.column.getIsSorted()
              const canSort = header.column.getCanSort()
              return <th key={header.id} style={{ width: header.getSize() }} aria-sort={sorted ? sorted === 'asc' ? 'ascending' : 'descending' : 'none'}>
                {canSort ? <button type="button" onClick={header.column.getToggleSortingHandler()} className="observation-sort-button">
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  <span aria-hidden="true">{sorted === 'asc' ? ' ↑' : sorted === 'desc' ? ' ↓' : ' ↕'}</span>
                </button> : flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            })}
          </tr>)}
        </thead>
        <tbody>
          {virtualItems[0]?.start ? <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: `${virtualItems[0].start}px`, padding: 0, border: 0 }} /></tr> : null}
          {virtualItems.map(virtualRow => {
            const row = tableRows[virtualRow.index]!
            return <tr key={row.id} data-index={virtualRow.index} ref={virtualizer.measureElement} style={{ height: `${virtualRow.size}px` }}>
              {row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
            </tr>
          })}
          {virtualItems.length && virtualizer.getTotalSize() > (virtualItems.at(-1)?.end ?? 0) ? <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: `${virtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0)}px`, padding: 0, border: 0 }} /></tr> : null}
        </tbody>
      </table>
    </div> : <div className="observation-table-empty" role="status">
      {rows.length ? <><strong>No observations match these filters</strong><span>Clear the filters to show all loaded observations.</span><button type="button" onClick={() => { onClassFilter('all'); onColorFilter('all') }}>Clear filters</button></> : hasRecordsAcrossSessions ? <><strong>No detections in this session</strong><span>Choose another session to review its observations.</span></> : <><strong>No observations yet</strong><span>Start a source with an available analysis worker to see detections here.</span></>}
    </div>}
    {inspectedTrack && <div className="accuracy-observations-track-panel"><TrackInspector sourceId={sourceId} sessionId={inspectedTrack.sessionId} trackId={inspectedTrack.trackId} onClose={() => setInspectedTrack(null)}/></div>}
  </section>
}
