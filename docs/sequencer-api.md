# JukeBox sequencer and MIDI API — Iteration 2, Milestone 1

The browser editor uses plain JavaScript, one Web Audio lookahead scheduler, a temporary sine voice, and locally bundled `@tonejs/midi` **2.0.28**. Spring Boot serves the existing `static/index.html`. No frontend framework, CDN, database changes or second transport are involved.

Load classic scripts in this order: `vendor/tonejs-midi-2.0.28.js`, `NoteSequence.js`, `SequencerEngine.js`, `midi-io.js`, `PianoRollEditor.js`, `sequencer-ui.js`. Vendor source, version, checksum and licenses are under `static/js/vendor/`.

## Musical data (version 2)

`new NoteSequence(stepCount = 16, ppq = 480)` creates a musical sequence. PPQ is pulses per quarter note, an integer 1–32767. Pattern length is 1–65536 sixteenth-note steps; the initial 16 steps represent one 4/4 measure. Viewport dimensions never define musical data.

```json
{
  "version": 2,
  "name": "JukeBox",
  "ppq": 480,
  "stepCount": 64,
  "importInfo": null,
  "tracks": [{ "id": "piano", "name": "Piano", "channel": 0, "program": 0 }],
  "tempos": [{ "ticks": 0, "bpm": 120 }, { "ticks": 1920, "bpm": 90 }],
  "timeSignatures": [{ "ticks": 0, "timeSignature": [4, 4] }],
  "notes": [{
    "id": "note-1", "midi": 60, "ticks": 17, "durationTicks": 720,
    "velocityMidi": 89, "velocity": 0.7007874015748031,
    "noteOffVelocity": 0, "trackId": "piano", "importId": null
  }]
}
```

- MIDI pitch integers 0–127 are accepted, including pitches outside the initial C2–B5 viewport.
- `ticks` and `durationTicks` are authoritative, safe integers. Start must be nonnegative and inside the pattern; duration must be positive. Notes may extend beyond the pattern end and continue ringing across a loop boundary.
- `velocityMidi` is note-on velocity 1–127; `noteOffVelocity` is 0–127. `velocity` is derived by division by 127. Note-on velocity zero is interpreted by MIDI as note-off, not a new silent note.
- Note IDs remain stable while editing. Duplicate pitch/start notes and overlapping notes are retained; they no longer overwrite one another. IDs are application identities, not standardized MIDI metadata, and are regenerated on import.
- Musical tracks have stable IDs plus names, zero-based MIDI channel 0–15 and zero-based program 0–127. The selected-note indicator displays the track name and one-based channel. Channel 9 is the conventional percussion channel; the temporary voice still plays it as pitched sine audio.
- Sorted tempo and meter maps are separate from notes. Import supplies defaults of 120 BPM and 4/4 at tick zero when absent. Tempo is quarter notes per minute regardless of meter denominator.
- Musical tracks are separate from `engine.tracks`, which remains the existing sample-track map. Sample buffers and Web Audio nodes are runtime data, not MIDI/persistence records.

### NoteSequence methods

- `addNote({midi, ticks, durationTicks, velocityMidi, noteOffVelocity, trackId, id?, importId?})` validates and returns a new note. The legacy `startStep`, `durationSteps` and normalized `velocity` inputs remain accepted. Explicit tick/velocityMidi inputs take precedence.
- Legacy step inputs are converted to the nearest integer tick; imported tick positions are never quantized. Notes expose read-only `startStep`/`durationSteps` getters for compatibility; update canonical ticks to edit timing.
- `removeById(id)` removes only that note.
- `updateNoteTiming(id, ticks, durationTicks)` edits the existing note object by stable ID. It requires integer ticks, at least one tick of duration, a nonnegative start and an end inside the current pattern. Use this for inspector edits and committed resize gestures. The legacy `addNote` API still accepts tails beyond the pattern, but UI edits/additions must fit; extend the pattern first.
- `ensurePianoTrack()` returns/creates the default manual musical track.
- `copyAtPpq(ppq)` stages an exact tick-rescaled copy of notes, tracks, tempo and meter maps (without an active import session). Noninteger tick conversions throw. `withMidiImport(source, importId)` builds a replacement import plus retained manual content without mutating either source; `withoutMidiImport()` builds the manual remainder.
- Note IDs are indexed to avoid quadratic duplicate checks during large imports. Add/remove notes through the model methods; do not change an existing note's ID directly.
- `removeNote(midi, startStep, trackId = 'piano')`, `hasNote(...)`, and `toggleNote(...)` are track-aware grid helpers. `removeNote` removes all matching notes on that track; use IDs to edit individual duplicates.
- `notesAt(step)` returns all tracks' notes starting in `[step, step+1)`.
- `stepToTick(step)` / `tickToStep(tick)` convert using four steps per quarter. Grid boundaries may be fractional ticks when PPQ is not divisible by four; imported notes remain integer ticks.
- `ticksToSeconds(ticks)` integrates the tempo map; `secondsToTicks(seconds)` is its continuous inverse.
- `positionAtTick(tick)` returns measure, beat, onBeat and meter. A meter change starts a new labeled measure, including changes in the middle of a preceding measure. The editing grid remains sixteenths; finer meter subdivisions may not coincide with grid lines.
- `visiblePitches(low = 36, high = 83)` returns descending MIDI rows; `pitchName(midi)` provides chromatic labels.
- `toJSON()` returns the plain version-2 data above. Future project persistence should additionally store engine loop bounds and sample asset references/trigger arrays. No backend persistence or JSON loader is implemented.

## Existing engine API and additions

### Context and transport

- `initContext(): void`: lazily creates the shared AudioContext and master GainNode. It does not resume it. Call in a user interaction when loading sample audio.
- `play(cursorTick?): Promise<void>`: resumes the context and the existing scheduler with a 50 ms lead. The UI supplies its precise editing cursor for fresh playback; direct legacy `play()` without an argument retains loop-start behavior. A supplied tick may be fractional for transport consumers; the editing cursor itself uses integer ticks. Play while paused resumes the saved/explicitly sought position rather than its argument. The initial pass and normal loop policy are described below. Await/catch it. Repeated calls share pending startup or do nothing while playing. Stop invalidates pending starts.
- `pause(): void`: saves the audible musical tick from `getPlaybackTick()`, cancels active/queued voices and samples through the existing Stop cleanup, invalidates pending startup, and retains that position for Resume. `isPaused` and `pausedTick` expose the paused state.
- `seekPaused(tick): void`: explicitly repositions a paused transport without starting audio. Has no effect while playing/stopped, validates composition bounds, and updates a pending Resume start if necessary. The composition end maps to loop start.
- `getPlaybackPosition(): {ticks, pass}`: reads the same audio clock without scheduling audio. `pass` is 0 for the initial audition pass, then 1, 2, … for full loop passes; it is null while paused/stopped. Together with `runId`, this lets the view distinguish wraps even when multiple loops pass between animation frames. Exact boundaries normalize sub-nanosecond arithmetic error.
- `getPlaybackTick(): number`: continuous transport position in PPQ ticks, integrating tempo segments through the initial audition pass and then wrapping inside the custom loop using the AudioContext clock. Transport positions can be fractional ticks; committed MIDI edits remain integers. Stopped returns loop start; paused returns the saved tick.
- `stop(): void`: clears the timer, invalidates legacy callbacks, cancels pending preparation, attempts every active/future pitched and sample cancellation independently, clears registries/visual events, calls the manager's optional Stop hook, and resets position to loop start. One throwing cancellation cannot skip healthy voices or samples. Synchronous failures are reported only after cleanup; reentrant Stop is safe.
- `setBpm(number)`: clamps finite values to 40–240; ignores non-finite input. For a constant-tempo composition it replaces that tempo. A composition with multiple tempo events rejects manual BPM changes rather than flattening the map; the UI disables BPM editing. Imported tempos outside the UI range are preserved and played without clamping.
- `setLoopRange(startStep, endStepExclusive)`: stopped-only integer bounds satisfying `0 <= start < end <= totalSteps`. Supports a single-step loop. UI endpoints are inclusive and one-based.
- `setPatternLength(steps)`: stopped-only coordinated resize of sequence, sample patterns, loop and position. Shortening past any note end or active sample trigger throws before mutation. Full-pattern loops expand with the pattern; custom loops are clamped. Changing pitch visibility never deletes notes.
- `replaceSequence(sequence)`: stopped-only application of an already validated NoteSequence. This low-level replacement API is unchanged. Sample buffers and trigger positions remain. Pattern length expands if needed to retain sample triggers. Loop resets to the full pattern; BPM reflects the initial tempo.
- `importMidiSequence(sequence)`: stopped-only provenance-aware import. Retains manual musical notes, replaces the prior import, applies the imported tempo/meter map, and resets the full-pattern loop. Called by `MidiIO.importInto`.
- `removeImportedMidi()`: stops active/pending playback and removes the current import group, restoring the preceding tempo/meter maps. Manual notes survive, migrating from removed imported tracks to Piano when needed. Uploaded samples and trigger patterns remain. With no active import, this is a no-op.
- `newSequence()`: stops active/pending playback, disconnects/removes every sample track and replaces the composition with a new 16-step, 480-PPQ, 120-BPM sequence containing one empty Piano track. It retains the shared AudioContext, master output and `voiceFactory` integration. The UI, rather than the engine API, owns the confirmation dialog and async-load invalidation.

