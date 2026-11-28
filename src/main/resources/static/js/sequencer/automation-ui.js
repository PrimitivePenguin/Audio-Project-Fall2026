// Automation point editing and lane drawing.
function createAutomationUI(editorState, actions) {
    const { engine, getElement, KEYBOARD_WIDTH, pianoViewport, ROLL } = editorState;

    const AUTOMATION_PAD = 14;

    const AUTOMATION_HIT = 9;

    const AUTOMATION_NAMES = {
        volume: 'Volume', pan: 'Pan', cutoff: 'Filter cutoff', resonance: 'Filter resonance',
        delaySend: 'Delay send', delayFeedback: 'Delay feedback', reverbSend: 'Reverb send'
    };

    const AUTOMATION_SPECS = Object.fromEntries(engine.automationParams().map((spec) => [spec.key, spec]));

    const automationPanel = getElement('automationPanel');
    const automationPlot = getElement('automationPlot');

    const automationToolbar = getElement('automationToolbar');

    function makeAutomationSelect(id, labelText) {
        const label = document.createElement('label');
        const text = document.createElement('span');
        text.textContent = labelText;
        const select = document.createElement('select');
        select.id = id;
        label.append(text, select);
        automationToolbar.append(label);
        return select;
    }

    const autoChannelSelect = makeAutomationSelect('automationChannel', 'Automate');

    const autoParamSelect = makeAutomationSelect('automationParameter', 'Parameter');

    const snapButton = document.createElement('button');

    const clearButton = document.createElement('button');

    const autoHint = document.createElement('span');

    const automationCanvas = getElement('automationCanvas');

    const automationContext = automationCanvas.getContext('2d');

    let autoSizeKey = '';

    let autoChannelsKey = '';

    editorState.autoGesture = null;

    let autoHoverIndex = -1;

    const autoSelection = () => ({ id: autoChannelSelect.value, key: autoParamSelect.value });

    const autoEditable = () => automationPanel.open && editorState.databaseProject?.role !== 'VIEWER' && Boolean(autoChannelSelect.value);

    const autoTop = AUTOMATION_PAD;

    const plotHeight = () => automationPlot.clientHeight;
    const autoBottom = () => Math.max(autoTop + 1, plotHeight() - AUTOMATION_PAD);

    const autoNorm = (spec, value) => spec.log
        ? Math.log(value / spec.min) / Math.log(spec.max / spec.min)
        : (value - spec.min) / (spec.max - spec.min);

    const autoValue = (spec, norm) => spec.log
        ? spec.min * (spec.max / spec.min) ** norm
        : spec.min + norm * (spec.max - spec.min);

    const autoYOf = (spec, value) => autoTop + (1 - autoNorm(spec, value)) * (autoBottom() - autoTop);

    const autoXOf = (tick) =>
        KEYBOARD_WIDTH + engine.sequence.tickToStep(tick) * editorState.STEP_WIDTH - pianoViewport.scrollLeft;

    function autoPointerValue(spec, key, y) {
        const norm = Math.min(1, Math.max(0, 1 - (y - autoTop) / (autoBottom() - autoTop)));
        const value = autoValue(spec, norm);
        return key === 'pan' && Math.abs(value) < 0.04 ? 0 : value; // easy to land on center
    }

    function autoTickOf(x) {
        let step = (x + pianoViewport.scrollLeft - KEYBOARD_WIDTH) / editorState.STEP_WIDTH;
        if (snapButton.getAttribute('aria-pressed') === 'true') {
            step = Math.round(step);
        }
        step = Math.min(engine.totalSteps, Math.max(0, step));
        return Math.round(engine.sequence.stepToTick(step));
    }

    function autoPointer(event) {
        const bounds = automationCanvas.getBoundingClientRect();
        return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    }

    function autoHit(points, spec, position) {
        let best = -1;
        let bestDistance = AUTOMATION_HIT;
        points.forEach((point, index) => {
            const distance = Math.hypot(autoXOf(point.tick) - position.x, autoYOf(spec, point.value) - position.y);
            if (distance <= bestDistance) {
                best = index;
                bestDistance = distance;
            }
        });
        return best;
    }

    function drawAutomationLane() {
        if (!automationPanel.open) return;
        const width = pianoViewport.clientWidth;
        const height = plotHeight();
        if (!width || !height) return;
        const ratio = window.devicePixelRatio || 1;
        const sizeKey = `${width}:${height}:${ratio}`;
        if (sizeKey !== autoSizeKey) {
            autoSizeKey = sizeKey;
            automationCanvas.width = Math.round(width * ratio);
            automationCanvas.height = Math.round(height * ratio);
            automationCanvas.style.width = `${width}px`;
            automationCanvas.style.height = `${height}px`;
        }
        const ctx = automationContext;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.fillStyle = ROLL.bg;
        ctx.fillRect(0, 0, width, height);

        const { id, key } = autoSelection();
        const spec = AUTOMATION_SPECS[key];
        if (!spec || !id) {
            return;
        }
        const format = (value) => actions.formatMixerValue(key, value);
        const scrollLeft = pianoViewport.scrollLeft;
        const points = editorState.autoGesture?.draft ?? engine.getAutomation(id, key);
        clearButton.disabled = !autoEditable() || !points.length;

        // Value guides
        ctx.lineWidth = 1;
        ctx.strokeStyle = ROLL.rowLine;
                 const sequence = engine.sequence;
        const first = Math.max(0, Math.floor(scrollLeft / editorState.STEP_WIDTH));
        const endStep = Math.min(engine.totalSteps, (scrollLeft + Math.max(0, width - KEYBOARD_WIDTH)) / editorState.STEP_WIDTH);
        const last = Math.ceil(endStep);

        // Value guides
        ctx.lineWidth = 1;
        ctx.strokeStyle = ROLL.rowLine;
        for (let i = 0; i <= 4; i++) {
            const y = autoTop + ((autoBottom() - autoTop) * i) / 4;
            ctx.beginPath();
            ctx.moveTo(KEYBOARD_WIDTH, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        // Step and meter guides, matching the piano roll
        const marks = [...sequence.meterMarks(sequence.stepToTick(scrollLeft / editorState.STEP_WIDTH),
            sequence.stepToTick(endStep), sequence.stepToTick(4 / editorState.STEP_WIDTH))]
            .filter((mark) => editorState.STEP_WIDTH >= 4 || mark.kind === 'measure');
        ctx.strokeStyle = ROLL.rowLine;
        ctx.beginPath();
        for (let step = first; editorState.STEP_WIDTH >= 5 && step <= last; step++) {
            const x = KEYBOARD_WIDTH + step * editorState.STEP_WIDTH - scrollLeft;
            if (x < KEYBOARD_WIDTH) continue;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
        }
        ctx.stroke();
        for (const mark of marks) {
            const x = KEYBOARD_WIDTH + sequence.tickToStep(mark.ticks) * editorState.STEP_WIDTH - scrollLeft;
            if (x < KEYBOARD_WIDTH) continue;
            ctx.strokeStyle = mark.kind === 'subdivision' ? ROLL.rowLine : ROLL.beatLine;
            ctx.lineWidth = mark.kind === 'measure' ? 2 : mark.kind === 'group' ? 1.5 : 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        ctx.lineWidth = 1;
        // Shade outside the loop
        const loopX = KEYBOARD_WIDTH + engine.loopStart * editorState.STEP_WIDTH - scrollLeft;
        const loopEndX = KEYBOARD_WIDTH + engine.loopEnd * editorState.STEP_WIDTH - scrollLeft;
        ctx.fillStyle = ROLL.loopShade;
        if (loopX > KEYBOARD_WIDTH) {
            ctx.fillRect(KEYBOARD_WIDTH, 0, loopX - KEYBOARD_WIDTH, height);
        }
        if (loopEndX < width) {
            const start = Math.max(KEYBOARD_WIDTH, loopEndX);
            ctx.fillRect(start, 0, width - start, height);
        }

        // Curve, points and playhead (clipped to the right of the gutter)
        ctx.save();
        ctx.beginPath();
        ctx.rect(KEYBOARD_WIDTH, 0, width - KEYBOARD_WIDTH, height);
        ctx.clip();
        if (points.length) {
            ctx.beginPath();
            ctx.moveTo(KEYBOARD_WIDTH, autoYOf(spec, points[0].value));
            for (const point of points) {
                ctx.lineTo(autoXOf(point.tick), autoYOf(spec, point.value));
            }
            ctx.lineTo(width, autoYOf(spec, points[points.length - 1].value));
            ctx.strokeStyle = ROLL.marquee;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.lineTo(width, autoBottom());
            ctx.lineTo(KEYBOARD_WIDTH, autoBottom());
            ctx.closePath();
            ctx.fillStyle = ROLL.marqueeFill;
            ctx.fill();
            const active = editorState.autoGesture ? editorState.autoGesture.index : autoHoverIndex;
            points.forEach((point, index) => {
                const x = autoXOf(point.tick);
                if (x < KEYBOARD_WIDTH - 6 || x > width + 6) {
                    return;
                }
                ctx.beginPath();
                ctx.arc(x, autoYOf(spec, point.value), index === active ? 6 : 4.5, 0, Math.PI * 2);
                ctx.fillStyle = ROLL.noteSelected;
                ctx.fill();
                ctx.strokeStyle = ROLL.noteOutline;
                ctx.lineWidth = 1;
                ctx.stroke();
            });
            if (editorState.autoGesture) {
                const point = points[editorState.autoGesture.index];
                ctx.font = '11px system-ui';
                ctx.textAlign = 'left';
                ctx.fillStyle = ROLL.text;
                ctx.fillText(format(point.value), Math.min(width - 52, autoXOf(point.tick) + 10),
                    Math.max(12, autoYOf(spec, point.value) - 8));
            }
        } else {
            // No lane: show where the mixer slider currently sits.
            const y = autoYOf(spec, engine.getChannelMix(id)[key]);
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = ROLL.marquee;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(KEYBOARD_WIDTH, y);
            ctx.lineTo(width, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.font = '12px system-ui';
            ctx.textAlign = 'center';
            ctx.fillStyle = ROLL.text;
            ctx.fillText('No automation. Click to add a point.', KEYBOARD_WIDTH + (width - KEYBOARD_WIDTH) / 2, height / 2);
        }
        if (editorState.displayedStep !== null) {
            ctx.fillStyle = ROLL.playback;
            ctx.fillRect(KEYBOARD_WIDTH + editorState.displayedStep * editorState.STEP_WIDTH - scrollLeft, 0, 2, height);
        }
        ctx.restore();

        // Gutter: parameter name and value range
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, KEYBOARD_WIDTH, height);
        ctx.clip();
        ctx.fillStyle = ROLL.laneHeader;
        ctx.fillRect(0, 0, KEYBOARD_WIDTH, height);
        ctx.fillStyle = ROLL.text;
        ctx.font = '11px system-ui';
        ctx.textAlign = 'left';
        ctx.fillText(AUTOMATION_NAMES[key], 6, 11);
        ctx.textAlign = 'right';
        ctx.fillText(format(spec.max), KEYBOARD_WIDTH - 6, autoTop + 24);
        ctx.fillText(format(spec.min), KEYBOARD_WIDTH - 6, autoBottom() - 4);
        ctx.restore();
    }

    function commitAutomation(id, key, before, after) {
        if (JSON.stringify(before) === JSON.stringify(after)) {
            return;
        }
        actions.checkHistory();
        const channel = [...autoChannelSelect.options].find((option) => option.value === id)?.textContent ?? id;
        actions.pushHistory({
            kind: 'automation', channelId: id, key, before, after,
            label: `${channel} · ${AUTOMATION_NAMES[key]}`
        });
      actions.broadcastSync('SETTINGS_SYNC', id);
    }

    function removeAutomationPointAt(position) {
        const { id, key } = autoSelection();
        const before = engine.getAutomation(id, key);
        const index = autoHit(before, AUTOMATION_SPECS[key], position);
        if (index < 0) {
            return;
        }
        const after = before.filter((_, i) => i !== index);
        engine.setAutomation(id, key, after);
        commitAutomation(id, key, before, after);
        autoHoverIndex = -1;
        drawAutomationLane();
    }

    function clearAutomationLane() {
        const { id, key } = autoSelection();
        const before = engine.getAutomation(id, key);
        if (!autoEditable() || !before.length) {
            return;
        }
        engine.clearAutomation(id, key);
        commitAutomation(id, key, before, []);
    }

    function cancelAutomationGesture() {
        if (!editorState.autoGesture) {
            return;
        }
        const { id, key, before, pointerId } = editorState.autoGesture;
        editorState.autoGesture = null;
        engine.setAutomation(id, key, before);
        if (automationCanvas.hasPointerCapture(pointerId)) {
            automationCanvas.releasePointerCapture(pointerId);
        }
        drawAutomationLane();
    }

    function syncAutomationControls() {
        const channels = actions.overviewTracks().map((track) => ({ id: track.id, name: track.name }));
        const key = JSON.stringify(channels);
        if (key !== autoChannelsKey) {
            autoChannelsKey = key;
            const previous = autoChannelSelect.value;
            autoChannelSelect.replaceChildren(...channels.map(({ id, name }) => new Option(name, id)));
            autoChannelSelect.value = channels.some(({ id }) => id === previous) ? previous : (channels[0]?.id ?? '');
        }
        drawAutomationLane();
    }

    function bind() {
        for (const spec of engine.automationParams()) {
            autoParamSelect.append(new Option(AUTOMATION_NAMES[spec.key], spec.key));
        }
        snapButton.type = 'button';
        snapButton.textContent = 'Snap';
        snapButton.title = 'Snap new and moved points to steps';
        snapButton.setAttribute('aria-pressed', 'true');
        snapButton.onclick = () => snapButton.setAttribute('aria-pressed',
            String(snapButton.getAttribute('aria-pressed') !== 'true'));
        clearButton.type = 'button';
        clearButton.textContent = 'Clear lane';
        autoHint.className = 'automation-hint';
        autoHint.textContent = 'Click to add a point · drag to move · Shift-click or right-click a point to delete';
        automationToolbar.append(snapButton, clearButton, autoHint);
        automationCanvas.onpointerdown = (event) => {
            if (event.button !== 0 || editorState.autoGesture || !autoEditable()) {
                return;
            }
            const { id, key } = autoSelection();
            const spec = AUTOMATION_SPECS[key];
            const position = autoPointer(event);
            if (event.shiftKey) {
                removeAutomationPointAt(position);
                return;
            }
            const before = engine.getAutomation(id, key);
            const draft = before.map((point) => ({ ...point }));
            let index = autoHit(draft, spec, position);
            if (index < 0) {
                if (position.x < KEYBOARD_WIDTH) {
                    return;
                }
                const tick = autoTickOf(position.x);
                const value = autoPointerValue(spec, key, position.y);
                const existing = draft.findIndex((point) => point.tick === tick);
                if (existing >= 0) {
                    draft[existing].value = value;
                    index = existing;
                } else {
                    draft.push({ tick, value });
                    draft.sort((a, b) => a.tick - b.tick);
                    index = draft.findIndex((point) => point.tick === tick);
                }
                engine.setAutomation(id, key, draft);
            }
            editorState.autoGesture = { pointerId: event.pointerId, id, key, spec, before, draft, index };
            automationCanvas.setPointerCapture(event.pointerId);
            automationCanvas.style.cursor = 'grabbing';
            event.preventDefault();
            drawAutomationLane();
        };
        automationCanvas.onpointermove = (event) => {
            const position = autoPointer(event);
            if (!editorState.autoGesture) {
                if (!autoEditable()) {
                    automationCanvas.style.cursor = 'default';
                    return;
                }
                const { id, key } = autoSelection();
                const index = autoHit(engine.getAutomation(id, key), AUTOMATION_SPECS[key], position);
                automationCanvas.style.cursor = index >= 0 ? 'grab' : 'crosshair';
                if (index !== autoHoverIndex) {
                    autoHoverIndex = index;
                    drawAutomationLane();
                }
                return;
            }
            if (event.pointerId !== editorState.autoGesture.pointerId) {
                return;
            }
            const { id, key, spec, draft, index } = editorState.autoGesture;
            // Points can't cross their neighbours, so ticks stay unique and ordered.
            const lowest = index > 0 ? draft[index - 1].tick + 1 : 0;
            const highest = index < draft.length - 1
                ? draft[index + 1].tick - 1
                : Math.floor(engine.sequence.stepToTick(engine.totalSteps));
            if (lowest <= highest) {
                draft[index].tick = Math.min(highest, Math.max(lowest, autoTickOf(position.x)));
            }
            draft[index].value = autoPointerValue(spec, key, position.y);
            engine.setAutomation(id, key, draft);
            drawAutomationLane();
        };
        automationCanvas.onpointerup = (event) => {
            if (!editorState.autoGesture || event.pointerId !== editorState.autoGesture.pointerId) {
                return;
            }
            const { id, key, before, draft, pointerId } = editorState.autoGesture;
            editorState.autoGesture = null;
            if (automationCanvas.hasPointerCapture(pointerId)) {
                automationCanvas.releasePointerCapture(pointerId);
            }
            automationCanvas.style.cursor = 'grab';
            commitAutomation(id, key, before, draft.map((point) => ({ ...point })));
            drawAutomationLane();
        };
        automationCanvas.onpointercancel = cancelAutomationGesture;
        automationCanvas.onlostpointercapture = cancelAutomationGesture;
        automationCanvas.oncontextmenu = (event) => {
            event.preventDefault();
            if (!editorState.autoGesture && autoEditable()) {
                removeAutomationPointAt(autoPointer(event));
            }
        };
        clearButton.onclick = () => actions.runEditorAction(clearAutomationLane);
        autoChannelSelect.onchange = autoParamSelect.onchange = () => {
            autoHoverIndex = -1;
            drawAutomationLane();
        };
    }

    return { bind, drawAutomationLane, syncAutomationControls, cancelAutomationGesture };
}
