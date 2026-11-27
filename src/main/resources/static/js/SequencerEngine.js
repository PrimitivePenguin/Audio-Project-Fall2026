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
const DEFAULT_LANE_GAIN = 1;
const MAX_TRACK_GAIN = 1.5;
const MASTER_ID = 'master';
const MAX_AUTOMATION_POINTS = 2000;       // per lane
const MAX_TEMPO_EVENTS = 2048;            // cap on tempo-map events compiled from a tempo lane
const PARAM_SMOOTHING_SEC = 0.015;
const MASTER_GAIN = 0.7;                  // headroom; also the master volume default

// Fully-open cutoff for each filter type.
const FILTER_TYPES = {lowpass: 20000, highpass: 20};

// Built-in per-channel params. Effect params come from the registry.
const CORE_PARAMS = {
    volume: {label: 'Vol', min: 0, max: MAX_TRACK_GAIN, def: null, step: 0.01, format: 'percent', automatable: true},
    pan: {label: 'Pan', min: -1, max: 1, def: 0, step: 0.01, format: 'pan', automatable: true},
    cutoff: {label: 'Cutoff', min: 20, max: 20000, def: 20000, step: 0.001, format: 'hz', log: true, automatable: true},
    resonance: {label: 'Reso', min: 0, max: 15, def: 0, step: 0.1, format: 'db', automatable: true}
};
// Tempo is automatable on the master channel only; it compiles into the sequence's tempo map.
const TEMPO_PARAM = {
    key: 'tempo', label: 'Tempo', min: MIN_BPM, max: MAX_BPM, def: DEFAULT_BPM,
    step: 0.1, format: 'bpm', log: false, automatable: true
};

class SequencerEngine {
    // Mix state lives here, not on the nodes, so it survives track removal/recreation
    // and can be set before the AudioContext exists.
    #mix = new Map();        // channelId -> stored mix values
    #automation = new Map(); // channelId -> Map(paramKey -> [{ tick, value }])
    #laneBuses = new Map();  // lane trackId (MIDI or audio) -> strip
    #masterStrip = null;
    #modules = [];           // registered effect modules, sorted by order
    #specs = {};             // param key -> spec (core + every module)
    #owner = new Map();      // effect param key -> module
    #shared = new Map();     // per-engine resources shared by effect instances

    constructor() {
        this.#modules = window.JukeBoxEffects?.all() ?? [];
        if (!this.#modules.length) console.warn('SequencerEngine: no effect modules registered.');
        this.#specs = {...CORE_PARAMS};
        for (const module of this.#modules) {
            for (const [key, spec] of Object.entries(module.params)) {
                this.#specs[key] = spec;
                this.#owner.set(key, module);
            }
        }
        // Audio graph
        this.audioContext = null;
        this.masterGain = null;
        this.laneGains = new Map(); // track ID to mute node
        this.mutedLanes = new Set();

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
        this.arrangement = new AudioArrangement();
        this.clipSources = new Set();
        this.clipPassEntry = true;
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
            this.#masterStrip = this.#buildStrip(this.getChannelMix(MASTER_ID), this.audioContext.destination, 'master');
            this.masterGain = this.#masterStrip.gain; // every lane still connects here
        }
    }

    laneOutput(id) {
        return this.#laneStrip(id).gain;
    }

