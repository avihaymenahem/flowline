import test from 'node:test'
import assert from 'node:assert/strict'
import { countByVehicleColor, countByVehicleType, vehicleColorLabel, vehicleTypeLabel, vehicleTypeKey } from './vehicleTypes.ts'

test('uses human labels only for classes the worker actually reports', () => {
  assert.equal(vehicleTypeLabel('motorcycle'), 'Motorcycle')
  assert.equal(vehicleTypeLabel('truck'), 'Truck')
  assert.equal(vehicleTypeLabel('van'), 'Van')
  assert.notEqual(vehicleTypeLabel('car'), 'Private car')
  assert.equal(vehicleTypeKey('  MOTORCYCLE '), 'motorcycle')
})

test('counts detections from one sample by reported type', () => {
  assert.deepEqual(countByVehicleType([
    { class: 'car' }, { class: 'CAR' }, { class: 'motorcycle' }, { class: 'truck' },
  ]), [
    { key: 'car', label: 'Car', count: 2 },
    { key: 'motorcycle', label: 'Motorcycle', count: 1 },
    { key: 'truck', label: 'Truck', count: 1 },
  ])
})

test('keeps missing color explicitly unknown in a latest-sample breakdown', () => {
  assert.equal(vehicleColorLabel(null), 'Unknown')
  assert.deepEqual(countByVehicleColor([
    { color: 'blue' }, { color: ' BLUE ' }, { color: undefined },
  ]).map(({ key, label, count }) => ({ key, label, count })), [
    { key: 'blue', label: 'Blue', count: 2 },
    { key: 'unknown', label: 'Unknown', count: 1 },
  ])
})