### Sample compatibility (unchanged signatures)

```javascript
const engine = new SequencerEngine();
// Run from a user gesture; handle errors in production UI.
engine.initContext();
const response = await fetch('/samples/kick.wav');
const buffer = await engine.audioContext.decodeAudioData(await response.arrayBuffer());
engine.addTrack('kick', buffer);
[0, 4, 8, 12].forEach(step => engine.setStep('kick', step, true));
await engine.play();
```

- `addTrack(trackId, audioBuffer)` creates `{buffer, steps, gainNode, activeSources}`. Replacing an ID stops/disconnects the previous track and resets its pattern. The UI explicitly copies/reapplies old triggers when replacing uploaded samples.
- `removeTrack(trackId)` independently attempts every sample-source cancellation, clears the buffer and trigger references, disconnects gain, and removes the track. Cleanup errors are reported without skipping the remaining work. It does not stop the transport, pitched voices or other sample tracks.
- `setStep(trackId, stepIndex, isActive)` enables/disables a sample trigger; unknown tracks and noninteger/out-of-range indexes are ignored.
- Default sample gain is 0.8 and master gain is 0.7. These provide headroom, not guaranteed clipping protection for arbitrary samples or unlimited polyphony.
- Audio uploads reuse one context/engine, decode before replacement and ignore stale results. Failed uploads retain the old sample and triggers. MIDI import is a separate control.

### Timing and UI hooks

The same 25 ms timer schedules ahead by approximately 100 ms using `AudioContext.currentTime`. `advanceStep()` adds the tempo-map duration of that step. Fractional note offsets and note ends are converted separately through the map, including tempo changes within a note or within a step. Sample triggers use the same step timestamps. Late callbacks skip complete cycles and missed steps instead of producing overdue-note bursts.

`onStepTick(callback)` remains a single legacy approximate setTimeout-based hook, protected by run IDs. `getPlaybackStep()` consumes legacy step timestamps and returns the paused step when paused; the canvas line and follow tracker share one `getPlaybackPosition()` sample per animation frame. `getPlaybackTick()` remains the compatible tick-only accessor. Public `currentStep` is the NEXT queued step, not the audible position. `stepSeconds(step)` is a convenience musical-time conversion. `onError(error, details)` receives guarded diagnostics; legacy one-argument handlers remain compatible. `details` includes `phase`, `fatal` and, when available, note/track IDs. The built-in UI displays per-voice/hook failures as warnings and keeps healthy audio running. Unexpected scheduler errors are fatal and stop transport. Initial context/preparation errors reject `play()`. Errors in the reporting callback cannot interrupt cleanup. `audioErrors` retains the last 50 diagnostics.

The UI stops on hidden/pagehide. Space and the Play/Pause button toggle Play, Pause and Resume. Live edits affect only events not already queued. Whole-step batching can queue fractional notes slightly beyond the nominal horizon (up to one extra step). Sustained notes retain their scheduled end after a manual tempo edit. During loops, notes starting before loop start are not chased; notes crossing loop end ring for their original mapped duration and may overlap subsequent passes. Tempo maps repeat from loop start, while an already scheduled sustained voice is not retimed at the wrap.

## Instrument integration entry point and voice contract

The standalone editor requires no instrument plugin. It dispatches a **`jukebox:ready`** event on `document` after creating its one engine and initializing the UI. `event.detail.engine` is that same instance, not a new transport. Load a teammate's registration script **before `sequencer-ui.js`**, with normal ordered script loading, so it can listen before the ready event. No global engine variable is created.

`engine.registerInstrumentManager(manager)` is stopped-only. It validates the manager, safely stops existing audio, disposes the previous registered manager, installs the new voice factory and supplies the current musical track list. `registerInstrumentManager(null)` unregisters it and restores the temporary oscillator. New Sequence retains the manager; it synchronizes the reset tracks and invalidates preparation. Direct assignment to `engine.voiceFactory` remains supported for existing adapters; preload assets yourself in that mode. Unregister an existing manager before switching to direct assignment rather than mixing both approaches.

Manager methods:

```javascript
manager.createVoice(event, audioContext, outputNode); // Required: synchronous Voice
manager.prepare(audioContext, outputNode, { signal }); // Optional: void or Promise<void>
manager.stop();                                     // Optional: synchronous, idempotent
manager.syncTracks(tracks);                         // Optional: synchronous, musical metadata
manager.dispose();                                 // Optional: release manager-owned resources
```

`prepare` runs after context initialization/resumption and **before scheduling starts**. Load buffers and AudioWorklet modules here, never in `createVoice`. Successful preparation is cached until registration or composition/track replacement. Stop aborts an in-flight preparation signal and releases pending Play; late completion cannot restart the transport. A manager must still honor/check the signal and dispose its own cancelled setup work. JavaScript cannot forcibly cancel arbitrary plugin work. Preparation failures reject Play without starting a scheduling interval; retry can prepare again.

`syncTracks` receives copied musical track metadata on registration and composition replacement/import/removal/New Sequence. Reconcile removed track IDs, channel/program changes and manager-owned per-track resources. It receives metadata, not sample buffers, and may run before context creation. Direct mutation of the public track array is not automatically watched; make such configuration changes through your integration's explicit lifecycle. Lifecycle hooks should be synchronous and non-throwing; accidental returned Promise rejections are observed, but asynchronous Stop is not an immediate-silence guarantee.

The low-level factory is:

```javascript
engine.voiceFactory = (event, audioContext, outputNode) => {
    // event: id, midi (0–127), velocity (0–1), velocityMidi (1–127),
    // noteOffVelocity (0–127), trackId, channel (0–15), program (0–127),
    // ticks, durationTicks, startStep, durationSteps,
    // when (absolute AudioContext seconds), duration (seconds).
    return {
        stop() { /* synchronously cancel active AND future sources */ },
        finished: completionPromise
    };
};
```

