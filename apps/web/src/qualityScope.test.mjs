import test from 'node:test'
import assert from 'node:assert/strict'
import { analysisScopeFromNotes } from './qualityScope.ts'

test('reports full-frame tiled coverage and untracked observations from the latest event notes', () => {
  assert.deepEqual(analysisScopeFromNotes([
    'detector_mode=full_frame_tiled_with_line_detail;detector_regions=8',
    'spatial_scope=full_frame_tiled;each_sampled_frame_is_tiled_across_entire_frame',
    'observations_include_untracked=true;crossings_require_active_tracks',
  ]), { scope: 'full_frame_tiled', includesUntrackedObservations: true })
})

test('keeps legacy line-region scope explicit and unknown notes conservative', () => {
  assert.deepEqual(analysisScopeFromNotes([
    'spatial_scope=counting_line_regions_only;visible_detections_are_not_full_frame_occupancy',
  ]), { scope: 'counting_line_regions', includesUntrackedObservations: false })
  assert.deepEqual(analysisScopeFromNotes([]), { scope: 'unknown', includesUntrackedObservations: false })
})
