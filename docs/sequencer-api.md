# Sequencer Engine Documentation

A 16-step, multi-track sample sequencer built on the Web Audio API. Timing uses a lookahead scheduler driven by the audio clock (`audioContext.currentTime`), so ordinary timer jitter does not determine audio start times. Long stalls can still drop steps.

---

## Quick Start

```javascript
const engine = new SequencerEngine();

// Load a sample (must happen after a user gesture for audio to be audible)
engine.initContext();
const response = await fetch('/samples/kick.wav');
const audioBuffer = await engine.audioContext.decodeAudioData(await response.arrayBuffer());
engine.addTrack('kick', audioBuffer);

// Basic "4 on the floor" kick pattern
[0, 4, 8, 12].forEach((i) => engine.setStep('kick', i, true));

engine.onStepTick((step) => highlightStep(step)); // your UI function
playButton.addEventListener('click', () => engine.play());
```

---

## API Reference

### Initialization & Transport Controls

#### `initContext(): void`
Creates the internal `AudioContext` and master gain node if they do not exist yet. Context resumption is awaited by `play()`.

> **Note:** `play()` and `addTrack()` call this automatically. However, browsers keep a new `AudioContext` suspended until a user gesture, so the first call should happen inside a click handler (for example, the play button). The UI defers initialization until Play or file selection; `play()` awaits resumption.

#### `play(): Promise<void>`
Resumes the shared audio context, starts at the loop start, and starts the existing lookahead scheduler. Await and catch the returned Promise. Repeated calls share a pending start or do nothing when running. Stop invalidates pending starts.

#### `stop(): void`
Halts playback, clears the scheduler interval, resets the current step to the loop start, and immediately silences all currently playing or already-scheduled audio sources. Invalidates pending step-highlight callbacks from the previous run.

#### `setBpm(newBpm: number): void`
Updates the tempo. Affects newly scheduled steps; events already queued within the 100 ms horizon are unchanged. Playback is not interrupted.
* **Parameters:** `newBpm` *(number)* - Clamped to `MIN_BPM`-`MAX_BPM` (40-240). Non-finite values (`NaN`, `Infinity`) are ignored and the tempo is left unchanged.

---

### Track & Grid Management

#### `addTrack(trackId: string, audioBuffer: AudioBuffer): void`
Registers a new track with a decoded audio sample. Creates a dedicated `GainNode` (default `0.8`) routed to the master gain, and initializes all steps to off.
* **Parameters:**
    * `trackId` *(string)* - Unique identifier for the track (e.g. `'kick'`).
    * `audioBuffer` *(AudioBuffer)* - Decoded Web Audio API buffer.
* **Note:** Track IDs must be unique. Reusing an ID now safely stops and disconnects the old track before replacement. Replacement resets its pattern; callers may copy the old steps and reapply them.

#### `removeTrack(trackId: string): void`
Stops any playing sources on the track, disconnects its gain node, and removes it from the engine. Does nothing if the ID doesn't exist.
* **Parameters:** `trackId` *(string)* - Track identifier.

#### `setStep(trackId: string, stepIndex: number, isActive: boolean): void`
Enables or disables playback for one step on one track. Unknown track IDs and noninteger or out-of-range step indexes are silently ignored.
* **Parameters:**
    * `trackId` *(string)* - Track identifier.
    * `stepIndex` *(number)* - 0-indexed step (`0` through `TOTAL_STEPS - 1`, i.e. `0`-`15`).
    * `isActive` *(boolean)* - `true` to trigger the sample on this step, `false` to mute it.

---

### UI Event Hooks

#### `onStepTick(callback: (stepIndex: number) => void): void`
Registers a callback invoked as the playhead reaches each step, for updating the UI.
* **Callback argument:** `stepIndex` *(number)* - The step about to play (`0`-`15`).
* **Notes:**
    * Only one callback is held at a time; registering a new one replaces the previous one.
    * The callback is driven by `setTimeout`, not the audio clock, so it is approximately (not sample-accurately) in sync with the audio. It fires only while playing.

