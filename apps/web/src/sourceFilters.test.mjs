import test from 'node:test'
import assert from 'node:assert/strict'
import { canDropSourceIntoFolder, canReorderSources, filterAndSortSources, normalizeSourceListSearch, sourceListFiltersFromSearch, updateSourceListSearch } from './sourceFilters.ts'

const source = (id, name, kind, status, folderId, createdAt) => ({ id, name, kind, status, folderId, createdAt })
const sources = [
  source('a', 'East 10', 'upload', 'completed', 'north', '2026-10-12T10:00:00Z'),
  source('b', 'East 2', 'youtube', 'running', 'north', '2026-10-13T10:00:00Z'),
  source('c', 'West camera', 'webcam', 'running', 'south', '2026-10-13T11:00:00Z'),
  source('d', 'East old stream', 'stream', 'stopped', undefined, '2026-10-10T10:00:00Z'),
]

test('combined source filters are applied within the selected folder', () => {
  const filters = { query: 'east', type: 'youtube', status: 'running', sort: 'manual' }
  assert.deepEqual(filterAndSortSources(sources, 'north', filters).map(item => item.id), ['b'])
  assert.deepEqual(filterAndSortSources(sources, 'south', filters), [])
  assert.deepEqual(filterAndSortSources(sources, 'all', { ...filters, query: '  eAsT  ', type: 'all', status: 'all' }).map(item => item.id), ['a', 'b', 'd'])
  assert.equal(filterAndSortSources(sources, 'all', { ...filters, query: '   ', type: 'all', status: 'all' }).length, sources.length)
})

test('sorting changes only the displayed copy and manual order remains saved order', () => {
  const original = sources.map(item => item.id)
  assert.deepEqual(filterAndSortSources(sources, 'all', { query: '', type: 'all', status: 'all', sort: 'manual' }).map(item => item.id), original)
  assert.deepEqual(filterAndSortSources(sources, 'all', { query: '', type: 'all', status: 'all', sort: 'name-asc' }).map(item => item.id), ['b', 'a', 'd', 'c'])
  assert.deepEqual(filterAndSortSources(sources, 'all', { query: '', type: 'all', status: 'all', sort: 'newest' }).map(item => item.id), ['c', 'b', 'a', 'd'])
  assert.deepEqual(filterAndSortSources(sources, 'all', { query: '', type: 'all', status: 'all', sort: 'status' }).map(item => item.id), ['b', 'c', 'd', 'a'])
  assert.deepEqual(sources.map(item => item.id), original)
})

test('reordering is allowed only for the unfiltered saved-order view', () => {
  const manual = { query: '', type: 'all', status: 'all', sort: 'manual' }
  assert.equal(canReorderSources(manual), true)
  assert.equal(canReorderSources({ ...manual, query: 'east' }), false)
  assert.equal(canReorderSources({ ...manual, type: 'upload' }), false)
  assert.equal(canReorderSources({ ...manual, status: 'running' }), false)
  assert.equal(canReorderSources({ ...manual, sort: 'name-asc' }), false)
  assert.equal(canReorderSources({ ...manual, query: '   ' }), true)
  assert.equal(canDropSourceIntoFolder('north', 'south', false), true)
  assert.equal(canDropSourceIntoFolder('north', 'north', false), false)
  assert.equal(canDropSourceIntoFolder(null, null, false), false)
  assert.equal(canDropSourceIntoFolder('north', 'north', true), true)
})

test('filter query state safely defaults invalid values and preserves folder across updates', () => {
  assert.deepEqual(sourceListFiltersFromSearch('?folder=north&type=unknown&status=bad&sort=sideways'), { query: '', type: 'all', status: 'all', sort: 'manual' })
  assert.deepEqual(updateSourceListSearch({ folder: 'north', unrelated: 'ignored' }, { type: 'youtube', query: 'East' }), { folder: 'north', q: 'East', type: 'youtube' })
  assert.deepEqual(updateSourceListSearch({ folder: 'north', q: '   ', sort: 'name-asc' }, { query: '', type: 'all', status: 'all', sort: 'manual' }), { folder: 'north' })
  assert.deepEqual(normalizeSourceListSearch({ folder: 'missing-folder', q: '', type: 'all', sort: 'manual', other: 'ignored' }), { folder: 'missing-folder' })
})
