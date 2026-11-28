// src/main/resources/static/js/instruments/SynthInstrumentManager.js
// Load AFTER the engine scripts and BEFORE sequencer-ui.js
document.addEventListener('jukebox:ready', ({ detail: { engine, editor, instrumentState } }) => {
    const DEFAULTS = {
        waveform: 'sawtooth', attack: 0.01, decay: 0.08,
        sustain: 0.5, release: 0.2, gain: 0.05, filterCutoff: 1200,
    };
    const LIMITS = {
        attack: [0, 5], decay: [0, 5], sustain: [0, 1],
        release: [0, 10], gain: [0, 0.2], filterCutoff: [50, 18000],
    };
    const WAVEFORMS = ['sine', 'square', 'sawtooth', 'triangle'];

    const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);
    const silentHandle = () => ({ stop() {}, finished: Promise.resolve() });

    const settingsByTrackId = Object.create(null);
    const voices = new Set();

    // ---- Public settings API ----

    // Returns true if the value was accepted (numbers are clamped to LIMITS).
    function setParam(trackId, key, value) {
        if (editor?.getState?.().readOnly || typeof trackId !== 'string' ||
            !engine.sequence.tracks.some((track) => track.id === trackId)) return false;
        if (key === 'waveform') {
            if (!WAVEFORMS.includes(value)) return false;
            (settingsByTrackId[trackId] ??= {}).waveform = value;
            return true;
        }
        if (!Object.hasOwn(LIMITS, key) || typeof value !== 'number' || !Number.isFinite(value)) {
            return false;
        }
        const [lo, hi] = LIMITS[key];
        (settingsByTrackId[trackId] ??= {})[key] = Math.min(hi, Math.max(lo, value));
        return true;
    }

    // Always returns a complete settings object (defaults filled in).
    function getSettings(trackId) {
        return { ...DEFAULTS, ...settingsByTrackId[trackId] };
    }

    function snapshot() {
        return { tracks: engine.sequence.tracks.map((track) => ({
            trackId: track.id,
            settings: getSettings(track.id)
        })) };
    }

    function restoreState(state) {
        Object.keys(settingsByTrackId).forEach((id) => delete settingsByTrackId[id]);
        if (!Array.isArray(state?.tracks)) {
            return;
        }
        const ids = new Set(engine.sequence.tracks.map((track) => track.id));
        for (const entry of state.tracks) {
            if (!entry || !ids.has(entry.trackId) || !entry.settings || typeof entry.settings !== 'object') {
                continue;
            }
            const restored = {};
            if (WAVEFORMS.includes(entry.settings.waveform)) {
                restored.waveform = entry.settings.waveform;
            }
            for (const [key, [lo, hi]] of Object.entries(LIMITS)) {
                const value = entry.settings[key];
                if (typeof value === 'number' && Number.isFinite(value)) {
                    restored[key] = Math.min(hi, Math.max(lo, value));
                }
            }
            settingsByTrackId[entry.trackId] = restored;
        }
    }

    const holdTime = (event, settings) => Math.max(event.when + event.duration,
        event.when + settings.attack + settings.decay);

    function scheduleVoice(ev, s, ctx, out) {
        const t0 = ev.when;
        const tHold = holdTime(ev, s);
        const tEnd = tHold + s.release;
        const peak = s.gain * ev.velocity;

        const osc = ctx.createOscillator();
        osc.type = s.waveform;
        osc.frequency.value = midiToHz(ev.midi);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = s.filterCutoff;

        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0, t0);
        amp.gain.linearRampToValueAtTime(peak, t0 + s.attack);
        amp.gain.linearRampToValueAtTime(peak * s.sustain, t0 + s.attack + s.decay);
        amp.gain.setValueAtTime(peak * s.sustain, tHold);
        amp.gain.linearRampToValueAtTime(0, tEnd);

        osc.connect(filter).connect(amp).connect(out);
        osc.start(t0);
        osc.stop(tEnd + 0.05);

        return { osc, filter, amp };
    }

    // ---- Instrument manager ----

    const manager = {
        syncTracks(tracks) {
            const ids = new Set(tracks.map((t) => t.id));
            for (const id of Object.keys(settingsByTrackId)) {
                if (!ids.has(id)) delete settingsByTrackId[id];
            }
        },

        createOfflineRenderer() {
            const settings = new Map(engine.sequence.tracks.map(({ id }) => [id, getSettings(id)]));
            return {
                endTime(event) {
                    const s = settings.get(event.trackId);
                    return event.channel === 9 ? null : holdTime(event, s) + s.release;
                },
                schedule(event, context, output) {
                    scheduleVoice(event, settings.get(event.trackId), context, output);
                },
            };
        },

        createVoice(ev, ctx, out) {
            if (ev.channel === 9) return silentHandle(); // percussion: skip for now

            const s = getSettings(ev.trackId);
            const { osc, filter, amp } = scheduleVoice(ev, s, ctx, out);

            let stopped = false;
            let resolveFinished;
            const finished = new Promise((r) => (resolveFinished = r));

            const voice = {
                stop() {
                    if (stopped) return; // idempotent
                    stopped = true;
                    const now = ctx.currentTime;
                    amp.gain.cancelScheduledValues(now);
                    amp.gain.setValueAtTime(amp.gain.value, now);
                    amp.gain.linearRampToValueAtTime(0, now + 0.01); // avoid a click
                    try { osc.stop(now + 0.02); } catch { /* already ended */ }
                },
                finished,
            };

            osc.onended = () => {
                osc.disconnect(); filter.disconnect(); amp.disconnect();
                voices.delete(voice);
                resolveFinished(); // only after cleanup
            };

            voices.add(voice);
            return voice;
        },

        stop() { [...voices].forEach((v) => v.stop()); },

        dispose() {
            manager.stop();
            Object.keys(settingsByTrackId).forEach((k) => delete settingsByTrackId[k]);
        },
    };

    engine.registerInstrumentManager(manager);
    restoreState(instrumentState?.synth);
    window.jukeboxSynth = { setParam, getSettings, DEFAULTS, LIMITS, WAVEFORMS,
        snapshot, restoreState, activeVoices: () => voices.size };
}, { once: true });