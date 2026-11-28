// Load AFTER DrumMachine.js and BEFORE sequencer-ui.js.
document.addEventListener('jukebox:ready', ({ detail: { editor, engine } }) => {
    const drums = window.jukeboxDrums;
    if (!drums) return; // DrumMachine.js didn't load

    const STEPS = drums.stepCount();
    let lastSignature = '';
    let pollTimer = null;

    const rows = drums.KIT.map(({ id, label }) => {
        const el = document.createElement('div');
        el.className = 'drum-row';

        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'drum-label';
        name.textContent = label;
        name.title = `Preview ${label}`;
        name.addEventListener('click', () => {
            drums.preview(id);
        });
        el.appendChild(name);

        const cells = [];
        for (let i = 0; i < STEPS; i++) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = i > 0 && i % 4 === 0 ? 'drum-step beat' : 'drum-step';
            cell.addEventListener('click', () => {
                if (drums.toggleStep(id, i) !== null) editor.instrumentChanged?.();
                render(true);
            });
            cells.push(cell);
            el.appendChild(cell);
        }

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'drum-volume';
        slider.min = '0';
        slider.max = '1.5';
        slider.step = '0.05';
        slider.setAttribute('aria-label', `${label} volume`);
        slider.addEventListener('input', () => drums.setVolume(id, Number(slider.value)));
        slider.addEventListener('change', () => editor.instrumentChanged?.());
        el.appendChild(slider);

        const pan = document.createElement('input');
        pan.type = 'range';
        pan.className = 'drum-pan';
        pan.min = '-1';
        pan.max = '1';
        pan.step = '0.05';
        pan.title = 'Pan (double-click to center)';
        pan.setAttribute('aria-label', `${label} pan`);
        pan.addEventListener('input', () => drums.setPan(id, Number(pan.value)));
        pan.addEventListener('dblclick', () => {
            pan.value = '0';
            if (drums.setPan(id, 0)) editor.instrumentChanged?.();
        });
        pan.addEventListener('change', () => editor.instrumentChanged?.());
        el.appendChild(pan);

        return { id, label, el, cells, slider, pan };
    });

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy to Sample Rack';
    const info = document.createElement('p');
    info.className = 'hint';
    const archived = document.createElement('p');
    archived.className = 'hint';
    archived.textContent = 'Steps after 16 from this saved pattern are archived in project data.';
    let exporting = false;
    const tempo = () => AudioArrangement.timeMap(engine.sequence).tempoAt(editor.getState().editingCursorTick);
    copy.addEventListener('click', async () => {
        if (exporting || editor.getState().readOnly) return;
        exporting = copy.disabled = true;
        try {
            const bpm = tempo();
            await editor.addDrumSample(drums.renderPattern(bpm), bpm);
        } catch (error) {
            info.textContent = error.message;
        } finally {
            exporting = false;
            copy.disabled = editor.getState().readOnly;
        }
    });
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'drum-pattern-preview';
    const previewLabel = '▶ Preview Pattern';
    preview.textContent = previewLabel;
    let previewing = false;
    preview.addEventListener('click', () => {
        if (previewing) {
            engine.stopPatternPreview();
            return;
        }
        if (engine.isPlaying || engine.startPromise) {
            info.textContent = 'Pause or stop playback before previewing the drum pattern.';
            return;
        }
        try {
            previewing = drums.previewPattern(tempo(), () => {
                previewing = false;
                preview.textContent = previewLabel;
            });
            if (previewing) {
                preview.textContent = '■ Stop Preview';
                info.textContent = info.dataset.tempo;
            } else {
                info.textContent = 'Enable a drum step to preview the pattern.';
            }
        } catch (error) {
            info.textContent = error.message;
        }
    });
    const actions = document.createElement('div');
    actions.className = 'drum-actions';
    actions.append(preview, copy);
    const panel = document.createElement('div');
    panel.className = 'drum-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Drum machine');
    panel.append(...rows.map((r) => r.el), actions, info, archived);

    InstrumentPanel.attach('drumMenu', 'drumToggle', panel, 'Drum machine', () => {
        render(true);
        clearInterval(pollTimer);
        pollTimer = setInterval(() => render(), 300);
    }, () => {
        clearInterval(pollTimer);
        engine.stopPatternPreview();
    });

    function render(force = false) {
        const bpm = tempo();
        const label = engine.sequence.tempos.length > 1 ? 'Tempo at editing cursor' : 'Pattern tempo';
        const message = `${label} · ${Number(bpm.toFixed(3))} BPM. Preview individual drums using their names.`;
        if (!exporting && info.dataset.tempo !== message) {
            info.dataset.tempo = message;
            info.textContent = message;
        }
        archived.hidden = !drums.hasLegacySteps();
        copy.disabled = exporting || editor.getState().readOnly;
        const data = rows.map((r) => drums.getSteps(r.id));
        const volumes = rows.map((r) => drums.getVolume(r.id).toFixed(2)).join(',');
        const pans = rows.map((r) => drums.getPan(r.id).toFixed(2)).join(',');
        const signature = `${volumes}|${pans}|` +
            data.map((d) => d.map(Number).join('')).join('/');
        if (!force && signature === lastSignature) return;
        lastSignature = signature;

        rows.forEach((row, r) => {
            row.cells.forEach((cell, i) => {
                const index = i;
                cell.disabled = Boolean(editor?.getState?.().readOnly);
                cell.setAttribute('aria-pressed', String(Boolean(data[r][index])));
                cell.setAttribute('aria-label', `${row.label} step ${index + 1}`);
            });
            row.slider.disabled = Boolean(editor?.getState?.().readOnly);
            if (document.activeElement !== row.slider) {
                row.slider.value = String(drums.getVolume(row.id));
            }
            row.pan.disabled = Boolean(editor?.getState?.().readOnly);
            if (document.activeElement !== row.pan) {
                row.pan.value = String(drums.getPan(row.id));
            }
        });


    }
}, { once: true });