Return a **fresh synchronous handle** for each scheduled occurrence. A Promise-returning/async factory is rejected, not awaited. Null handles, missing/noncallable Stop and nonthenable completion are rejected before registration. Malformed handles are cancelled best-effort; valid handles delivered by a mistaken async factory are also cancelled when they arrive. Throws and invalid handles skip that voice while other notes and samples continue. Rejected `finished` promises remove/cancel that voice and produce a diagnostic without an unhandled rejection.

`stop()` must be idempotent and safe before the scheduled start, while sounding, and after normal completion. `finished` must be a Promise or thenable that resolves only after all resources of that voice (including its release) have ended and been cleaned up. It should not reject; rejection is treated as a voice failure. `duration` is the scheduled note-gate duration; an instrument may implement a release afterwards, resolving `finished` when that release completes. `event.id` is a musical note ID, reused across loop passes, not a unique audio-instance ID. Do not deduplicate overlapping occurrences by that ID alone.

### Runnable registration example

For example, save the following as your teammate's adapter script and load it immediately before `sequencer-ui.js`. This runnable demonstration delegates sound to the existing temporary voice; replace that one delegation with the final prepared instrument engine. It implements no instrument presets or effects.

```javascript
document.addEventListener('jukebox:ready', (event) => {
    const engine = event.detail.engine;
    let tracks = [];

    engine.registerInstrumentManager({
        syncTracks(currentTracks) {
            tracks = currentTracks;
            // Reconcile manager-owned buses/resources for removed track IDs here.
        },
        async prepare(context, outputNode, { signal }) {
            // Await sample/AudioWorklet preparation here when the real engine exists.
            // Use this context, and check signal before attaching any new resources.
            if (signal.aborted) {
                return;
            }
        },
        createVoice(noteEvent, context, outputNode) {
            // noteEvent retains trackId, channel, program, pitch, velocity and timing.
            return engine.createPitchedVoice(noteEvent);
        },
        stop() {
            // Synchronously flush/mute manager-owned effect tails if applicable.
        },
        dispose() {
            tracks = [];
            // Disconnect manager-owned nodes. Never close the shared context.
        }
    });
}, { once: true });
```

### Ownership, routing and remaining integration limits

- The sequencer owns the AudioContext, transport and master output. Use the supplied context and `noteEvent.when`; never create a second clock, scheduler or context, and never close/suspend this shared context on Stop.
- Route `voice → optional per-track effects → outputNode`. The engine already connects `outputNode` (master gain) to the destination. Do not create duplicate destination paths or reconnect the master per note. Master-effects insertion requires one deliberate graph reconfiguration owned by the integration.
- Voice completion cleans only that voice's nodes. The manager owns persistent buses, processors, loaded assets and per-track selection. `syncTracks` reconciles track replacements; `dispose` releases manager resources on replacement/unregistration. New Sequence keeps the manager and context, not stale MIDI track IDs.
- A stopped source can leave reverb/delay buffers ringing. Use the manager's Stop hook to flush or gate those tails synchronously if immediate silence is required. The sequencer cannot clear arbitrary private DSP state; Stop errors are isolated and reported, not a guarantee that a broken plugin actually silenced itself.
- Sample tracks remain on their original buffer/gain path and do not pass through `voiceFactory`. Removing a sample does not call the instrument manager's Stop hook or flush shared effects, which could silence unrelated notes. Any future sample-specific effects need explicit per-track ownership and cleanup.
- Tempo-map timing and note endpoints are already converted to seconds. Already scheduled voices are not retimed after edits; loop-tail and note-chasing policies are unchanged. Tempo-synchronized effects may require additional tempo-map integration later.
- The temporary sine voice uses the MIDI frequency formula and gain envelopes at velocity × 0.02 before master gain. Final instruments must provide their own gain staging. A manager that allocates audio but throws without returning a cancellable handle remains responsible for those allocations; the sequencer cannot recover unreported resources.

## MIDI APIs

- `MidiIO.inspect(Uint8Array | ArrayBuffer)` validates header/chunks/event boundaries, running status, note pairing counts, timing mode, and resource limits; returns source PPQ, note count, extent, and warnings.
- `MidiIO.parse(input)` returns `{sequence, warnings}` without changing playback state or the current composition.
- `MidiIO.importInto(engine, input)` parses/validates first, then calls `importMidiSequence`. Invalid imports or imports while playing leave the old composition intact.
- `MidiIO.encode(sequence)` returns `{bytes: Uint8Array, warnings}` for a format-1 SMF containing the musical tracks and a conductor track (the unused manual Piano track is omitted while an import is open), irrespective of the selected loop. UI downloads a Blob as `jukebox.mid`.

Supported subset: PPQ formats 0/1, MIDI pitches, exact integer start/duration ticks and source PPQ, positive-duration notes, note-on/off velocities, chords/overlaps, track names, channel/program identities, tempo changes and time signatures. End-of-track padding preserves pattern trailing silence. With unusual PPQ values, import pads the pattern to a step boundary representable by integer ticks; note positions/durations are unchanged. Formats 2 and SMPTE are rejected. Corrupt/unmatched or zero-duration notes are rejected rather than dropped. Resource limits: 10 MB input, 100,000 notes, 256 source chunks/255 decoded musical tracks, 65536 pattern steps, imported tempos 1–1000 BPM. Oversized arrangements fail with an error rather than being truncated.

@tonejs/midi may split mixed-channel/program source tracks into musical channel/program tracks. Original binary structure and program-change event positions are not retained. Program changes while a note on that channel is active are rejected because the library cannot pair them reliably. Same-pitch overlapping MIDI note-on/off events have no unique note IDs: pairing is FIFO; nested/reordered same-pitch note-offs may be interpreted differently by other software. Duplicates and chords are retained in the application; arbitrary lossless MIDI round-trip is not promised.

Controllers (including sustain), pitch bend, aftertouch, SysEx, key signatures, extra text/lyrics/markers, and nonstandard events are not retained/rendered; detected unsupported source events produce import warnings. Export always displays its note-focused exclusions. Program changes are metadata only, percussion is not synthesized as drums, and sustain/bends do not affect temporary playback. MIDI export contains no sample audio, JukeBox loop markers or application note IDs. MIDI string metadata follows the library's encoding and may vary for non-ASCII names.

## Unified All Notes editor

The piano roll displays **all musical tracks together**. The track dropdown is removed; tracks are not merged in the model or export. Stable track-based colors distinguish blocks. Selection shows the exact note ID, track name, channel, provenance, start/duration ticks and PPQ. New notes always use the default Piano track.

The canvas is only viewport-sized, scaled by device pixel ratio; a CSS spacer supplies the long scrollable timeline. Hit testing uses CSS coordinates relative to the canvas plus viewport scroll offsets. `PianoRollEditor` contains pure rectangle, hit/edge, navigation, duration and resize calculations; it has no audio clock or scheduler. Imported integer ticks are mapped to fractional step positions without snapping during display.

After import, the pitch limits expand to include every note and the editor navigates to the earliest **imported** start. It centers vertically on pitches near that start rather than keeping a stale scroll offset. **Find Notes** repeats navigation across all current notes and restores narrowed pitch limits as needed. It does not zoom a long song into one screen. The persistent summary distinguishes the total note count, remaining imported note count, original imported count, and musical track count. Scrolling never drops notes.

### Selection, length and resize

