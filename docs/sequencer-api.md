# Sequencer Engine Documentation

A 16-step, multi-track sample sequencer built on the Web Audio API. Timing uses a lookahead scheduler driven by the audio clock (`audioContext.currentTime`), so playback stays accurate even when JavaScript timers jitter.

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
Creates the internal `AudioContext` and master gain node if they don't exist yet, and resumes the context if it is suspended.

> **Note:** `play()` and `addTrack()` call this automatically. However, browsers keep a new `AudioContext` suspended until a user gesture, so the first call should happen inside a click handler (for example, the play button). Calling it at page load is safe but produces no sound until the user interacts.

#### `play(): void`
Starts playback from step `0` and starts the lookahead scheduler. Does nothing if already playing.

#### `stop(): void`
Halts playback, clears the scheduler interval, resets the current step to `0`, and immediately silences all currently playing or already-scheduled audio sources. Also cancels pending step-highlight callbacks from the previous run.

#### `setBpm(newBpm: number): void`
Updates the tempo. Takes effect from the next step; playback is not interrupted.
* **Parameters:** `newBpm` *(number)* - Clamped to `MIN_BPM`-`MAX_BPM` (40-240). Non-finite values (`NaN`, `Infinity`) are ignored and the tempo is left unchanged.

---

### Track & Grid Management

#### `addTrack(trackId: string, audioBuffer: AudioBuffer): void`
Registers a new track with a decoded audio sample. Creates a dedicated `GainNode` (default `0.8`) routed to the master gain, and initializes all steps to off.
* **Parameters:**
    * `trackId` *(string)* - Unique identifier for the track (e.g. `'kick'`).
    * `audioBuffer` *(AudioBuffer)* - Decoded Web Audio API buffer.
* **Note:** Track IDs must be unique. Reusing an ID replaces the track entry but leaves the old track's gain node connected to the master bus. Call `removeTrack(trackId)` first if you want to replace a sample.

#### `removeTrack(trackId: string): void`
Stops any playing sources on the track, disconnects its gain node, and removes it from the engine. Does nothing if the ID doesn't exist.
* **Parameters:** `trackId` *(string)* - Track identifier.

#### `setStep(trackId: string, stepIndex: number, isActive: boolean): void`
Enables or disables playback for one step on one track. Unknown track IDs and out-of-range step indexes are silently ignored.
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

These are module-level constants. They are not configurable from outside the file unless you `export` them.

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
* **No pause:** `stop()` always resets to step `0`.
* **UI sync:** step highlighting can drift slightly from the audio (see `onStepTick`).
* **Fixed pattern length:** `totalSteps` should not be changed after tracks have been added.