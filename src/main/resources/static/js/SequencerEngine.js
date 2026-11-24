// --- Constants ---
const MIN_BPM = 40;
const MAX_BPM = 240;
const DEFAULT_BPM = 120;

const TOTAL_STEPS = 16;
const STEPS_PER_BEAT = 4; // 16th notes

const SCHEDULE_INTERVAL_MS = 25; // how often the scheduler timer fires
const SCHEDULE_AHEAD_SEC = 0.1; // how far ahead to schedule audio
const START_DELAY_SEC = 0.05; // small head start so step 0 isn't late

const DEFAULT_TRACK_GAIN = 0.8;
const DEFAULT_MIDI_GAIN = 1;      // keeps MIDI tracks as loud as they are today
const DEFAULT_PAN = 0;
const MAX_TRACK_GAIN = 1.5;

const MAX_DELAY_SEC = 4;       // 2 beats at the slowest tempo (40 BPM) = 3 s
const DELAY_DAMP_HZ = 4000;
const REVERB_SECONDS = 2;

// Fully-open cutoff for each filter type.
const FILTER_TYPES = {lowpass: 20000, highpass: 20};

const MIX_PARAMS = {
    volume: {min: 0, max: MAX_TRACK_GAIN, def: null},
    pan: {min: -1, max: 1, def: 0},
    cutoff: {min: 20, max: 20000, def: 20000}, // default follows filter type
    resonance: {min: 0, max: 15, def: 0},
    delaySend: {min: 0, max: 1, def: 0},
    delayBeats: {min: 0.125, max: 2, def: 0.75}, // synced to BPM
    delayFeedback: {min: 0, max: 0.9, def: 0.4},
    reverbSend: {min: 0, max: 1, def: 0}
};
const AUTOMATABLE_PARAMS = ['volume', 'pan', 'cutoff', 'resonance', 'delaySend', 'delayFeedback', 'reverbSend'];
const LOG_PARAMS = new Set(['cutoff']);   // interpolated and drawn on a log scale
const MAX_AUTOMATION_POINTS = 2000;       // per lane

const PARAM_SMOOTHING_SEC = 0.015; // time constant; avoids zipper noise while dragging
const MASTER_GAIN = 0.7; // headroom so summed tracks don't clip as easily

class SequencerEngine {
    // Mix state lives here, not on the nodes, so it survives track removal/recreation
// and can be set before the AudioContext exists.
    #mix = new Map();       // trackId -> { volume, pan }
    #automation = new Map(); // channelId -> Map(paramKey -> [{ tick, value }])
    #midiBuses = new Map(); // MIDI trackId -> { gain, pan }
    #impulse = null; // reverb impulse shared by every channel's convolver
    constructor() {
        // Audio graph
        this.audioContext = null;
        this.masterGain = null;

        // Transport & timing state
        this.bpm = DEFAULT_BPM;
        this.isPlaying = false;
        this.isPaused = false;
        this.pausedTick = null;
        this.playbackAnchorTick = 0;
        this.playbackAnchorTime = 0;
        this.playbackInitialEndStep = TOTAL_STEPS;
        this.schedulingEndStep = TOTAL_STEPS;
        this.pendingStartTick = null;
        this.currentStep = 0;
        this.totalSteps = TOTAL_STEPS;
        this.loopStart = 0;
        this.loopEnd = TOTAL_STEPS;
        this.sequence = new NoteSequence(this.totalSteps);
        this.nextMidiImportId = 1;
        this.pitchedVoices = new Set();
        this.stepEvents = [];
        this.onError = null;
        this.voiceFactory = null;
        this.audioErrors = [];
        this.instrumentManager = null;
        this.instrumentPreparation = null;
        this.preparationController = null;
        this.isStopping = false;

        // Lookahead scheduling uses the audio clock, not timer callback arrival times.
        this.lookaheadTimer = null;
        this.nextNoteTime = 0.0; // next step's time, in AudioContext seconds

        // Incremented on every play/stop so stale UI timeouts can detect they're outdated
        this.runId = 0;

        // trackId -> { buffer, steps: [bool x totalSteps], gainNode, activeSources: Set }
        this.tracks = new Map();

        // UI callback for step highlighting
        this.onStepTickCallback = null;
    }

