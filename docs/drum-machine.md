# Drum Machine

Open **Drums** in the transport toolbar. Kick, Snare, and Hi-hat each have 16 sixteenth-note steps, a volume slider, and a named button for a one-shot preview. The pattern covers four quarter-note beats in every meter. Importing MIDI, changing the arrangement length, and zooming preserve the 16-step grid.

**Copy to Sample Rack** mixes the existing synthesized drum buffers at their current levels and the tempo at the editing cursor. At 120 BPM the loop is 2 seconds. At 90 BPM it is approximately 2.667 seconds. The PCM mix starts hits at the nearest sample frame, fades any tail cut by the loop end over its last 5 ms, and limits peaks at the PCM range. WAV exports pass through the ordinary rack decoding, preview, and IndexedDB pipeline. Each export has its own stable ID and receives a unique Drum Pattern name. Editing the drum grid cannot alter an exported sample.

The kit is for pattern creation and individual audition. Arrangement Play schedules exported clips through the existing Web Audio scheduler. It does not schedule the drum editor's pattern. Stop and Pause cancel any outstanding one-shot previews.

Project instrument state stores the current 16 steps and volume for each drum. Older steps after 16 are retained in `legacySteps`, shown as archived in the panel, and excluded from playback and export. Viewers can inspect and preview the kit. A new sequence clears project drum settings.

Keyboard users can Tab through the drums, edit sliders with arrows, and activate focused buttons with Enter. Space controls arrangement playback even when a drum control has focus. See the [sequencer API](sequencer-api.md) for clip playback and local asset storage.
