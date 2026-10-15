export type CameraLocation = { latitude: number; longitude: number; label?: string }

export type CameraLocationInput = { latitude: string; longitude: string; label: string }

export function parseCameraLocationInput(input: CameraLocationInput): { location: CameraLocation } | { error: string } {
  const latitudeText = input.latitude.trim()
  const longitudeText = input.longitude.trim()
  if (!latitudeText || !longitudeText) return { error: 'Enter both latitude and longitude.' }
  const latitude = Number(latitudeText)
  const longitude = Number(longitudeText)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return { error: 'Latitude must be a number from -90 to 90.' }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return { error: 'Longitude must be a number from -180 to 180.' }
  const label = input.label.trim()
  if (label.length > 120) return { error: 'Location label must be 120 characters or fewer.' }
  return { location: { latitude, longitude, ...(label ? { label } : {}) } }
}

const MAP_LATITUDE_LIMIT = 85.05112878
const MIN_LONGITUDE_SPAN = 0.008
const MIN_LATITUDE_SPAN = 0.006

export type LocationMapBounds = { south: number; west: number; north: number; east: number }

export function normalizeLongitude(longitude: number) {
  const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180
  return wrapped === -180 && longitude > 0 ? 180 : wrapped
}

export function longitudeOnVisibleWorldCopy(longitude: number, mapCenterLongitude: number, preferredCopyLongitude = mapCenterLongitude) {
  const wrapped = normalizeLongitude(longitude)
  return wrapped + 360 * Math.round((preferredCopyLongitude - wrapped) / 360)
}

export function locationMapBounds(locations: readonly CameraLocation[]): LocationMapBounds | null {
  if (!locations.length) return null
  const latitudes = locations.map(location => Math.max(-MAP_LATITUDE_LIMIT, Math.min(MAP_LATITUDE_LIMIT, location.latitude)))
  const south = Math.max(-MAP_LATITUDE_LIMIT, Math.min(...latitudes))
  const north = Math.max(-MAP_LATITUDE_LIMIT, Math.max(...latitudes))
  const longitudes = locations.map(location => normalizeLongitude(location.longitude)).sort((a, b) => a - b)
  let largestGap = -1
  let west = longitudes[0]!
  let east = longitudes[longitudes.length - 1]!
  for (let index = 0; index < longitudes.length; index++) {
    const current = longitudes[index]!
    const next = index === longitudes.length - 1 ? longitudes[0]! + 360 : longitudes[index + 1]!
    const gap = next - current
    if (gap > largestGap) {
      largestGap = gap
      west = index === longitudes.length - 1 ? longitudes[0]! : longitudes[index + 1]!
      east = current < west ? current + 360 : current
    }
  }
  const longitudeSpan = east - west
  const latitudeSpan = north - south
  if (longitudeSpan < MIN_LONGITUDE_SPAN) {
    const center = west + longitudeSpan / 2
    west = center - MIN_LONGITUDE_SPAN / 2
    east = center + MIN_LONGITUDE_SPAN / 2
  }
  let boundedSouth = south
  let boundedNorth = north
  if (latitudeSpan < MIN_LATITUDE_SPAN) {
    const center = (south + north) / 2
    boundedSouth = Math.max(-MAP_LATITUDE_LIMIT, center - MIN_LATITUDE_SPAN / 2)
    boundedNorth = Math.min(MAP_LATITUDE_LIMIT, center + MIN_LATITUDE_SPAN / 2)
  }
  return { south: boundedSouth, west, north: boundedNorth, east }
}