    // --- Initialization & Audio Context ---
    initContext() {
        if (!this.audioContext) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContextClass();

            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.value = MASTER_GAIN;
            this.masterGain.connect(this.audioContext.destination);

        }
    }

    // --- Transport Controls ---
    play(cursorTick = undefined) {
        if (this.isPlaying || this.startPromise) {
            return this.startPromise || Promise.resolve();
        }
        const resuming = this.isPaused;
        const requestedTick = resuming ? this.pausedTick : cursorTick ?? this.sequence.stepToTick(this.loopStart);
        this.#validatePlaybackTick(requestedTick);
        const compositionEnd = this.sequence.stepToTick(this.totalSteps);
        const atCompositionEnd = requestedTick === compositionEnd || requestedTick === Math.floor(compositionEnd);
        this.pendingStartTick = !resuming && atCompositionEnd
            ? this.sequence.stepToTick(this.loopStart) : requestedTick;
        const token = ++this.runId;
        const start = async () => {
            this.initContext();
            if (this.audioContext.state !== 'running') {
                await this.audioContext.resume();
            }
            if (token !== this.runId) {
                return;
            }
            if (this.instrumentManager?.prepare) {
                try {
                    await this.#prepareInstruments();
                } catch (error) {
                    if (token !== this.runId) {
                        return;
                    }
                    throw error;
                }
            }
            if (token !== this.runId) {
                return;
            }
            const startTick = this.pendingStartTick;
            this.pendingStartTick = null;
            this.isPlaying = true;
            this.isPaused = false;
            this.pausedTick = null;
            this.playbackAnchorTick = startTick;
            this.playbackInitialEndStep = startTick < this.sequence.stepToTick(this.loopEnd)
                ? this.loopEnd : this.totalSteps;
            this.schedulingEndStep = this.playbackInitialEndStep;
            this.playbackAnchorTime = this.audioContext.currentTime + START_DELAY_SEC;
            const startStep = this.sequence.tickToStep(startTick);
            this.currentStep = Math.floor(startStep);
            this.nextNoteTime = this.playbackAnchorTime -
                (this.sequence.ticksToSeconds(startTick) - this.stepSeconds(this.currentStep));
            if (resuming || cursorTick !== undefined) {
                // Audition held notes once at the chosen start, then schedule only future onsets.
                for (const note of this.sequence.notes) {
                    if (note.ticks < startTick && note.ticks + note.durationTicks > startTick) {
                        this.#scheduleNote(note, this.playbackAnchorTime, startTick);
                    }
                    if (token !== this.runId) {
                        return;
                    }
                }
            }
            if (startStep > this.currentStep) {
                // The first partial step starts in the past, so schedule its remaining events
                // before the ordinary late-callback skip logic advances to the next full step.
                this.scheduleStep(this.currentStep, this.nextNoteTime, startTick);
                if (token !== this.runId) {
                    return;
                }
                this.advanceStep();
            }
            this.scheduler();
            if (!this.isPlaying || token !== this.runId) {
                return;
            }
            this.lookaheadTimer = setInterval(() => {
                try {
                    this.scheduler();
                } catch (error) {
                    this.stop();
                    this.#reportAudioError(error, {phase: 'scheduler', fatal: true});
                }
            }, SCHEDULE_INTERVAL_MS);
        };
        const pending = start().catch((error) => {
            if (token === this.runId) {
                this.stop();
            }
            throw error;
        });
        this.startPromise = pending;
        pending
            .finally(() => {
                if (this.startPromise === pending) {
                    this.startPromise = null;
                }
            })
            .catch(() => {
            });
        return pending;
    }

    #validatePlaybackTick(tick) {
        if (!Number.isFinite(tick) || tick < 0 || tick > this.sequence.stepToTick(this.totalSteps)) {
            throw new RangeError('Keep the playback position inside the composition.');
        }
    }

    seekPaused(tick) {
        if (!this.isPaused) {
            return;
        }
        this.#validatePlaybackTick(tick);
        this.pausedTick = tick === this.sequence.stepToTick(this.totalSteps)
            ? this.sequence.stepToTick(this.loopStart) : tick;
        if (this.startPromise) {
            this.pendingStartTick = this.pausedTick;
        }
        this.currentStep = this.sequence.tickToStep(this.pausedTick);
        this.visibleStep = Math.floor(this.currentStep);
    }

    pause() {
        if (!this.isPlaying && !this.startPromise) {
            return;
        }
        const tick = this.getPlaybackTick();
        // Reuse the complete cancellation path, including preparation, samples and manager hooks.
        this.stop();
        this.isPaused = true;
        this.pausedTick = tick;
        this.currentStep = this.sequence.tickToStep(tick);
        this.visibleStep = Math.floor(this.currentStep);
    }

    getPlaybackTick() {
        return this.getPlaybackPosition().ticks;
    }

    getPlaybackPosition() {
        if (this.isPaused) {
            return {ticks: this.pausedTick, pass: null};
        }
        if (!this.isPlaying) {
            return {ticks: this.pendingStartTick ?? this.sequence.stepToTick(this.loopStart), pass: null};
        }
        const sequence = this.sequence;
        const loopStartSeconds = this.stepSeconds(this.loopStart);
        const loopDuration = this.stepSeconds(this.loopEnd) - loopStartSeconds;
        const elapsed = Math.max(0, this.audioContext.currentTime - this.playbackAnchorTime);
        const initialStartSeconds = sequence.ticksToSeconds(this.playbackAnchorTick);
        const initialDuration = this.stepSeconds(this.playbackInitialEndStep) - initialStartSeconds;
        // Normalize sub-nanosecond clock rounding at exact wraps so view consumers do not
        // mistake a new loop for one last forward-moving frame at the old loop end.
        const remaining = elapsed - initialDuration;
        const tolerance = 1e-9;
        if (remaining < -tolerance) {
            return {ticks: sequence.secondsToTicks(initialStartSeconds + elapsed), pass: 0};
        }
        const loopTime = Math.max(0, remaining);
        const cycles = Math.floor((loopTime + tolerance) / loopDuration);
        const loopElapsed = Math.max(0, loopTime - cycles * loopDuration);
        return {
            ticks: sequence.secondsToTicks(loopStartSeconds + loopElapsed),
            pass: 1 + cycles
        };
    }

    stop() {
        if (this.isStopping) {
            return;
        }
        this.isStopping = true;
        this.isPlaying = false;
        this.isPaused = false;
        this.pausedTick = null;
        this.runId++; // invalidates any pending UI timeouts
        clearInterval(this.lookaheadTimer);
        this.currentStep = this.loopStart;
        this.startPromise = null;
        this.pendingStartTick = null;
        this.stepEvents = [];
        this.visibleStep = null;
        const voices = [...this.pitchedVoices];
        this.pitchedVoices.clear();
        const failures = [];
        try {
            this.#cancelPreparation();
            for (const voice of voices) {
                this.#stopVoice(voice, failures);
            }
            this.tracks.forEach((track) => {
                track.activeSources.forEach((source) => {
                    try {
                        this.#restoreAutomatedParams();
                    } catch (error) {
                        failures.push({error, phase: 'automation-restore'});
                    }
                });
                track.activeSources.clear();
            });
            this.#callInstrumentHook('stop', [], failures);
            // Report only after every healthy voice and sample has been cancelled.
            failures.forEach(({error, ...details}) => this.#reportAudioError(error, details));
        } finally {
            this.isStopping = false;
        }
    }

    #reportAudioError(error, details = {}) {
        const failure =
            error instanceof Error
                ? error
                : new Error(error?.message ?? String(error), {cause: error});
        const information = {fatal: false, ...details};
        this.audioErrors.push({error: failure, ...information});
        if (this.audioErrors.length > 50) {
            this.audioErrors.shift();
        }
        try {
            if (this.onError) {
                const result = this.onError(failure, information);
                if (result && typeof result.then === 'function') {
                    Promise.resolve(result).catch((handlerError) =>
                        console.error('JukeBox audio error handler failed:', handlerError)
                    );
                }
            } else {
                console.error('JukeBox audio:', information, failure);
            }
        } catch (handlerError) {
            console.error('JukeBox audio error handler failed:', handlerError);
        }
    }

    #stopVoice(voice, failures = null) {
        const report = (error) => {
            if (failures) {
                failures.push({error, phase: 'voice-stop'});
            } else {
                this.#reportAudioError(error, {phase: 'voice-stop'});
            }
        };
        try {
            const result = voice.stop();
            // stop() is synchronous by contract, but observe an accidental async rejection too.
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch((error) =>
                    this.#reportAudioError(error, {phase: 'voice-stop'})
                );
            }
        } catch (error) {
            report(error);
        }
    }

    #discardVoice(voice, completion = undefined) {
        // Inspect independent parts separately: one broken getter must not skip cancellation.
        try {
            if (voice && typeof voice.stop === 'function') {
                this.#stopVoice(voice);
            }
        } catch (error) {
            this.#reportAudioError(error, {phase: 'discarded-voice'});
        }
        try {
            if (voice && typeof voice.then === 'function') {
                Promise.resolve(voice).then(
                    (lateVoice) => this.#discardVoice(lateVoice),
                    (error) => this.#reportAudioError(error, {phase: 'async-factory'})
                );
                return;
            }
        } catch (error) {
            this.#reportAudioError(error, {phase: 'discarded-voice'});
        }
        try {
            const finished = completion ?? voice?.finished;
            if (finished && typeof finished.then === 'function') {
                Promise.resolve(finished).catch((error) =>
                    this.#reportAudioError(error, {phase: 'discarded-voice'})
                );
            }
        } catch (error) {
            this.#reportAudioError(error, {phase: 'discarded-voice'});
        }
    }

    #registerVoice(voice, event) {
        let finished;
        try {
            if (voice && typeof voice.then === 'function') {
                // Never await a factory in the scheduler. Cancel any handle it delivers late.
                throw new TypeError(
                    'voiceFactory must return a synchronous voice handle, not a Promise.'
                );
            }
            finished = voice?.finished;
            if (
                !voice ||
                typeof voice.stop !== 'function' ||
                !finished ||
                typeof finished.then !== 'function'
            ) {
                throw new TypeError(
                    'A voice needs stop() and a Promise/thenable finished property.'
                );
            }
            const completion = Promise.resolve(finished);
            this.pitchedVoices.add(voice);
            completion.then(
                () => this.pitchedVoices.delete(voice),
                (error) => {
                    this.pitchedVoices.delete(voice);
                    this.#stopVoice(voice);
                    this.#reportAudioError(error, {
                        phase: 'voice-completion',
                        noteId: event.id,
                        trackId: event.trackId
                    });
                }
            );
        } catch (error) {
            this.#discardVoice(voice, finished);
            throw error;
        }
    }

    addMidiTrack(name) {
        if (this.isPlaying || this.startPromise) {
            throw new Error('Pause or stop playback before adding a MIDI track.');
        }
        const track = this.sequence.addMusicalTrack({name});
        this.#syncInstrumentTracks();
        return track;
    }

    renameMidiTrack(id, name) {
        if (this.isPlaying || this.startPromise) {
            throw new Error('Pause or stop playback before renaming a MIDI track.');
        }
        const track = this.sequence.renameMusicalTrack(id, name);
        this.#syncInstrumentTracks();
        return track;
    }

    reorderMidiTrack(id, toIndex) {
        // Ordering is visual/serialization state; routing still uses unchanged stable IDs.
        return this.sequence.moveMusicalTrack(id, toIndex);
    }

    setMidiTrackOrder(ids) {
        this.sequence.setMusicalTrackOrder(ids);
    }

    assertTrackDeletionStopped() {
        if (this.isPlaying || this.isPaused || this.startPromise) {
            throw new Error('Press Stop before deleting or restoring MIDI tracks.');
        }
    }

    deleteMidiTrack(id) {
        this.assertTrackDeletionStopped();
        const record = this.sequence.deleteMusicalTrack(id);
        this.#syncInstrumentTracks();
        return record;
    }

    restoreMidiTrack(record) {
        this.assertTrackDeletionStopped();
        const track = this.sequence.restoreMusicalTrack(record);
        this.#syncInstrumentTracks();
        return track;
    }

    registerInstrumentManager(manager) {
        if (this.isPlaying || this.startPromise) {
            throw new Error('Stop playback before changing the instrument manager.');
        }
        if (manager !== null && (!manager || typeof manager.createVoice !== 'function')) {
            throw new TypeError('An instrument manager needs a synchronous createVoice() method.');
        }
        for (const name of ['prepare', 'stop', 'syncTracks', 'dispose']) {
            if (manager?.[name] !== undefined && typeof manager[name] !== 'function') {
                throw new TypeError(`Instrument manager ${name} must be a function.`);
            }
        }
        this.stop();
        this.#callInstrumentHook('dispose');
        this.instrumentManager = manager;
        this.voiceFactory = manager
            ? (event, context, output) => manager.createVoice(event, context, output)
            : null;
        this.instrumentPreparation = null;
        this.#syncInstrumentTracks();
    }

    #callInstrumentHook(name, args = [], failures = null) {
        try {
            const result = this.instrumentManager?.[name]?.(...args);
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch((error) =>
                    this.#reportAudioError(error, {phase: `instruments-${name}`})
                );
            }
        } catch (error) {
            if (failures) {
                failures.push({error, phase: `instruments-${name}`});
            } else {
                this.#reportAudioError(error, {phase: `instruments-${name}`});
            }
        }
    }

    #syncInstrumentTracks() {
        this.#pruneMidiBuses();
        this.#cancelPreparation();
        this.instrumentPreparation = null;
        this.#callInstrumentHook('syncTracks', [
            this.sequence.tracks.map((track) => ({...track}))
        ]);
    }

    #cancelPreparation() {
        if (this.preparationController) {
            this.preparationController.abort();
            this.preparationController = null;
            this.instrumentPreparation = null;
        }
    }

    #prepareInstruments() {
        if (!this.instrumentPreparation) {
            const controller = new AbortController();
            this.preparationController = controller;
            const work = Promise.resolve().then(() => {
                if (!controller.signal.aborted) {
                    return this.instrumentManager.prepare(this.audioContext, this.masterGain, {
                        signal: controller.signal
                    });
                }
            });
            let cancel;
            const cancelled = new Promise((resolve, reject) => {
                cancel = () => reject(new Error('Instrument preparation cancelled.'));
                controller.signal.addEventListener('abort', cancel, {once: true});
            });
            // Stop releases pending Play even if a faulty manager ignores its signal.
            const preparation = Promise.race([work, cancelled]);
            this.instrumentPreparation = preparation;
            preparation.then(
                () => {
                    controller.signal.removeEventListener('abort', cancel);
                    if (this.preparationController === controller) {
                        this.preparationController = null;
                    }
                },
                () => {
                    controller.signal.removeEventListener('abort', cancel);
                    if (this.instrumentPreparation === preparation) {
                        this.instrumentPreparation = null;
                        this.preparationController = null;
                    }
                }
            );
        }
        return this.instrumentPreparation;
    }

    setBpm(newBpm) {
        if (!Number.isFinite(newBpm)) {
            return;
        }
        if (this.sequence.tempos.length > 1) {
            throw new Error('Imported tempo map is active; BPM editing is disabled.');
        }
        const tick = this.getPlaybackTick();
        this.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, newBpm));
        this.#updateDelayTimes();
        this.sequence.tempos = [{ticks: 0, bpm: this.bpm}];
        if (this.isPlaying) {
            this.playbackAnchorTick = tick;
            this.playbackInitialEndStep = tick < this.sequence.stepToTick(this.loopEnd)
                ? this.loopEnd : this.totalSteps;
            this.playbackAnchorTime = this.audioContext.currentTime;
        }
    }

    // Timeline changes are stopped-only and retain all notes and sample triggers.
    setPatternLength(steps) {
        if (this.isPlaying || this.startPromise) {
            throw new Error('Stop before resizing the pattern.');
        }
        if (!Number.isInteger(steps) || steps < 1 || steps > 65536) {
            throw new RangeError('Use 1–65536 steps.');
        }
        if (
            this.sequence.notes.some(
                (note) => note.ticks + note.durationTicks > this.sequence.stepToTick(steps)
            ) ||
            [...this.tracks.values()].some((track) => track.steps.slice(steps).some(Boolean))
        ) {
            throw new Error(
                'Cannot shorten past existing notes or sample triggers. Remove them first.'
            );
        }
        const wasFullPatternLoop = this.loopStart === 0 && this.loopEnd === this.totalSteps;
        this.totalSteps = this.sequence.stepCount = steps;
        this.tracks.forEach((track) => {
            track.steps = Array.from({length: steps}, (_, stepIndex) =>
                Boolean(track.steps[stepIndex])
            );
        });
        if (wasFullPatternLoop) {
            this.loopStart = 0;
            this.loopEnd = steps;
        } else {
            this.loopEnd = Math.min(this.loopEnd, steps);
            this.loopStart = Math.min(this.loopStart, this.loopEnd - 1);
        }
        this.currentStep = this.loopStart;
        this.isPaused = false;
        this.pausedTick = null;
    }

    replaceSequence(sequence) {
        if (this.isPlaying || this.startPromise) {
            throw new Error('Stop before importing MIDI.');
        }
        if (!(sequence instanceof NoteSequence)) {
            throw new Error('Expected a validated NoteSequence.');
        }
        // Retain sample triggers even if the imported song is shorter.
        const lastSampleStep = Math.max(
            1,
            ...[...this.tracks.values()].map((track) => track.steps.lastIndexOf(true) + 1)
        );
        sequence.stepCount = Math.max(sequence.stepCount, lastSampleStep);
        this.sequence = sequence;
        this.totalSteps = sequence.stepCount;
        this.tracks.forEach((track) => {
            track.steps = Array.from({length: this.totalSteps}, (_, i) =>
                Boolean(track.steps[i])
            );
        });
        this.loopStart = 0;
        this.loopEnd = this.totalSteps;
        this.currentStep = 0;
        this.isPaused = false;
        this.pausedTick = null;
        this.bpm = sequence.tempos.find((tempo) => tempo.ticks === 0)?.bpm ?? 120;
        this.#updateDelayTimes();
        this.#syncInstrumentTracks();
    }

    importMidiSequence(sequence) {
        if (this.isPlaying || this.startPromise) {
            throw new Error('Stop before importing MIDI.');
        }
        const importId = `import-${this.nextMidiImportId}`;
        const combined = this.sequence.withMidiImport(sequence, importId);
        this.replaceSequence(combined);
        this.nextMidiImportId++;
        return combined;
    }

    removeImportedMidi() {
        if (!this.sequence.importInfo) {
            return;
        }
        const remaining = this.sequence.withoutMidiImport();
        this.stop();
        this.replaceSequence(remaining);
    }

    newSequence() {
        this.stop();
        for (const trackId of [...this.tracks.keys()]) {
            this.removeTrack(trackId);
        }
        this.#mix.clear();
        this.#automation.clear();
        for (const strip of this.#midiBuses.values()) {
            this.#disposeStrip(strip);
        }
        this.#midiBuses.clear();
        this.replaceSequence(new NoteSequence());
    }

    stepSeconds(step) {
        return this.sequence.ticksToSeconds(this.sequence.stepToTick(step));
    }

    setLoopRange(start, end) {
        if (this.isPlaying || this.startPromise) {
            throw new Error('Stop playback before changing the loop.');
        }
        if (
            !Number.isInteger(start) ||
            !Number.isInteger(end) ||
            start < 0 ||
            end > this.totalSteps ||
            start >= end
        ) {
            throw new RangeError('Loop must contain at least one valid step.');
        }
        this.loopStart = start;
        this.loopEnd = end;
        this.currentStep = start;
        this.isPaused = false;
        this.pausedTick = null;
    }

    // UI reads the same audio clock; no second playback scheduler.
    getPlaybackStep() {
        let step = this.visibleStep ?? null;
        while (this.stepEvents.length && this.stepEvents[0].time <= this.audioContext.currentTime) {
            step = this.stepEvents.shift().step;
        }
        this.visibleStep = this.isPlaying ? step : this.isPaused ? Math.floor(this.sequence.tickToStep(this.pausedTick)) : null;
        return this.visibleStep;
    }

    // --- Track & Grid Management ---
    addTrack(trackId, audioBuffer) {
        this.initContext();
        this.removeTrack(trackId);

        const strip = this.#buildStrip(this.#mixFor(trackId, DEFAULT_TRACK_GAIN));
        this.tracks.set(trackId, {
            buffer: audioBuffer,
            steps: new Array(this.totalSteps).fill(false),
            gainNode: strip.gain, // entry point for sources
            strip,
            activeSources: new Set()
        });
    }

    removeTrack(trackId) {
        const track = this.tracks.get(trackId);
        if (!track) {
            return;
        }

        const failures = [];
        track.activeSources.forEach((source) => {
            try {
                source.stop();
            } catch (error) {
                failures.push(error);
            }
        });
        track.activeSources.clear();
        track.buffer = null;
        track.steps = [];
        this.#disposeStrip(track.strip);
        this.tracks.delete(trackId);
        failures.forEach((error) =>
            this.#reportAudioError(error, {phase: 'sample-remove', trackId})
        );
    }

    setStep(trackId, stepIndex, isActive) {
        const track = this.tracks.get(trackId);
        if (track && Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex < this.totalSteps) {
            track.steps[stepIndex] = Boolean(isActive);
        }
    }

    // --- Core Lookahead Scheduler ---
    scheduler() {
        if (!this.isPlaying) {
            return;
        }
        const runId = this.runId;
        // Skip whole cycles, then remaining missed steps. Preserve the audio-clock phase.
        const now = this.audioContext.currentTime;
        const loopSeconds = this.stepSeconds(this.loopEnd) - this.stepSeconds(this.loopStart);
        if (this.nextNoteTime < now) {
            // Finish a potentially non-loop initial pass before skipping repeated full loops.
            const untilWrap = this.stepSeconds(this.schedulingEndStep) - this.stepSeconds(this.currentStep);
            if (this.nextNoteTime + untilWrap <= now) {
                this.nextNoteTime += untilWrap;
                this.currentStep = this.loopStart;
                this.schedulingEndStep = this.loopEnd;
                const cycles = Math.floor((now - this.nextNoteTime) / loopSeconds);
                this.nextNoteTime += cycles * loopSeconds;
            }
            while (this.nextNoteTime < now - 1e-9) {
                this.advanceStep();
            }
        }
        // Schedule every step that falls inside the lookahead window
        while (
            this.isPlaying &&
            this.nextNoteTime < this.audioContext.currentTime + SCHEDULE_AHEAD_SEC
            ) {
            this.scheduleStep(this.currentStep, this.nextNoteTime);
            if (!this.isPlaying || runId !== this.runId) {
                break;
            }
            this.advanceStep();
        }
    }

    advanceStep() {
        // Subtract mapped positions so tempo changes inside a step are included.
        const stepDuration =
            this.stepSeconds(this.currentStep + 1) - this.stepSeconds(this.currentStep);

        this.nextNoteTime += stepDuration;
        if (this.currentStep + 1 >= this.schedulingEndStep) {
            this.currentStep = this.loopStart;
            this.schedulingEndStep = this.loopEnd;
        } else {
            this.currentStep++;
        }
    }

    scheduleStep(stepIndex, time, fromTick = null) {
        const runId = this.runId;
        // Bound history even for legacy consumers that only use onStepTick().
        this.stepEvents = this.stepEvents.filter(
            (event) => event.time >= this.audioContext.currentTime - 1
        );
        const visibleTime = fromTick === null ? time : this.playbackAnchorTime;
        this.stepEvents.push({step: stepIndex, time: visibleTime});
        try {
            this.#scheduleAutomation(stepIndex, time, fromTick);
        } catch (error) {
            this.#reportAudioError(error, {phase: 'automation', fatal: false});
        }
        this.#schedulePitchedNotes(stepIndex, time, fromTick);
        if (runId !== this.runId) {
            return;
        }
        this.#notifyStepTick(stepIndex, visibleTime);
        if (fromTick === null || fromTick <= this.sequence.stepToTick(stepIndex)) {
            this.#scheduleSampleTracks(stepIndex, time);
        }
    }

    #schedulePitchedNotes(stepIndex, time, fromTick = null) {
        const runId = this.runId;
        for (const note of this.sequence.notesAt(stepIndex)) {
            if (runId !== this.runId) {
                return;
            }
            if (fromTick !== null && note.ticks < fromTick) {
                continue;
            }
            const when = time + this.sequence.ticksToSeconds(note.ticks) - this.stepSeconds(stepIndex);
            this.#scheduleNote(note, when);
        }
    }

    #scheduleNote(note, when, soundingFromTick = note.ticks) {
        const runId = this.runId;
        const track = this.sequence.tracks.find((track) => track.id === note.trackId);
        const event = {
            ...note,
            channel: track?.channel,
            program: track?.program,
            startStep: note.startStep,
            durationSteps: note.durationSteps,
            when,
            duration: this.sequence.ticksToSeconds(note.ticks + note.durationTicks) -
                this.sequence.ticksToSeconds(soundingFromTick)
        };
        try {
            // Notes whose track is unknown fall back to the master bus.
            const output = track ? this.#getMidiBus(track.id).gain : this.masterGain;
            const voice = this.voiceFactory
                ? this.voiceFactory(event, this.audioContext, output)
                : this.createPitchedVoice(event, output)
            if (runId !== this.runId) {
                this.#discardVoice(voice);
                return;
            }
            this.#registerVoice(voice, event);
        } catch (error) {
            this.#reportAudioError(error, {
                phase: 'voice-factory',
                noteId: note.id,
                trackId: note.trackId
            });
        }
    }

    #notifyStepTick(stepIndex, time) {
        // The legacy UI callback is approximate; audio sources use timestamped starts.
        // A run ID drops callbacks left over from a previous playback run.
        if (this.onStepTickCallback) {
            const runId = this.runId;
            const delayMs = Math.max(0, (time - this.audioContext.currentTime) * 1000);
            setTimeout(() => {
                if (this.isPlaying && this.runId === runId) {
                    this.onStepTickCallback(stepIndex);
                }
            }, delayMs);
        }
    }

    #scheduleSampleTracks(stepIndex, time) {
        // Sample tracks share the same step timestamp as pitched notes.
        this.tracks.forEach((track) => {
            if (!track.steps[stepIndex] || !track.buffer) {
                return;
            }

            const source = this.audioContext.createBufferSource();
            source.buffer = track.buffer;
            source.connect(track.gainNode);

            // Track the source so stop() can silence it; clean up when it finishes
            track.activeSources.add(source);
            source.onended = () => {
                track.activeSources.delete(source);
                source.disconnect();
            };

            source.start(time);
        });
    }

    // Future instruments implement (event, sharedContext, output) => { stop(), finished: Promise }.
    createPitchedVoice(event, output = this.masterGain) {
        const oscillator = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        oscillator.frequency.value = 440 * 2 ** ((event.midi - 69) / 12);
        oscillator.connect(gain);
        gain.connect(output);
        const end = event.when + event.duration;
        const ramp = Math.min(0.005, event.duration / 4);
        gain.gain.setValueAtTime(0, event.when);
        gain.gain.linearRampToValueAtTime(event.velocity * 0.02, event.when + ramp);
        gain.gain.setValueAtTime(event.velocity * 0.02, end - ramp);
        gain.gain.linearRampToValueAtTime(0, end);
        const finished = new Promise((resolve) => {
            oscillator.onended = () => {
                oscillator.disconnect();
                gain.disconnect();
                resolve();
            };
        });
        oscillator.start(event.when);
        oscillator.stop(end);
        return {
            finished,
            stop: () => {
                try {
                    oscillator.stop();
                } catch (_) {
                }
            }
        };
    }

