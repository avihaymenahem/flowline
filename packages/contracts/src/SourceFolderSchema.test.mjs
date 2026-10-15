import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceFolderSchema, SourceSchema, SourcesResponseSchema } from '../dist/index.js'

const sourceId = 'd8a0116a-f0b5-4817-83a3-69823987d0e1'
const folderId = '1072029f-c98f-48e6-8328-b05c1832f067'
const folder = { id: folderId, name: ' Downtown ', createdAt: '2026-10-13T00:00:00.000Z' }

test('source folders trim bounded names and require UUID and ISO creation time', () => {
  assert.deepEqual(SourceFolderSchema.parse(folder), { ...folder, name: 'Downtown' })
  assert.equal(SourceFolderSchema.safeParse({ ...folder, name: '   ' }).success, false)
  assert.equal(SourceFolderSchema.safeParse({ ...folder, name: 'x'.repeat(121) }).success, false)
  assert.equal(SourceFolderSchema.safeParse({ ...folder, id: 'bad-id' }).success, false)
  assert.equal(SourceFolderSchema.safeParse({ ...folder, createdAt: 'yesterday' }).success, false)
  assert.equal(SourceFolderSchema.safeParse({ ...folder, extra: true }).success, false)
})

test('source membership is optional for legacy rows and validated when present', () => {
  const legacy = { id: sourceId, name: 'Legacy', kind: 'upload', status: 'completed', createdAt: folder.createdAt }
  assert.equal(SourceSchema.parse(legacy).folderId, undefined)
  assert.equal(SourceSchema.parse({ ...legacy, folderId }).folderId, folderId)
  assert.equal(SourceSchema.safeParse({ ...legacy, folderId: 'bad-id' }).success, false)
})

test('source library response remains compatible with old sources-only payloads', () => {
  const legacy = { id: sourceId, name: 'Legacy', kind: 'upload', status: 'completed', createdAt: folder.createdAt }
  assert.deepEqual(SourcesResponseSchema.parse({ sources: [legacy] }).folders, [])
  assert.deepEqual(SourcesResponseSchema.parse({ sources: [legacy], folders: [folder] }).folders, [{ ...folder, name: 'Downtown' }])
})
