import test from 'node:test'
import assert from 'node:assert/strict'
import { api } from './api.ts'

test('deleteSource accepts the API 204 response without trying to parse JSON', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, init) => {
    request = { url, init }
    return new Response(null, { status: 204 })
  }
  try {
    assert.equal(await api.deleteSource('source/one'), undefined)
    assert.equal(request.url, '/api/sources/source%2Fone')
    assert.equal(request.init.method, 'DELETE')
  } finally { globalThis.fetch = originalFetch }
})

test('deleteSource surfaces a backend conflict message', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Stop analysis before deleting this source.' }), {
    status: 409, headers: { 'Content-Type': 'application/json' },
  })
  try {
    await assert.rejects(api.deleteSource('source-1'), /Stop analysis before deleting this source\./)
  } finally { globalThis.fetch = originalFetch }
})
