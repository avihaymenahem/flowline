const labels: Record<string, string> = {
  car: 'Car',
  truck: 'Truck',
  bus: 'Bus',
  motorcycle: 'Motorcycle',
  bicycle: 'Bicycle',
}
const colorSwatches: Record<string, string> = {
  black: '#313941', blue: '#5d8ec3', gray: '#969fa7', green: '#5da77d', orange: '#dc9654',
  pink: '#cb79a4', purple: '#9272b5', red: '#d66059', white: '#edf0f1', yellow: '#d8b94f', unknown: '#aeb8c1',
}

export function vehicleTypeKey(className: string): string {
  return className.trim().toLowerCase()
}

export function vehicleTypeLabel(className: string): string {
  const key = vehicleTypeKey(className)
  return labels[key] ?? key.replace(/\b\w/g, character => character.toUpperCase())
}

export function countByVehicleType(detections: Array<{ class: string }>): Array<{ key: string; label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const detection of detections) {
    const key = vehicleTypeKey(detection.class)
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([key, count]) => ({ key, label: vehicleTypeLabel(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export function vehicleColorKey(color?: string | null): string {
  return color?.trim().toLowerCase() || 'unknown'
}

export function vehicleColorLabel(color?: string | null): string {
  const key = vehicleColorKey(color)
  return key === 'unknown' ? 'Unknown' : key.replace(/\b\w/g, character => character.toUpperCase())
}

export function vehicleColorSwatch(color?: string | null): string {
  return colorSwatches[vehicleColorKey(color)] ?? colorSwatches.unknown
}

export function countByVehicleColor(detections: Array<{ color?: string | null }>): Array<{ key: string; label: string; swatch: string; count: number }> {
  const counts = new Map<string, number>()
  for (const detection of detections) {
    const key = vehicleColorKey(detection.color)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([key, count]) => ({ key, label: vehicleColorLabel(key), swatch: vehicleColorSwatch(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}
