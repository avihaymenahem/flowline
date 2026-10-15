import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceSchema } from '../dist/index.js'

const source = {
  id: '7c3d38bd-480b-44f6-8e4c-2269db8e4cda',
  name: 'Downtown camera',
  kind: 'youtube',
  status: 'idle',
  createdAt: '2026-10-13T08:00:00.000Z',
  url: 'https://www.youtube.com/watch?v=1EiC9bvVGnk',
}

test('accepts bounded safe YouTube source metadata while preserving legacy source records', () => {
  assert.equal(SourceSchema.parse(source).youtube, undefined)
  const parsed = SourceSchema.parse({ ...source, youtube: { videoId: '1EiC9bvVGnk', title: 'Downtown live camera', isLive: true, liveStatus: 'is_live' } })
  assert.equal(parsed.youtube?.videoId, '1EiC9bvVGnk')
  assert.equal(parsed.youtube?.isLive, true)
  assert.equal(SourceSchema.safeParse({ ...source, youtube: { videoId: 'short', title: 'x'.repeat(201) } }).success, false)
  assert.equal(SourceSchema.safeParse({ ...source, youtube: { videoId: '1EiC9bvVGnk', liveStatus: 'maybe_live' } }).success, false)
})