Click empty grid space with nothing selected to add a grid-aligned note. If notes are selected, the first empty-grid click only clears selection; a subsequent empty click creates a note. Click a note body to select it. Repeated clicks at the same overlap cycle through a deterministic reverse insertion order; **Next overlapping note** provides the same choice. The selected block is drawn last so its edges remain visible. A note's track and stable ID identify the exact record being edited. Clicks on selected notes no longer delete them accidentally; use **Delete note** explicitly. Fully overlapping notes remain independent records, even across different tracks.

The Length field is a decimal text field, avoiding native number-spinner minimum/step offsets. **±1 step** buttons and Arrow Up/Down in Length adjust each selected note by one rounded sixteenth-note tick delta (one-tick minimum for a single note; invalid group changes are rejected atomically). A new sequence defaults to one step. Selected fractional lengths are displayed without decimal truncation; exact duration ticks are also shown. Invalid/empty/nonfinite/nonpositive values are rejected. User-entered fractional edits convert to the nearest representable integer tick. Selecting an imported note never changes its ticks.

Drag either note edge using a mouse, pen or touch pointer:

- Right edge keeps the start fixed; left edge keeps the end fixed. After at least three CSS pixels of deliberate movement, resize duration snaps to a whole number of sixteenth-note steps relative to that fixed endpoint. For unusual PPQ, that duration is converted to the nearest representable integer tick.
- This relative snap preserves a fractional imported fixed endpoint. The first real drag explicitly changes its length to a whole-step duration; merely selecting/clicking never changes it. The Length field still accepts fractional durations, including one-tick notes, independently of mouse snapping.
- The normal drag minimum is one whole step, not a one-tick dot. If a fractional note at the pattern boundary cannot fit even one step, the preview leaves it unchanged and asks you to extend the pattern. All normal resize results remain inside the pattern. Existing tails outside the pattern still require extension before left-edge resizing.
- Move the right edge at least six CSS pixels **past the left boundary**, or the left edge past the displayed right boundary, to enter **red deletion preview**. Release deletes only that stable note ID. Dragging back restores the normal preview. Escape, pointer cancellation and lost capture preserve the original note.
- The inspector and block show candidate timing without changing the model until release. A committed deletion clears selection and the Length field returns to the new-note default. MIDI export and future scheduler calls read the updated model; already queued audio remains subject to the existing lookahead policy.
- Pointer capture supports movement/release outside the canvas and scroll-offset corrections. A drag never triggers click deletion or overlap cycling. Short imported notes have an eight-CSS-pixel minimum display/hit target; their true duration remains unchanged and is shown in ticks.

Note-body movement and multi-selection are described below. There is no drag autoscroll yet. Wheel/trackpad scrolling explores other measures. Canvas editing is pointer-based; length controls remain keyboard operable. +/− Measure uses the meter at the pattern end, while direct pattern-step input supports irregular lengths. Shortening past stored notes/triggers is rejected rather than deleting data.

## Iteration 2: selection and editing

Selection is a Set of stable note IDs, independent of MIDI records. A plain body click selects one note and repeated clicks cycle overlapping IDs as before. Shift-click toggles the hit note without clearing other selections. **Cmd/Ctrl+A** selects every musical note across tracks and measures; **Escape** clears selection when idle. Selected blocks are gold and the toolbar reports the selection count. Sample triggers are never part of this selection.

An empty-space click clears all selected IDs without creating a note or recording history. With no selection, an empty-space click creates a Piano note as before. This decision occurs in the click handler before note creation, not through a create/delete workaround. Moving at least three CSS pixels instead starts a marquee, whether or not notes were selected. Its rectangle is calculated in scrollable content coordinates and selects notes with **positive-area intersection with their actual musical rectangles** (touching only a boundary does not count; the eight-pixel hit-target extension does not count). All overlapping records qualify independently. A plain marquee replaces selection; Shift-marquee adds intersections to the original selection. Selection previews never change MIDI data. Escape, cancellation, or lost capture restores the pre-marquee selection.

Dragging a note body moves it; dragging a selected body moves the selected group. The horizontal displacement snaps to whole sixteenth-note steps and is converted once to integer ticks; vertical displacement snaps to semitones. Original fractional grid positions and relative tick/pitch offsets survive. The shared displacement clamps to the earliest start, latest end, and MIDI pitch 0–127. Notes with incompatible tails beyond the current pattern require pattern extension first. Scrolling offsets are included in both axes. The canvas and inspector preview changes without mutating playback/export data. Release commits one action; Escape, pointer cancellation and lost capture discard previews. Resize edges retain priority over bodies, and drag release suppresses click creation/cycling. No automatic edge scrolling is implemented.

### Clipboard and shortcuts

All editor shortcuts route through one document handler. They accept Cmd on macOS and Ctrl on Windows/Linux. Inputs (including number fields), textareas, selects, and editable content retain normal typing and clipboard behavior. Escape deliberately cancels an active pointer gesture even while a control has focus. Existing Length-field arrow handling remains local to that control. Alt-modified and unrelated shortcuts are left alone.

| Operation | Shortcut | Policy |
| --- | --- | --- |
| Play/Pause/Resume | Space | Fresh Play starts at the precise editing cursor and enters the configured loop after its initial pass. Resume uses the saved position, or a new cursor position explicitly chosen while paused. |
| Copy | Cmd/Ctrl+C | Copy selected note records to an in-application clipboard; originals stay unchanged. |
| Cut | Cmd/Ctrl+X | Copy, then remove the selected IDs as one undoable edit. |
| Paste | Cmd/Ctrl+V | Place the earliest copied start at the **editing cursor**, preserving relative tick positions and pitches. Repeated paste at the same cursor intentionally creates independent overlaps. |
| Duplicate | Cmd/Ctrl+D | Place a copy immediately after the source selection's latest note end, with its earliest start at that end. Duplicate also refreshes the internal clipboard from its source. |
| Delete selected | Delete / Backspace | Remove only selected IDs. |
| Undo | Cmd/Ctrl+Z | Restore the preceding note edit. |
| Redo | Cmd/Ctrl+Shift+Z | Reapply an undone note edit. |

Toolbar buttons provide clipboard/history operations without shortcuts. Paste and duplicate select their new records. Copies retain duration, velocity, note-off velocity, track identity, channel/program through that track, and pitch. They receive fresh IDs and `importId: null`, so Remove Imported MIDI keeps them (migrating them to Piano if their imported track is removed, as before). Copying does not modify source provenance. The clipboard is session-local and cleared when the sequence object is replaced; there is no system clipboard dependency.

Paste/duplicate safely extend the pattern to fit, up to 65536 steps, through the existing engine API. Expansion while playback/preparation is active is rejected before adding notes; stop first. Operations fitting the current pattern retain existing live-edit behavior. Undo removes pasted notes but **retains the expanded pattern length**, sample trigger arrays and current loop bounds. No collision resolution overwrites unrelated notes. MIDI export uses the same edited model and original musical track identities.

### Group resizing and history boundaries

With multiple notes selected, either edge applies a **shared duration delta** in ticks to all selected records, keeping **every start fixed**. Moving the right edge right lengthens; moving the left edge left lengthens. The delta snaps to whole steps before conversion to ticks, preserving fractional differences between original durations. It clamps against every note's end boundary and minimum duration. The minimum is one rounded whole step, except existing shorter notes may stay at their original duration. If those constraints cannot coexist, the group stays unchanged. Crossing an opposite edge never deletes a group. Single-note left/right resizing and drag-to-delete keep the Iteration 1 semantics above. Inspector Length assigns an absolute duration to **every selected ID**, keeping starts fixed. A common duration is displayed when equal; unequal durations show an empty field with a **Mixed** placeholder. ±1-step buttons and Length-field arrows apply a relative delta to each selected duration, preserving differences and fractional starts. Both paths prevalidate all note durations/endpoints, then apply one atomic history entry; boundary-crossing or nonpositive group edits are rejected without trimming or expansion. Extend the pattern explicitly first. Velocity continues editing the primary note only.

