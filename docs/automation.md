# Automation

Per-channel parameter automation for the channel mixer. A lane is a list of
`{ tick, value }` points for one channel and one parameter, drawn and edited in
a canvas under the piano roll. Playback stays stateless, so looping, pause,
resume, seeking and tempo changes need no extra bookkeeping.

## Files

- `SequencerEngine` (lane storage, interpolation, scheduling, persistence helpers)
- `static/js/sequencer-ui.js` (automation lane editor, undo/redo, save/load)
- `static/css/sequencer.css` (`.automation-panel`, `.automation-toolbar`, `.automation-canvas`)

## Data model

Lanes are stored in the engine as `channelId -> paramKey -> [{ tick, value }]`,
sorted by tick with unique ticks. Channel IDs are the same as the mixer's
(a MIDI track's stable ID, `uploaded`, `drum-kick`, `drum-snare`, `drum-hat`).

- Values are linearly interpolated between points. Before the first point a lane
  holds its first value, and after the last point it holds its last value.
- Cutoff is interpolated and drawn on a log scale, so sweeps move evenly in pitch.
- A lane holds at most 2000 points. Values are clamped to the parameter's range,
  ticks are rounded and clamped to 0 or above, and later duplicates of a tick win.
- Lanes can exist for channels that do not exist yet or any more (a deleted
  track, or a sample awaiting re-upload). They are kept and resume when the
  channel returns.

## Automatable parameters

| Key | Range | Scale |
| --- | --- | --- |
| `volume` | 0 to 1.5 | linear |
| `pan` | -1 to 1 | linear |
| `cutoff` | 20 to 20000 Hz | log |
| `resonance` | 0 to 15 dB | linear |
| `delaySend` | 0 to 1 | linear |
| `delayFeedback` | 0 to 0.9 | linear |
| `reverbSend` | 0 to 1 | linear |

Filter type is not automatable because switching it can click, and delay time
is not automatable because it would warble the pitch of the repeats.

## Engine API

```js
engine.automationParams();                   // [{ key, min, max, def, log }] for the automatable set
engine.setAutomation(id, key, points);       // replace a lane; [] removes it; true if accepted
engine.getAutomation(id, key);               // copy of the lane's points ([] if none)
engine.hasAutomation(id, key);               // does the lane exist?
engine.clearAutomation(id, key);             // same as setAutomation(id, key, [])
engine.automationValueAt(id, key, tick);     // lane value at a tick, or null if no lane
engine.snapshotAutomation();                 // { version: 1, lanes: [{ channelId, key, points }] }
engine.restoreAutomation(state);             // replaces all lanes from a snapshot
```

`setAutomation` returns `false` for an unknown parameter, a non-string channel
ID, a non-array, or more than 2000 points. Invalid individual points are skipped.

## Playback

For every scheduled sixteenth, the engine schedules automation ramps at the
interval boundaries, any automation points inside the interval, and any tempo
changes inside the interval. Cutoff uses exponential ramps. Offline WAV and MP3
rendering uses the same curves over the full song, including effect decay.

- A partial first step (after resume or seek) starts the curve at the chosen
  tick, not the step boundary.
- Tempo changes are handled because step times come from the sequence's tempo
  map each time.
- An error in automation scheduling is reported as a non-fatal audio warning and
  does not stop playback.
- Referencing an automated delay or reverb parameter creates that channel's
  effect nodes, even if its send slider is at 0. A MIDI track's strip is created
  on demand the same way.
- On Stop or Pause every automated parameter snaps back to its mixer value, so
  the sliders mean what they say while stopped. While playing, a lane overrides
  its slider, and moving the slider can win for up to one step before the lane
  takes over again.

## Lane editor

The canvas sits under the piano roll and shares its horizontal scroll and zoom,
so lane points line up with notes above. Pick a channel and parameter from the
toolbar.

| Action | Result |
| --- | --- |
| Click empty space | Add a point |
| Drag a point | Move it (it cannot cross its neighbours) |
| Shift-click or right-click a point | Delete it |
| Escape during a drag | Cancel and restore the lane |
| Snap button | Snap new and moved points to steps (on by default) |
| Clear lane | Remove the whole lane |

- With nothing drawn, a dashed line shows where the mixer slider currently sits.
- Pan snaps to center near zero for easy centering.
- The shaded region marks the area outside the loop, and the playhead follows
  playback.
- Snap changes the point placement grid. With Snap off, the scheduler applies
  points at their stored ticks, including points between sixteenth boundaries.
- Viewers can see lanes but cannot edit them.
- The panel is marked `data-daw-controls` and `data-daw-pointer-inputs`, so the
  focus policy returns focus to the workspace after pointer use and Space still
  controls transport.
- The channel list refreshes every 500 ms, like the mixer panel.

## Undo and redo

Each add, move, delete and clear is one history entry of kind `automation`
(`{ channelId, key, before, after, label }`) on the shared undo stack. A drag is
one entry, committed on release. History entries are weighted by point count,
so the existing size limits still apply.

## Database state

`instruments.automation` stores `engine.snapshotAutomation()` in the project
JSON. On load, `engine.restoreAutomation(...)` runs after `restoreMix(...)`.
Older projects have no `automation` key and load with no lanes.

## Related fixes

- A new sample or drum channel now defaults to volume 0.8. Previously the default
  was read before the track was registered, so it came out as 1.0.
- `newSequence()` now clears all stored mixes and automation and disposes every
  MIDI strip, so a reused track ID such as `piano` no longer keeps its old pan,
  filter or effect settings after New Sequence.

## Limits

- Pointer-only editing, with no keyboard editing of points yet.
- No recording of slider moves into lanes.
- Lanes are straight lines between points, with no curve shapes or step mode.
- Mix and automation share undo with note edits, so a pattern resize clears the
  history, as it does for notes.

## Manual testing

1. On a synth track, draw a Cutoff lane from high to low and play: a filter
   sweep. On a drum, draw a zigzag Pan lane and a fading Volume lane.
2. Pause mid-lane and Resume. Pause, drag the ruler cursor, and Resume: the
   parameter jumps to the right value for that position. A loop wrap restarts
   the lane at the loop start.
3. Change BPM during playback: the lane stays aligned with the notes.
4. Press Stop: sliders are back in charge.
5. Add, drag, delete and clear points, then Undo and Redo each.
6. Press Escape mid-drag: the lane returns to its previous shape.
7. Save, reload, and confirm lanes return. Open as a Viewer: lanes display but
   cannot be edited.
8. Change a MIDI track's pan, press New Sequence, and confirm it returns to
   center in the UI and by ear.