// --- Per-channel mix: volume, pan, filter, per-channel delay and reverb ---
    #defaultVolume(id) {
        return this.sequence.tracks.some((track) => track.id === id) ? DEFAULT_MIDI_GAIN : DEFAULT_TRACK_GAIN;
    }

    #defaultFor(id, key, mix) {
        if (key === 'volume') return this.#defaultVolume(id);
        if (key === 'cutoff') return FILTER_TYPES[mix?.filterType ?? 'lowpass'];
        return MIX_PARAMS[key].def;
    }

    #mixFor(id) {
        let mix = this.#mix.get(id);
        if (!mix) {
            mix = {filterType: 'lowpass'};
            this.#mix.set(id, mix);
        }
        for (const key of Object.keys(MIX_PARAMS)) {
            mix[key] ??= this.#defaultFor(id, key, mix);
        }
        return mix;
    }

    #isChannel(id) {
        return this.tracks.has(id) || this.sequence.tracks.some((track) => track.id === id);
    }

    hasChannel(id) {
        return this.#isChannel(id);
    }

    #strip(id) {
        return this.tracks.get(id)?.strip ?? this.#midiBuses.get(id) ?? null;
    }

    #smooth(param, value) {
        const now = this.audioContext.currentTime;
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, PARAM_SMOOTHING_SEC);
    }

    #delaySeconds(beats) {
        return Math.min(MAX_DELAY_SEC, (beats * 60) / this.bpm);
    }