Each creation, deletion, move, resize, cut, paste, duplicate or inspector edit records one history entry. Entries store before/after records only for changed IDs, including all supported note metadata; no tempo maps, sample buffers, project data or audio nodes are copied into history. History retains at most 100 actions and 200000 changed-note records (always keeping the newest action). New edits clear Redo; selection/copy/cancellation do not. Undo/redo updates canvas, selection and inspector together. Already scheduled audio follows the existing scheduler lookahead policy.

Import/replacement, Remove Imported MIDI and New Sequence establish a new sequence identity and clear old history on the next editor operation. Explicit pattern-length changes also clear note history, preventing Undo from restoring notes beyond a deliberately shortened pattern. These arrangement operations themselves are outside note history; tempo, loop, sample and project operations are not undoable here.

### Milestone 1 verification

Run all six frontend suites listed below, the JavaScript syntax checks, and Spring Boot tests. The Iteration 2 suite adds selection/Shift/marquee, overlapping tracks, move previews and cancellation, pitch/tick boundaries, clipboard/provenance, export, group resizing, focus safety, history and a 100000-note movement calculation. Existing suites retain MIDI, sample, audio-clock and instrument integration coverage. These are automated fake-DOM/Web Audio tests, not manual browser verification.

Manual browser checklist after `sh mvnw spring-boot:run` at `http://localhost:8080/`:

1. Create several pitches across measures; Shift-click and marquee-select them. Test Shift-marquee, overlapping imported tracks, Cmd/Ctrl+A, Escape and the selection counter.
2. Drag bodies diagonally, including after scrolling both axes. Check the preview, group offsets, bounds, release outside the canvas, Escape and cancellation. Confirm edges still resize independently from bodies.
3. Copy, cut, paste at different ruler cursor positions and duplicate near the pattern end. Confirm new IDs, preserved track/velocity, safe pattern expansion and independent overlaps. Remove Imported MIDI and verify duplicates survive.
4. Undo/redo every operation, single-note edge deletion, group resizing and inspector edits. Undo then make a fresh edit and verify Redo is cleared. Type in all inputs to verify shortcuts never delete notes there.
5. Resize both edges of a group: starts must stay fixed, fractional duration differences must survive and crossing must never delete the group. Test minimum durations, pattern ends and Escape.
6. Export/reimport the edited MIDI, compare timing and tracks, then check tempo maps, looping, samples, Find Notes, New Sequence and real instrument/audio playback.

Native pointer capture, appearance, platform keyboard behavior and audible output still require this browser checklist; automated tests do not establish those results.

## Full-screen workspace, transport and paste cursor

The vanilla HTML/CSS workspace fills `100dvh`: a compact transport/project toolbar, a piano-roll editing toolbar, a flexible scrollable canvas viewport, and a status footer. **Workspace options** is a keyboard-accessible disclosure panel containing pattern length, pitch range, import removal/reset, overlapping-note navigation, detailed note information, and all existing sample controls. **Account** retains current-user fetch, Login/Register navigation and the POST Logout form; **Project Dashboard** links to the existing `/dashboard.html`. No dashboard, authentication, project storage, backend, or database APIs are changed. A ResizeObserver handles changes to the actual viewport in addition to window resize and scroll; pointer conversion remains relative to the current canvas bounding rectangle in CSS pixels.

The **Shortcuts** button opens a native modal dialog with an accessible name, Close button, native focus containment, Escape handling, and focus restoration to the opener. Bindings, button tooltips and keyboard guide entries derive from the same shortcut metadata. The guide also describes actual mouse gestures, scrolling and overlap navigation. While any native open dialog or active ARIA modal is present, global editor shortcuts do not run. Space additionally leaves focused buttons, links, disclosure summaries and menus to their normal keyboard behavior. Repeated Space keydown events are consumed without repeatedly toggling transport.

### True Pause/Resume

Pause saves the audible tick from the audio clock, **not** `currentStep`, which belongs to the lookahead scheduler. It cancels pending preparation, active/future pitched voices, sample sources and instrument-manager output using the existing robust cancellation path, invalidates prior run IDs, and clears queued visual markers. Resume reuses the same AudioContext and scheduler and anchors the saved position at the new audio start time. The first partial step schedules only note onsets at/after the saved tick. MIDI notes spanning that tick are rearticulated once for their remaining tempo-mapped duration; original note data stays unchanged. Sample triggers before that tick are not retriggered; already playing sample tails are cancelled and are **not audio-seeked** on Resume. Future triggers retain their mapped timing.

The orange playback line follows continuous `getPlaybackTick()` position, including tempo changes and loop wrapping; it stays at the paused tick. Stop clears pause and returns the transport to the existing loop-start state. Playback startup/preparation can be paused immediately and resumed without allowing stale async results or old callbacks to restart an earlier run. The manager's existing optional `stop()` hook is also used by Pause; no new mandatory instrument API or scheduler is introduced. Sustained instrument envelopes restart on Resume because the current voice interface has no seek/pause method. Changing loop bounds, pattern length, or replacing a sequence invalidates a saved transport pause. Tempo changes while paused retain the saved musical tick and Resume uses the new map. Fresh UI playback starts at the editing cursor. Moving that cursor while playing does not seek, restart, cancel voices or change the current run. Moving it while paused explicitly seeks the saved Resume position.

### Editing cursor lifecycle

Click or drag the sticky measure/beat ruler to set a teal line and triangle, with a compact **Measure · Beat · Step (absolute step · tick)** label. The pointer's continuous horizontal content coordinate is converted directly to ticks and rounded **once to the nearest MIDI tick**, without flooring to a grid step. The cursor is clamped to `[0, floor(stepToTick(stepCount))]`. This is the last integer-tick position in patterns whose PPQ gives a fractional endpoint. Existing note creation and movement snapping are unchanged.

Pointer down positions the cursor immediately and captures the pointer. Pointer moves and the final release update it live in either direction, even outside the ruler. The captured gesture never enters note creation, movement, resize or marquee handling; its follow-up click is suppressed. Escape, pointer cancellation and lost capture restore the cursor and the prior paused transport tick independently, preserving any fractional paused position. Cursor movement and cancellation do not enter note-edit history. Scrolling during capture recalculates from the last screen coordinate after repositioning the viewport canvas. Resizing redraws the same tick position; no automatic edge scrolling is added.

Paste uses that exact integer cursor tick as the earliest copied note's destination, with no step rounding. Relative tick differences, track identity, duration, velocity, fresh stable IDs and manual provenance retain their existing rules. Safe stopped expansion, Undo/Redo and MIDI export all use those same committed tick records. Repositioning the cursor never quantizes existing notes or modifies selection/loop markers. Teal distinguishes it from the moving orange playback line.

### Initial playback pass and loop policy

The cursor determines only the beginning of fresh UI playback. Neither loop marker changes:

| Cursor position | Initial pass | Following passes |
| --- | --- | --- |
| Before loop start | Cursor → loop end (including the material before the loop) | Full loop start → loop end |
| Inside loop | Cursor → loop end | Full loop start → loop end |
| At/beyond loop end, before composition end | Cursor → composition end | Full loop start → loop end |
| At composition end | Start at loop start immediately | Full loop start → loop end |

