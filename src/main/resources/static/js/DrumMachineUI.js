// Load AFTER DrumMachine.js and BEFORE sequencer-ui.js.
document.addEventListener('jukebox:ready', ({ detail: { editor } }) => {
    const drums = window.jukeboxDrums;
    if (!drums) return; // DrumMachine.js didn't load

    const PAGE = 16;
    let page = 0;
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
        for (let i = 0; i < PAGE; i++) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = i > 0 && i % 4 === 0 ? 'drum-step beat' : 'drum-step';
            cell.addEventListener('click', () => {
                drums.toggleStep(id, page * PAGE + i);
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

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.textContent = '◀';
    prev.setAttribute('aria-label', 'Previous steps');
    prev.addEventListener('click', () => {
        page -= 1;
        render(true);
    });

    const next = document.createElement('button');
    next.type = 'button';
    next.textContent = '▶';
    next.setAttribute('aria-label', 'Next steps');
    next.addEventListener('click', () => {
        page += 1;
        render(true);
    });

    const pageLabel = document.createElement('span');
    const pager = document.createElement('div');
    pager.className = 'drum-pager';
    pager.append(prev, pageLabel, next);

    const panel = document.createElement('div');
    panel.className = 'drum-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Drum machine');
    panel.append(...rows.map((r) => r.el), pager);

    InstrumentPanel.attach('drumMenu', 'drumToggle', panel, 'Drum machine', () => {
        render(true);
        clearInterval(pollTimer);
        pollTimer = setInterval(() => render(), 300);
    }, () => clearInterval(pollTimer));

    function render(force = false) {
        const total = drums.stepCount();
        const pages = Math.max(1, Math.ceil(total / PAGE));
        page = Math.max(0, Math.min(page, pages - 1));

        const data = rows.map((r) => drums.getSteps(r.id));
        const volumes = rows.map((r) => drums.getVolume(r.id).toFixed(2)).join(',');
        const signature = `${total}|${page}|${volumes}|` +
            data.map((d) => d.map(Number).join('')).join('/');
        if (!force && signature === lastSignature) return;
        lastSignature = signature;

        rows.forEach((row, r) => {
            row.cells.forEach((cell, i) => {
                const index = page * PAGE + i;
                cell.disabled = index >= total || Boolean(editor?.getState?.().readOnly);
                cell.setAttribute('aria-pressed', String(Boolean(data[r][index])));
                cell.setAttribute('aria-label', `${row.label} step ${index + 1}`);
            });
            row.slider.disabled = Boolean(editor?.getState?.().readOnly);
            if (document.activeElement !== row.slider) {
                row.slider.value = String(drums.getVolume(row.id));
            }
        });

        pageLabel.textContent = `Steps ${page * PAGE + 1}-${Math.min(total, (page + 1) * PAGE)} of ${total}`;
        prev.disabled = page === 0;
        next.disabled = page >= pages - 1;
    }
}, { once: true });