---

## Public Properties

| Property | Type | Description |
| :--- | :--- | :--- |
| `bpm` | `number` | Current tempo (use `setBpm` to change) |
| `isPlaying` | `boolean` | Whether the transport is running |
| `currentStep` | `number` | Next step the scheduler will queue (runs slightly ahead of what you hear) |
| `totalSteps` | `number` | Steps per pattern (`TOTAL_STEPS`) |
| `tracks` | `Map` | `trackId -> { buffer, steps, gainNode, activeSources }` |
| `audioContext` | `AudioContext \| null` | `null` until `initContext()` runs |
| `masterGain` | `GainNode \| null` | Master bus; all tracks route through it |

There is no volume setter yet. Per-track volume can be set directly:

```javascript
engine.tracks.get('kick').gainNode.gain.value = 0.5;
```

---

## Constants Reference

These are top-level constants in a classic script, not supported runtime configuration setters.

| Constant | Value | Description |
| :--- | :--- | :--- |
| `MIN_BPM` | `40` | Minimum allowed tempo |
| `MAX_BPM` | `240` | Maximum allowed tempo |
| `DEFAULT_BPM` | `120` | Startup tempo |
| `TOTAL_STEPS` | `16` | Steps per pattern (one bar of 16th notes in 4/4) |
| `STEPS_PER_BEAT` | `4` | Steps per quarter note |
| `SCHEDULE_INTERVAL_MS` | `25` | How often the scheduler timer fires |
| `SCHEDULE_AHEAD_SEC` | `0.1` | How far ahead audio is scheduled |
| `START_DELAY_SEC` | `0.05` | Head start before step 0 on `play()` |
| `DEFAULT_TRACK_GAIN` | `0.8` | Per-track volume default |
| `MASTER_GAIN` | `0.7` | Master bus level; adds headroom but does not guarantee clipping won't occur with many simultaneous tracks |

---

## Known Limitations

* **Background tabs:** browsers throttle `setInterval` in hidden tabs, which can cause stutter or dropped steps with the current 100 ms lookahead.
* **No pause:** `stop()` resets to the loop start.
* **UI sync:** step highlighting can drift slightly from the audio (see `onStepTick`).
* **Fixed pattern length:** `totalSteps` should not be changed after tracks have been added.

## Iteration 1 piano roll

Open `/` on the Spring Boot server. The same application retains the optional uploaded sample track. `NoteSequence.js` must load before `SequencerEngine.js`; `sequencer-ui.js` wires the existing engine to the editor. No npm dependencies are required.

### Musical data

`engine.sequence` is a `NoteSequence`, independent of DOM dimensions. The initial viewport displays MIDI 36–83 (C2–B5), descending, with chromatic sharp/flat labels; approximately 24 rows are visible, initially centered near C4. All MIDI integers 0–127 are valid in the model.

- `new NoteSequence(stepCount = 16)` creates a pattern.
- `addNote({midi, startStep, durationSteps = 1, velocity = 0.7, trackId = 'piano'})` validates and inserts/replaces a note at the same pitch, position and identity.
- `removeNote(midi, startStep, trackId = 'piano')` removes matching notes.
- `toggleNote(midi, startStep)` toggles a default piano note.
- `hasNote(midi, startStep)` queries pitch/position.
- `notesAt(step)` returns notes starting in `[step, step + 1)`.
- `toJSON()` returns plain musical data; `visiblePitches()` returns descending C2–B5 MIDI rows; `pitchName(midi)` formats labels.

Start positions may be fractional, durations must be positive and velocity must be in 0–1. The current UI creates integer positions and one-step durations. Scheduler offsets fractional starts within their containing step. Duration is converted to seconds at scheduling time; sustained notes do not retime after tempo changes. Notes can extend past the loop end and overlap following iterations until Stop.

Proposed future persistence payload (no backend persistence implemented):