// The one place a stored mix value becomes an audio-node change.
    #applyParam(strip, mix, key, value) {
        switch (key) {
            case 'volume':
                this.#smooth(strip.gain.gain, value);
                break;
            case 'pan':
                this.#smooth(strip.pan.pan, value);
                break;
            case 'cutoff':
                this.#smooth(strip.filter.frequency, value);
                break;
            case 'resonance':
                this.#smooth(strip.filter.Q, value);
                break;
            case 'delaySend':
                if (strip.delay || value > 0) {
                    this.#smooth(this.#ensureDelay(strip, mix).send.gain, value);
                }
                break;
            case 'delayBeats':
                if (strip.delay) {
                    this.#smooth(strip.delay.delay.delayTime, this.#delaySeconds(value));
                }
                break;
            case 'delayFeedback':
                if (strip.delay) {
                    this.#smooth(strip.delay.feedback.gain, value);
                }
                break;
            case 'reverbSend':
                if (strip.reverb || value > 0) {
                    this.#smooth(this.#ensureReverb(strip, mix).send.gain, value);
                }
                break;
        }
    }

// Works for sample, drum and MIDI channels, before or during playback.
    setChannelParam(id, key, value) {
        const spec = MIX_PARAMS[key];
        if (!spec || !Number.isFinite(value) || !this.#isChannel(id)) {
            return false;
        }
        const clamped = Math.min(spec.max, Math.max(spec.min, value));
        const mix = this.#mixFor(id);
        mix[key] = clamped;
        const strip = this.#strip(id);
        if (strip) {
            this.#applyParam(strip, mix, key, clamped);
        }
        return true;
    }

    setChannelVolume(id, value) {
        return this.setChannelParam(id, 'volume', value);
    }

    setChannelPan(id, value) {
        return this.setChannelParam(id, 'pan', value);
    }

