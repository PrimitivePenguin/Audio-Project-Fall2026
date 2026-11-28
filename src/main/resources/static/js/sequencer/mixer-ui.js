// Channel mixer rows and parameter controls.
function createMixerUI(editorState, actions) {
    const { engine, mixerPanel } = editorState;

    let mixerKey = '';
    let mixerRows = [];

    const formatPct = (value) => `${Math.round(value * 100)}%`;

    const formatPan = (value) =>
        Math.abs(value) < 0.005 ? 'C' : `${value < 0 ? 'L' : 'R'}${Math.round(Math.abs(value) * 100)}`;

    const formatHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : String(Math.round(hz)));

    const CUTOFF_RATIO = 1000;

    const MIX_CONTROLS = [
        { key: 'volume', label: 'Vol', min: 0, max: 1.5, step: 0.01, format: formatPct },
        { key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, format: formatPan },
        { key: 'filterType', label: 'Filter', select: [['lowpass', 'Low-pass'], ['highpass', 'High-pass']] },
        { key: 'cutoff', label: 'Cutoff', min: 0, max: 1, step: 0.001, format: formatHz,
            toSlider: (hz) => Math.log(hz / 20) / Math.log(CUTOFF_RATIO),
            fromSlider: (position) => 20 * CUTOFF_RATIO ** position },
        { key: 'resonance', label: 'Reso', min: 0, max: 15, step: 0.1, format: (v) => `${v.toFixed(1)} dB` },
        { key: 'delaySend', label: 'Delay', min: 0, max: 1, step: 0.01, format: formatPct },
        { key: 'delayBeats', label: 'Time', min: 0.125, max: 2, step: 0.125, format: (v) => `${+v.toFixed(3)} beat` },
        { key: 'delayFeedback', label: 'Fdbk', min: 0, max: 0.9, step: 0.01, format: formatPct },
        { key: 'reverbSend', label: 'Reverb', min: 0, max: 1, step: 0.01, format: formatPct }
    ];

    function createMixRow({ id, name }) {
        const row = document.createElement('div');
        row.className = 'mix-row';
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', name);
        row.dataset.trackId = id;
        // Opts into the "release focus after pointer use" policy so Space still controls transport.
        row.setAttribute('data-daw-pointer-inputs', '');
                row.addEventListener('change', () => actions.broadcastSync('SETTINGS_SYNC', id));
        const heading = document.createElement('span');
        heading.className = 'mix-title';
        heading.textContent = name;
        row.append(heading);

        const controls = MIX_CONTROLS.map((control) => {
            const wrapper = document.createElement('label');
            const text = document.createElement('span');
            text.textContent = control.label;

            if (control.select) {
                const input = document.createElement('select');
                for (const [value, label] of control.select) input.append(new Option(label, value));
                wrapper.append(text, input);
                row.append(wrapper);
                input.addEventListener('change', () => {
                    if (!input.disabled) engine.setChannelFilterType(id, input.value);
                    refresh();
                });
                return { control, input };
            }

            const toSlider = control.toSlider ?? ((value) => value);
            const fromSlider = control.fromSlider ?? ((value) => value);
            const input = document.createElement('input');
            input.type = 'range';
            input.min = String(control.min);
            input.max = String(control.max);
            input.step = String(control.step);
            input.title = 'Double-click to reset';
            const readout = document.createElement('output');
            wrapper.append(text, input, readout);
            row.append(wrapper);

            input.addEventListener('input', () => {
                if (!input.disabled) engine.setChannelParam(id, control.key, fromSlider(input.valueAsNumber));
                refresh();
            });
            input.addEventListener('dblclick', () => {
                if (!input.disabled && engine.resetChannelParam(id, control.key)) actions.broadcastSync('SETTINGS_SYNC', id);
                refresh();
            });
            return { control, input, readout, toSlider };
        });

        function refresh() {
            const locked = !engine.hasChannel(id) || editorState.databaseProject?.role === 'VIEWER';
            const mix = engine.getChannelMix(id);
            for (const { control, input, readout, toSlider } of controls) {
                input.disabled = locked;
                const focused = document.activeElement === input;
                if (control.select) {
                    if (!focused) input.value = mix.filterType;
                    continue;
                }
                if (!focused) input.value = String(toSlider(mix[control.key]));
                readout.textContent = control.format(mix[control.key]);
            }
        }

        return { row, refresh };
    }

    function syncMixer() {
        const tracks = actions.overviewTracks();
        const key = JSON.stringify(tracks.map((track) => [track.id, track.name]));
        if (key !== mixerKey) {
            mixerKey = key;
            mixerRows = tracks.map(createMixRow);
            mixerPanel.replaceChildren(...mixerRows.map((mix) => mix.row));
        }
        mixerRows.forEach((mix) => mix.refresh());
    }

    function formatMixerValue(key, value) {
        return MIX_CONTROLS.find((control) => control.key === key).format(value);
    }

    return { syncMixer, formatMixerValue };
}
