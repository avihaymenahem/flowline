import test from 'node:test'
import assert from 'node:assert/strict'
import { pageFromPath, pageLocationFromPath, pagePathFor, pagePaths, searchAfterSourceCanonicalization } from './pageRouting.ts'

test('each workspace page has a stable reloadable route', () => {
  for (const [page, path] of Object.entries(pagePaths)) assert.equal(pageFromPath(path), page)
  assert.equal(pageFromPath('/'), 'overview')
})

test('unknown paths are recognized as fallback routes, not pages', () => {
  assert.equal(pageFromPath('/missing'), null)
  assert.equal(pageFromPath('/road-planning'), null)
  assert.equal(pageFromPath('/live/source/extra'), null)
  assert.equal(pageFromPath('/live/source%2Fextra'), null)
})

test('source-aware routes preserve one selected ID on each existing workspace page', () => {
  const sourceId = 'camera-1'
  for (const page of Object.keys(pagePaths)) {
    const path = pagePathFor(page, sourceId)
    assert.equal(path, `${pagePaths[page]}/${sourceId}`)
    assert.deepEqual(pageLocationFromPath(path), { page, sourceId })
  }
  assert.deepEqual(pageLocationFromPath('/observations/camera%20one/'), { page: 'observations', sourceId: 'camera one' })
})

test('base routes remain valid until a source is chosen', () => {
  assert.deepEqual(pageLocationFromPath('/live'), { page: 'live', sourceId: null })
  assert.equal(pagePathFor('live'), '/live')
  assert.equal(pagePathFor('overview', null), '/overview')
})

test('source default-route canonicalization preserves supported Sources view params only', () => {
  assert.deepEqual(searchAfterSourceCanonicalization('sources', { folder: 'south-2', q: 'South', type: 'youtube', status: 'running', sort: 'newest', unrelated: 'drop' }), { folder: 'south-2', q: 'South', type: 'youtube', status: 'running', sort: 'newest' })
  assert.deepEqual(searchAfterSourceCanonicalization('sources', { folder: 'south-2', type: 'unsupported' }), { folder: 'south-2' })
  assert.deepEqual(searchAfterSourceCanonicalization('sources', { unrelated: 'drop' }), {})
  assert.deepEqual(searchAfterSourceCanonicalization('live', { folder: 'south-2' }), {})
})