// Switching type moves a fully-open cutoff to the new type's open position,
// so the filter doesn't suddenly start cutting the sound.
    setChannelFilterType(id, type) {
        if (!Object.hasOwn(FILTER_TYPES, type) || !this.#isChannel(id)) {
            return false;
        }
        const mix = this.#mixFor(id);
        const previous = mix.filterType;
        if (previous === type) {
            return true;
        }
        const wasOpen = mix.cutoff === FILTER_TYPES[previous];
        mix.filterType = type;
        const strip = this.#strip(id);
        if (strip) {
            strip.filter.type = type;
        }
        if (wasOpen) {
            this.setChannelParam(id, 'cutoff', FILTER_TYPES[type]);
        }
        return true;
    }

    resetChannelParam(id, key) {
        if (!MIX_PARAMS[key]) {
            return false;
        }
        return this.setChannelParam(id, key, this.#defaultFor(id, key, this.#mix.get(id)));
    }

    getChannelMix(id) {
        const mix = this.#mix.get(id);
        const out = {filterType: mix?.filterType ?? 'lowpass'};
        for (const key of Object.keys(MIX_PARAMS)) {
            out[key] = mix?.[key] ?? this.#defaultFor(id, key, mix);
        }
        return out;
    }

// Applies any recognised keys and ignores the rest, so old saves still load.
// The filter type goes first so a saved cutoff isn't remapped afterwards.
    applyChannelMix(id, mix) {
        this.setChannelFilterType(id, mix?.filterType);
        for (const key of Object.keys(MIX_PARAMS)) {
            this.setChannelParam(id, key, mix?.[key]);
        }
    }

// Picks just the valid mix values out of a saved object.
    extractMix(source) {
        const out = {};
        for (const key of Object.keys(MIX_PARAMS)) {
            if (Number.isFinite(source?.[key])) out[key] = source[key];
        }
        if (Object.hasOwn(FILTER_TYPES, source?.filterType)) out.filterType = source.filterType;
        return out;
    }

    resetChannelMix(id) {
        this.#mix.delete(id);
    }

    snapshotMix() {
        return {
            tracks: this.sequence.tracks.map((track) => ({
                trackId: track.id,
                ...this.getChannelMix(track.id)
            }))
        };
    }

    restoreMix(state) {
        if (!Array.isArray(state?.tracks)) {
            return;
        }
        for (const entry of state.tracks) {
            this.applyChannelMix(entry?.trackId, entry);
        }
    }

// gain -> filter -> pan -> master, plus optional per-channel delay and reverb taps off pan.
    #buildStrip(mix) {
        const ctx = this.audioContext;
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        const pan = ctx.createStereoPanner();
        filter.type = mix.filterType;
        gain.gain.value = mix.volume;
        filter.frequency.value = mix.cutoff;
        filter.Q.value = mix.resonance;
        pan.pan.value = mix.pan;
        gain.connect(filter);
        filter.connect(pan);
        pan.connect(this.masterGain);
        const strip = {gain, filter, pan, delay: null, reverb: null};
        if (mix.delaySend > 0) this.#ensureDelay(strip, mix);
        if (mix.reverbSend > 0) this.#ensureReverb(strip, mix);
        return strip;
    }

