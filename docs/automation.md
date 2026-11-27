# Automation

Per-channel and master parameter automation. A lane is a list of
`{ tick, value }` points for one channel and one parameter, drawn and edited in
a canvas under the piano roll. Playback stays stateless, so looping, pause,
resume, seeking and tempo changes need no extra bookkeeping. Which parameters
exist comes from the effect registry; see [effects](effects.md).

## Files

- `SequencerEngine` (lane storage, interpolation, scheduling, persistence helpers)
- `static/js/sequencer-ui.js` (automation lane editor, undo/redo, save/load)
- `static/css/sequencer.css` (`.automation-panel`, `.automation-toolbar`, `.automation-canvas`)

## Data model

Lanes are stored in the engine as `channelId -> paramKey -> [{ tick, value }]`,
sorted by tick with unique ticks. A channel ID is a MIDI track's stable ID, an
audio lane's ID, or `master`. Drum tracks and the legacy sample are preview-only,
so they have no lanes.

- Values are linearly interpolated between points. Before the first point a lane
  holds its first value, and after the last point it holds its last value.
- Parameters marked `log` (cutoff, distortion tone) are interpolated and drawn on
  a log scale, so sweeps move evenly in pitch.
- A lane holds at most 2000 points. Values are clamped to the parameter's range,
  ticks are rounded and clamped to 0 or above, and later duplicates of a tick win.
- Deleting a track removes its lanes along with it, and Undo restores them.
  Saved lanes for a channel that no longer exists are dropped on load.

## Automatable parameters

The list below is what ships. Effect parameters come from the registry, so a new
effect with `automatable: true` parameters appears here automatically.

| Key | Channels | Range | Scale |
| --- | --- | --- | --- |
| `volume` | all | 0 to 1.5 | linear |
| `pan` | all | -1 to 1 | linear |
| `cutoff` | all | 20 to 20000 Hz | log |
| `resonance` | all | 0 to 15 dB | linear |
| `distDrive`, `distMix` | all | 0 to 1 | linear |
| `distTone` | all | 500 to 20000 Hz | log |
| `compThreshold` | all | -60 to 0 dB | linear |
| `compRatio` | all | 1 to 20 | linear |
| `compMakeup` | all | 0 to 24 dB | linear |
| `limThreshold` | master | -24 to 0 dB | linear |
| `delaySend`, `reverbSend` | lanes | 0 to 1 | linear |
| `delayFeedback` | lanes | 0 to 0.9 | linear |
| `tempo` | master | 40 to 240 BPM | linear |

Not automatable: filter type (switching it can click), delay time (it would
warble the pitch of the repeats), and the compressor and limiter attack and
release times.

## Engine API

```js
engine.automationParams(id);                 // automatable params for a channel: [{ key, label, groupLabel, min, max, def, step, format, log }]; the master also lists tempo
engine.setAutomation(id, key, points);       // replace a lane; [] removes it; true if accepted
engine.getAutomation(id, key);               // copy of the lane's points ([] if none)
engine.hasAutomation(id, key);               // does the lane exist?
engine.clearAutomation(id, key);             // same as setAutomation(id, key, [])
engine.automationValueAt(id, key, tick);     // lane value at a tick, or null if no lane
engine.snapshotAutomation();                 // { version: 1, lanes: [{ channelId, key, points }] }
engine.restoreAutomation(state);             // replaces all lanes from a snapshot
```

`setAutomation` returns `false` for an unknown or non-automatable parameter, a
channel that is not a lane or the master, a parameter outside the channel's
scope (for example `delaySend` on the master), a non-array, or more than 2000
points. Invalid individual points are skipped. Tempo has extra rules, below.

## Playback

For every scheduled 16th step, `scheduleStep` calls `#scheduleAutomation`, which
evaluates each lane at the step's start and end tick. It asks the owning module
for the parameter's `AudioParam`s (`targets(key)`), converts the value with the
module's `map` if it has one (for example dB to linear gain), then schedules
`setValueAtTime(start)` and a ramp to the end value at the step's audio times.
The ramp is exponential for `log` parameters with positive values and linear
otherwise.

- A partial first step (after resume or seek) starts the curve at the chosen
  tick, not the step boundary.
- Tempo changes are handled because step times come from the sequence's tempo
  map each time.
- An error in automation scheduling is reported as a non-fatal audio warning and
  does not stop playback.
- Automating an effect parameter creates that effect on the channel even if its
  mix is off, so the lane has something to drive. A lane's strip is created on
  demand the same way.
- On Stop or Pause every automated parameter snaps back to its mixer value, so
  the sliders mean what they say while stopped. While playing, a lane overrides
  its slider, and moving the slider can win for up to one step before the lane
  takes over again.

