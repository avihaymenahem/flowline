import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeOrganizationSourceSnapshot, sourceIdFromDrag, sourcesInFolder, validSourceFolderView } from './sourceFolders.ts'

const sources = [
  { id: 'a', name: 'A', folderId: 'work', status: 'running' },
  { id: 'b', name: 'B', status: 'idle' },
  { id: 'c', name: 'C', folderId: 'home', status: 'completed' },
  { id: 'd', name: 'D', folderId: 'work', status: 'stopped' },
]

test('folder views filter by membership without changing the persisted source order', () => {
  assert.deepEqual(sourcesInFolder(sources, 'all').map(source => source.id), ['a', 'b', 'c', 'd'])
  assert.deepEqual(sourcesInFolder(sources, 'ungrouped').map(source => source.id), ['b'])
  assert.deepEqual(sourcesInFolder(sources, 'work').map(source => source.id), ['a', 'd'])
})

test('folder deletion and missing folders have safe URL-view recovery', () => {
  const folderIds = new Set(['work', 'home'])
  assert.equal(validSourceFolderView('all', folderIds), true)
  assert.equal(validSourceFolderView('ungrouped', folderIds), true)
  assert.equal(validSourceFolderView('home', folderIds), true)
  assert.equal(validSourceFolderView('deleted-folder', folderIds), false)
})

test('drag drops accept only a known source carried by the private source payload', () => {
  const knownIds = new Set(['source-1'])
  assert.equal(sourceIdFromDrag(['application/x-traffic-source', 'text/plain'], 'source-1', knownIds), 'source-1')
  assert.equal(sourceIdFromDrag(['text/plain'], 'source-1', knownIds), null)
  assert.equal(sourceIdFromDrag(['application/x-traffic-source'], 'external-id', knownIds), null)
  assert.equal(sourceIdFromDrag(['Files'], '', knownIds), null)
})

test('organization snapshots update membership/order without reverting newer source state or resurrecting deletions', () => {
  const current = [
    { id: 'a', name: 'Renamed locally', folderId: 'old', status: 'running', location: { latitude: 32 } },
    { id: 'b', name: 'B', status: 'idle' },
  ]
  const snapshot = [
    { id: 'b', name: 'B', folderId: 'new', status: 'idle' },
    { id: 'a', name: 'Old server name', folderId: 'new', status: 'stopped' },
    { id: 'deleted', name: 'Deleted', folderId: 'new', status: 'idle' },
  ]
  const merged = mergeOrganizationSourceSnapshot(current, snapshot, new Set(['deleted']))
  assert.deepEqual(merged.map(source => source.id), ['b', 'a'])
  assert.equal(merged[0].folderId, 'new')
  assert.equal(merged[1].folderId, 'new')
  assert.equal(merged[1].name, 'Renamed locally')
  assert.equal(merged[1].status, 'running')
  assert.deepEqual(merged[1].location, { latitude: 32 })
})
