import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MapPin, Pencil, Plus, Trash2 } from 'lucide-react'
import { api, type Source } from './api'
import { parseCameraLocationInput } from './cameraLocation'
import { CameraLocationMap, CameraLocationPicker } from './CameraLocationMap'

export function CameraLocationCard({ source, onSaved, onSelect }: { source: Source; onSaved: (source: Source) => void; onSelect: (sourceId: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const requestGeneration = useRef(0)
  const currentSourceId = useRef(source.id)
  currentSourceId.current = source.id
  const location = source.location
  const parsedDraftCoordinates = parseCameraLocationInput({ latitude, longitude, label: '' })
  const draftLocation = 'location' in parsedDraftCoordinates ? parsedDraftCoordinates.location : null

  useEffect(() => {
    requestGeneration.current++
    setEditing(false)
    setBusy(false)
    setError('')
    setLatitude(location ? String(location.latitude) : '')
    setLongitude(location ? String(location.longitude) : '')
    setLabel(location?.label ?? '')
    return () => { requestGeneration.current++ }
  }, [source.id, location?.latitude, location?.longitude, location?.label])

  const beginEdit = () => {
    setLatitude(location ? String(location.latitude) : '')
    setLongitude(location ? String(location.longitude) : '')
    setLabel(location?.label ?? '')
    setError('')
    setEditing(true)
  }
  const persist = async (nextLocation: Source['location'] | null, requestedId: string, request: number) => {
    setBusy(true)
    setError('')
    try {
      const updated = await api.setSourceLocation(requestedId, nextLocation ?? null)
      if (updated.id !== requestedId) {
        if (request === requestGeneration.current && currentSourceId.current === requestedId) setError('The server returned a different source for this location.')
        return
      }
      onSaved(updated)
      if (request !== requestGeneration.current || currentSourceId.current !== requestedId) return
      setEditing(false)
    } catch (reason) {
      if (request === requestGeneration.current && currentSourceId.current === requestedId) setError(reason instanceof Error ? reason.message : 'Could not save this location.')
    } finally {
      if (request === requestGeneration.current && currentSourceId.current === requestedId) setBusy(false)
    }
  }
  const save = (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseCameraLocationInput({ latitude, longitude, label })
    if ('error' in parsed) { setError(parsed.error); return }
    const id = source.id
    void persist(parsed.location, id, ++requestGeneration.current)
  }
  const clear = () => {
    if (!location || busy) return
    void persist(null, source.id, ++requestGeneration.current)
  }
  const cancel = () => {
    if (busy) return
    setEditing(false)
    setError('')
  }

  return <section className="panel camera-location-panel" aria-labelledby="camera-location-title">
    <div className="panel-heading camera-location-heading"><div><h2 id="camera-location-title">Camera location</h2><p>{location?.label || (location ? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}` : 'No location saved')}</p></div>{!editing && !busy && <button type="button" className="button button-quiet camera-location-edit" onClick={beginEdit} aria-label={`${location ? 'Edit' : 'Set'} location for ${source.name}`}>{location ? <Pencil size={13}/> : <Plus size={14}/>} {location ? 'Edit' : 'Set location'}</button>}</div>
    {editing ? <form className="camera-location-form" onSubmit={save}>
      <p className="camera-location-picker-instructions">Click or tap the map to place the pin. Drag to pan and use the zoom controls to find the camera.</p>
      <CameraLocationPicker location={draftLocation} onPick={picked => { setLatitude(picked.latitude.toFixed(6)); setLongitude(picked.longitude.toFixed(6)); setError('') }}/>
      <details className="camera-location-coordinate-details"><summary>Enter coordinates instead</summary><div className="camera-location-coordinates"><label>Latitude<input inputMode="decimal" type="number" step="any" min="-90" max="90" value={latitude} onChange={event => setLatitude(event.target.value)} placeholder="e.g. 40.7128" aria-label="Latitude" /></label><label>Longitude<input inputMode="decimal" type="number" step="any" min="-180" max="180" value={longitude} onChange={event => setLongitude(event.target.value)} placeholder="e.g. -74.0060" aria-label="Longitude" /></label></div></details>
      <label className="camera-location-label">Location label <span>Optional</span><input type="text" maxLength={120} value={label} onChange={event => setLabel(event.target.value)} placeholder="e.g. North entrance" aria-label="Location label" /></label>
      {error && <div className="camera-location-error" role="alert">{error}</div>}
      <div className="camera-location-actions"><button type="submit" className="button button-primary" disabled={busy || !draftLocation}>{busy ? 'Saving…' : 'Save location'}</button><button type="button" className="button button-quiet" onClick={cancel} disabled={busy}>Cancel</button></div>
    </form> : location ? <>
      <CameraLocationMap sources={[source]} onSelect={onSelect} compact/>
      <div className="camera-location-footer"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a><span>Map not loading? Select the marker to open this source.</span></div>
      {error && <div className="camera-location-error" role="alert">{error}</div>}
      <div className="camera-location-clear-row"><button type="button" className="camera-location-clear" onClick={clear} disabled={busy}><Trash2 size={12}/>{busy ? 'Saving…' : 'Clear saved location'}</button></div>
    </> : <div className="camera-location-empty"><MapPin size={17}/><span>Set this source’s location to see it on the map.</span></div>}
  </section>
}