```json
{
  "version": 1,
  "bpm": 120,
  "stepsPerBeat": 4,
  "loop": { "startStep": 0, "endStepExclusive": 16 },
  "sequence": {
    "stepCount": 16,
    "notes": [
      { "midi": 60, "startStep": 0, "durationSteps": 1, "velocity": 0.7, "trackId": "piano" }
    ]
  }
}
```

Sample buffers and audio nodes are runtime objects, not persistence data. Future sample persistence needs asset identifiers and trigger arrays. The model accepts longer patterns, but engine pattern resizing and additional-bar UI are deferred; do not change `totalSteps` after construction.

### Loop and visual API

`setLoopRange(startStep, endStepExclusive)` accepts integers satisfying `0 <= start < end <= totalSteps`. Defaults to `[0,16)`. Throws for invalid ranges or while playing/starting. Play and Stop reset to loop start. Single-step loops are supported. The UI uses inclusive 1-based endpoints and disables edits during playback.

`getPlaybackStep()` consumes queued step timestamps against `audioContext.currentTime`, returning the sounding step or null before the first event/after Stop. The UI calls it with requestAnimationFrame. `currentStep` remains the next scheduling position, not the audible position. Existing `onStepTick()` remains supported with approximate timer-based synchronization.

`onError` may be assigned an error callback for failures in scheduler timer ticks. Initial playback errors reject `play()` and should be caught by callers.

### Instruments/effects integration

The existing sample path is preserved. Piano notes currently use temporary sine oscillators at `440 * 2 ** ((midi - 69) / 12)`, with a short gain envelope ending at the requested duration. Each voice peaks at velocity × 0.02 before the existing master gain, providing headroom for 48-note chords. Arbitrarily loud uploaded samples or future voices can still clip.

Set `engine.voiceFactory` to a function:

```javascript
engine.voiceFactory = (event, audioContext, outputNode) => {
    // event: { midi, velocity, when, duration, trackId, startStep, durationSteps }
    // when and duration are seconds on the supplied audioContext timeline.
    // Connect your voice/effects output to outputNode (avoid duplicate destination routing).
    return { stop() { /* cancel active AND future audio */ }, finished: completionPromise };
};
```

The returned completion Promise must resolve when the voice ends (including cancellation); it must not reject. Stop must be safe for already-ended voices. Clean up voice nodes on completion. Use this SAME audio context and schedule at `event.when`; do not start another scheduler or translate through wall-clock time. Instrument identity is `trackId`; effects and instrument selection are outside this iteration. The engine owns transport and context lifecycle.

### Scheduling and lifecycle

The original 25 ms interval and 100 ms lookahead remain the only playback scheduler. Timestamped starts and cumulative step advancement avoid timer-based accumulated drift. A delayed callback skips missed positions arithmetically instead of playing overdue notes in a burst. This does not guarantee uninterrupted audio under long main-thread stalls.

The UI stops on hidden/pagehide. Stop cancels pitched voices and sample sources, clears the visual event queue, and invalidates stale callbacks/pending starts. Grid/BPM edits affect events not already scheduled. Sample uploads decode before replacement, retain the trigger pattern, reuse the context/engine, and ignore stale async upload results. Failed uploads leave the previous sample intact.

### Verification and launch

- `node src/test/frontend/sequencer-tests.js`: dependency-free automated tests with fake Web Audio and timers. This verifies logic, not audible browser output.
- `sh mvnw test`: existing Spring tests.
- `sh mvnw spring-boot:run` with Java 21, then open `http://localhost:8080/`.

Manual checks: toggle C4/E4/G4 at step 1, Play and listen for a chord, edit while playing, vary BPM, Stop during startup/playback, test loop 3–8 and loop 5–5, upload/replace an audio file, check sample triggers remain selected, hide the tab and confirm transport stops, scroll through all octaves, and use keyboard focus/Space to toggle cells.

Limitations: no audible/manual verification is implied by automated tests; no MIDI/WAV export, persistence, advanced note editing, arrangement editor, instrument selection, or effects. Audio latency and display frames can cause small visual offsets. Loop edits require Stop. Upload behavior still needs real-browser decoding checks.
