import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { RefreshCw, Save, Settings2, Undo2 } from 'lucide-react'
import { api, type Source } from './api'
import { formatVideoDateTime, localDateTimeCandidates, localDateTimeInput } from './videoTime'

export function RecordingTimeEditor({ source, onSourceUpdated, dialogMode = false }: { source: Source; onSourceUpdated: (source: Source) => void; dialogMode?: boolean }) {
  const [open, setOpen] = useState(dialogMode)
  const [localStart, setLocalStart] = useState('')
  const [timeZone, setTimeZone] = useState('Asia/Jerusalem')
  const [selectedOffset, setSelectedOffset] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const changeBlocked = source.status === 'running'
  const candidates = useMemo(() => localStart ? localDateTimeCandidates(localStart, timeZone) : [], [localStart, timeZone])
  const recordingTime = source.recordingTime

  useEffect(() => {
    setLocalStart(localDateTimeInput(recordingTime?.effectiveStartAt, timeZone))
    setSelectedOffset('')
  }, [source.id, recordingTime?.effectiveStartAt, recordingTime?.embeddedStartAt])

  const updateSource = async (task: () => Promise<Source>, success: string) => {
    if (changeBlocked) { setError('Stop analysis before changing video date/time.'); return }
    setBusy(true); setMessage(''); setError('')
    try { const updated = await task(); onSourceUpdated(updated); setMessage(success) }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not update video date/time') }
    finally { setBusy(false) }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (changeBlocked) { setError('Stop analysis before changing video date/time.'); return }
    if (!localStart || !candidates.length) { setError('Choose a valid local date and time for the selected timezone.'); return }
    if (candidates.length > 1 && !candidates.some(candidate => candidate.iso === selectedOffset)) {
      setError('This local time occurs twice because of a clock change. Choose the intended UTC offset.'); return
    }
    const candidate = candidates.length === 1 ? candidates[0]! : candidates.find(item => item.iso === selectedOffset)!
    await updateSource(() => api.setRecordingTime(source.id, candidate.iso), 'Video date/time saved.')
  }

  const startLabel = formatVideoDateTime(recordingTime, 0)
  const sourceLabel = recordingTime?.provenance === 'manual_override'
    ? 'Manual correction'
    : recordingTime?.provenance === 'embedded_metadata'
      ? recordingTime.embeddedField === 'mvhd_creation_time' ? 'MP4 container creation time' : 'Embedded video metadata'
      : 'No date/time metadata found'

  return <section className="recording-time-editor" aria-label={`Video date and time for ${source.name}`}>
    <div className="recording-time-summary">
      <span><strong>Video date/time</strong><small>{startLabel ?? 'Unknown · elapsed video position only'}</small></span>
      {!dialogMode && <button type="button" className="recording-time-toggle" aria-expanded={open} onClick={() => { setOpen(value => !value); setMessage(''); setError('') }}><Settings2 size={13}/>{open ? 'Close' : 'Set / correct'}</button>}
    </div>
    <div className="recording-time-provenance">{sourceLabel}. Embedded container time may reflect an export date; it is not verified capture time.</div>
    {recordingTime?.provenance === 'manual_override' && recordingTime.embeddedStartAt && <div className="recording-time-original">Embedded value: {formatVideoDateTime({ effectiveStartAt: recordingTime.embeddedStartAt, provenance: 'embedded_metadata' })} (Asia/Jerusalem)</div>}
    {open && <div className="recording-time-controls">
      {changeBlocked && <small className="recording-time-help" role="status">Stop analysis before changing video date/time.</small>}
      {source.kind === 'upload' && <button type="button" className="recording-time-refresh" disabled={busy||changeBlocked} onClick={() => void updateSource(() => api.refreshSourceMetadata(source.id), 'Embedded metadata refreshed.')}><RefreshCw size={13}/> Refresh embedded metadata</button>}
      <form onSubmit={save}>
        <label>Video start date and time<input type="datetime-local" step="1" value={localStart} disabled={changeBlocked} onChange={event => { setLocalStart(event.target.value); setSelectedOffset(''); setError(''); setMessage('') }}/></label>
        <label>Timezone<select value={timeZone} disabled={changeBlocked} onChange={event => { setTimeZone(event.target.value); setSelectedOffset(''); setError(''); setMessage('') }}><option value="Asia/Jerusalem">Israel · Asia/Jerusalem</option><option value="UTC">UTC</option></select></label>
        {candidates.length > 1 && <label>Repeated local time<select value={selectedOffset} disabled={changeBlocked} onChange={event => setSelectedOffset(event.target.value)}><option value="">Choose the intended occurrence…</option>{candidates.map((candidate,index)=><option value={candidate.iso} key={candidate.iso}>{index===0?'Earlier':'Later'} occurrence · UTC{offsetLabel(candidate.offsetMinutes)}</option>)}</select></label>}
        {localStart && candidates.length === 0 && <small className="recording-time-help">This local time does not exist in that timezone, usually because clocks moved forward.</small>}
        {candidates.length > 1 && <small className="recording-time-help">This local time occurs twice. Select the matching UTC offset to avoid an ambiguous timestamp.</small>}
        <div className="recording-time-actions"><button type="submit" className="button button-primary" disabled={busy||changeBlocked||!localStart||!candidates.length||(candidates.length>1&&!selectedOffset)}><Save size={13}/> Save date/time</button>{recordingTime?.provenance==='manual_override'&&<button type="button" className="button button-quiet" disabled={busy||changeBlocked} onClick={()=>void updateSource(()=>api.setRecordingTime(source.id,null),'Restored embedded metadata.')}><Undo2 size={13}/> Revert to metadata</button>}</div>
      </form>
      {message&&<small className="recording-time-success" role="status">{message}</small>}{error&&<small className="recording-time-error" role="alert">{error}</small>}
    </div>}
  </section>
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '−' : '+'
  const absolute = Math.abs(minutes)
  return `${sign}${String(Math.floor(absolute/60)).padStart(2,'0')}:${String(absolute%60).padStart(2,'0')}`
}