    #laneStrip(id) {
        let strip = this.#laneBuses.get(id);
        if (!strip) {
            this.initContext();
            // Mute sits last, so a muted lane also silences its delay and reverb tails.
            const mute = this.audioContext.createGain();
            mute.gain.value = this.mutedLanes.has(id) ? 0 : 1;
            mute.connect(this.masterGain);
            strip = this.#buildStrip(this.getChannelMix(id), mute);
            strip.mute = mute;
            this.#laneBuses.set(id, strip);
            this.laneGains.set(id, mute); // setLaneMuted reads this
        }
        return strip;
    }

    setLaneMuted(id, muted) {
        if (muted) this.mutedLanes.add(id);
        else this.mutedLanes.delete(id);
        const gain = this.laneGains.get(id)?.gain;
        if (!gain) return;
        const now = this.audioContext.currentTime;
        if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(now);
        else {
            const value = gain.value;
            gain.cancelScheduledValues(now);
            gain.setValueAtTime(value, now);
        }
        gain.linearRampToValueAtTime(muted ? 0 : 1, now + 0.008);
    }

    // One-shot audition on the shared clock, independent of transport and project data.
    playPatternPreview(buffer, onEnd) {
        if (this.isPlaying || this.startPromise || this.patternPreview) return false;
        this.initContext();
        const context = this.audioContext;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.masterGain);
        const finish = () => {
            if (this.patternPreview !== stop) return;
            source.onended = null;
            source.disconnect();
            this.patternPreview = null;
            onEnd?.();
        };
        const stop = () => {
            try {
                source.stop();
            } finally {
                finish();
            }
        };
        this.patternPreview = stop;
        source.onended = finish;
        try {
            source.start();
            if (context.state !== 'running') {
                context.resume().catch(() => {
                    if (this.patternPreview === stop) stop();
                });
            }
        } catch (error) {
            finish();
            throw error;
        }
        return true;
    }

    stopPatternPreview() {
        this.patternPreview?.();
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
        this.stopPatternPreview();
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
            this.clipPassEntry = true;
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
        this.stopPatternPreview();
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
                        source.stop();
                    } catch (error) {
                        failures.push({error, phase: 'sample-stop'});
                    }
                });
                track.activeSources.clear();
            });
            for (const source of this.clipSources) {
                try {
                    source.stop();
                } catch (error) {
                    failures.push({error, phase: 'clip-stop'});
                }
                source.disconnect();
            }
            this.clipSources.clear();
            try {
                this.#restoreAutomatedParams();
            } catch (error) {
                failures.push({error, phase: 'automation-restore'});
            }
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
            throw new Error('Press Stop before deleting or restoring tracks.');
        }
    }

    #channelAutomation(id) {
        return [...(this.#automation.get(id) ?? [])]
            .map(([key, points]) => ({key, points: points.map((point) => ({...point}))}));
    }

    #laneDeletionState(id) {
        const order = this.arrangement.orderedTracks(this.sequence.tracks).map((track) => track.id);
        return {
            order, index: order.indexOf(id), mix: this.getChannelMix(id),
            muted: this.mutedLanes.has(id), automation: this.#channelAutomation(id)
        };
    }

    #removeLane(id, state) {
        this.arrangement.laneOrder = state.order.filter((laneId) => laneId !== id);
        this.#disconnectLane(id);
        this.#mix.delete(id);
        this.#automation.delete(id);
        this.mutedLanes.delete(id);
    }

    #restoreLane(id, state) {
        const order = this.arrangement.laneOrder;
        const next = state.order.slice(state.index + 1).find((laneId) => order.includes(laneId));
        order.splice(next ? order.indexOf(next) : Math.min(state.index, order.length), 0, id);
        this.applyChannelMix(id, state.mix);
        this.setLaneMuted(id, state.muted);
        for (const {key, points} of state.automation ?? []) this.setAutomation(id, key, points);
    }

    deleteMidiTrack(id) {
        this.assertTrackDeletionStopped();
        const lane = this.#laneDeletionState(id);
        const record = this.sequence.deleteMusicalTrack(id);
        this.#removeLane(id, lane);
        this.#syncInstrumentTracks();
        return {...record, lane};
    }

    restoreMidiTrack(record) {
        this.assertTrackDeletionStopped();
        const track = this.sequence.restoreMusicalTrack(record);
        if (record.lane) this.#restoreLane(track.id, record.lane);
        this.#syncInstrumentTracks();
        return track;
    }

    deleteAudioTrack(id) {
        this.assertTrackDeletionStopped();
        const lane = this.#laneDeletionState(id);
        const record = this.arrangement.deleteTrack(id);
        this.#removeLane(id, lane);
        return {...record, lane};
    }

    restoreAudioTrack(record) {
        this.assertTrackDeletionStopped();
        this.arrangement.restoreTrack(record);
        this.#restoreLane(record.track.id, record.lane);
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
        this.#pruneLaneBuses();
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
        if (this.hasAutomation(MASTER_ID, 'tempo')) {
            throw new Error('Tempo automation is active. Edit or clear the Tempo lane.');
        }
        if (!Number.isFinite(newBpm)) {
            return;
        }
        if (this.sequence.tempos.length > 1) {
            throw new Error('Imported tempo map is active; BPM editing is disabled.');
        }
        if (this.arrangement.clips.size && (this.isPlaying || this.startPromise)) {
            throw new Error('Pause or stop before changing BPM with audio clips.');
        }
        const tick = this.getPlaybackTick();
        this.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, newBpm));
        this.#notifyTempo();
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
        if (this.arrangement.query(this.sequence, this.sequence.stepToTick(steps), Infinity, true).length) {
            throw new Error('Cannot shorten past existing audio clips. Trim or move them first.');
        }
        const wasFullPatternLoop = this.loopStart === 0 && this.loopEnd === this.totalSteps;
        this.totalSteps = this.sequence.stepCount = steps;
        this.tracks.forEach((track) => {
            if (track.previewOnly) return;
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
        this.arrangement.retime(this.sequence.ppq, sequence.ppq);
        const lastClipTick = this.arrangement.clips.size ? this.arrangement.getIndex(sequence).root.maxEnd : 0;
        const lastClipStep = Math.min(65536, Math.ceil(sequence.tickToStep(lastClipTick) - 1e-10));
        sequence.stepCount = Math.max(sequence.stepCount, lastSampleStep, lastClipStep);
        this.sequence = sequence;
        this.totalSteps = sequence.stepCount;
        this.tracks.forEach((track) => {
            if (track.previewOnly) return;
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
        this.#notifyTempo();
        this.#syncInstrumentTracks();
    }

    importMidiSequence(sequence) {
        if (this.isPlaying || this.startPromise) {
            throw new Error('Stop before importing MIDI.');
        }
        const importId = `import-${this.nextMidiImportId}`;
        const combined = this.sequence.withMidiImport(sequence, importId, this.arrangement.clips.size > 0);
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
        this.arrangement = new AudioArrangement();
        for (const id of [...this.#laneBuses.keys()]) this.#disconnectLane(id);
        this.#mix.clear();
        this.#automation.clear();
        this.mutedLanes.clear();
        this.#syncMasterStrip();
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
    addTrack(trackId, audioBuffer, {previewOnly = false} = {}) {
        this.initContext();
        this.removeTrack(trackId);

        const strip = this.#buildStrip(this.#mixFor(trackId));
        this.tracks.set(trackId, {
            buffer: audioBuffer,
            steps: previewOnly ? [] : new Array(this.totalSteps).fill(false),
            previewOnly,
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
                this.clipPassEntry = true;
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
            this.clipPassEntry = true;
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
        this.#scheduleAudioClips(stepIndex, time, fromTick);
        if (runId !== this.runId) return;
        this.#notifyStepTick(stepIndex, visibleTime);
        if (fromTick === null || fromTick <= this.sequence.stepToTick(stepIndex)) {
            this.#scheduleSampleTracks(stepIndex, time);
        }
    }

    #scheduleAudioClips(stepIndex, time, fromTick) {
        const held = this.clipPassEntry;
        this.clipPassEntry = false;
        if (!this.arrangement.clips.size) return;
        const sequence = this.sequence;
        const firstTick = fromTick ?? sequence.stepToTick(stepIndex);
        const endTick = sequence.stepToTick(stepIndex + 1);
        const clips = this.arrangement.query(sequence, firstTick, endTick, held);
        if (!clips.length) return;
        const map = AudioArrangement.timeMap(sequence);
        const stepSeconds = map.secondsAt(sequence.stepToTick(stepIndex));
        const firstSeconds = map.secondsAt(firstTick);
        const cutoff = map.secondsAt(sequence.stepToTick(this.schedulingEndStep));
        const audioNow = this.audioContext.currentTime;
        const runId = this.runId;
        for (const {clip, startSeconds, endSeconds} of clips) {
            if (this.runId !== runId) return;
            const buffer = this.arrangement.assets.get(clip.assetId)?.buffer;
            if (!buffer) continue;
            const onset = Math.max(startSeconds, firstSeconds, stepSeconds + audioNow - time);
            const duration = Math.min(endSeconds, cutoff) - onset;
            if (duration <= 1e-9) continue;
            let source;
            try {
                source = this.audioContext.createBufferSource();
                source.buffer = buffer;
                source.connect(this.laneOutput(clip.trackId));
                this.clipSources.add(source);
                source.onended = () => {
                    this.clipSources.delete(source);
                    source.disconnect();
                };
                source.start(Math.max(audioNow, time + onset - stepSeconds),
                    clip.sourceOffsetSeconds + onset - startSeconds, duration);
            } catch (error) {
                if (source) {
                    this.clipSources.delete(source);
                    source.disconnect();
                }
                this.#reportAudioError(error, {phase: 'clip-start'});
            }
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
            const output = this.laneOutput(note.trackId);
            const voice = this.voiceFactory
                ? this.voiceFactory(event, this.audioContext, output)
                : this.createPitchedVoice(event, output);
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
            if (track.previewOnly || !track.steps[stepIndex] || !track.buffer) {
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

    // ---- Channels: mix, effect hosting, master ----
    #isLane(id) {
        return this.sequence.tracks.some((track) => track.id === id) || this.arrangement.tracks.has(id);
    }

    #defaultVolume(id) {
        if (id === MASTER_ID) return MASTER_GAIN;
        return this.#isLane(id) ? DEFAULT_LANE_GAIN : DEFAULT_TRACK_GAIN;
    }

    #defaultFor(id, key, mix) {
        if (key === 'volume') return this.#defaultVolume(id);
        if (key === 'cutoff') return FILTER_TYPES[mix?.filterType ?? 'lowpass'];
        return this.#specs[key].def;
    }

    #mixFor(id) {
        let mix = this.#mix.get(id);
        if (!mix) {
            mix = { filterType: 'lowpass' };
            this.#mix.set(id, mix);
        }
        for (const key of Object.keys(this.#specs)) {
            mix[key] ??= this.#defaultFor(id, key, mix);
        }
        return mix;
    }

    #isChannel(id) {
        return id === MASTER_ID || this.tracks.has(id) || this.arrangement.tracks.has(id) || this.#isLane(id);
    }

    hasChannel(id) {
        return this.#isChannel(id);
    }

    // An effect's params only exist on channels in that module's scopes.
    #allowed(id, key) {
        const module = this.#owner.get(key);
        return !module || module.scopes.includes(id === MASTER_ID ? 'master' : 'channel');
    }

    #strip(id) {
        if (id === MASTER_ID) return this.#masterStrip;
        return this.tracks.get(id)?.strip ?? this.#laneBuses.get(id) ?? null;
    }

    #smooth(param, value) {
        const now = this.audioContext.currentTime;
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, PARAM_SMOOTHING_SEC);
    }

    // What effect modules get. They never see the engine itself.
    #fxEnv() {
        return {
            context: this.audioContext,
            shared: this.#shared,
            bpm: () => this.bpm,
            smooth: (param, value) => this.#smooth(param, value),
            set: (param, value) => {
                param.cancelScheduledValues(0);
                param.value = value;
            }
        };
    }

    // The one place a stored mix value becomes an audio-node change.
    #applyParam(id, key) {
        const strip = this.#strip(id);
        if (!strip) return;
        const mix = this.#mixFor(id);
        switch (key) {
            case 'volume': this.#smooth(strip.gain.gain, mix.volume); return;
            case 'pan': this.#smooth(strip.pan.pan, mix.pan); return;
            case 'cutoff': this.#smooth(strip.filter.frequency, mix.cutoff); return;
            case 'resonance': this.#smooth(strip.filter.Q, mix.resonance); return;
        }
        const module = this.#owner.get(key);
        if (!module || !module.scopes.includes(strip.scope)) return;
        const existing = strip.effects.get(module.id);
        if (existing) existing.apply(mix, this.#fxEnv());
        else if (module.isActive(mix)) this.#ensureEffect(strip, module, mix);
    }

    // Works for lanes, sample/drum channels and the master, before or during playback.
    setChannelParam(id, key, value) {
        const spec = this.#specs[key];
        if (!spec || !Number.isFinite(value) || !this.#isChannel(id) || !this.#allowed(id, key)) {
            return false;
        }
        this.#mixFor(id)[key] = Math.min(spec.max, Math.max(spec.min, value));
        this.#applyParam(id, key);
        return true;
    }

    setChannelVolume(id, value) { return this.setChannelParam(id, 'volume', value); }
    setChannelPan(id, value) { return this.setChannelParam(id, 'pan', value); }

    // Switching type moves a fully-open cutoff to the new type's open position.
    setChannelFilterType(id, type) {
        if (!Object.hasOwn(FILTER_TYPES, type) || !this.#isChannel(id)) return false;
        const mix = this.#mixFor(id);
        const previous = mix.filterType;
        if (previous === type) return true;
        const wasOpen = mix.cutoff === FILTER_TYPES[previous];
        mix.filterType = type;
        const strip = this.#strip(id);
        if (strip) strip.filter.type = type;
        if (wasOpen) this.setChannelParam(id, 'cutoff', FILTER_TYPES[type]);
        return true;
    }

    resetChannelParam(id, key) {
        if (!this.#specs[key]) return false;
        return this.setChannelParam(id, key, this.#defaultFor(id, key, this.#mix.get(id)));
    }

    getChannelMix(id) {
        const mix = this.#mix.get(id);
        const out = { filterType: mix?.filterType ?? 'lowpass' };
        for (const key of Object.keys(this.#specs)) {
            out[key] = mix?.[key] ?? this.#defaultFor(id, key, mix);
        }
        return out;
    }

    // Applies any recognised keys and ignores the rest, so old saves still load.
    // The filter type goes first so a saved cutoff isn't remapped afterwards.
    applyChannelMix(id, mix) {
        this.setChannelFilterType(id, mix?.filterType);
        for (const key of Object.keys(this.#specs)) {
            this.setChannelParam(id, key, mix?.[key]);
        }
    }

    extractMix(source) {
        const out = {};
        for (const key of Object.keys(this.#specs)) {
            if (Number.isFinite(source?.[key])) out[key] = source[key];
        }
        if (Object.hasOwn(FILTER_TYPES, source?.filterType)) out.filterType = source.filterType;
        return out;
    }

    resetChannelMix(id) {
        this.#mix.delete(id);
        if (id === MASTER_ID) this.#syncMasterStrip();
    }

    // Master mix is saved with the lane mixes.
    snapshotMix() {
        return {
            master: this.getChannelMix(MASTER_ID),
            tracks: this.arrangement.orderedTracks(this.sequence.tracks).map((track) => ({
                trackId: track.id,
                ...this.getChannelMix(track.id)
            }))
        };
    }

    restoreMix(state) {
        // Master always resets first, so loading a project without a master mix gives defaults.
        this.#mix.delete(MASTER_ID);
        this.#syncMasterStrip();
        if (state?.master) this.applyChannelMix(MASTER_ID, state.master);
        if (!Array.isArray(state?.tracks)) return;
        for (const entry of state.tracks) {
            this.applyChannelMix(entry?.trackId, entry);
        }
    }

    #syncMasterStrip() {
        const strip = this.#masterStrip;
        if (!strip) return;
        strip.filter.type = this.getChannelMix(MASTER_ID).filterType;
        for (const key of Object.keys(this.#specs)) {
            if (this.#allowed(MASTER_ID, key)) this.#applyParam(MASTER_ID, key);
        }
    }

    // Describes every param for the UI: core groups first, then each effect valid for this channel.
    paramCatalog(id = null) {
        const scope = id === MASTER_ID ? 'master' : 'channel';
        const describe = (key, spec) => ({
            key, label: spec.label ?? key, min: spec.min, max: spec.max, def: spec.def,
            step: spec.step ?? 0.01, format: spec.format ?? 'number',
            log: spec.log === true, automatable: spec.automatable === true
        });
        const groups = [
            { id: 'mix', label: 'Mix', params: ['volume', 'pan'].map((key) => describe(key, CORE_PARAMS[key])) },
            { id: 'filter', label: 'Filter', params: ['cutoff', 'resonance'].map((key) => describe(key, CORE_PARAMS[key])) }
        ];
        for (const module of this.#modules) {
            if (!module.scopes.includes(scope)) continue;
            groups.push({
                id: module.id, label: module.label, kind: module.kind,
                params: Object.entries(module.params).map(([key, spec]) => describe(key, spec))
            });
        }
        return groups;
    }

    effectActive(id, moduleId) {
        const module = this.#modules.find((candidate) => candidate.id === moduleId);
        return Boolean(module?.isActive(this.getChannelMix(id)));
    }

    // gain -> filter -> [inserts] -> pan -> out, plus send taps off pan. Effects are created lazily.
    #buildStrip(mix, out = this.masterGain, scope = 'channel') {
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
        pan.connect(out);
        const strip = { gain, filter, pan, out, scope, effects: new Map() };
        for (const module of this.#modules) {
            if (module.scopes.includes(scope) && module.isActive(mix)) this.#ensureEffect(strip, module, mix);
        }
        return strip;
    }

    #ensureEffect(strip, module, mix) {
        let instance = strip.effects.get(module.id);
        if (instance) return instance;
        const env = this.#fxEnv();
        instance = module.create(env, mix);
        strip.effects.set(module.id, instance);
        if (module.kind === 'send') {
            strip.pan.connect(instance.input);
            instance.output.connect(strip.out);
        } else {
            this.#rewireInserts(strip);
        }
        instance.apply(mix, env, true);
        return instance;
    }

    // Reconnects filter -> active inserts (in module order) -> pan. Runs when an insert is first created.
    #rewireInserts(strip) {
        const inserts = this.#modules
            .filter((module) => module.kind === 'insert' && strip.effects.has(module.id))
            .map((module) => strip.effects.get(module.id));
        try { strip.filter.disconnect(); } catch (_) {}
        for (const instance of inserts) {
            try { instance.output.disconnect(); } catch (_) {}
        }
        let tail = strip.filter;
        for (const instance of inserts) {
            tail.connect(instance.input);
            tail = instance.output;
        }
        tail.connect(strip.pan);
    }

    #disposeStrip(strip) {
        if (!strip) return;
        for (const instance of strip.effects?.values() ?? []) {
            try { instance.dispose?.(); } catch (_) {}
            for (const node of instance.nodes) {
                try { node.disconnect(); } catch (_) {}
            }
        }
        // Never disconnect strip.out: for lanes it is shared.
        for (const node of [strip.gain, strip.filter, strip.pan, strip.mute].filter(Boolean)) {
            try { node.disconnect(); } catch (_) {}
        }
    }

    #disconnectLane(id) {
        const strip = this.#laneBuses.get(id);
        if (!strip) return;
        this.#disposeStrip(strip);
        this.#laneBuses.delete(id);
        this.laneGains.delete(id);
    }

    #pruneLaneBuses() {
        const midiIds = new Set(this.sequence.tracks.map((track) => track.id));
        for (const id of [...this.#laneBuses.keys()]) {
            if (!midiIds.has(id) && !this.arrangement.tracks.has(id)) this.#disconnectLane(id);
        }
    }

    // Tempo-synced effects (delay times) retime themselves.
    #notifyTempo() {
        if (!this.audioContext) return;
        const env = this.#fxEnv();
        const strips = [...this.tracks].map(([id, track]) => [id, track.strip]).concat([...this.#laneBuses]);
        for (const [id, strip] of strips) {
            const mix = this.getChannelMix(id);
            for (const instance of strip?.effects?.values() ?? []) instance.onTempoChange?.(mix, env);
        }
    }

    // ---- Automation ----
    // Every automatable param for a channel; the master also gets Tempo.
    automationParams(id) {
        const list = this.paramCatalog(id).flatMap((group) =>
            group.params.filter((param) => param.automatable).map((param) => ({ ...param, groupLabel: group.label })));
        if (id === MASTER_ID) list.push({ ...TEMPO_PARAM, groupLabel: 'Master' });
        return list;
    }

    #spec(key) {
        return key === 'tempo' ? TEMPO_PARAM : this.#specs[key];
    }

    #cleanPoints(spec, points) {
        if (!Array.isArray(points) || points.length > MAX_AUTOMATION_POINTS) return null;
        const byTick = new Map();
        for (const point of points) {
            if (!Number.isFinite(point?.tick) || !Number.isFinite(point?.value)) continue;
            byTick.set(Math.max(0, Math.round(point.tick)), Math.min(spec.max, Math.max(spec.min, point.value)));
        }
        return [...byTick].sort((a, b) => a[0] - b[0]).map(([tick, value]) => ({ tick, value }));
    }

    // Replaces a lane. An empty list removes it. Returns false if the lane isn't allowed.
    setAutomation(id, key, points) {
        return this.#setLane(id, key, points, false);
    }

    #setLane(id, key, points, restoring) {
        const spec = this.#spec(key);
        if (typeof id !== 'string' || spec?.automatable !== true) return false;
        const isTempo = key === 'tempo';
        if (!(id === MASTER_ID || this.#isLane(id)) || (isTempo && id !== MASTER_ID) || !this.#allowed(id, key)) {
            return false;
        }
        if (isTempo && !restoring) {
            // The tempo map is read by the scheduler, so only edit it while stopped.
            if (this.isPlaying || this.startPromise) return false;
            // An imported tempo map is only replaced if the user already owns a tempo lane.
            if (this.sequence.tempos.length > 1 && !this.hasAutomation(MASTER_ID, 'tempo')) return false;
        }
        const cleaned = this.#cleanPoints(spec, points);
        if (!cleaned) return false;
        if (!cleaned.length) {
            const lanes = this.#automation.get(id);
            if (lanes?.delete(key)) {
                if (!lanes.size) this.#automation.delete(id);
                this.#restoreAutomatedParam(id, key);
                if (isTempo && !restoring) this.#compileTempo();
            }
            return true;
        }
        let lanes = this.#automation.get(id);
        if (!lanes) {
            lanes = new Map();
            this.#automation.set(id, lanes);
        }
        lanes.set(key, cleaned);
        if (isTempo && !restoring) this.#compileTempo();
        return true;
    }

    getAutomation(id, key) {
        return (this.#automation.get(id)?.get(key) ?? []).map((point) => ({ ...point }));
    }

    hasAutomation(id, key) {
        return this.#automation.get(id)?.has(key) ?? false;
    }

    clearAutomation(id, key) {
        return this.setAutomation(id, key, []);
    }

    automationValueAt(id, key, tick) {
        const points = this.#automation.get(id)?.get(key);
        return points ? this.#interpolate(points, tick, this.#spec(key)?.log === true) : null;
    }

    snapshotAutomation() {
        const lanes = [];
        for (const [channelId, keys] of this.#automation) {
            for (const [key, points] of keys) {
                lanes.push({ channelId, key, points: points.map((point) => ({ ...point })) });
            }
        }
        return { version: 1, lanes };
    }

    restoreAutomation(state) {
        this.#restoreAutomatedParams();
        this.#automation.clear();
        if (!Array.isArray(state?.lanes)) return;
        // Tempo lanes are not recompiled here: the saved tempo map already contains the result.
        for (const lane of state.lanes) this.#setLane(lane?.channelId, lane?.key, lane?.points, true);
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

    // Writes the tempo lane into the sequence's tempo map, one event per step (or per stride on long lanes).
    #compileTempo() {
        const sequence = this.sequence;
        const points = this.#automation.get(MASTER_ID)?.get('tempo');
        if (!points?.length) {
            sequence.tempos = [{ ticks: 0, bpm: this.bpm }];
            this.#notifyTempo();
            return;
        }
        const clamp = (bpm) => Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
        const firstStep = Math.floor(sequence.tickToStep(points[0].tick));
        const lastStep = Math.ceil(sequence.tickToStep(points[points.length - 1].tick));
        const stride = Math.max(1, Math.ceil((lastStep - firstStep) / MAX_TEMPO_EVENTS));
        const tempos = [{ ticks: 0, bpm: clamp(points[0].value) }];
        for (let step = firstStep + stride; step < lastStep + stride; step += stride) {
            const ticks = Math.round(sequence.stepToTick(Math.min(step, lastStep)));
            const bpm = clamp(this.#interpolate(points, ticks, false));
            const previous = tempos[tempos.length - 1];
            if (ticks > previous.ticks && Math.abs(bpm - previous.bpm) >= 0.01) {
                tempos.push({ ticks, bpm: Number(bpm.toFixed(3)) });
            }
        }
        sequence.tempos = tempos;
        this.#notifyTempo();
    }

    // Like #strip, but builds a lane's strip if it doesn't exist yet.
    #stripFor(id) {
        return this.#strip(id) ?? (this.#isLane(id) ? this.#laneStrip(id) : null);
    }

    // The AudioParams behind a mix key, creating the effect if a lane needs it.
    #automationTargets(strip, id, key) {
        switch (key) {
            case 'volume': return [{ param: strip.gain.gain }];
            case 'pan': return [{ param: strip.pan.pan }];
            case 'cutoff': return [{ param: strip.filter.frequency }];
            case 'resonance': return [{ param: strip.filter.Q }];
        }
        const module = this.#owner.get(key);
        if (!module || !module.scopes.includes(strip.scope)) return [];
        const instance = strip.effects.get(module.id) ?? this.#ensureEffect(strip, module, this.#mixFor(id));
        return instance.targets(key);
    }

    // Called for every scheduled step: one set + one ramp per automated parameter.
    #scheduleAutomation(stepIndex, time, fromTick) {
        if (!this.#automation.size) return;
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
            if (!strip) continue;
            for (const [key, points] of lanes) {
                if (key === 'tempo') continue; // already in the tempo map
                const log = this.#specs[key]?.log === true;
                const v0 = this.#interpolate(points, tick0, log);
                const v1 = this.#interpolate(points, tick1, log);
                for (const { param, map } of this.#automationTargets(strip, id, key)) {
                    const a = map ? map(v0) : v0;
                    const b = map ? map(v1) : v1;
                    param.setValueAtTime(a, t0);
                    if (b !== a && t1 > t0) {
                        if (log && a > 0 && b > 0) param.exponentialRampToValueAtTime(b, t1);
                        else param.linearRampToValueAtTime(b, t1);
                    }
                }
            }
        }
    }

    // Snap automated parameters back to their mixer values (Stop/Pause, lane removal).
    #restoreAutomatedParams() {
        for (const [id, lanes] of this.#automation) {
            for (const key of lanes.keys()) this.#restoreAutomatedParam(id, key);
        }
    }

    #restoreAutomatedParam(id, key) {
        if (!this.audioContext || key === 'tempo') return;
        this.#applyParam(id, key);
    }

    // --- UI Event Hook ---
    onStepTick(callback) {
        this.onStepTickCallback = callback;
    }
}