## Tempo automation

A Tempo lane exists on the master only. It is not scheduled like other lanes:
editing it compiles it into `sequence.tempos` as a staircase, one event per 16th
step (or per stride on very long lanes, capped at 2048 events), so playback and
export use the existing tempo-map code.

- Editing a tempo lane is allowed only while stopped. A rejected edit shows a
  status message, and a rejected Undo or Redo keeps its history entry.
- An imported tempo map is protected: a tempo lane cannot be drawn over it.
- While a tempo lane exists, `setBpm()` throws and the BPM field is disabled.
  Clearing the lane restores a constant tempo using the base BPM.
- Loading a project does not recompile the lane, since the saved tempo map
  already contains the result. The base BPM comes from the map's first event.
- The delay follows the base BPM, not the automated tempo.

## Lane editor

The canvas sits under the piano roll and shares its horizontal scroll and zoom,
so lane points line up with notes above. Pick a channel (the master is listed
first) and a parameter ("Group · Parameter") from the toolbar. The parameter list
is rebuilt when the channel changes, and the channel list when tracks are added,
removed, renamed or reordered.

| Action | Result |
| --- | --- |
| Click empty space | Add a point |
| Drag a point | Move it (it cannot cross its neighbours) |
| Shift-click or right-click a point | Delete it |
| Escape during a drag | Cancel and restore the lane |
| Snap button | Snap new and moved points to steps (on by default) |
| Clear lane | Remove the whole lane |

- With nothing drawn, a dashed line shows where the mixer slider (or, for tempo,
  the base BPM) currently sits.
- Pan snaps to center near zero for easy centering.
- Grid lines follow the same meter marks and zoom as the piano roll. The shaded
  region marks the area outside the loop, and the playhead follows playback.
- With Snap on, playback matches the drawn curve exactly. With Snap off, a point
  inside a step rounds the curve slightly, because ramps are scheduled per step.
- Viewers can see lanes but cannot edit them.
- Edits are broadcast to collaborators when a gesture is committed.
- The panel is marked `data-daw-controls` and `data-daw-pointer-inputs`, so the
  focus policy returns focus to the workspace after pointer use and Space still
  controls transport.

## Undo and redo

Each add, move, delete and clear is one history entry of kind `automation`
(`{ channelId, key, before, after, label }`) on the shared undo stack. A drag is
one entry, committed on release. History entries are weighted by point count,
so the existing size limits still apply.

## Database state

`instruments.automation` stores `engine.snapshotAutomation()` in the project
JSON. On load, `engine.restoreAutomation(...)` runs after `restoreMix(...)`. Lanes
may use `channelId: 'master'` and, for tempo, `key: 'tempo'`. Older projects have
no `automation` key and load with no lanes.

## Related behavior

- Default volume depends on the channel: 1.0 for lanes, 0.8 for sample and drum
  channels, and 0.7 for the master.
- `newSequence()` clears all stored mixes and automation, disposes every lane
  strip, and resets the master, so a reused track ID such as `piano` no longer
  keeps its old pan, filter or effect settings.

## Limits

- Pointer-only editing, with no keyboard editing of points yet.
- No recording of slider moves into lanes.
- Lanes are straight lines between points, with no curve shapes or step mode.
- Mix and automation share undo with note edits, so a pattern resize clears the
  history, as it does for notes.
- Tempo lanes are a per-step staircase, and how audio clips behave when the tempo
  changes under them depends on `AudioArrangement`.
- Audio export does not apply automation.

## Manual testing

1. On a synth track, draw a Cutoff lane from high to low and play: a filter
   sweep. Draw a Distortion Mix lane and a Master Volume fade-out.
2. Pause mid-lane and Resume. Pause, drag the ruler cursor, and Resume: the
   parameter jumps to the right value for that position. A loop wrap restarts
   the lane at the loop start.
3. Change BPM during playback: the lane stays aligned with the notes.
4. Press Stop: sliders are back in charge.
5. Add, drag, delete and clear points, then Undo and Redo each.
6. Press Escape mid-drag: the lane returns to its previous shape.
7. Draw a Tempo lane from 100 to 140 BPM and play it. Try drawing one while
   playing, and over an imported tempo map: both are refused with a message.
   Clear it and confirm the BPM field works again.
8. Delete a track that has lanes, then Undo: the lanes come back.
9. Save, reload, and confirm lanes return. Open as a Viewer: lanes display but
   cannot be edited.
10. Change a MIDI track's pan, press New Sequence, and confirm it returns to
    center in the UI and by ear.