// Effects are created the first time their send goes above zero.
    #ensureDelay(strip, mix) {
        if (!strip.delay) {
            const ctx = this.audioContext;
            const send = ctx.createGain();
            const delay = ctx.createDelay(MAX_DELAY_SEC);
            const damp = ctx.createBiquadFilter();
            const feedback = ctx.createGain();
            damp.type = 'lowpass';
            damp.frequency.value = DELAY_DAMP_HZ;
            send.gain.value = mix.delaySend;
            delay.delayTime.value = this.#delaySeconds(mix.delayBeats);
            feedback.gain.value = mix.delayFeedback;
            strip.pan.connect(send);
            send.connect(delay);
            delay.connect(damp);
            damp.connect(feedback);
            feedback.connect(delay);   // feedback loop (legal: it contains a DelayNode)
            damp.connect(this.masterGain);
            strip.delay = {send, delay, damp, feedback};
        }
        return strip.delay;
    }

    #ensureReverb(strip, mix) {
        if (!strip.reverb) {
            const ctx = this.audioContext;
            const send = ctx.createGain();
            const convolver = ctx.createConvolver();
            this.#impulse ??= this.#makeImpulse(REVERB_SECONDS);
            convolver.buffer = this.#impulse;
            send.gain.value = mix.reverbSend;
            strip.pan.connect(send);
            send.connect(convolver);
            convolver.connect(this.masterGain);
            strip.reverb = {send, convolver};
        }
        return strip.reverb;
    }

