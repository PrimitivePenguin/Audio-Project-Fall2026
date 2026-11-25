// Load AFTER the engine scripts and BEFORE sequencer-ui.js.
// Do NOT call registerInstrumentManager here: only one manager can be
// registered, and a second one would replace the synth.
document.addEventListener('jukebox:ready', ({ detail: { engine, editor, instrumentState } }) => {
    const STEPS = 16;
    const patterns = new Map();
    const legacy = new Map();
    const TWO_PI = 2 * Math.PI;
    const DEFAULT_VOLUME = 0.8; // matches the engine's default sample gain

    // ---- Sound rendering (plain sample math, no Web Audio nodes) ----

    function finish(data, sr) {
        // Normalise to a 0.9 peak and fade the last 5 ms so there's no end click.
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v));
        const gain = peak > 0 ? 0.9 / peak : 1;
        const fade = Math.floor(sr * 0.005);
        for (let i = 0; i < data.length; i++) {
            data[i] *= gain * Math.min(1, (data.length - i) / fade);
        }
        return data;
    }

    function renderKick(sr) {
        const data = new Float32Array(Math.floor(sr * 0.45));
        let phase = 0;
        for (let i = 0; i < data.length; i++) {
            const t = i / sr;
            phase += (TWO_PI * (45 + 120 * Math.exp(-t * 35))) / sr; // pitch sweep
            data[i] = Math.sin(phase) * Math.exp(-t * 9);
        }
        return finish(data, sr);
    }

    function renderSnare(sr) {
        const data = new Float32Array(Math.floor(sr * 0.25));
        for (let i = 0; i < data.length; i++) {
            const t = i / sr;
            const noise = (Math.random() * 2 - 1) * Math.exp(-t * 22);
            const tone = Math.sin(TWO_PI * 185 * t) * Math.exp(-t * 30) * 0.6;
            data[i] = noise + tone;
        }
        return finish(data, sr);
    }

    function renderHat(sr) {
        const data = new Float32Array(Math.floor(sr * 0.08));
        let prev = 0;
        for (let i = 0; i < data.length; i++) {
            const noise = Math.random() * 2 - 1;
            data[i] = (noise - prev) * Math.exp(-(i / sr) * 60); // crude high-pass
            prev = noise;
        }
        return finish(data, sr);
    }

    const KIT = [
        { id: 'drum-kick', label: 'Kick', render: renderKick },
        { id: 'drum-snare', label: 'Snare', render: renderSnare },
        { id: 'drum-hat', label: 'Hi-hat', render: renderHat },
    ];
    const isDrum = (id) => KIT.some((d) => d.id === id);
    const buffers = {}; // rendered once per page load

    // ---- Engine wiring ----

    function getTrack(id) {
        return engine.tracks.get(id); // engine.tracks is a Map of sample tracks
    }

    // Creates any drum sample track the engine doesn't currently have.
    // addTrack on an existing ID would reset its pattern, so we skip those.
    function ensureTracks() {
        engine.initContext();
        const ctx = engine.audioContext;
        for (const drum of KIT) {
            if (getTrack(drum.id)) continue;
            if (!buffers[drum.id]) {
                const data = drum.render(ctx.sampleRate);
                const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
                buf.copyToChannel(data, 0);
                buffers[drum.id] = buf;
            }
            engine.addTrack(drum.id, buffers[drum.id], { previewOnly: true });
        }
        return ctx;
    }

    // ---- Public API ----

    const getSteps = (id) => isDrum(id) ? [...(patterns.get(id) ?? Array(STEPS).fill(false))] : [];
    const getVolume = (id) => (getTrack(id) ? engine.getChannelMix(id).volume : DEFAULT_VOLUME);
    const getPan = (id) => (getTrack(id) ? engine.getChannelMix(id).pan : 0);
    const stepCount = () => STEPS;

    function setPan(id, value) {
        if (editor?.getState?.().readOnly || !isDrum(id) || !Number.isFinite(value)) return false;
        ensureTracks();
        return engine.setChannelPan(id, value);
    }
    // step is zero-based (0 = first sixteenth), like engine.setStep.
    function setStep(id, step, on) {
        if (editor?.getState?.().readOnly || !isDrum(id) || !Number.isInteger(step) || step < 0 || step >= STEPS) {
            return false;
        }
        const steps = getSteps(id);
        steps[step] = !!on;
        patterns.set(id, steps);
        ensureTracks();
        return true;
    }

    // Returns the new state, or null if the step was rejected.
    function toggleStep(id, step) {
        const now = !getSteps(id)[step];
        return setStep(id, step, now) ? now : null;
    }

    function setVolume(id, value) {
        if (editor?.getState?.().readOnly || !isDrum(id) || !Number.isFinite(value)) return false;
        ensureTracks();
        return engine.setChannelVolume(id, value); // keeps the engine's mix state in sync
    }

    // One-shot audition through the track's own gain node (respects volume).
    function preview(id) {
        if (!isDrum(id)) return false;
        const ctx = ensureTracks();
        if (ctx.state === 'suspended') ctx.resume();
        const track = getTrack(id);
        const src = ctx.createBufferSource();
        src.buffer = buffers[id];
        src.connect(track.gainNode);
        track.activeSources.add(src); // so Stop / removeTrack silence it too
        src.onended = () => { track.activeSources.delete(src); src.disconnect(); };
        src.start();
        return true;
    }

    function snapshot() {
        return {
            stepCount: STEPS,
            tracks: KIT.filter((drum) => getTrack(drum.id)).map((drum) => ({
                id: drum.id,
                volume: getVolume(drum.id),
                pan: getPan(drum.id),
                steps: getSteps(drum.id),
                ...(legacy.has(drum.id) ? { legacySteps: legacy.get(drum.id).slice() } : {})
            }))
        };
    }

    function restoreState(state) {
        // Only kit tracks belong to this API; never remove uploaded samples or MIDI tracks.
        KIT.forEach((drum) => {
            engine.removeTrack(drum.id);
            engine.resetChannelMix(drum.id);
        });
        patterns.clear();
        legacy.clear();
        if (!Array.isArray(state?.tracks)) {
            return;
        }
        const entries = state.tracks.filter((entry) => entry && isDrum(entry.id));
        if (!entries.length) {
            return;
        }
        ensureTracks();
        for (const entry of entries) {
            const track = getTrack(entry.id);
            if (Array.isArray(entry.steps)) {
                patterns.set(entry.id, Array.from({ length: STEPS }, (_, step) => entry.steps[step] === true));
                const tail = Array.isArray(entry.legacySteps) ? entry.legacySteps : entry.steps.slice(STEPS);
                if (tail.length) legacy.set(entry.id, tail.map((step) => step === true));
            }
            engine.setChannelVolume(entry.id, entry.volume);
            engine.setChannelPan(entry.id, entry.pan);
        }
    }

    function renderPatternPCM(bpm) {
        if (!Number.isFinite(bpm) || bpm <= 0) throw new Error('The cursor has no valid tempo.');
        engine.initContext();
        const rate = engine.audioContext.sampleRate;
        const frames = Math.round(rate * 240 / bpm);
        if (frames < 1 || frames > rate * 300) throw new Error('The drum loop is outside the audio asset duration limit.');
        const channels = [new Float32Array(frames), new Float32Array(frames)];
        for (const { id } of KIT) {
            const steps = getSteps(id);
            if (!steps.some(Boolean)) continue;
            const hit = buffers[id].getChannelData(0);
            const volume = getVolume(id);
            const angle = (getPan(id) + 1) * Math.PI / 4;
            const left = volume * Math.cos(angle);
            const right = volume * Math.sin(angle);
            steps.forEach((enabled, step) => {
                if (!enabled) return;
                const start = Math.round(step * rate * 15 / bpm);
                const length = Math.min(hit.length, frames - start);
                const cutsTail = length < hit.length;
                for (let i = 0; i < length; i++) {
                    const fade = cutsTail ? Math.min(1, (length - i - 1) / (rate * 0.005)) : 1;
                    channels[0][start + i] += hit[i] * left * fade;
                    channels[1][start + i] += hit[i] * right * fade;
                }
            });
        }
        return { rate, frames, channels: channels.map((channel) =>
            Int16Array.from(channel, (value) => Math.round(Math.max(-1, Math.min(1, value)) * 32767))) };
    }

    function previewPattern(bpm, onEnd) {
        if (engine.isPlaying || engine.startPromise || engine.patternPreview ||
            !KIT.some(({ id }) => getSteps(id).some(Boolean))) return false;
        const { rate, frames, channels } = renderPatternPCM(bpm);
        const buffer = engine.audioContext.createBuffer(2, frames, rate);
        channels.forEach((channel, index) => {
            buffer.copyToChannel(Float32Array.from(channel, (sample) => sample / 32768), index);
        });
        return engine.playPatternPreview(buffer, onEnd);
    }

    function renderPattern(bpm) {
        const { rate, frames, channels } = renderPatternPCM(bpm);
        // Encode PCM WAV. The JUNK ID gives repeated exports their own rack identity.
        const bytes = new ArrayBuffer(68 + frames * 4);
        const view = new DataView(bytes);
        const tag = (offset, value) => {
            for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
        };
        tag(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true);
        tag(8, 'WAVE'); tag(12, 'fmt '); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); view.setUint16(22, 2, true);
        view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true);
        view.setUint16(32, 4, true); view.setUint16(34, 16, true);
        tag(36, 'JUNK'); view.setUint32(40, 16, true);
        crypto.getRandomValues(new Uint8Array(bytes, 44, 16));
        tag(60, 'data'); view.setUint32(64, frames * 4, true);
        for (let i = 0; i < frames; i++) {
            view.setInt16(68 + 4 * i, channels[0][i], true);
            view.setInt16(70 + 4 * i, channels[1][i], true);
        }
        return bytes;
    }

    restoreState(instrumentState?.drums);


    window.jukeboxDrums = {
        KIT: KIT.map(({ id, label }) => ({ id, label })),
        ensure: () => { ensureTracks(); },
        hasTrack: (id) => !!getTrack(id),
        setStep, toggleStep, setVolume, setPan, preview,
        getSteps, getVolume, getPan, stepCount, snapshot, restoreState, renderPattern, previewPattern,
        hasLegacySteps: () => [...legacy.values()].some((steps) => steps.some(Boolean)),
    };
}, { once: true });