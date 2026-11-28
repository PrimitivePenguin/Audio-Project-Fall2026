# Channel Mixer

Per-channel volume, pan, filter, delay and reverb for every sound source in the
sequencer: MIDI tracks, the uploaded sample and the three drum tracks. The mixer
lives in `SequencerEngine`, so it owns no timing or transport of its own. Each
channel gets its own small effect chain.

## Files

- `SequencerEngine` (channel strips, parameter API, persistence helpers)
- `static/js/sequencer-ui.js` (mixer panel)
- `static/js/instruments/DrumMachine.js` (drum channels and their snapshot)
- The drum panel script (drum volume and pan sliders)
- `static/css/sequencer.css` (`.mixer-panel`, `.mix-row`)

## Signal flow

```
source -> gain -> filter -> pan -+-> master
                                 +-> delay send -> delay <-> feedback -> master
                                 +-> reverb send -> convolver -> master
```

Sends are post-fader, post-filter and post-pan, so turning a channel down also
turns its effects down.

- Sample and drum channels build their strip in `addTrack`. Their entry point is
  `track.gainNode`, so `preview()` in the drum machine goes through the mixer.
- MIDI tracks get a strip the first time one of their notes is scheduled. The
  engine passes that strip's gain node to the instrument manager as its `output`
  node, so the synth needs no changes.
- Notes for an unknown track fall back to the master bus.
- Delay and reverb are created the first time a channel's send rises above 0 and
  stay until the channel is removed. Channels that never use an effect pay
  nothing for it.

## Channel IDs

| Channel | ID |
| --- | --- |
| MIDI track | the track's stable ID (e.g. `piano`) |
| Uploaded sample | `uploaded` |
| Drums | `drum-kick`, `drum-snare`, `drum-hat` |

## Mix parameters

| Key | Default | Range / values |
| --- | --- | --- |
| `volume` | 0.8 (sample, drums), 1 (MIDI) | 0 to 1.5 |
| `pan` | 0 | -1 (left) to 1 (right) |
| `filterType` | `lowpass` | `lowpass`, `highpass` |
| `cutoff` | fully open (20000 Hz low-pass, 20 Hz high-pass) | 20 to 20000 Hz |
| `resonance` | 0 dB | 0 to 15 |
| `delaySend` | 0 | 0 to 1 |
| `delayBeats` | 0.75 (dotted eighth) | 0.125 to 2 beats |
| `delayFeedback` | 0.4 | 0 to 0.9 |
| `reverbSend` | 0 | 0 to 1 |

Numeric values are clamped to range. Non-finite values, unknown keys and unknown
channels are rejected (`false`) and change nothing.

## Engine API

```js
engine.setChannelParam(id, key, value);   // true if accepted; smoothed, safe during playback
engine.setChannelVolume(id, value);       // shorthand for key 'volume'
engine.setChannelPan(id, value);          // shorthand for key 'pan'
engine.setChannelFilterType(id, type);    // 'lowpass' | 'highpass'
engine.resetChannelParam(id, key);        // back to that parameter's default
engine.getChannelMix(id);                 // complete mix object, defaults filled in
engine.hasChannel(id);                    // is this a known MIDI/sample/drum channel?

engine.snapshotMix();                     // { tracks: [{ trackId, ...mix }] } for MIDI tracks
engine.restoreMix(state);                 // applies a snapshotMix() result
engine.applyChannelMix(id, mix);          // apply any recognised keys, ignore the rest
engine.extractMix(source);                // pick just the valid mix values from a saved object
engine.resetChannelMix(id);               // forget a channel's stored mix
```

`jukeboxDrums` exposes `setVolume`, `setPan`, `getVolume` and `getPan` as
shorthands for the drum channels.

## Behaviour and limits

- Parameter changes use a 15 ms smoothing constant, so dragging a slider during
  playback does not click or zipper. A change also affects notes that are already
  sounding, since a channel's voices share one strip.
- Mix state is stored in the engine, separately from the audio nodes. It survives
  track removal and recreation (re-uploading a sample keeps its mix), and it can
  be set before the `AudioContext` exists.
- Switching `filterType` moves a fully open cutoff to the new type's open
  position so the sound is not suddenly cut. A cutoff you set stays put. The
  type switch itself is not smoothed and can click faintly mid-sound.
- Delay time is stored in beats and follows tempo changes. Each repeat passes
  through a 4 kHz low-pass, so repeats get darker. Maximum delay is 4 s.
- Reverb is a decaying-noise impulse (2 s) generated once and shared by every
  channel's convolver. Each channel has its own send level, but reverb size is
  fixed.
- Delay and reverb tails ring out after Stop or Pause. Deleting a track or
  removing the sample cuts its tails, because the effect nodes go with it.
- Deleting a MIDI track disposes its strip but keeps its stored mix, so Undo
  restores the track at its previous settings. New Sequence clears all mixes.
- Channel 9 (MIDI percussion) is silent in the synth, so its sliders are not
  audible.
- There is no limiter. Several channels with high volume and effect sends can
  still clip; the master gain is 0.7 for headroom.
- Mix changes are not on the undo/redo stack.

## Mixer panel

The panel sits under the track metadata and shows one row per channel: every MIDI
track in track order, then Sample, then Kick, Snare and Hi-hat. Each row has
Vol, Pan, Filter (type select), Cutoff, Reso, Delay, Time, Fdbk and Reverb
controls with live readouts.

- Double-click any slider to reset it to its default.
- Cutoff is logarithmic across 20 Hz to 20 kHz.
- Rows rebuild only when the channel list changes (tracks added, removed,
  renamed, reordered, or drums appearing); otherwise slider values just refresh,
  and a slider being dragged is never overwritten.
- The panel polls the engine every 500 ms so changes from other UI (such as the
  drum panel sliders) show up.
- Viewers get disabled controls. Rows are marked `data-daw-pointer-inputs`, so
  the focus policy returns focus to the workspace after pointer use and Space
  still controls transport.

## Database state

| Source | Where it is saved |
| --- | --- |
| MIDI tracks | `instruments.mixer` = `engine.snapshotMix()` |
| Drums | each entry of `instruments.drums.tracks` carries the full mix beside `steps` |
| Uploaded sample | mix fields are stored flat on the `sample` object |

On load, `engine.restoreMix(instruments.mixer)` applies the MIDI mixes. Sample
audio is not stored, so its saved mix is held in `unavailableSample` and applied
when the original file is re-uploaded. Drums restore through
`jukeboxDrums.restoreState`. Older projects that stored only `volume` and `pan`
(or nothing) load normally, with any missing parameters at their defaults.

## Manual testing

1. `engine.getChannelMix('piano')` returns the defaults listed above.
2. Hard-pan one MIDI track left and another right during playback. Moving the
   slider mid-note glides without clicks.
3. Sweep Cutoff down on a synth track: it darkens. Switch to High-pass: the sound
   does not vanish, and sweeping the cutoff up thins it out.
4. Raise Delay on one drum and Reverb on another. They sound different at the
   same time. Change BPM and the delay repeats follow.
5. Double-click each slider and confirm it resets.
6. Save, reload, and confirm every channel's mix returns. Re-upload the sample and
   confirm its mix is applied.
7. Delete a MIDI track and Undo: its settings come back.
8. Open a project as a Viewer: all mixer controls are disabled.