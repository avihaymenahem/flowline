export type ScenePoint = { x: number; y: number }

export type ScenePointPermission = {
  sourceId: string
  eventSourceId: string
  armed: boolean
  canEdit: boolean
  sourceRunning: boolean
  mediaReady: boolean
  isUpload: boolean
  mediaPaused: boolean
  mediaSeeking: boolean
  point: ScenePoint
}

export function canAcceptScenePoint(input: ScenePointPermission): boolean {
  return input.sourceId === input.eventSourceId && input.armed && input.canEdit && !input.sourceRunning && input.mediaReady &&
    (!input.isUpload || (input.mediaPaused && !input.mediaSeeking)) &&
    Number.isFinite(input.point.x) && Number.isFinite(input.point.y) &&
    input.point.x >= 0 && input.point.x <= 1 && input.point.y >= 0 && input.point.y <= 1
}

export function appendScenePoint(points: ScenePoint[], point: ScenePoint, limit: number): ScenePoint[] {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 || points.length >= Math.max(0, limit)) return points
  return [...points, point]
}
