import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequestGeneration } from './requestGeneration.ts'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('a delayed scene response from a prior source cannot replace the current source scene', async () => {
  const generation = createRequestGeneration()
  let currentSourceId = 'north'
  let visibleScene = null
  const northResponse = deferred()
  const northRequest = generation.begin(currentSourceId)
  const load = async (request, sourceId, response) => {
    const scene = await response.promise
    if (generation.isCurrent(request, currentSourceId) && request.key === sourceId) visibleScene = scene
  }
  const northLoad = load(northRequest, 'north', northResponse)

  currentSourceId = 'south'
  const southResponse = deferred()
  const southRequest = generation.begin(currentSourceId)
  const southLoad = load(southRequest, 'south', southResponse)
  southResponse.resolve({ zones: [{ id: 'south-zone' }] })
  await southLoad
  assert.equal(visibleScene.zones[0].id, 'south-zone')

  northResponse.resolve({ zones: [{ id: 'stale-north-zone' }] })
  await northLoad
  assert.equal(visibleScene.zones[0].id, 'south-zone')
})

test('a newer refresh invalidates an older response for the same source', async () => {
  const generation = createRequestGeneration()
  const oldResponse = deferred()
  const freshResponse = deferred()
  const oldRequest = generation.begin('north')
  const freshRequest = generation.begin('north')
  let visibleScene = null
  const load = async (request, response) => {
    const scene = await response.promise
    if (generation.isCurrent(request, 'north')) visibleScene = scene
  }
  const oldLoad = load(oldRequest, oldResponse)
  const freshLoad = load(freshRequest, freshResponse)

  freshResponse.resolve({ revision: 2 })
  await freshLoad
  oldResponse.resolve({ revision: 1 })
  await oldLoad
  assert.deepEqual(visibleScene, { revision: 2 })
})
