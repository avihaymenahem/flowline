export type SpatialScope = 'full_frame_tiled' | 'counting_line_regions' | 'unknown'

export function analysisScopeFromNotes(notes: string[]): { scope: SpatialScope; includesUntrackedObservations: boolean } {
  const scope: SpatialScope = notes.some(note => note.startsWith('spatial_scope=full_frame_tiled;'))
    ? 'full_frame_tiled'
    : notes.some(note => note.startsWith('spatial_scope=counting_line_regions_only;'))
      ? 'counting_line_regions'
      : 'unknown'
  return { scope, includesUntrackedObservations: notes.some(note => note.startsWith('observations_include_untracked=true;')) }
}
