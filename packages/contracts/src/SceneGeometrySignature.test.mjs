import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisContextSchema, sceneGeometrySignature, sceneGeometryParts } from '../dist/index.js';

test('scene geometry signature is canonical and excludes display labels', () => {
  const scene = {
    zones: [{ id: '🚗-zone', name: '道路', polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }],
    countingLines: [{ id: '線', name: 'North', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 }, directionLabels: ['East', 'West'] }]
  };
  assert.equal(sceneGeometrySignature(scene), 'g1:[[ ["🚗-zone",[[0,0],[1,0],[1,1]]] ],[["線",[0,0.5],[1,0.5]]]]'.replaceAll(' ', ''));
  assert.equal(sceneGeometrySignature({ ...scene, zones: [...scene.zones].reverse().map((zone) => ({ ...zone, name: 'renamed' })), countingLines: scene.countingLines.map((line) => ({ ...line, name: 'renamed', directionLabels: ['A', 'B'] })) }), sceneGeometrySignature(scene));
  assert.deepEqual(Object.keys(sceneGeometryParts(scene)).sort(), ['lines', 'zones']);
  assert.notEqual(sceneGeometrySignature({ ...scene, zones: [{ ...scene.zones[0], polygon: [...scene.zones[0].polygon].reverse() }] }), sceneGeometrySignature(scene));
});

test('captured analysis settings require matching scene provenance', () => {
  const scene = { zones: [], countingLines: [] };
  const context = { settingsCaptured: true, detector: { backend: 'yolo26' }, tracker: { backend: 'IoUTracker' },
    scene: { geometrySignature: sceneGeometrySignature(scene), snapshot: scene } };
  assert.equal(AnalysisContextSchema.safeParse(context).success, true);
  assert.equal(AnalysisContextSchema.safeParse({ ...context, scene: { ...context.scene, geometrySignature: 'wrong' } }).success, false);
  assert.equal(AnalysisContextSchema.safeParse({ settingsCaptured: false, qualityCoverage: 'known', qualityNotes: [] }).success, true);
});
