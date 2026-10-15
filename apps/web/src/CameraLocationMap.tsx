import { useEffect, useMemo, useRef } from 'react'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Source } from './api'
import { locationMapBounds, longitudeOnVisibleWorldCopy, normalizeLongitude, type CameraLocation } from './cameraLocation'

type LocatedSource = Pick<Source, 'id' | 'name' | 'location'>
const cameraPinIcon = L.divIcon({
  className: 'camera-location-marker',
  html: '<svg viewBox="0 0 32 40" width="32" height="40" aria-hidden="true"><path d="M16 1.5C7.9 1.5 1.5 7.8 1.5 15.7c0 10.1 14.5 22.6 14.5 22.6s14.5-12.5 14.5-22.6C30.5 7.8 24.1 1.5 16 1.5Z" fill="#128e8a" stroke="#fff" stroke-width="2.5"/><circle cx="16" cy="15.5" r="5.2" fill="#fff"/></svg>',
  iconSize: [32, 40],
  iconAnchor: [16, 39],
  popupAnchor: [0, -35],
})

export function CameraLocationMap({ sources, onSelect, compact = false }: { sources: LocatedSource[]; onSelect: (sourceId: string) => void; compact?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const pinsLayerRef = useRef<L.LayerGroup | null>(null)
  const onSelectRef = useRef(onSelect)
  const previousGeometryRef = useRef('')
  onSelectRef.current = onSelect

  const locatedSources = useMemo(() => sources.filter(source => source.location), [sources])
  const geometryKey = JSON.stringify(locatedSources.map(source => [source.id, source.location!.latitude, source.location!.longitude]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  const markerKey = JSON.stringify(locatedSources.map(source => [source.id, source.name, source.location!.latitude, source.location!.longitude, source.location!.label ?? '']).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  const bounds = locationMapBounds(locatedSources.map(source => source.location!))

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const map = L.map(host, { scrollWheelZoom: false, zoomControl: true, keyboard: true })
    map.setView([0, 0], 2)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(map)
    const pins = L.layerGroup().addTo(map)
    mapRef.current = map
    pinsLayerRef.current = pins
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => map.invalidateSize({ pan: false })))
    resizeObserver.observe(host)
    return () => {
      resizeObserver.disconnect()
      map.remove()
      mapRef.current = null
      pinsLayerRef.current = null
      previousGeometryRef.current = ''
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layer = pinsLayerRef.current
    if (!map || !layer) return
    const geometryChanged = previousGeometryRef.current !== geometryKey
    const center = bounds && geometryChanged ? (bounds.west + bounds.east) / 2 : map.getCenter().lng
    layer.clearLayers()
    for (const source of locatedSources) {
      const location = source.location!
      const longitude = location.longitude + 360 * Math.round((center - location.longitude) / 360)
      const marker = L.marker([location.latitude, longitude], { icon: cameraPinIcon, title: `${source.name} location`, alt: `${source.name} location` }).addTo(layer)
      const popup = document.createElement('div')
      popup.className = 'camera-map-popup'
      const title = document.createElement('strong')
      title.textContent = source.name
      popup.append(title)
      if (location.label) {
        const detail = document.createElement('span')
        detail.textContent = location.label
        popup.append(detail)
      }
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'camera-map-popup-action'
      open.textContent = 'Open Live monitor'
      open.addEventListener('click', () => onSelectRef.current(source.id))
      popup.append(open)
      marker.bindPopup(popup, { closeButton: true, autoPan: true })
    }
    previousGeometryRef.current = geometryKey
  }, [geometryKey, markerKey])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !bounds) return
    map.fitBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]], {
      padding: compact ? [12, 12] : [28, 28],
      maxZoom: compact ? 15 : 16,
      animate: false,
    })
  }, [compact, geometryKey])

  return <div ref={hostRef} className={`camera-location-leaflet${compact ? ' compact' : ' overview'}`} role="application" aria-label={compact ? 'Map of the selected source location' : 'Map of saved source locations'} />
}

export function CameraLocationPicker({ location, onPick }: { location: CameraLocation | null; onPick: (location: Pick<CameraLocation, 'latitude' | 'longitude'>) => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  const onPickRef = useRef(onPick)
  const preferredCopyLongitudeRef = useRef<number | null>(null)
  onPickRef.current = onPick
  const locationRef = useRef(location)
  locationRef.current = location

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const initial = locationRef.current
    const map = L.map(host, { scrollWheelZoom: false, zoomControl: true, keyboard: true, worldCopyJump: true })
      .setView(initial ? [initial.latitude, initial.longitude] : [31.5, 34.8], initial ? 13 : 7)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(map)
    const placePin = (latitude: number, longitude: number) => {
      if (!markerRef.current) markerRef.current = L.marker([latitude, longitude], { icon: cameraPinIcon, title: 'Selected camera location', alt: 'Selected camera location', keyboard: true }).addTo(map)
      else markerRef.current.setLatLng([latitude, longitude])
    }
    if (initial) placePin(initial.latitude, initial.longitude)
    const handleMapClick = (event: L.LeafletMouseEvent) => {
      const picked = { latitude: event.latlng.lat, longitude: normalizeLongitude(event.latlng.wrap().lng) }
      preferredCopyLongitudeRef.current = event.latlng.lng
      placePin(picked.latitude, event.latlng.lng)
      onPickRef.current(picked)
    }
    map.on('click', handleMapClick)
    mapRef.current = map
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => map.invalidateSize({ pan: false })))
    resizeObserver.observe(host)
    return () => {
      resizeObserver.disconnect()
      map.remove()
      mapRef.current = null
      markerRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (location) {
      if (!markerRef.current) markerRef.current = L.marker([location.latitude, location.longitude], { icon: cameraPinIcon, title: 'Selected camera location', alt: 'Selected camera location', keyboard: true }).addTo(map)
      else markerRef.current.setLatLng([location.latitude, longitudeOnVisibleWorldCopy(location.longitude, map.getCenter().lng, preferredCopyLongitudeRef.current ?? map.getCenter().lng)])
      preferredCopyLongitudeRef.current = null
    } else if (markerRef.current) {
      markerRef.current.remove()
      markerRef.current = null
    }
  }, [location?.latitude, location?.longitude])

  const showSelectedPin = () => {
    const map = mapRef.current
    if (!map || !location) return
    const longitude = longitudeOnVisibleWorldCopy(location.longitude, map.getCenter().lng)
    preferredCopyLongitudeRef.current = null
    map.setView([location.latitude, longitude], Math.max(map.getZoom(), 12))
    markerRef.current?.setLatLng([location.latitude, longitude])
  }

  const showWorld = () => {
    const map = mapRef.current
    if (!map) return
    preferredCopyLongitudeRef.current = null
    map.setView([20, 0], 1)
    if (location && markerRef.current) {
      const longitude = longitudeOnVisibleWorldCopy(location.longitude, map.getCenter().lng)
      markerRef.current.setLatLng([location.latitude, longitude])
    }
  }

  return <div className="camera-location-picker-wrap">
    <div ref={hostRef} className="camera-location-picker" role="application" aria-label="Interactive map for choosing a camera location" />
    <button type="button" className="camera-location-world-button" title="Zoom out to a world view" onClick={showWorld}>World view</button>
    {location && <button type="button" className="camera-location-show-pin-button" onClick={showSelectedPin}>Show selected pin</button>}
  </div>
}
