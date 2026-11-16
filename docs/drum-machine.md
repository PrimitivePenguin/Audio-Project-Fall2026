# Drum machine

A three-voice step-sequenced drum machine (kick, snare, hi-hat) with a small
grid UI. Sounds are synthesized in JS. Patterns play through the engine's
existing sample-track system, so the engine keeps owning the transport,
scheduler and `AudioContext`.

## Files

- `static/js/instruments/DrumMachine.js` (sounds, engine wiring, `window.jukeboxDrums`)
- `static/js/DrumMachineUI.js` (step grid panel)
- `static/index.html` (script tags)

Load the instrument scripts before `sequencer-ui.js`, in this order:

```html
<script src="/js/instruments/SynthInstrumentManager.js"></script>
<script src="/js/InstrumentPanel.js"></script>
<script src="/js/SynthUI.js"></script>
<script src="/js/instruments/DrumMachine.js"></script>
<script src="/js/DrumMachineUI.js"></script>
<script src="/js/sequencer-ui.js"></script>
```

Each registers from the `jukebox:ready` event. The UI reads `window.jukeboxDrums`,
so `DrumMachine.js` must come first.

## How it fits the engine

The drum machine uses **sample tracks**, not the instrument manager.

- Each drum is a sample track created with `engine.addTrack(id, buffer)`
  (`drum-kick`, `drum-snare`, `drum-hat`). Hits are set with `engine.setStep`.
- Sample tracks run on the engine's own scheduler, with the same step
  timestamps as pitched notes, so tempo, loop range, Pause and Stop all apply.
- `DrumMachine.js` does **not** call `registerInstrumentManager`. Only one
  manager can be registered, and a second would replace the synth.
- Tracks are created lazily on first use (preview, toggle or volume change).
  This also initializes the shared `AudioContext` from a user gesture.
- Preview sources are added to the track's `activeSources`, so Stop and
  `removeTrack` silence them.

## Sounds

Rendered once per page load into `AudioBuffer`s, normalised to a 0.9 peak with
a 5 ms fade-out. No audio files are loaded.

| Drum | Synthesis | Length |
| --- | --- | --- |
| Kick | Sine with a falling pitch sweep and exponential decay | 0.45 s |
| Snare | Decaying noise plus a 185 Hz tone | 0.25 s |
| Hi-hat | High-passed noise, very short decay | 0.08 s |

The noise differs between page loads but is identical within one session.

## API

Exposed as `window.jukeboxDrums`. Steps are **zero-based**; the UI labels are
one-based.

```js
jukeboxDrums.KIT;                          // [{ id, label }, ...]
jukeboxDrums.setStep(id, step, on);        // true if accepted
jukeboxDrums.toggleStep(id, step);         // new state, or null if rejected
jukeboxDrums.setVolume(id, value);         // true if accepted
jukeboxDrums.preview(id);                  // one-shot audition, true if accepted
jukeboxDrums.getSteps(id);                 // copy of the boolean step array
jukeboxDrums.getVolume(id);                // current gain
jukeboxDrums.stepCount();                  // engine pattern length in steps
jukeboxDrums.hasTrack(id);                 // does the engine currently have this track
jukeboxDrums.ensure();                     // create any missing drum tracks
```

- `setStep` and `toggleStep` reject unknown IDs, non-integer steps, negative
  steps and steps at or beyond the pattern length.
- Volume is clamped to 0 to 1.5. The default is 0.8, the engine's default
  sample gain.

## UI

- A **Drums** button in the top toolbar opens the panel.
- One row per drum: a label (click to preview), 16 step buttons per page and a
  volume slider. A pager appears when the pattern is longer than 16 steps.
- Step buttons are real buttons with `aria-pressed` and per-step labels, so the
  grid is keyboard operable.
- Mouse clicks release focus so Space still controls the transport; keyboard
  activation keeps normal focus behaviour.
- The panel is marked `data-daw-controls`, like the other DAW controls.
- While the panel is open it polls every 300 ms to pick up New Sequence,
  MIDI import and pattern-length changes. It does not poll while closed.

## Behaviour with the rest of the app

- **Pattern length:** the grid follows `engine.totalSteps`. Triggers are kept
  when the pattern grows or MIDI is imported. The engine refuses to shorten
  the pattern past an active trigger.
- **New Sequence** removes every sample track. Drum patterns clear and volumes
  reset to 0.8; the tracks are recreated empty on next use.
- **Uploaded sample:** independent of the existing single `uploaded` sample
  slot and its trigger list.
- **Synth:** unchanged. MIDI channel 9 notes from imported files are still
  silent, because the synth skips channel 9 and drums are not played from
  notes.
- **Pause:** cancels sounding hits. Resume does not retrigger them (existing
  engine behaviour for sample tracks).

## Limits

- Three drums with fixed sounds. No sample loading or replacement.
- No per-step velocity or accents; every hit plays at the track volume.
- No playhead highlight on the grid.
- Patterns and volumes persist through database Save Project (see below); they
  are not part of note Undo/Redo or MIDI export.
- The 300 ms refresh poll is a simple way to notice engine changes without
  modifying shared engine code.

## Manual testing

1. `Object.keys(jukeboxDrums)` lists the API above, and the Drums button
   appears.
2. Each label click previews its drum.
3. A kick/snare/hat pattern plays from the toolbar Play button with no
   piano-roll notes, and edits are audible on the next pass.
4. Volume sliders change level live. Stop silences everything, including a
   preview.
5. Space after a mouse click toggles the transport, not the step.
6. Drums and synth notes play together in time.
7. New Sequence clears the grid; a pattern longer than 16 steps shows the
   pager; MIDI import keeps existing drum steps.

## Integrated project state and focus

`jukeboxDrums.snapshot()` returns `{stepCount, tracks: [{id, volume, steps}]}` for existing kit tracks. `restoreState(state)` replaces only kit IDs, rebuilds generated audio and restores finite clamped volume plus strict boolean patterns within the authoritative composition length. Old/malformed state uses empty/default kit values. It never changes uploaded audio or musical MIDI tracks. Database initialization passes `instrumentState.drums` through the once-only ready event after loading the selected composition. No extra manager, AudioContext or scheduler is introduced. A restored kit can allocate the shared suspended context before the first Play.

The primary-toolbar panel uses shared `InstrumentPanel` presentation, Close/Escape and internal overflow. Only one instrument panel is open; the 300 ms UI refresh stops when closed. Central pointer focus completion handles buttons and range releases; keyboard-focused ranges/buttons retain native behavior, and Space becomes transport after a completed pointer interaction. Viewer patterns/volumes are read-only; preview remains available.

Drum-generated audio is reproducible from configuration (noise differs on reload), whereas arbitrary uploaded audio is not persisted by this API. See [sequencer integration](sequencer-api.md#post-merge-dashboard-and-instrument-integration) for the versioned JSON, sample limitation and manual checks.
