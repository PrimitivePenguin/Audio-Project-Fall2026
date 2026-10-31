# JukeBox sequencer and MIDI API — Iteration 1

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
- `play(): Promise<void>`: resumes the context, starts at loop start with a 50 ms lead, and begins the existing scheduler. Await/catch it. Repeated calls share pending startup or do nothing while playing. Stop invalidates pending starts.
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

`onStepTick(callback)` remains a single legacy approximate setTimeout-based hook, protected by run IDs. `getPlaybackStep()` consumes timestamps against the audio clock for the canvas playhead. Public `currentStep` is the NEXT queued step, not the audible position. `stepSeconds(step)` is a convenience musical-time conversion. `onError(error, details)` receives guarded diagnostics; legacy one-argument handlers remain compatible. `details` includes `phase`, `fatal` and, when available, note/track IDs. The built-in UI displays per-voice/hook failures as warnings and keeps healthy audio running. Unexpected scheduler errors are fatal and stop transport. Initial context/preparation errors reject `play()`. Errors in the reporting callback cannot interrupt cleanup. `audioErrors` retains the last 50 diagnostics.

The UI stops on hidden/pagehide. There is no pause. Live edits affect only events not already queued. Whole-step batching can queue fractional notes slightly beyond the nominal horizon (up to one extra step). Sustained notes retain their scheduled end after a manual tempo edit. During loops, notes starting before loop start are not chased; notes crossing loop end ring for their original mapped duration and may overlap subsequent passes. Tempo maps repeat from loop start, while an already scheduled sustained voice is not retimed at the wrap.

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

Click empty space to add a grid-aligned note. Click a note body to select it. Repeated clicks at the same overlap cycle through a deterministic reverse insertion order; **Next overlapping note** provides the same choice. The selected block is drawn last so its edges remain visible. A note's track and stable ID identify the exact record being edited. Clicks on selected notes no longer delete them accidentally; use **Delete note** explicitly. Fully overlapping notes remain independent records, even across different tracks.

The Length field is a decimal text field, avoiding native number-spinner minimum/step offsets. **±1 step** buttons and Arrow Up/Down adjust by one sixteenth-note step from the canonical duration (clamped to a minimum of one MIDI tick). A new sequence defaults to one step. Selected fractional lengths are displayed without decimal truncation; exact duration ticks are also shown. Invalid/empty/nonfinite/nonpositive values are rejected. User-entered fractional edits convert to the nearest representable integer tick. Selecting an imported note never changes its ticks.

Drag either note edge using a mouse, pen or touch pointer:

- Right edge keeps the start fixed; left edge keeps the end fixed. After at least three CSS pixels of deliberate movement, resize duration snaps to a whole number of sixteenth-note steps relative to that fixed endpoint. For unusual PPQ, that duration is converted to the nearest representable integer tick.
- This relative snap preserves a fractional imported fixed endpoint. The first real drag explicitly changes its length to a whole-step duration; merely selecting/clicking never changes it. The Length field still accepts fractional durations, including one-tick notes, independently of mouse snapping.
- The normal drag minimum is one whole step, not a one-tick dot. If a fractional note at the pattern boundary cannot fit even one step, the preview leaves it unchanged and asks you to extend the pattern. All normal resize results remain inside the pattern. Existing tails outside the pattern still require extension before left-edge resizing.
- Move the right edge at least six CSS pixels **past the left boundary**, or the left edge past the displayed right boundary, to enter **red deletion preview**. Release deletes only that stable note ID. Dragging back restores the normal preview. Escape, pointer cancellation and lost capture preserve the original note.
- The inspector and block show candidate timing without changing the model until release. A committed deletion clears selection and the Length field returns to the new-note default. MIDI export and future scheduler calls read the updated model; already queued audio remains subject to the existing lookahead policy.
- Pointer capture supports movement/release outside the canvas and scroll-offset corrections. A drag never triggers click deletion or overlap cycling. Short imported notes have an eight-CSS-pixel minimum display/hit target; their true duration remains unchanged and is shown in ticks.

There is no drag autoscroll or note-body movement yet. Wheel/trackpad scrolling explores other measures. Canvas editing is pointer-based; length controls remain keyboard operable. +/− Measure uses the meter at the pattern end, while direct pattern-step input supports irregular lengths. Shortening past stored notes/triggers is rejected rather than deleting data.

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

Remaining limitations: no arbitrary lossless MIDI round-trip, controller/sustain/bend rendering, MIDI devices, WAV export, note-body dragging, drag autoscroll, final instruments/effects, collaboration or persistence. Notes that began before loop start are not chased, and scheduled tails can ring over loop boundaries as described above. Rendering is virtualized; very dense files still require scanning visible candidates from the model. Source sample/audio, unsupported MIDI events and application provenance are excluded from MIDI export. The compatible, now validated `voiceFactory` contract continues to receive original per-note track identity, channel/program, pitch, velocity and committed tick timing on the shared audio clock. Final instrument/DSP behavior still requires testing with the teammate's implementation; automated mocks do not verify audible effects-tail flushing.