// Decaying stereo noise: a cheap, file-free reverb impulse.
    #makeImpulse(seconds) {
        const ctx = this.audioContext;
        const length = Math.floor(ctx.sampleRate * seconds);
        const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
        for (let channel = 0; channel < 2; channel++) {
            const data = impulse.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
            }
        }
        return impulse;
    }

    #disposeStrip(strip) {
        if (!strip) {
            return;
        }
        const nodes = [strip.gain, strip.filter, strip.pan,
            ...Object.values(strip.delay ?? {}), ...Object.values(strip.reverb ?? {})];
        for (const node of nodes) {
            try {
                node.disconnect();
            } catch (_) {
            }
        }
    }

// MIDI voices connect to this strip's gain node.
    #getMidiBus(trackId) {
        let strip = this.#midiBuses.get(trackId);
        if (!strip) {
            strip = this.#buildStrip(this.getChannelMix(trackId));
            this.#midiBuses.set(trackId, strip);
        }
        return strip;
    }

    #pruneMidiBuses() {
        const ids = new Set(this.sequence.tracks.map((track) => track.id));
        for (const [id, strip] of this.#midiBuses) {
            if (!ids.has(id)) {
                this.#disposeStrip(strip);
                this.#midiBuses.delete(id);
            }
        }
    }

// Delay times are in beats, so a tempo change retimes every active delay.
    #updateDelayTimes() {
        if (!this.audioContext) {
            return;
        }
        const strips = [...[...this.tracks].map(([id, track]) => [id, track.strip]), ...this.#midiBuses];
        for (const [id, strip] of strips) {
            if (strip?.delay) {
                this.#smooth(strip.delay.delay.delayTime, this.#delaySeconds(this.getChannelMix(id).delayBeats));
            }
        }
    }


    // --- Automation ---
    automationParams() {
        return AUTOMATABLE_PARAMS.map((key) => ({key, ...MIX_PARAMS[key], log: LOG_PARAMS.has(key)}));
    }

    #cleanPoints(key, points) {
        if (!Array.isArray(points) || points.length > MAX_AUTOMATION_POINTS) {
            return null;
        }
        const spec = MIX_PARAMS[key];
        const byTick = new Map();
        for (const point of points) {
            if (!Number.isFinite(point?.tick) || !Number.isFinite(point?.value)) {
                continue;
            }
            // Later duplicates win; values are clamped to the parameter's range.
            byTick.set(Math.max(0, Math.round(point.tick)), Math.min(spec.max, Math.max(spec.min, point.value)));
        }
        return [...byTick].sort((a, b) => a[0] - b[0]).map(([tick, value]) => ({tick, value}));
    }

