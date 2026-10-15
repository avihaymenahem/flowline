import type { TrafficEvent } from './api'

export const MAX_CLIENT_EVENT_RECORDS = 500

export function recentEventWindow<T>(events: T[], limit = MAX_CLIENT_EVENT_RECORDS): { events: T[]; omitted: number } {
  const boundedLimit = Math.max(0, Math.floor(limit))
  const omitted = Math.max(0, events.length - boundedLimit)
  return { events: omitted ? events.slice(omitted) : events, omitted }
}

export function appendRecentEvent<T extends { id?: string }>(events: T[], event: T, limit = MAX_CLIENT_EVENT_RECORDS): { events: T[]; omitted: number; duplicate: boolean } {
  if (event.id && events.some(existing => existing.id === event.id)) return { events, omitted: 0, duplicate: true }
  const result = recentEventWindow([...events, event], limit)
  return { ...result, duplicate: false }
}
export function mergeRecentEventHistory(history: TrafficEvent[], realtime: TrafficEvent[], limit = MAX_CLIENT_EVENT_RECORDS): { events: TrafficEvent[]; omitted: number } {
  const merged = new Map<string, TrafficEvent>()
  for (const event of [...history, ...realtime]) {
    const key = event.id ?? `${event.sourceId}:${event.sessionId}:${event.sourceTimeMs}:${event.type}`
    merged.set(key, event)
  }
  return recentEventWindow([...merged.values()], limit)
}
