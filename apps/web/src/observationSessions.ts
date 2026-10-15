import type { TrafficEvent } from './api'

export type ObservationSessionOption = { id: string; label: string }

export function observationSessionOptions(events: TrafficEvent[], latestSessionId?: string): ObservationSessionOption[] {
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.sessionId, (counts.get(event.sessionId) ?? 0) + 1)
  const orderedIds = [...new Set([...events].reverse().map(event => event.sessionId))]
  if (latestSessionId && !orderedIds.includes(latestSessionId)) orderedIds.unshift(latestSessionId)
  if (latestSessionId) {
    orderedIds.splice(orderedIds.indexOf(latestSessionId), 1)
    orderedIds.unshift(latestSessionId)
  }
  return orderedIds.map(id => ({ id, label: `Session ${id.slice(0, 8)} · ${counts.get(id) ?? 0} records${id === latestSessionId ? ' (current)' : ''}` }))
}

export function filterObservationEvents(events: TrafficEvent[], sessionFilter: string, latestSessionId?: string): TrafficEvent[] {
  if (sessionFilter === 'all') return events
  const sessionId = sessionFilter === 'latest' ? latestSessionId : sessionFilter
  return sessionId ? events.filter(event => event.sessionId === sessionId) : []
}
