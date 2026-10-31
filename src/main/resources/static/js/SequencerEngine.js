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
const MASTER_GAIN = 0.7; // headroom so summed tracks don't clip as easily

class SequencerEngine {
    constructor() {
        // Audio graph
        this.audioContext = null;
        this.masterGain = null;

        // Transport & timing state
        this.bpm = DEFAULT_BPM;
        this.isPlaying = false;
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
    play() {
        if (this.isPlaying || this.startPromise) {
            return this.startPromise || Promise.resolve();
        }
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
            this.isPlaying = true;
            this.currentStep = this.loopStart;
            this.nextNoteTime = this.audioContext.currentTime + START_DELAY_SEC;
            this.scheduler();
            if (!this.isPlaying || token !== this.runId) {
                return;
            }
            this.lookaheadTimer = setInterval(() => {
                try {
                    this.scheduler();
                } catch (error) {
                    this.stop();
                    this.#reportAudioError(error, { phase: 'scheduler', fatal: true });
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
            .catch(() => {});
        return pending;
    }

    stop() {
        if (this.isStopping) {
            return;
        }
        this.isStopping = true;
        this.isPlaying = false;
        this.runId++; // invalidates any pending UI timeouts
        clearInterval(this.lookaheadTimer);
        this.currentStep = this.loopStart;
        this.startPromise = null;
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
                        source.stop();
                    } catch (error) {
                        failures.push({ error, phase: 'sample-stop' });
                    }
                });
                track.activeSources.clear();
            });
            this.#callInstrumentHook('stop', [], failures);
            // Report only after every healthy voice and sample has been cancelled.
            failures.forEach(({ error, ...details }) => this.#reportAudioError(error, details));
        } finally {
            this.isStopping = false;
        }
    }

    #reportAudioError(error, details = {}) {
        const failure =
            error instanceof Error
                ? error
                : new Error(error?.message ?? String(error), { cause: error });
        const information = { fatal: false, ...details };
        this.audioErrors.push({ error: failure, ...information });
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
                failures.push({ error, phase: 'voice-stop' });
            } else {
                this.#reportAudioError(error, { phase: 'voice-stop' });
            }
        };
        try {
            const result = voice.stop();
            // stop() is synchronous by contract, but observe an accidental async rejection too.
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch((error) =>
                    this.#reportAudioError(error, { phase: 'voice-stop' })
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
            this.#reportAudioError(error, { phase: 'discarded-voice' });
        }
        try {
            if (voice && typeof voice.then === 'function') {
                Promise.resolve(voice).then(
                    (lateVoice) => this.#discardVoice(lateVoice),
                    (error) => this.#reportAudioError(error, { phase: 'async-factory' })
                );
                return;
            }
        } catch (error) {
            this.#reportAudioError(error, { phase: 'discarded-voice' });
        }
        try {
            const finished = completion ?? voice?.finished;
            if (finished && typeof finished.then === 'function') {
                Promise.resolve(finished).catch((error) =>
                    this.#reportAudioError(error, { phase: 'discarded-voice' })
                );
            }
        } catch (error) {
            this.#reportAudioError(error, { phase: 'discarded-voice' });
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
                    this.#reportAudioError(error, { phase: `instruments-${name}` })
                );
            }
        } catch (error) {
            if (failures) {
                failures.push({ error, phase: `instruments-${name}` });
            } else {
                this.#reportAudioError(error, { phase: `instruments-${name}` });
            }
        }
    }

    #syncInstrumentTracks() {
        this.#cancelPreparation();
        this.instrumentPreparation = null;
        this.#callInstrumentHook('syncTracks', [
            this.sequence.tracks.map((track) => ({ ...track }))
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
                controller.signal.addEventListener('abort', cancel, { once: true });
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
        this.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, newBpm));
        this.sequence.tempos = [{ ticks: 0, bpm: this.bpm }];
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
            track.steps = Array.from({ length: steps }, (_, stepIndex) =>
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
            track.steps = Array.from({ length: this.totalSteps }, (_, i) =>
                Boolean(track.steps[i])
            );
        });
        this.loopStart = 0;
        this.loopEnd = this.totalSteps;
        this.currentStep = 0;
        this.bpm = sequence.tempos.find((tempo) => tempo.ticks === 0)?.bpm ?? 120;
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
    }

    // UI reads the same audio clock; no second playback scheduler.
    getPlaybackStep() {
        let step = this.visibleStep ?? null;
        while (this.stepEvents.length && this.stepEvents[0].time <= this.audioContext.currentTime) {
            step = this.stepEvents.shift().step;
        }
        this.visibleStep = this.isPlaying ? step : null;
        return this.visibleStep;
    }

    // --- Track & Grid Management ---
    addTrack(trackId, audioBuffer) {
        this.initContext(); // guarantees audioContext and masterGain exist

        this.removeTrack(trackId);
        // Per-track gain node for volume control
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = DEFAULT_TRACK_GAIN;
        gainNode.connect(this.masterGain);

        this.tracks.set(trackId, {
            buffer: audioBuffer,
            steps: new Array(this.totalSteps).fill(false),
            gainNode,
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
        try {
            track.gainNode.disconnect();
        } catch (error) {
            failures.push(error);
        }
        this.tracks.delete(trackId);
        failures.forEach((error) =>
            this.#reportAudioError(error, { phase: 'sample-remove', trackId })
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
            const cycles = Math.floor((now - this.nextNoteTime) / loopSeconds);
            this.nextNoteTime += cycles * loopSeconds;
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
        this.currentStep =
            this.currentStep + 1 >= this.loopEnd ? this.loopStart : this.currentStep + 1;
    }

    scheduleStep(stepIndex, time) {
        const runId = this.runId;
        // Bound history even for legacy consumers that only use onStepTick().
        this.stepEvents = this.stepEvents.filter(
            (event) => event.time >= this.audioContext.currentTime - 1
        );
        this.stepEvents.push({ step: stepIndex, time });
        this.#schedulePitchedNotes(stepIndex, time);
        if (runId !== this.runId) {
            return;
        }
        this.#notifyStepTick(stepIndex, time);
        this.#scheduleSampleTracks(stepIndex, time);
    }

    #schedulePitchedNotes(stepIndex, time) {
        const runId = this.runId;
        // Convert each endpoint separately: a sustained note may cross tempo changes.
        this.sequence.notesAt(stepIndex).forEach((note) => {
            if (runId !== this.runId) {
                return;
            }
            const track = this.sequence.tracks.find((track) => track.id === note.trackId);
            const event = {
                ...note,
                channel: track?.channel,
                program: track?.program,
                startStep: note.startStep,
                durationSteps: note.durationSteps,
                when: time + this.sequence.ticksToSeconds(note.ticks) - this.stepSeconds(stepIndex),
                duration:
                    this.sequence.ticksToSeconds(note.ticks + note.durationTicks) -
                    this.sequence.ticksToSeconds(note.ticks)
            };
            try {
                const voice = this.voiceFactory
                    ? this.voiceFactory(event, this.audioContext, this.masterGain)
                    : this.createPitchedVoice(event);
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
        });
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
    createPitchedVoice(event) {
        const oscillator = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        oscillator.frequency.value = 440 * 2 ** ((event.midi - 69) / 12);
        oscillator.connect(gain);
        gain.connect(this.masterGain);
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
                } catch (_) {}
            }
        };
    }

    // --- UI Event Hook ---
    onStepTick(callback) {
        this.onStepTickCallback = callback;
    }
}
