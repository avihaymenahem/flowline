import { useEffect, useState } from 'react'
import { MapPin } from 'lucide-react'
import type { Source } from './api'
import { CameraLocationMap } from './CameraLocationMap'

export function OverviewLocationMap({ sources, selectedId, onSelect, onAdd }: { sources: Source[]; selectedId: string | null; onSelect: (sourceId: string) => void; onAdd: () => void }) {
  const locatedSources = sources.filter(source => source.location)
  const sourcesWithoutLocation = sources.filter(source => !source.location)
  const preferredTargetId = sourcesWithoutLocation.find(source => source.id === selectedId)?.id ?? sourcesWithoutLocation[0]?.id ?? ''
  const [targetId, setTargetId] = useState(preferredTargetId)
  useEffect(() => {
    if (!sourcesWithoutLocation.some(source => source.id === targetId)) setTargetId(preferredTargetId)
  }, [preferredTargetId, sourcesWithoutLocation, targetId])

  return <section className="panel overview-location-panel" aria-labelledby="overview-location-title">
    <div className="panel-heading"><div><h2 id="overview-location-title">Camera locations</h2><p>{locatedSources.length ? `${locatedSources.length} saved source location${locatedSources.length === 1 ? '' : 's'}` : 'No locations have been saved yet'}</p></div></div>
    {locatedSources.length ? <>
      <CameraLocationMap sources={locatedSources} onSelect={onSelect}/>
      {sourcesWithoutLocation.length > 0 && <div className="overview-location-footer"><span>{sourcesWithoutLocation.length} source{sourcesWithoutLocation.length === 1 ? '' : 's'} without a saved location</span><div><select aria-label="Choose a source to set its location" value={targetId} onChange={event => setTargetId(event.target.value)}>{sourcesWithoutLocation.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select><button type="button" className="button button-quiet" onClick={() => targetId && onSelect(targetId)}>Set location</button></div></div>}
    </> : <div className="overview-location-empty">
      <MapPin size={22}/>
      <p>No camera pins are shown until you save a location.</p>
      {sources.length ? <><label>Choose a source<select aria-label="Choose a source to set its location" value={targetId} onChange={event => setTargetId(event.target.value)}>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label><button type="button" className="button button-primary" onClick={() => targetId && onSelect(targetId)} disabled={!targetId}>Set location on Live</button></> : <button type="button" className="button button-primary" onClick={onAdd}>Add a video source</button>}
    </div>}
  </section>
}