// Replaces a lane. An empty list removes it. Channels need not exist yet, so lanes
// can be restored before drums or the sample are created.
    setAutomation(id, key, points) {
        if (typeof id !== 'string' || !id || !AUTOMATABLE_PARAMS.includes(key)) {
            return false;
        }
        const cleaned = this.#cleanPoints(key, points);
        if (!cleaned) {
            return false;
        }
        if (!cleaned.length) {
            const lanes = this.#automation.get(id);
            if (lanes?.delete(key)) {
                if (!lanes.size) {
                    this.#automation.delete(id);
                }
                this.#restoreAutomatedParam(id, key);
            }
            return true;
        }
        let lanes = this.#automation.get(id);
        if (!lanes) {
            lanes = new Map();
            this.#automation.set(id, lanes);
        }
        lanes.set(key, cleaned);
        return true;
    }

    getAutomation(id, key) {
        return (this.#automation.get(id)?.get(key) ?? []).map((point) => ({...point}));
    }

    hasAutomation(id, key) {
        return this.#automation.get(id)?.has(key) ?? false;
    }

    clearAutomation(id, key) {
        return this.setAutomation(id, key, []);
    }

// Value of a lane at a tick, or null if the parameter has no lane.
    automationValueAt(id, key, tick) {
        const points = this.#automation.get(id)?.get(key);
        return points ? this.#interpolate(points, tick, LOG_PARAMS.has(key)) : null;
    }

    snapshotAutomation() {
        const lanes = [];
        for (const [channelId, keys] of this.#automation) {
            for (const [key, points] of keys) {
                lanes.push({channelId, key, points: points.map((point) => ({...point}))});
            }
        }
        return {version: 1, lanes};
    }

    restoreAutomation(state) {
        this.#restoreAutomatedParams();
        this.#automation.clear();
        if (!Array.isArray(state?.lanes)) {
            return;
        }
        for (const lane of state.lanes) {
            this.setAutomation(lane?.channelId, lane?.key, lane?.points);
        }
    }

    #interpolate(points, tick, log) {
        const first = points[0];
        const last = points[points.length - 1];
        if (tick <= first.tick) return first.value;
        if (tick >= last.tick) return last.value;
        let low = 0;
        let high = points.length - 1;
        while (high - low > 1) {
            const middle = (low + high) >> 1;
            if (points[middle].tick <= tick) low = middle; else high = middle;
        }
        const a = points[low];
        const b = points[high];
        const fraction = (tick - a.tick) / (b.tick - a.tick);
        return log ? a.value * (b.value / a.value) ** fraction : a.value + (b.value - a.value) * fraction;
    }

// Like #strip, but builds a MIDI track's strip if it doesn't exist yet.
    #stripFor(id) {
        const existing = this.#strip(id);
        if (existing) {
            return existing;
        }
        return this.sequence.tracks.some((track) => track.id === id) ? this.#getMidiBus(id) : null;
    }

// The AudioParam behind a mix key, creating delay/reverb nodes if the lane needs them.
    #audioParam(strip, mix, key) {
        switch (key) {
            case 'volume':
                return strip.gain.gain;
            case 'pan':
                return strip.pan.pan;
            case 'cutoff':
                return strip.filter.frequency;
            case 'resonance':
                return strip.filter.Q;
            case 'delaySend':
                return this.#ensureDelay(strip, mix).send.gain;
            case 'delayFeedback':
                return this.#ensureDelay(strip, mix).feedback.gain;
            case 'reverbSend':
                return this.#ensureReverb(strip, mix).send.gain;
            default:
                return null;
        }
    }

// Called for every scheduled step: one set + one ramp per automated parameter.
    #scheduleAutomation(stepIndex, time, fromTick) {
        if (!this.#automation.size) {
            return;
        }
        const sequence = this.sequence;
        const stepStart = sequence.stepToTick(stepIndex);
        // A partial first step (resume/seek) starts at the chosen tick, not the step boundary.
        const tick0 = fromTick === null ? stepStart : Math.max(stepStart, fromTick);
        const tick1 = sequence.stepToTick(stepIndex + 1);
        const stepOffset = this.stepSeconds(stepIndex);
        const t0 = time + sequence.ticksToSeconds(tick0) - stepOffset;
        const t1 = time + this.stepSeconds(stepIndex + 1) - stepOffset;
        for (const [id, lanes] of this.#automation) {
            const strip = this.#stripFor(id);
            if (!strip) {
                continue;
            }
            const mix = this.#mixFor(id);
            for (const [key, points] of lanes) {
                const param = this.#audioParam(strip, mix, key);
                if (!param) {
                    continue;
                }
                const log = LOG_PARAMS.has(key);
                const v0 = this.#interpolate(points, tick0, log);
                const v1 = this.#interpolate(points, tick1, log);
                param.setValueAtTime(v0, t0);
                if (v1 !== v0 && t1 > t0) {
                    if (log) {
                        param.exponentialRampToValueAtTime(v1, t1);
                    } else {
                        param.linearRampToValueAtTime(v1, t1);
                    }
                }
            }
        }
    }

// Snap automated parameters back to their mixer values (Stop/Pause, lane removal).
    #restoreAutomatedParams() {
        for (const [id, lanes] of this.#automation) {
            for (const key of lanes.keys()) {
                this.#restoreAutomatedParam(id, key);
            }
        }
    }

    #restoreAutomatedParam(id, key) {
        if (!this.audioContext) {
            return;
        }
        const strip = this.#strip(id);
        if (strip) {
            const mix = this.#mixFor(id);
            this.#applyParam(strip, mix, key, mix[key]);
        }
    }

    // --- UI Event Hook ---
    onStepTick(callback) {
        this.onStepTickCallback = callback;
    }
}

