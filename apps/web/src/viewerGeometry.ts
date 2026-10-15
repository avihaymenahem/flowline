import type { ContainRect } from './overlayGeometry'

export type ViewerBounds = { left: number; top: number; width: number; height: number }

export function clampViewerPan(panX: number, panY: number, zoom: number, bounds: Pick<ViewerBounds, 'width' | 'height'>, imageRect: ContainRect): { x: number; y: number } {
  const scale = Math.max(1, zoom)
  const maxX = Math.max(0, (scale * bounds.width * imageRect.width - bounds.width) / 2)
  const maxY = Math.max(0, (scale * bounds.height * imageRect.height - bounds.height) / 2)
  return { x: Math.max(-maxX, Math.min(maxX, panX)), y: Math.max(-maxY, Math.min(maxY, panY)) }
}

export function zoomViewerAtPoint(currentZoom: number, nextZoom: number, panX: number, panY: number, pointX: number, pointY: number, bounds: Pick<ViewerBounds, 'width' | 'height'>, imageRect: ContainRect): { x: number; y: number } {
  const oldZoom = Math.max(1, currentZoom)
  const zoom = Math.max(1, Math.min(8, nextZoom))
  const offsetX = pointX - bounds.width / 2
  const offsetY = pointY - bounds.height / 2
  const ratio = zoom / oldZoom
  return clampViewerPan(panX * ratio + offsetX * (1 - ratio), panY * ratio + offsetY * (1 - ratio), zoom, bounds, imageRect)
}

export function pinchViewerPan(currentZoom: number, nextZoom: number, panX: number, panY: number, startPoint: { x: number; y: number }, nextPoint: { x: number; y: number }, bounds: Pick<ViewerBounds, 'width' | 'height'>, imageRect: ContainRect): { x: number; y: number } {
  const oldZoom = Math.max(1, currentZoom)
  const zoom = Math.max(1, Math.min(8, nextZoom))
  const anchoredX = (startPoint.x - bounds.width / 2 - panX) / oldZoom
  const anchoredY = (startPoint.y - bounds.height / 2 - panY) / oldZoom
  return clampViewerPan(nextPoint.x - bounds.width / 2 - anchoredX * zoom, nextPoint.y - bounds.height / 2 - anchoredY * zoom, zoom, bounds, imageRect)
}

export function viewerPointToImage(clientX: number, clientY: number, bounds: ViewerBounds, zoom: number, panX: number, panY: number, imageRect: ContainRect): { x: number; y: number } | null {
  if (!(bounds.width > 0 && bounds.height > 0 && zoom > 0)) return null
  const stageX = (clientX - bounds.left - bounds.width / 2 - panX) / zoom + bounds.width / 2
  const stageY = (clientY - bounds.top - bounds.height / 2 - panY) / zoom + bounds.height / 2
  const left = bounds.width * imageRect.left
  const top = bounds.height * imageRect.top
  const width = bounds.width * imageRect.width
  const height = bounds.height * imageRect.height
  const x = (stageX - left) / width
  const y = (stageY - top) / height
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y }
}