The cursor's final integer endpoint is treated as composition end even when the underlying step/PPQ endpoint is fractional. Transport pause positions still retain their exact fractional ticks. Direct engine consumers may call `play(tick)` for the same initial-pass policy, or omit the argument to retain legacy loop-start playback.

The scheduler tracks the current pass endpoint separately from the configured loop end. When it advances through that endpoint, it switches to the normal loop start/end. The audio-clock playhead independently integrates the initial remaining duration and then full-loop cycles. Delayed callbacks skip the remaining initial pass before skipping repeated loops, preserving tempo-map phase without replaying stale onsets. Initial partial-step scheduling skips earlier note/sample onsets; sustained MIDI notes spanning the chosen tick are rearticulated once for their remaining mapped duration. Existing natural note tails can still ring over a wrap, but onsets are not scheduled twice at that boundary. No second timer, context or scheduler is created.

Pause saves the currently audible musical tick, whether in the initial pass or a later loop. Resume without cursor movement continues from that tick and the appropriate endpoint. Deliberately clicking/dragging the ruler while paused is an explicit seek; Resume starts from the new cursor and reapplies the initial-pass policy. Cancelling that gesture restores the previous saved Resume tick as well as the old editing cursor. A ruler movement while playing changes editing/paste state only. Stop cancels audio and clears pause as before; the stationary editing cursor remains, and the next fresh UI Play starts there again.

- Startup and successful MIDI import/replacement: cursor resets to tick zero for the new sequence/PPQ.
- New Sequence and Remove Imported MIDI: cursor resets to tick zero.
- Play, Pause, Resume, Stop, Find Notes, viewport changes and ordinary note edits: cursor stays fixed in musical ticks.
- Explicit pattern resizing: cursor stays fixed when valid and clamps to the new pattern end when shortened.
- Paste/duplicate expansion: cursor stays fixed; custom loop markers retain existing engine behavior.
- Undo/redo: cursor stays fixed. Undo of an expanding paste removes notes but leaves pattern expansion in place, as before.
- Invalid/cancelled imports and a cancelled New Sequence: cursor stays unchanged.

### Follow-up verification and remaining limits

`workspace-tests.js` covers three/four-note absolute length assignment, relative/fractional changes, Mixed/common display, atomic boundary rejection, single-entry history, mouse-resize synchronization, Space transport, queued voice/sample cancellation, rapid startup races, tempo-map/custom-loop position, cursor scrolling/paste/export/lifecycle, unsnapped captured dragging/cancellation, precise PPQ conversion, initial playback passes before/inside/after loops, paused cursor seeking, empty-click deselection without history, help focus and keyboard guards, viewport resize callbacks and preserved markup/control IDs. The fake DOM/Web Audio tests do not verify native layout, focus trapping, real browser audio, authentication server behavior, or instrument envelope quality.

Verification results for this follow-up: **161 frontend tests passed** (25 sequencer, 32 editor, 16 Iteration 2, 15 voice integration, 41 workspace, 32 navigation/follow); **14 Spring Boot tests passed**, with no failures/errors/skips; `node --check` passed for **15 JavaScript files** and `git diff --check` passed. These automated runs are separate from manual checks. No manual browser/audio verification was performed in this follow-up. The prior browser attempt was blocked by unavailable browser access and missing Computer Use permission; the existing local server was left untouched.

Manual follow-up at the running app (or `sh mvnw spring-boot:run` when port 8080 is free):

1. At laptop and desktop window sizes, confirm the roll fills the remaining height without page scrolling, both toolbars wrap accessibly, Workspace options scrolls, and Account/Project Dashboard navigation remains intact.
2. Select three then four unequal-length notes. Confirm **Mixed**, assign 4, then Undo/Redo. Test relative ±1 on fractional durations, boundary rejection, and inspector updates after mouse group resizing.
3. Use Space from the roll to Play/Pause/Resume, including rapid taps, custom loops and tempo maps. Listen for cancelled queued notes, remaining held-note retriggers, sample behavior and instrument manager cleanup. Stop must reset the transport to loop start, and the next fresh Play must use the unchanged editing cursor. Space in inputs, a focused button, Account menu or the help dialog must retain native behavior.
4. Copy a chord, extend the pattern to measure 5, click between ruler steps and Paste at that exact tick. Drag the cursor both directions, scroll horizontally during capture, resize the window, then test Escape/lost capture. Select the chord and click empty grid space: selection must clear without adding a note; click again to create one. Test fresh Play inside a loop, before loop start, at/after loop end, and at composition end; after the initial pass verify full-loop repetition. Pause and Resume without moving the cursor, then seek by moving it while paused; moving it during playback must leave audio uninterrupted. Check independent teal/orange lines, preserved relative timing/track/velocity, fresh IDs, Undo/Redo and exported MIDI. Test after horizontal scrolling, resize and high DPI.
5. Open Shortcuts, Tab/Shift+Tab through the native dialog, close with Escape or Close, and verify focus returns to Shortcuts without editing notes. Confirm clipboard/transport shortcuts do nothing while the dialog is open.

No drag autoscroll, audio sample seeking, velocity lane, quantization tools, recording, notation icons or later Iteration 2 features are added here. Inspector duration edits deliberately reject timeline overflow; stopped paste/duplicate may expand through the existing engine API. The next milestone should follow real-browser review of these editing and transport changes.

## Directional note navigation and midpoint playback follow

### Arrow navigation

Unmodified Arrow Right/Left/Up/Down navigate only when **exactly one eligible musical note** is selected. Zero or multiple selected IDs are unchanged. A missing directional candidate is a no-op. No note data, cursor, transport timing, or undo/redo entry changes; a successful navigation replaces the selected ID and refreshes highlighting, count and inspector. The existing arrow controls inside Length still adjust durations locally. Global navigation is ignored in text/number inputs, textareas, selects, editable content, open dialogs and focused native/menu controls. Cmd/Ctrl/Alt/Shift-modified arrows retain their native behavior. Only successful editor navigation prevents default scrolling.

The coordinates are the **musical center** (`ticks + durationTicks / 2`) and MIDI pitch. Centers use the full canonical duration even when clipped or extending beyond the viewport. They do not use CSS rectangles, pixels, note heads alone or note ends alone. Distance is compared with doubled centers to preserve half-tick positions:

```js
selectedCenterTimes2 = 2 * selected.ticks + selected.durationTicks;
candidateCenterTimes2 = 2 * candidate.ticks + candidate.durationTicks;
scaledD = 4 * Math.abs(candidateCenterTimes2 - selectedCenterTimes2)
        + 2 * sequence.ppq * Math.abs(candidate.midi - selected.midi);
```

This equals (sixteenth-step center distance + semitone distance) × 2 × PPQ and retains fractional grid timing at any supported PPQ. Ordinary pattern bounds use safe Number arithmetic. A conservative doubled-center bound of `floor(Number.MAX_SAFE_INTEGER / 8)` guarantees room for scaled distances; larger legacy safe-integer note tails switch the entire comparison to exact BigInt arithmetic. Ranking remains linear, and no musical data is converted or modified.

| Arrow | Strict directional eligibility | Equal-distance priority |
| --- | --- | --- |
| Right | Candidate center is strictly later | Higher pitch, then earlier musical center |
| Left | Candidate center is strictly earlier | Higher pitch, then earlier musical center |
| Up | Candidate pitch is higher | Earlier musical center, then higher pitch |
| Down | Candidate pitch is lower | Earlier musical center, then higher pitch |

