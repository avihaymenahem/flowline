import type { SourcePreview, TrafficEvent } from './api'

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

export function youtubePreviewErrorMessage(input: { sourceStatus: string; sourceError?: string; requestError?: string; previewAvailable: boolean }): string {
  if (input.requestError) return input.requestError
  if (input.sourceStatus === 'error' && !input.previewAvailable) return input.sourceError ?? ''
  return ''
}

export function sourceMessage(messages: Readonly<Record<string, string>>, sourceId: string): string {
  return messages[sourceId] ?? ''
}

export function updateSourceMessage(messages: Readonly<Record<string, string>>, sourceId: string, text: string): Record<string, string> {
  return { ...messages, [sourceId]: text }
}

export function youtubeVideoIdFromUrl(raw: string): string | null {
  let url: URL
  const normalized = raw.trim()
  try { url = new URL(normalized) } catch { return null }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const authority = normalized.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1]
  if (!authority || authority.includes('@') || authority.includes(':') || url.username || url.password || url.port) return null
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  let id: string | null = null
  if (host === 'youtu.be') {
    const parts = url.pathname.split('/').filter(Boolean)
    id = parts.length === 1 ? parts[0]! : null
  }
  else if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
    if (url.pathname === '/watch') {
      const ids = url.searchParams.getAll('v')
      id = ids.length === 1 ? ids[0]! : null
    }
    else {
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length === 2 && parts[0] === 'live') id = parts[1]!
    }
  }
  return id && VIDEO_ID.test(id) ? id : null
}

export function previewMatchesEvent(preview: SourcePreview | null, event: TrafficEvent | undefined, sourceId: string): boolean {
  return !!preview && !!event && preview.sourceId === sourceId && event.sourceId === sourceId &&
    preview.sessionId === event.sessionId && preview.sourceTimeMs === event.sourceTimeMs
}

export function matchingPreviewEvent(preview: SourcePreview | null, events: TrafficEvent[], sourceId: string, sessionId?: string): TrafficEvent | undefined {
  if (!preview || !sessionId || preview.sourceId !== sourceId || preview.sessionId !== sessionId) return undefined
  return events.find(event => event.sourceId === sourceId && event.sessionId === sessionId && event.sourceTimeMs === preview.sourceTimeMs)
}

export function youtubeFrameReadyForAnnotation(input: {
  sourceId: string
  sourceStatus: string
  imageComplete: boolean
  imageSourceMatches: boolean
  imageWidth: number
  imageHeight: number
  loadedPreview: SourcePreview | null
  frameCandidate: SourcePreview | null
}): boolean {
  const { sourceId, sourceStatus, imageComplete, imageSourceMatches, imageWidth, imageHeight, loadedPreview, frameCandidate } = input
  return sourceStatus !== 'running' && imageComplete && imageSourceMatches && !!loadedPreview && !!frameCandidate &&
    loadedPreview.sourceId === sourceId && frameCandidate.sourceId === sourceId &&
    loadedPreview.sessionId === frameCandidate.sessionId && loadedPreview.frameId === frameCandidate.frameId &&
    loadedPreview.sourceTimeMs === frameCandidate.sourceTimeMs &&
    imageWidth === loadedPreview.width && imageHeight === loadedPreview.height
}
