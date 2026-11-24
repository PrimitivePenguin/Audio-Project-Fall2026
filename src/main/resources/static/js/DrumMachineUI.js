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
                drums.toggleStep(id, i);
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
        el.appendChild(slider);

        return { id, label, el, cells, slider };
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
    const panel = document.createElement('div');
    panel.className = 'drum-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Drum machine');
    panel.append(...rows.map((r) => r.el), copy, info, archived);

    InstrumentPanel.attach('drumMenu', 'drumToggle', panel, 'Drum machine', () => {
        render(true);
        clearInterval(pollTimer);
        pollTimer = setInterval(() => render(), 300);
    }, () => clearInterval(pollTimer));

    function render(force = false) {
        const bpm = tempo();
        const label = engine.sequence.tempos.length > 1 ? 'Tempo at editing cursor' : 'Export tempo';
        const message = `${label} · ${Number(bpm.toFixed(3))} BPM. Preview individual drums using their names.`;
        if (!exporting && info.dataset.tempo !== message) {
            info.dataset.tempo = message;
            info.textContent = message;
        }
        archived.hidden = !drums.hasLegacySteps();
        copy.disabled = exporting || editor.getState().readOnly;
        const data = rows.map((r) => drums.getSteps(r.id));
        const volumes = rows.map((r) => drums.getVolume(r.id).toFixed(2)).join(',');
        const signature = `${volumes}|` +
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
        });


    }
}, { once: true });