import test from 'node:test'
import assert from 'node:assert/strict'
import { api } from './api.ts'

test('source library and folder organization helpers use the staged contract payloads', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const library = { sources: [{ id: 'source-1', name: 'Camera', kind: 'webcam', status: 'idle', createdAt: '2026-01-01' }], folders: [{ id: 'folder-1', name: 'North', createdAt: '2026-01-01' }] }
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    return new Response(JSON.stringify(library), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    assert.deepEqual(await api.sourceLibrary(), library)
    await api.createSourceFolder(' North ')
    await api.renameSourceFolder('folder/1', 'New name')
    await api.deleteSourceFolder('folder/1')
    await api.organizeSource('source/1', 'folder-1', 'source-2')
    await api.organizeSource('source/1', null)
    assert.deepEqual(calls, [
      { url: '/api/sources', method: 'GET', body: undefined },
      { url: '/api/source-folders', method: 'POST', body: { name: ' North ' } },
      { url: '/api/source-folders/folder%2F1', method: 'PATCH', body: { name: 'New name' } },
      { url: '/api/source-folders/folder%2F1', method: 'DELETE', body: undefined },
      { url: '/api/sources/source%2F1/organization', method: 'PUT', body: { folderId: 'folder-1', beforeSourceId: 'source-2' } },
      { url: '/api/sources/source%2F1/organization', method: 'PUT', body: { folderId: null } },
    ])
  } finally { globalThis.fetch = originalFetch }
})

test('sourceLibrary supplies an empty folder list for older sources-only API responses', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ sources: [{ id: 'source-1', name: 'Camera' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  try {
    assert.deepEqual(await api.sourceLibrary(), { sources: [{ id: 'source-1', name: 'Camera' }], folders: [] })
  } finally { globalThis.fetch = originalFetch }
})
