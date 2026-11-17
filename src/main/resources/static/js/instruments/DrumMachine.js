// Load AFTER the engine scripts and BEFORE sequencer-ui.js.
// Do NOT call registerInstrumentManager here: only one manager can be
// registered, and a second one would replace the synth.
document.addEventListener('jukebox:ready', ({ detail: { engine, editor, instrumentState } }) => {
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
            engine.addTrack(drum.id, buffers[drum.id]);
        }
        return ctx;
    }

    // ---- Public API ----

    const getSteps = (id) => (isDrum(id) ? [...(getTrack(id)?.steps ?? [])] : []);
    const getVolume = (id) => getTrack(id)?.gainNode.gain.value ?? DEFAULT_VOLUME;
    const stepCount = () => engine.totalSteps;

    // step is zero-based (0 = first sixteenth), like engine.setStep.
    function setStep(id, step, on) {
        if (editor?.getState?.().readOnly || !isDrum(id) || !Number.isInteger(step) || step < 0 || step >= engine.totalSteps) {
            return false;
        }
        ensureTracks();
        engine.setStep(id, step, !!on);
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
        getTrack(id).gainNode.gain.value = Math.min(1.5, Math.max(0, value));
        return true;
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
            stepCount: engine.totalSteps,
            tracks: KIT.filter((drum) => getTrack(drum.id)).map((drum) => ({
                id: drum.id,
                volume: getVolume(drum.id),
                steps: getSteps(drum.id).map(Boolean)
            }))
        };
    }

    function restoreState(state) {
        // Only kit tracks belong to this API; never remove uploaded samples or MIDI tracks.
        KIT.forEach((drum) => engine.removeTrack(drum.id));
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
                track.steps = Array.from({ length: engine.totalSteps }, (_, step) => entry.steps[step] === true);
            }
            if (typeof entry.volume === 'number' && Number.isFinite(entry.volume)) {
                track.gainNode.gain.value = Math.min(1.5, Math.max(0, entry.volume));
            }
        }
    }

    restoreState(instrumentState?.drums);

    window.jukeboxDrums = {
        KIT: KIT.map(({ id, label }) => ({ id, label })),
        ensure: () => { ensureTracks(); },
        hasTrack: (id) => !!getTrack(id),
        setStep, toggleStep, setVolume, preview,
        getSteps, getVolume, stepCount, snapshot, restoreState,
    };
}, { once: true });