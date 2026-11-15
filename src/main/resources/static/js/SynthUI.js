// src/main/resources/static/js/instruments/synth-ui.js
// Load AFTER SynthInstrumentManager.js and BEFORE sequencer-ui.js.
document.addEventListener('jukebox:ready', ({ detail: { engine, editor } }) => {
    const synth = window.jukeboxSynth;
    if (!synth) return; // SynthInstrumentManager.js didn't load

    const PERCUSSION_CHANNEL = 9;
    let selectedId = null;
    let lastActive = null;
    let trackSignature = '';
    let valueSignature = '';
    let pollTimer = null;

    // ---- Parameter definitions (ranges come from the synth's own LIMITS) ----

    const time = (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
    const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
    const PARAMS = [
        { key: 'attack', label: 'Attack', curve: 'square', fmt: time },
        { key: 'decay', label: 'Decay', curve: 'square', fmt: time },
        { key: 'sustain', label: 'Sustain', curve: 'linear', fmt: (v) => `${Math.round(v * 100)}%` },
        { key: 'release', label: 'Release', curve: 'square', fmt: time },
        { key: 'filterCutoff', label: 'Cutoff', curve: 'log', fmt: hz },
        { key: 'gain', label: 'Volume', curve: 'linear', fmt: (v) => v.toFixed(3) },
    ];

    // Sliders run 0..1. Time controls use a square curve and cutoff a log curve,
    // so the short/low end isn't squashed into the first few pixels.
    function toSlider(p, v) {
        const [lo, hi] = synth.LIMITS[p.key];
        if (p.curve === 'log') return Math.log(v / lo) / Math.log(hi / lo);
        if (p.curve === 'square') return Math.sqrt(Math.max(0, (v - lo) / (hi - lo)));
        return (v - lo) / (hi - lo);
    }
    function fromSlider(p, x) {
        const [lo, hi] = synth.LIMITS[p.key];
        if (p.curve === 'log') return lo * (hi / lo) ** x;
        if (p.curve === 'square') return lo + (hi - lo) * x * x;
        return lo + (hi - lo) * x;
    }

    // ---- Styles ----

    const style = document.createElement('style');
    style.textContent = `
    .synth-toggle { position: fixed; left: 12px; bottom: 12px; z-index: 60; }
    .synth-panel {
      position: fixed; left: 12px; bottom: 52px; z-index: 60; width: 300px;
      padding: 10px 12px; border-radius: 8px;
      background: Canvas; color: CanvasText; border: 1px solid GrayText;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
      font: 13px system-ui, sans-serif;
    }
    .synth-panel[hidden], .synth-note[hidden] { display: none; }
    .synth-row { display: grid; grid-template-columns: 64px 1fr 62px; align-items: center; gap: 8px; margin: 6px 0; }
    .synth-row select, .synth-row input[type="range"] { width: 100%; box-sizing: border-box; }
    .synth-readout { text-align: right; font-variant-numeric: tabular-nums; }
    .synth-note { margin: 6px 0; opacity: 0.75; }
    .synth-footer { display: flex; justify-content: flex-end; margin-top: 8px; }
  `;
    document.head.appendChild(style);

    // After a mouse click, release focus so Space still controls the transport.
    const releasePointerFocus = (event) => {
        if (event.detail > 0) event.currentTarget.blur();
    };

    // ---- Elements ----

    function makeRow(labelText, control, readout) {
        const row = document.createElement('div');
        row.className = 'synth-row';
        const label = document.createElement('span');
        label.textContent = labelText;
        row.append(label, control);
        if (readout) row.appendChild(readout);
        return row;
    }

    const trackSelect = document.createElement('select');
    trackSelect.setAttribute('aria-label', 'Synth track');
    trackSelect.addEventListener('change', () => {
        selectedId = trackSelect.value || null;
        render(true);
    });

    const waveSelect = document.createElement('select');
    waveSelect.setAttribute('aria-label', 'Waveform');
    for (const wave of synth.WAVEFORMS) {
        const option = document.createElement('option');
        option.value = wave;
        option.textContent = wave;
        waveSelect.appendChild(option);
    }
    waveSelect.addEventListener('change', () => {
        if (selectedId) synth.setParam(selectedId, 'waveform', waveSelect.value);
        render(true);
    });

    const controls = PARAMS.map((p) => {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '1';
        slider.step = '0.001';
        slider.setAttribute('aria-label', p.label);
        const readout = document.createElement('span');
        readout.className = 'synth-readout';
        slider.addEventListener('input', () => {
            if (!selectedId) return;
            synth.setParam(selectedId, p.key, fromSlider(p, Number(slider.value)));
            readout.textContent = p.fmt(synth.getSettings(selectedId)[p.key]);
        });
        // Release focus after a mouse drag so Space controls the transport again.
        slider.addEventListener('pointerup', () => slider.blur());
        return { p, slider, readout, row: makeRow(p.label, slider, readout) };
    });

    const note = document.createElement('div');
    note.className = 'synth-note';
    note.hidden = true;
    note.textContent = 'Percussion track (channel 10): the synth does not play it.';

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', (event) => {
        if (selectedId) {
            for (const [key, value] of Object.entries(synth.DEFAULTS)) {
                synth.setParam(selectedId, key, value);
            }
        }
        render(true);
        releasePointerFocus(event);
    });
    const footer = document.createElement('div');
    footer.className = 'synth-footer';
    footer.appendChild(reset);

    const panel = document.createElement('div');
    panel.className = 'synth-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Synth settings');
    panel.append(
        makeRow('Track', trackSelect),
        note,
        makeRow('Waveform', waveSelect),
        ...controls.map((c) => c.row),
        footer
    );

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'synth-toggle';
    toggle.textContent = 'Synth';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', (event) => {
        const open = panel.hidden;
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        clearInterval(pollTimer);
        if (open) {
            render(true);
            pollTimer = setInterval(() => render(), 300); // picks up track changes, New Sequence, import
        }
        releasePointerFocus(event);
    });

    const root = document.createElement('div');
    root.setAttribute('data-daw-controls', ''); // the app's focus policy treats these as DAW controls
    root.append(toggle, panel);
    document.body.appendChild(root);

    // ---- Rendering ----

    function defaultTrackId(tracks) {
        const pitched = tracks.find((t) => t.channel !== PERCUSSION_CHANNEL);
        return (pitched ?? tracks[0])?.id ?? null;
    }

    function render(force = false) {
        const tracks = engine.sequence.tracks;

        // Follow the piano roll's Active track selector when it changes.
        const active = editor?.getState?.().activeTrackId ?? null;
        if (active && active !== lastActive && tracks.some((t) => t.id === active)) {
            selectedId = active;
        }
        lastActive = active;
        if (!tracks.some((t) => t.id === selectedId)) selectedId = defaultTrackId(tracks);

        // Rebuild the dropdown only when the track list actually changed.
        const tSig = tracks.map((t) => `${t.id}|${t.name}|${t.channel}`).join('\n');
        if (force || tSig !== trackSignature) {
            trackSignature = tSig;
            trackSelect.replaceChildren(
                ...tracks.map((t) => {
                    const option = document.createElement('option');
                    option.value = t.id;
                    option.textContent = `${t.name} (ch ${t.channel + 1})`;
                    return option;
                })
            );
        }
        trackSelect.value = selectedId ?? '';

        const track = tracks.find((t) => t.id === selectedId);
        const disabled = !track || track.channel === PERCUSSION_CHANNEL;
        note.hidden = !(track && track.channel === PERCUSSION_CHANNEL);

        const settings = selectedId ? synth.getSettings(selectedId) : synth.DEFAULTS;
        const vSig = `${selectedId}|${disabled}|${JSON.stringify(settings)}`;
        if (!force && vSig === valueSignature) return;
        valueSignature = vSig;

        waveSelect.disabled = disabled;
        reset.disabled = disabled;
        if (document.activeElement !== waveSelect) waveSelect.value = settings.waveform;
        for (const { p, slider, readout } of controls) {
            slider.disabled = disabled;
            if (document.activeElement !== slider) slider.value = String(toSlider(p, settings[p.key]));
            readout.textContent = p.fmt(settings[p.key]);
        }
    }
}, { once: true });