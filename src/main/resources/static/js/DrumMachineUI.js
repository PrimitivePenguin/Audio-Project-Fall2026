// Load AFTER DrumMachine.js and BEFORE sequencer-ui.js.
document.addEventListener('jukebox:ready', () => {
    const drums = window.jukeboxDrums;
    if (!drums) return; // DrumMachine.js didn't load

    const PAGE = 16;
    let page = 0;
    let lastSignature = '';
    let pollTimer = null;

    const style = document.createElement('style');
    style.textContent = `
    .drum-toggle { position: fixed; right: 12px; bottom: 12px; z-index: 60; }
    .drum-panel {
      position: fixed; right: 12px; bottom: 52px; z-index: 60;
      padding: 10px 12px; border-radius: 8px;
      background: Canvas; color: CanvasText; border: 1px solid GrayText;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
      font: 13px system-ui, sans-serif;
    }
    .drum-panel[hidden] { display: none; }
    .drum-row { display: flex; align-items: center; gap: 4px; margin: 4px 0; }
    .drum-label { width: 64px; text-align: left; }
    .drum-step {
      width: 22px; height: 26px; padding: 0; cursor: pointer;
      border: 1px solid GrayText; border-radius: 3px; background: transparent;
    }
    .drum-step.beat { margin-left: 6px; }
    .drum-step[aria-pressed="true"] { background: #e8a33d; border-color: #e8a33d; }
    .drum-step:disabled { visibility: hidden; }
    .drum-volume { width: 70px; margin-left: 10px; }
    .drum-pager { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
  `;
    document.head.appendChild(style);

    // After a mouse click, release focus so Space still controls the transport.
    const releasePointerFocus = (event) => {
        if (event.detail > 0) event.currentTarget.blur();
    };

    const rows = drums.KIT.map(({ id, label }) => {
        const el = document.createElement('div');
        el.className = 'drum-row';

        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'drum-label';
        name.textContent = label;
        name.title = `Preview ${label}`;
        name.addEventListener('click', (event) => {
            drums.preview(id);
            releasePointerFocus(event);
        });
        el.appendChild(name);

        const cells = [];
        for (let i = 0; i < PAGE; i++) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = i > 0 && i % 4 === 0 ? 'drum-step beat' : 'drum-step';
            cell.addEventListener('click', (event) => {
                drums.toggleStep(id, page * PAGE + i);
                render(true);
                releasePointerFocus(event);
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
    prev.addEventListener('click', (event) => { page -= 1; render(true); releasePointerFocus(event); });

    const next = document.createElement('button');
    next.type = 'button';
    next.textContent = '▶';
    next.setAttribute('aria-label', 'Next steps');
    next.addEventListener('click', (event) => { page += 1; render(true); releasePointerFocus(event); });

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

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'drum-toggle';
    toggle.textContent = 'Drums';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', (event) => {
        const open = panel.hidden;
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        clearInterval(pollTimer);
        if (open) {
            render(true);
            pollTimer = setInterval(() => render(), 300); // picks up New Sequence, import, resize
        }
        releasePointerFocus(event);
    });

    const root = document.createElement('div');
    root.setAttribute('data-daw-controls', ''); // the app's focus policy treats these as DAW controls
    root.append(toggle, panel);
    document.body.appendChild(root);

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
                cell.disabled = index >= total;
                cell.setAttribute('aria-pressed', String(Boolean(data[r][index])));
                cell.setAttribute('aria-label', `${row.label} step ${index + 1}`);
            });
            if (document.activeElement !== row.slider) {
                row.slider.value = String(drums.getVolume(row.id));
            }
        });

        pageLabel.textContent = `Steps ${page * PAGE + 1}-${Math.min(total, (page + 1) * PAGE)} of ${total}`;
        prev.disabled = page === 0;
        next.disabled = page >= pages - 1;
    }
}, { once: true });