Final ties use the stable note ID's lexical **code-unit** ordering, independent of insertion order and locale. Diagonal candidates are valid; identical centers and pitches are not directional candidates for each other, and retain normal mouse overlap cycling. Notes with identical starts but unequal durations can be horizontal candidates; different starts with identical centers cannot.

`PianoRollEditor.eligibleNotes(sequence, view)` centralizes eligibility. The current UI is All Notes and has no per-track filter control. The helper accepts an optional `trackId` (null means all) and `hiddenTrackIds` Set for filtered callers; tracks with `hidden: true` or `visible: false` are excluded. These optional flags affect the editor view, not playback or MIDI export. UI navigation, rendering and hit testing also respect configured low/high pitch limits. Offscreen rows inside that range remain candidates. Ctrl/Cmd+A still includes pitches outside the current pitch range on eligible tracks; Find Notes can expand the range as before. No new track/filter UI is introduced.

`revealNote()` computes the smallest horizontal/vertical change that exposes the chosen note within the musical grid, accounting for the fixed 100px keyboard and 32px ruler. A block that fits is fully revealed; an oversized block reveals its head rather than chasing its distant tail. Reveal geometry remains unchanged: ranking uses duration through the musical center, while revealing a long block still exposes its head without chasing its tail. Navigation that changes horizontal scroll releases playback following through the same manual-navigation path as Find Notes; vertical-only or already-visible navigation does not cancel horizontal follow.

### Stop button and immediate Space restart

The previous Stop/Space failure came from retained button focus: the centralized handler deliberately ignores Space on focused buttons, so a subsequent Space would perform the button's native Stop action again instead of invoking Play. Only the explicit Stop-button click handler now calls `stopPlayback()` and then focuses the existing piano-roll viewport with `preventScroll: true`. Mouse clicks and native Enter/Space activations share this handler. The next Space therefore targets the editor and starts a fresh pass from its editing cursor.

Stop remains a normal focusable button with native Enter/Space activation. Its initial native Space activation is not intercepted or combined with Play; focus moves after the Stop action, so only a subsequent Space starts playback. Unrelated buttons, inputs, selects, editable content and dialogs keep their existing global shortcut protections. Background Stop paths (errors, lifecycle and sequence operations) do not use this focus handoff. No scheduler, transport state machine or playback-follow behavior changes are made for this fix.

`workspace-tests.js` includes six focused regression cases for mouse Stop then immediate Space, native Enter/Space Stop activation without a second Stop, Start/Pause/Resume/Stop/Start during an initial partial pass and a repeated custom loop, editing-cursor start position, cancellation of old voices, one scheduler, and unchanged input/dialog/button guards. Native button keyup behavior is modeled in the fake DOM tests; it still needs real-browser verification.

Manual checks: click Stop during playback, immediately press Space, and confirm one fresh playback start at the unchanged editing cursor. Repeat by tabbing to Stop and activating it with Enter and Space. Confirm Stop remains reachable by Tab and that focus returns to the piano roll without changing scroll position. Repeat with custom loops, while following, and while starting after the custom loop; typing fields, Shortcuts and unrelated focused buttons must retain their normal Space behavior.

### Midpoint follow state machine

`PianoRollFollow` is a view-only tracker loaded with `PianoRollEditor.js`. The existing animation loop samples the engine's audio-clock position and loop pass once, updates tracking, applies bounded scrolling, and draws the orange line with the new offset. It does not schedule sound or write MIDI data. There is no additional timer or animation chain.

The musical midpoint excludes the fixed keyboard:

```js
gridWidth = viewport.clientWidth - keyboardWidth;
midpointX = keyboardWidth + gridWidth / 2;
contentX = sequence.tickToStep(playbackTick) * stepWidth;
desiredScrollLeft = contentX - gridWidth / 2;
```

| State | Behavior / transition |
| --- | --- |
| DISARMED | No automatic scrolling. A clearly left-of-midpoint observation arms it. Starting at/right of center never immediately follows. |
| ARMED | Grid stays stationary. A subsequent advancing audio-clock sample crossing from left to center/right enters FOLLOWING. |
| FOLLOWING | Each existing animation frame directly applies the centered, bounded horizontal offset. No CSS smooth scrolling or lagging easing. |

Arming requires more than 0.5 CSS pixel to the left to avoid boundary flicker. Crossing requires actual forward tick movement and reaching the midpoint. Starting exactly at the midpoint does not lock. A manually interrupted playhead at/right of center may leave the viewport entirely; it cannot relock until observed left and then crossing again.

### Manual interference, wraps and bounds

All intentional programmatic horizontal navigation uses one wrapper and releases follow before changing `scrollLeft`. Native horizontal wheel/trackpad and Shift+wheel intent, horizontal scrollbar interaction, and any observed external horizontal offset change also release it. Ordinary vertical pitch scrolling does not. At the changed offset the current audio-clock position seeds a fresh readiness observation, so scrolling ahead can arm **without centering**, then a later musical crossing locks again. This can repeat throughout the same playback run.

Automatic writes immediately record the actual clamped/rounded `scrollLeft` read back from the browser. Both scroll handlers and the animation loop compare the current offset with that last observed/applied value before any follow write. A difference is manual/external navigation; a queued automatic scroll event reading the same offset is ignored as interference. This avoids timer-based suppression flags and assumptions about delayed/coalesced scroll-event ordering. Captured note, resize and ruler gestures yield follow while active, so automatic movement cannot alter an in-progress edit beneath the pointer; on release it reassesses readiness.

The scroll range stays `[0, max(0, keyboardWidth + patternSteps * stepWidth - viewport.clientWidth)]`. Near composition end, when centering would exceed that maximum, the viewport stays at the boundary and the orange line moves right naturally. Short patterns never manufacture extra measures or horizontal space.

A changed run ID, changed loop pass (including several skipped passes), backward position jump, or changed viewport width discards the old crossing observation. It seeds ARMED/DISARMED at the current viewport without forcing a jump. Loop wraps therefore reveal the new loop-start position wherever it falls in the existing viewport, and can follow again only after a new crossing. Pause freezes the viewport and resets readiness; Resume reassesses at its saved/explicitly sought tick. Stop resets follow immediately. Fresh cursor playback and all initial-pass/custom-loop rules remain unchanged. Moving the editing cursor during playback still does not seek audio, and following never moves that stationary editing cursor.

### Verification and manual browser checks

`navigation-follow-tests.js` has 32 tests covering musical-center distance (including unequal durations, half-tick centers, identical starts/centers, exact large-tail arithmetic and rejected screen-geometry getters), all four directional/tie rules, exact PPQ timing, overlap IDs, eligibility, single-selection/focus guards, minimal reveal, no MIDI/history edits, 100000 candidates, midpoint state transitions, delayed automatic/manual scroll events, wheel/scrollbar/vertical input, repeated rearming, loop/seek/pause/restart/resize transitions, short/end/long-pattern bounds, navigation during follow, tempo-map audio-clock position, and one animation/listener chain.

No real-browser or audible verification is claimed for this change. After starting the app:

1. Select one note among diagonally arranged notes and press every arrow; inspect tie cases and verify duration changes influence selection through musical centers, including notes whose centers reverse their head order. Try zero/multi-selection, Length arrows, focused menus and Shortcuts help. Navigate beyond each visible edge and confirm minimal reveal.
2. On a long pattern, Play from left of the musical midpoint. Confirm no initial scroll, then an orange midpoint lock. Start at/right of midpoint and verify no automatic recentering, even when it leaves the screen.
3. During following, try trackpad scrolling, Shift+wheel and scrollbar dragging. The grid must stay under your control. Scroll ahead to put the playhead left of center, then confirm a later crossing locks again; repeat several times. Vertical-only scrolling should preserve follow.
4. Navigate with arrows during playback: an offscreen horizontal reveal must release follow without affecting audio or the teal cursor; onscreen/vertical-only selection should not fight tracking.
5. Test custom loops, initial passes outside the loop, tempo maps, Pause/Resume, paused cursor seeking, Stop/restart, viewport resizing and the timeline end. A wrap must never snap the viewport back merely to center the playhead. Verify sample/instrument audio and exported MIDI remain unchanged.

