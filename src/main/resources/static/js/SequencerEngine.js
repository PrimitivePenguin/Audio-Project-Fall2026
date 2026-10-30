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
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
    }

    // --- Transport Controls ---
    play() {
        this.initContext();
        if (this.isPlaying) return;

        this.isPlaying = true;
        this.runId++;
        this.currentStep = 0;
        this.nextNoteTime = this.audioContext.currentTime + START_DELAY_SEC;

        this.lookaheadTimer = setInterval(() => this.scheduler(), SCHEDULE_INTERVAL_MS);
    }

    stop() {
        this.isPlaying = false;
        this.runId++; // invalidates any pending UI timeouts
        clearInterval(this.lookaheadTimer);
        this.currentStep = 0;

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

    // --- Track & Grid Management ---
    addTrack(trackId, audioBuffer) {
        this.initContext(); // guarantees audioContext and masterGain exist

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
        if (track && stepIndex >= 0 && stepIndex < this.totalSteps) {
            track.steps[stepIndex] = isActive;
        }
    }

    // --- Core Lookahead Scheduler ---
    scheduler() {
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
        this.currentStep = (this.currentStep + 1) % this.totalSteps;
    }

    scheduleStep(stepIndex, time) {
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
            source.onended = () => track.activeSources.delete(source);

            source.start(time);
        });
    }

    // --- UI Event Hook ---
    onStepTick(callback) {
        this.onStepTickCallback = callback;
    }
}