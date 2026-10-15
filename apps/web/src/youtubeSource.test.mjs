import test from 'node:test'
import assert from 'node:assert/strict'
import { matchingPreviewEvent, previewMatchesEvent, sourceMessage, updateSourceMessage, youtubeFrameReadyForAnnotation, youtubePreviewErrorMessage, youtubeVideoIdFromUrl } from './youtubeSource.ts'

test('YouTube preview request errors take priority while recovered frames suppress persisted failures', () => {
  assert.equal(youtubePreviewErrorMessage({ sourceStatus: 'error', sourceError: 'Saved resolver error', requestError: 'Current preview request failed', previewAvailable: false }), 'Current preview request failed')
  assert.equal(youtubePreviewErrorMessage({ sourceStatus: 'error', sourceError: 'Saved resolver error', previewAvailable: false }), 'Saved resolver error')
  assert.equal(youtubePreviewErrorMessage({ sourceStatus: 'error', sourceError: 'Saved resolver error', previewAvailable: true }), '')
  assert.equal(youtubePreviewErrorMessage({ sourceStatus: 'idle', sourceError: 'Stale error', previewAvailable: false }), '')
})

test('late transient media errors cannot overwrite the current source error', () => {
  let errors = updateSourceMessage({}, 'youtube-b', 'Current preview failed.')
  errors = updateSourceMessage(errors, 'webcam-a', 'Late frame submission failed.')
  assert.equal(sourceMessage(errors, 'youtube-b'), 'Current preview failed.')
  assert.equal(sourceMessage(errors, 'webcam-a'), 'Late frame submission failed.')
  errors = updateSourceMessage(errors, 'youtube-b', '')
  assert.equal(sourceMessage(errors, 'youtube-b'), '')
})

test('recognizes supported single-video YouTube URL forms and ignores ordinary query extras', () => {
  assert.equal(youtubeVideoIdFromUrl('https://www.youtube.com/watch?v=1EiC9bvVGnk&list=PL123'), '1EiC9bvVGnk')
  assert.equal(youtubeVideoIdFromUrl('https://youtube.com/live/1H0iTzv2jiQ?feature=share'), '1H0iTzv2jiQ')
  assert.equal(youtubeVideoIdFromUrl('https://youtu.be/1EiC9bvVGnk?t=30'), '1EiC9bvVGnk')
  assert.equal(youtubeVideoIdFromUrl('https://m.youtube.com/watch?feature=share&v=1EiC9bvVGnk'), '1EiC9bvVGnk')
  assert.equal(youtubeVideoIdFromUrl('https://youtube.com./live/1H0iTzv2jiQ'), '1H0iTzv2jiQ')
})

test('rejects URLs that API and resolver reject, including ambiguous IDs and extra path segments', () => {
  assert.equal(youtubeVideoIdFromUrl('https://youtube.com/shorts/1EiC9bvVGnk'), null)
  assert.equal(youtubeVideoIdFromUrl('https://youtube.com/watch?v=short'), null)
  assert.equal(youtubeVideoIdFromUrl('https://youtube.com/watch?v=1EiC9bvVGnk&v=1H0iTzv2jiQ'), null)
  assert.equal(youtubeVideoIdFromUrl('https://youtu.be/1EiC9bvVGnk/extra'), null)
  assert.equal(youtubeVideoIdFromUrl('https://youtube.com/live/1H0iTzv2jiQ/extra'), null)
  assert.equal(youtubeVideoIdFromUrl('https://youtube.com:8443/watch?v=1EiC9bvVGnk'), null)
  assert.equal(youtubeVideoIdFromUrl('https://youtube.com:443/watch?v=1EiC9bvVGnk'), null)
  assert.equal(youtubeVideoIdFromUrl('https://name@youtube.com/watch?v=1EiC9bvVGnk'), null)
  assert.equal(youtubeVideoIdFromUrl('https://www.m.youtube.com/watch?v=1EiC9bvVGnk'), null)
  assert.equal(youtubeVideoIdFromUrl('javascript:alert(1)'), null)
})

test('preview matches only an event from the same source, session, and exact source time', () => {
  const preview = { sourceId: 's1', sessionId: 'preview-session', sourceTimeMs: 2400, frameId: 'f1', width: 1280, height: 720 }
  const event = { sourceId: 's1', sessionId: 'preview-session', sourceTimeMs: 2400 }
  assert.equal(previewMatchesEvent(preview, event, 's1'), true)
  assert.equal(previewMatchesEvent(preview, { ...event, sourceTimeMs: 2401 }, 's1'), false)
  assert.equal(previewMatchesEvent(preview, { ...event, sessionId: 'new-session' }, 's1'), false)
  assert.equal(previewMatchesEvent(preview, event, 'other-source'), false)
  assert.equal(previewMatchesEvent(null, event, 's1'), false)
})

test('keeps the event paired with the loaded preview when a newer event arrives', () => {
  const preview = { sourceId: 's1', sessionId: 'session-a', sourceTimeMs: 2400, frameId: 'f1', width: 1280, height: 720 }
  const displayed = { sourceId: 's1', sessionId: 'session-a', sourceTimeMs: 2400, id: 'displayed' }
  const newer = { sourceId: 's1', sessionId: 'session-a', sourceTimeMs: 2900, id: 'newer' }
  assert.equal(matchingPreviewEvent(preview, [newer, displayed], 's1', 'session-a'), displayed)
  assert.equal(matchingPreviewEvent(preview, [displayed], 's1', 'session-b'), undefined)
  assert.equal(matchingPreviewEvent(preview, [newer], 's1', 'session-a'), undefined)
  assert.equal(matchingPreviewEvent(preview, [displayed], 's2', 'session-a'), undefined)
})

test('allows annotation after stop when the already decoded preview still matches', () => {
  const preview = { sourceId: 's1', sessionId: 'preview-session', sourceTimeMs: 2400, frameId: 'f1', width: 1280, height: 720 }
  const currentImage = {
    sourceId: 's1', sourceStatus: 'stopped', imageComplete: true, imageSourceMatches: true,
    imageWidth: 1280, imageHeight: 720, loadedPreview: preview, frameCandidate: preview,
  }
  assert.equal(youtubeFrameReadyForAnnotation(currentImage), true)
  assert.equal(youtubeFrameReadyForAnnotation({ ...currentImage, sourceStatus: 'running' }), false)
  assert.equal(youtubeFrameReadyForAnnotation({ ...currentImage, loadedPreview: { ...preview, sourceId: 's2' } }), false)
  assert.equal(youtubeFrameReadyForAnnotation({ ...currentImage, frameCandidate: { ...preview, sessionId: 'new-session' } }), false)
  assert.equal(youtubeFrameReadyForAnnotation({ ...currentImage, imageComplete: false }), false)
  assert.equal(youtubeFrameReadyForAnnotation({ ...currentImage, imageSourceMatches: false }), false)
  assert.equal(youtubeFrameReadyForAnnotation({ ...currentImage, imageWidth: 1920 }), false)
})
