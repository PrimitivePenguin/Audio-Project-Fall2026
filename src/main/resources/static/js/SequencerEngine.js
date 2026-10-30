// --- Constants ---
const MIN_BPM = 40;
const MAX_BPM = 240;
const DEFAULT_BPM = 120;

const TOTAL_STEPS = 16;
const STEPS_PER_BEAT = 4; // 16th notes

const SCHEDULE_INTERVAL_MS = 25;  // how often the scheduler timer fires
const SCHEDULE_AHEAD_SEC = 0.1;   // how far ahead to schedule audio
const START_DELAY_SEC = 0.05;     // small head start so step 0 isn't late

const DEFAULT_TRACK_GAIN = 0.8;
const MASTER_GAIN = 0.7;          // headroom so summed tracks don't clip as easily


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
        this.pitchedVoices = new Set();
        this.stepEvents = [];
        this.onError = null;
        this.voiceFactory = null;

        // Scheduler (lookahead pattern s/o Chris Wilson https://web.dev/articles/audio-scheduling)
        this.lookaheadTimer = null;
        this.nextNoteTime = 0.0; // next step's time, in AudioContext seconds

        // Incremented on every play/stop so stale UI timeouts can detect they're outdated
        this.runId = 0;

        // trackId -> { buffer, steps: [bool x TOTAL_STEPS], gainNode, activeSources: Set }
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
        if (this.isPlaying || this.startPromise) return this.startPromise || Promise.resolve();
        const token = ++this.runId;
        const start = async () => {
            this.initContext();
            if (this.audioContext.state !== 'running') await this.audioContext.resume();
            if (token !== this.runId) return;
            this.isPlaying = true;
            this.currentStep = this.loopStart;
            this.nextNoteTime = this.audioContext.currentTime + START_DELAY_SEC;
            this.scheduler();
            this.lookaheadTimer = setInterval(() => {
                try { this.scheduler(); }
                catch (error) { this.stop(); if (this.onError) this.onError(error); }
            }, SCHEDULE_INTERVAL_MS);
        };
        const pending = start().catch(error => {
            if (token === this.runId) this.stop();
            throw error;
        });
        this.startPromise = pending;
        pending.finally(() => {
            if (this.startPromise === pending) this.startPromise = null;
        }).catch(() => {});
        return pending;
    }

    stop() {
        this.isPlaying = false;
        this.runId++; // invalidates any pending UI timeouts
        clearInterval(this.lookaheadTimer);
        this.currentStep = this.loopStart;
        this.startPromise = null;
        this.stepEvents = [];
        this.visibleStep = null;
        this.pitchedVoices.forEach(voice => voice.stop());
        this.pitchedVoices.clear();

        // Silence anything already scheduled or still ringing
        this.tracks.forEach((track) => {
            track.activeSources.forEach((source) => {
                try { source.stop(); } catch (_) { /* already ended */ }
            });
            track.activeSources.clear();
        });
    }

    setBpm(newBpm) {
        if (!Number.isFinite(newBpm)) return;
        this.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, newBpm));
    }

    setLoopRange(start, end) {
        if (this.isPlaying || this.startPromise) throw new Error('Stop playback before changing the loop.');
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > this.totalSteps || start >= end) {
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
        if (!track) return;

        track.activeSources.forEach((source) => {
            try { source.stop(); } catch (_) { /* already ended */ }
        });
        track.gainNode.disconnect();
        this.tracks.delete(trackId);
    }

    setStep(trackId, stepIndex, isActive) {
        const track = this.tracks.get(trackId);
        if (track && Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex < this.totalSteps) {
            track.steps[stepIndex] = Boolean(isActive);
        }
    }

    // --- Core Lookahead Scheduler ---
    scheduler() {
        if (!this.isPlaying) return;
        const duration = 60 / this.bpm / STEPS_PER_BEAT;
        const missed = Math.max(0, Math.ceil((this.audioContext.currentTime - this.nextNoteTime) / duration));
        if (missed) {
            this.nextNoteTime += missed * duration;
            this.currentStep = this.loopStart + (this.currentStep - this.loopStart + missed) % (this.loopEnd - this.loopStart);
        }
        // Schedule every step that falls inside the lookahead window
        while (this.nextNoteTime < this.audioContext.currentTime + SCHEDULE_AHEAD_SEC) {
            this.scheduleStep(this.currentStep, this.nextNoteTime);
            this.advanceStep();
        }
    }

    advanceStep() {
        // 60 / BPM = one quarter note; divide by STEPS_PER_BEAT for one step
        const stepDuration = 60.0 / this.bpm / STEPS_PER_BEAT;

        this.nextNoteTime += stepDuration;
        this.currentStep = this.currentStep + 1 >= this.loopEnd ? this.loopStart : this.currentStep + 1;
    }

    scheduleStep(stepIndex, time) {
        // Bound history even for legacy consumers that only use onStepTick().
        this.stepEvents = this.stepEvents.filter(event => event.time >= this.audioContext.currentTime - 1);
        this.stepEvents.push({ step: stepIndex, time });
        this.sequence.notesAt(stepIndex).forEach(note => {
            const event = { ...note, when: time + (note.startStep - stepIndex) * 60 / this.bpm / STEPS_PER_BEAT, duration: note.durationSteps * 60 / this.bpm / STEPS_PER_BEAT };
            const voice = this.voiceFactory
                ? this.voiceFactory(event, this.audioContext, this.masterGain)
                : this.createPitchedVoice(event);
            this.pitchedVoices.add(voice);
            voice.finished.finally(() => this.pitchedVoices.delete(voice));
        });
        // 1. Notify the UI, delayed to roughly match the audio.
        //    runId check drops callbacks left over from a previous run.
        if (this.onStepTickCallback) {
            const runId = this.runId;
            const delayMs = Math.max(0, (time - this.audioContext.currentTime) * 1000);
            setTimeout(() => {
                if (this.isPlaying && this.runId === runId) {
                    this.onStepTickCallback(stepIndex);
                }
            }, delayMs);
        }

        // 2. Trigger every track that has this step enabled
        this.tracks.forEach((track) => {
            if (!track.steps[stepIndex] || !track.buffer) return;

            const source = this.audioContext.createBufferSource();
            source.buffer = track.buffer;
            source.connect(track.gainNode);

            // Track the source so stop() can silence it; clean up when it finishes
            track.activeSources.add(source);
            source.onended = () => { track.activeSources.delete(source); source.disconnect(); };

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
        const finished = new Promise(resolve => {
            oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); resolve(); };
        });
        oscillator.start(event.when);
        oscillator.stop(end);
        return { finished, stop: () => { try { oscillator.stop(); } catch (_) {} } };
    }

    // --- UI Event Hook ---
    onStepTick(callback) {
        this.onStepTickCallback = callback;
    }
}