Remaining limits: no drag-edge autoscroll, no added track-filter control, and no active-playback seeking feature. Dense files still require linear scans for navigation/rendering; no spatial index is introduced. Native trackpad/scrollbar momentum, browser subpixel rounding and visual smoothness require the manual checks above. Audio sample-tail seeking and instrument rearticulation limits remain as previously documented.

## Sample-trigger editor

This is a sample-trigger sequencer, not a waveform/audio-track editor. Upload audio, enter **Trigger at step**, then **Add Trigger**. UI positions are 1-based sixteenth-note steps: in 4/4, steps 1, 5, 9 and 13 begin the four beats. Internally, `setStep('uploaded', displayedStep - 1, true)` uses zero-based indexes.

Accept integer positions from 1 through the current pattern length. Empty, nonfinite, fractional, negative, zero, out-of-range and duplicate positions are rejected. Active triggers are listed numerically, each with a Remove control. The list has 50 entries per page and previous/next controls; it does not create a button for every pattern step. It is independent of piano-roll scrolling and musical note data. Pattern resizing updates the input range; engine validation still prevents shrinking past any active trigger.

**Remove Sample** calls the existing `removeTrack('uploaded')`, clears the upload input/name/trigger controls and invalidates pending audio uploads. It stops active and queued sample sources, releases the buffer/trigger references and disconnects their gain node. It leaves transport, piano-roll voices, MIDI data, tempo maps and loop settings unchanged, including during playback. New uploads start empty after removal; ordinary sample replacement retains the previous sample trigger pattern. A manager's shared effect tails are not globally flushed when removing only a sample.

## Import provenance and removal

`note.importId` is null for manual notes and a session ID for imported notes. Imported tracks carry `importId` and `sourceTrackId`; they retain source name, channel and program. Editing pitch/timing/velocity does not clear imported provenance. Application IDs/provenance are not MIDI-standard fields and are not exported; reimporting a file starts a new import group.

`sequence.importInfo` stores the current group ID, original imported count, prior composition name/pattern length and preceding tempo/meter maps. `toJSON()` includes this optional information for future persistence. No database or JSON loader is implemented.

Import policy:

1. A new MIDI file replaces only the previous imported group (including edited imported notes), preserving manual notes created before or after it.
2. Retained manual notes on a removed imported track migrate to Piano. Separate manual tracks are retained.
3. Imported tempo/meter maps apply globally during playback; the previous maps are restored when the import is removed. Later manual BPM changes while an import is open do not overwrite that saved baseline.
4. Imported and manual ticks share one PPQ. If manual notes exist, use their PPQ's least common multiple with source PPQ, preserving exact beat positions. If this exceeds SMF's 32767-PPQ limit, reject the import before mutation. No silent timing rounding is used. Source PPQ is retained when no rescaling is needed; PPQ need not revert after removal because surviving notes may use its finer resolution.

**Remove Imported MIDI** stops playback, cancels pending MIDI replacements, removes all notes belonging to the current import (including edited ones), migrates surviving manual notes as above, restores the prior tempo/meter maps, clears selection and MIDI input, and resets the loop to the remaining complete pattern. Manual content, audio sample buffers and patterns survive; the remaining pattern expands if required for them. The same MIDI file may then be imported again. Pending audio sample uploads remain independent.

**New Sequence** first asks for confirmation. Cancel performs no changes. Confirm stops active/pending audio, invalidates pending MIDI and audio loads, removes every musical note, import and sample track, and restores one Piano track, 120 BPM, 16 steps, full loop, default note length/velocity, C2–B5 visibility centered near C4, and empty file inputs/status. It does not reload the page or create a new scheduler/context. Instrument callbacks remain attached to the existing engine.

## Testing and limitations

Run:

```sh
node src/test/frontend/sequencer-tests.js
node src/test/frontend/editor-tests.js
node src/test/frontend/iteration2-tests.js
node src/test/frontend/workspace-tests.js
node src/test/frontend/navigation-follow-tests.js
node src/test/frontend/voice-integration-tests.js
sh mvnw test
sh mvnw spring-boot:run
```

Open `http://localhost:8080/`. No npm install is required. Tests use the actual bundled MIDI parser/encoder plus fake Web Audio, pointer capture, preparation cancellation and canvas operations. A synthetic 1696-step/22-track file with an empty first track exercises the visibility regression. Other editor tests cover all-note rendering, navigation/pitches, overlap isolation, both resize edges, scroll/DPI offsets, fractional timing, input validation, cancellation, provenance, PPQ conflicts, export and reset/load races. Automated mocks cannot prove real browser rendering, native pointer capture or audible output. No new manual browser/audio verification is implied.

Manual checks:

1. Import the long MIDI file. Confirm the total count, visible notes near the first musical entry, all-track colors, and Find Notes after scrolling far away.
2. Select overlapping notes by clicking repeatedly or using Next overlapping note; check track/ID labels and edit only the intended note.
3. Add a C4 note; use +1 step three times to reach 4, then −1 to reach 1. Select fractional imported notes and inspect exact ticks without changing them.
4. Drag each note edge across steps/measures; verify left edits preserve the end, right edits preserve the start, minimum/boundary clamping, inspector synchronization, release outside the canvas and Escape/pointer cancellation. Test after horizontal scrolling and on a high-DPI display.
5. Export edited notes, open New Sequence, reimport and compare the supported timing/track subset. Use a separate player if checking round-trip acoustics; controllers/sustain are excluded as documented.
6. Create manual notes before and after import, upload a sample and enable triggers, then Remove Imported MIDI. Only imported notes/metadata should disappear; manual notes and samples must remain.
7. Try New Sequence with Cancel and Confirm, including during playback or a pending upload. Confirm restores the complete empty starting state; late async results must not restore old content.
8. Rerun BPM, tempo-map playback, looping, Play/Stop, sample replacement, and invalid MIDI rollback checks.
9. Drag each edge past the opposite boundary: check the red preview, restore it by dragging back, then test release, Escape and pointer cancellation. Check imported one-tick notes stay untouched on click and remain selectable.
10. Upload a sample on a long pattern; add triggers at steps 1, 128 and 1696, remove one, and test invalid/duplicate entries. Use previous/next pages if many triggers exist. Remove Sample during playback and confirm musical voices continue.
11. Load the runnable instrument registration example before the UI. Check preparation precedes playback, Stop during preparation prevents a late start, and source/voice failures produce warnings while healthy voices continue.

Remaining limitations: no arbitrary lossless MIDI round-trip, controller/sustain/bend rendering, MIDI devices, WAV export, drag autoscroll, final instruments/effects, collaboration or persistence. Notes that began before loop start are not chased, and scheduled tails can ring over loop boundaries as described above. Rendering is virtualized; very dense files still require scanning visible candidates from the model. Source sample/audio, unsupported MIDI events and application provenance are excluded from MIDI export. The compatible, now validated `voiceFactory` contract continues to receive original per-note track identity, channel/program, pitch, velocity and committed tick timing on the shared audio clock. Final instrument/DSP behavior still requires testing with the teammate's implementation; automated mocks do not verify audible effects-tail flushing.
