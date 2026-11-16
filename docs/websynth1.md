# WebSynth1

A basic polyphonic subtractive synth for pitched MIDI tracks. It plugs into the
sequencer through `engine.registerInstrumentManager(...)` and replaces the
temporary sine voice. It does not own any timing, `AudioContext` or transport.

## Files

- `static/js/instruments/SynthInstrumentManager.js` (the manager and settings API)
- `static/index.html` (script tag, loaded **before** `sequencer-ui.js`)

The script registers itself from the `jukebox:ready` event, so it must load
before `sequencer-ui.js` fires that event. No global engine variable exists.

## How it fits the engine

For each scheduled note the engine calls
`createVoice(noteEvent, audioContext, outputNode)`. The synth builds
`oscillator -> low-pass filter -> gain envelope -> outputNode` at `noteEvent.when`
and returns a handle `{ stop(), finished }`.

- `stop()` is idempotent. It ramps the gain to zero over ~10 ms (no click) and
  stops the oscillator. Safe before start, while sounding and after completion.
- `finished` resolves from the oscillator's `onended`, after the release tail
  and after all nodes are disconnected.
- `syncTracks(tracks)` deletes settings for track IDs that no longer exist.
- `stop()` / `dispose()` silence every active voice. `dispose()` also clears
  all settings.
- `createVoice` is synchronous and does no setup work. Nothing needs `prepare()`.

## Settings API

Settings are stored per track ID, separate from the note data, and are exposed
as `window.jukeboxSynth`.

```js
jukeboxSynth.setParam(trackId, key, value); // returns true if accepted
jukeboxSynth.getSettings(trackId);          // full object, defaults filled in
jukeboxSynth.activeVoices();                // number of voices still sounding or releasing
jukeboxSynth.DEFAULTS;  jukeboxSynth.LIMITS;  jukeboxSynth.WAVEFORMS;
```

| Key | Default | Range / values |
| --- | --- | --- |
| `waveform` | `sawtooth` | `sine`, `square`, `sawtooth`, `triangle` |
| `attack` | 0.01 s | 0 to 5 |
| `decay` | 0.08 s | 0 to 5 |
| `sustain` | 0.5 | 0 to 1 (fraction of peak) |
| `release` | 0.2 s | 0 to 10 |
| `gain` | 0.05 | 0 to 0.2 (before master gain) |
| `filterCutoff` | 1200 Hz | 50 to 18000 |

Numeric values are clamped to range. Non-finite numbers, unknown keys and
invalid waveforms are rejected (`false`) and change nothing.

Settings are read when a voice is created, so a change affects notes scheduled
afterwards. Notes already queued or sounding keep their old sound.

## Behaviour and limits

- Channel 9 (MIDI percussion) is silent in this synth. The integrated DrumMachine uses separate sample tracks, not imported percussion notes.
- Peak level is `gain x velocity`. Large chords at high velocity can still
  clip, because there is no per-manager limiter or voice cap.
- Pause cancels voices and Resume restarts envelopes. This is an engine
  limitation (voices have no seek).
- Settings persist in database projects through the versioned instrument snapshot.
  Removed-track settings are dropped on sync; New Sequence resets settings.
- The top-toolbar Synth panel edits settings through the same API.

## Manual testing

1. `window.jukeboxSynth` exists and `getSettings('piano')` returns the defaults.
2. Notes are audible on Play; waveform, cutoff, attack and release changes are
   audible on the next notes.
3. Stop silences immediately without clicks, and `jukeboxSynth.activeVoices()`
   returns to 0.
4. Deleting a track discards its synth settings. Undoing the delete restores the
     track with default settings.

## Toolbar, database state and focus integration

Load `/js/instruments/SynthInstrumentManager.js`, `/js/InstrumentPanel.js`, and `/js/SynthUI.js` before `/js/sequencer-ui.js`; root-absolute entry URLs support both direct and forwarded database-project routes. Registration is once-only on `jukebox:ready`, after the selected composition loads. The manager restores `event.detail.instrumentState.synth` before the Synth UI mounts its one toolbar panel.

`jukeboxSynth.snapshot()` returns `{tracks: [{trackId, settings}]}` with complete current settings for canonical stable track IDs. `restoreState(state)` clears previous state, skips unknown tracks and invalid waveform/numeric values, clamps finite values to LIMITS and defaults missing parameters. Saving reads the snapshot without resetting it. MIDI programs/channels are unchanged; parameters still apply when a future voice is created. Viewer setters reject writes and settings controls are disabled. New Sequence resets parameters, including reused Piano IDs.

The Synth panel stays open during transport and scrolls internally when needed. Close/Escape or its toolbar toggle dismiss it; opening Drums closes it. The centralized focus policy releases pointer-operated sliders on pointerup and native selects on completed change, leaving Tab/arrow/native chooser interactions intact. No control-specific blur handlers are used. A chooser dismissed without changing a value conservatively retains native select focus.

See [sequencer integration](sequencer-api.md#post-merge-dashboard-and-instrument-integration) and [project collaboration](project-collaboration.md) for the JSON envelope, existing optimistic concurrency behavior and verification checklist.
