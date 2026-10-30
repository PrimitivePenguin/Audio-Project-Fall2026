(() => {
    const engine = new SequencerEngine();
    const getElement = (id) => document.getElementById(id);
    const statusElement = getElement('status');
    const bpmInput = getElement('bpm');
    const loopStartInput = getElement('loopStart');
    const loopEndInput = getElement('loopEnd');
    const playButton = getElement('playButton');
    const pianoViewport = getElement('pianoViewport');
    const pianoCanvas = getElement('pianoCanvas');
    const pianoSpacer = getElement('pianoSpacer');
    const drawingContext = pianoCanvas.getContext('2d');

    // Grid geometry and editor state. Musical timing stays in NoteSequence.
    const {
        rowHeight: ROW_HEIGHT,
        stepWidth: STEP_WIDTH,
        keyboardWidth: KEYBOARD_WIDTH,
        rulerHeight: RULER_HEIGHT
    } = PianoRollEditor.geometry;
    let selectedNoteId = null;
    let latestAudioUploadId = 0;
    let latestMidiImportId = 0;
    let isStartingPlayback = false;
    let lowestPitch = 36;
    let highestPitch = 83;
    let displayedStep = null;
    let canvasSizeKey = '';
    let newNoteLengthSteps = 1;
    let newNoteVelocity = 89;
    let resizeGesture = null;
    let suppressResizeClick = false;
    let overlapIds = [];
    let playRequestId = 0;
    let sampleTriggerPage = 0;
    let loadedSampleName = '';
    let isSampleLoading = false;
    const SAMPLE_PAGE_SIZE = 50;
    const EMPTY_SAMPLE_STATUS = 'Upload an audio sample, then add trigger steps.';

    // Controls and selected-note details.
    function showStatus(text) {
        statusElement.textContent = text;
    }

    function updateTransportControls() {
        const busy = isStartingPlayback || engine.isPlaying || Boolean(engine.startPromise);
        playButton.disabled = busy;
        for (const id of [
            'loopStart',
            'loopEnd',
            'patternSteps',
            'addBar',
            'removeBar',
            'midiFile'
        ]) {
            getElement(id).disabled = busy;
        }
        bpmInput.disabled = engine.sequence.tempos.length > 1;
        bpmInput.min = bpmInput.disabled ? '' : '40';
        bpmInput.max = bpmInput.disabled ? '' : '240';
        getElement('tempoInfo').textContent = bpmInput.disabled
            ? 'Imported tempo map active; BPM editing disabled.'
            : 'BPM edits replace the constant tempo (40–240).';
    }

    function syncEditorState() {
        getElement('patternSteps').value = engine.totalSteps;
        loopStartInput.max = loopEndInput.max = engine.totalSteps;
        loopStartInput.value = engine.loopStart + 1;
        loopEndInput.value = engine.loopEnd;
        bpmInput.value = engine.bpm;
        pianoSpacer.style.width = `${KEYBOARD_WIDTH + engine.totalSteps * STEP_WIDTH}px`;
        pianoSpacer.style.height = `${RULER_HEIGHT + (highestPitch - lowestPitch + 1) * ROW_HEIGHT}px`;
        updateTransportControls();
        updateCompositionSummary();
        renderSampleEditor();
        renderPianoRoll();
    }

    function updateCompositionSummary() {
        const sequence = engine.sequence;
        const info = sequence.importInfo;
        const importedNotes = info
            ? sequence.notes.filter((note) => note.importId === info.id).length
            : 0;
        getElement('compositionInfo').textContent =
            `${sequence.notes.length} notes total · ` +
            `${sequence.tracks.length} musical tracks · ${importedNotes} MIDI notes remaining` +
            (info ? ` (${info.noteCount} originally imported)` : '');
        getElement('removeImportedMidi').disabled = !info;
    }

    function selectedNote() {
        return engine.sequence.notes.find((note) => note.id === selectedNoteId) ?? null;
    }

    function selectNote(note) {
        selectedNoteId = note?.id ?? null;
        refreshNoteControls();
    }

    function refreshNoteControls(preview = null) {
        const note = selectedNote();
        getElement('deleteNote').disabled = !note;
        getElement('nextOverlap').disabled = overlapIds.length < 2;
        if (!note) {
            getElement('noteLength').value = String(newNoteLengthSteps);
            getElement('velocity').value = newNoteVelocity;
            getElement('noteInfo').textContent =
                'All musical tracks are visible. New notes use Piano. ' +
                'Click to select; repeated clicks cycle overlaps. Drag an edge to resize, or past the opposite edge to delete. Escape cancels. Delete note also removes the selection.';
            return;
        }
        if (preview?.deleteNote) {
            getElement('noteLength').value = String(note.durationSteps);
            getElement('noteInfo').textContent =
                'Release to delete this note. Drag back to keep resizing; Escape cancels.';
            return;
        }
        const ticks = preview?.ticks ?? note.ticks;
        const durationTicks = preview?.durationTicks ?? note.durationTicks;
        const track = engine.sequence.tracks.find((candidate) => candidate.id === note.trackId);
        getElement('noteLength').value = String(engine.sequence.tickToStep(durationTicks));
        getElement('velocity').value = note.velocityMidi;
        getElement('noteInfo').textContent =
            `${NoteSequence.pitchName(note.midi)} · ` +
            `${track?.name ?? note.trackId} (channel ${(track?.channel ?? 0) + 1}) · ` +
            `${note.id} · start ${ticks}, duration ${durationTicks} ticks at ${engine.sequence.ppq} PPQ` +
            (note.importId ? ' · imported' : ' · manual') +
            (preview?.limited
                ? ' · extend the pattern for whole-step resizing'
                : preview
                  ? ' · resize preview'
                  : '');
    }

    function currentView() {
        return {
            width: pianoViewport.clientWidth,
            height: pianoViewport.clientHeight,
            scrollLeft: pianoViewport.scrollLeft,
            scrollTop: pianoViewport.scrollTop,
            highestPitch
        };
    }

    function expandPitchRange(notes) {
        for (const note of notes) {
            lowestPitch = Math.min(lowestPitch, note.midi);
            highestPitch = Math.max(highestPitch, note.midi);
        }
        getElement('pitchLow').value = lowestPitch;
        getElement('pitchHigh').value = highestPitch;
    }

    function findNotes(notes = engine.sequence.notes) {
        if (!notes.length) {
            showStatus('No notes to find. Add a note or import MIDI.');
            return;
        }
        expandPitchRange(notes);
        syncEditorState();
        const target = PianoRollEditor.navigation(notes, engine.sequence, currentView());
        const maxLeft = Math.max(
            0,
            KEYBOARD_WIDTH + engine.totalSteps * STEP_WIDTH - pianoViewport.clientWidth
        );
        const maxTop = Math.max(
            0,
            RULER_HEIGHT +
                (highestPitch - lowestPitch + 1) * ROW_HEIGHT -
                pianoViewport.clientHeight
        );
        pianoViewport.scrollLeft = Math.min(maxLeft, target.scrollLeft);
        pianoViewport.scrollTop = Math.min(maxTop, target.scrollTop);
        renderPianoRoll();
        renderSampleEditor();
    }

    getElement('findNotes').onclick = () => findNotes();

    // Canvas rendering: keep the original layer order and drawing state.
    function renderPianoRoll() {
        const width = pianoViewport.clientWidth;
        const height = pianoViewport.clientHeight;
        const scrollLeft = pianoViewport.scrollLeft;
        const scrollTop = pianoViewport.scrollTop;
        prepareCanvas(width, height, scrollLeft, scrollTop);
        const first = Math.max(0, Math.floor(scrollLeft / STEP_WIDTH));
        const last = Math.min(engine.totalSteps, Math.ceil((scrollLeft + width) / STEP_WIDTH));

        drawPitchRows(width, height, scrollTop);
        drawTimingGrid(first, last, height, scrollLeft);
        drawLoopRegion(width, height, scrollLeft);
        drawNoteBlocks(width, height, scrollLeft, scrollTop);
        drawPianoKeys(height, scrollTop);
        drawMeasureRuler(first, last, width, scrollLeft);
    }

    function prepareCanvas(width, height, scrollLeft, scrollTop) {
        // One viewport-sized canvas regardless of composition length; no per-cell DOM.
        const size = `${width}:${height}:${window.devicePixelRatio || 1}`;
        if (size !== canvasSizeKey) {
            const pixelRatio = window.devicePixelRatio || 1;
            pianoCanvas.width = Math.round(width * pixelRatio);
            pianoCanvas.height = Math.round(height * pixelRatio);
            pianoCanvas.style.width = `${width}px`;
            pianoCanvas.style.height = `${height}px`;
            drawingContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            canvasSizeKey = size;
        }
        pianoCanvas.style.left = `${scrollLeft}px`;
        pianoCanvas.style.top = `${scrollTop}px`;
        drawingContext.fillStyle = '#f8fafc';
        drawingContext.fillRect(0, 0, width, height);
    }

    function drawPitchRows(width, height, scrollTop) {
        for (
            let row = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
            row <=
            Math.min(highestPitch - lowestPitch, Math.ceil((scrollTop + height) / ROW_HEIGHT));
            row++
        ) {
            const midi = highestPitch - row;
            const y = RULER_HEIGHT + row * ROW_HEIGHT - scrollTop;
            const isBlackKey = [1, 3, 6, 8, 10].includes(midi % 12);
            drawingContext.fillStyle = isBlackKey ? '#e6ecf3' : '#f8fafc';
            drawingContext.fillRect(KEYBOARD_WIDTH, y, width - KEYBOARD_WIDTH, ROW_HEIGHT);
            drawingContext.strokeStyle = '#d2dae5';
            drawingContext.beginPath();
            drawingContext.moveTo(KEYBOARD_WIDTH, y + ROW_HEIGHT);
            drawingContext.lineTo(width, y + ROW_HEIGHT);
            drawingContext.stroke();
        }
    }

    function drawTimingGrid(first, last, height, scrollLeft) {
        for (let step = first; step <= last; step++) {
            const x = KEYBOARD_WIDTH + step * STEP_WIDTH - scrollLeft;
            if (x < KEYBOARD_WIDTH) {
                continue;
            }
            const position = engine.sequence.positionAtTick(engine.sequence.stepToTick(step));
            drawingContext.strokeStyle = position.onBeat ? '#8d9db1' : '#d2dae5';
            drawingContext.lineWidth = position.onBeat && position.beat === 1 ? 2 : 1;
            drawingContext.beginPath();
            drawingContext.moveTo(x, RULER_HEIGHT);
            drawingContext.lineTo(x, height);
            drawingContext.stroke();
            drawingContext.lineWidth = 1;
        }
    }

    function drawLoopRegion(width, height, scrollLeft) {
        const loopX = KEYBOARD_WIDTH + engine.loopStart * STEP_WIDTH - scrollLeft;
        const loopEndX = KEYBOARD_WIDTH + engine.loopEnd * STEP_WIDTH - scrollLeft;
        drawingContext.fillStyle = '#25364b20';
        if (loopX > KEYBOARD_WIDTH) {
            drawingContext.fillRect(KEYBOARD_WIDTH, RULER_HEIGHT, loopX - KEYBOARD_WIDTH, height);
        }
        if (loopEndX < width) {
            drawingContext.fillRect(
                Math.max(KEYBOARD_WIDTH, loopEndX),
                RULER_HEIGHT,
                width - Math.max(KEYBOARD_WIDTH, loopEndX),
                height
            );
        }
    }

    function drawNoteBlocks(width, height, scrollLeft, scrollTop) {
        // All tracks share the view. Draw the selected note last so its resize edges stay visible.
        drawingContext.save();
        drawingContext.beginPath();
        drawingContext.rect(
            KEYBOARD_WIDTH,
            RULER_HEIGHT,
            width - KEYBOARD_WIDTH,
            height - RULER_HEIGHT
        );
        drawingContext.clip();
        const notes = engine.sequence.notes.filter((note) => note.id !== selectedNoteId);
        if (selectedNote()) {
            notes.push(selectedNote());
        }
        notes.forEach((note) => {
            if (note.midi < lowestPitch || note.midi > highestPitch) {
                return;
            }
            const preview = resizeGesture?.noteId === note.id ? resizeGesture.preview : null;
            const startStep = preview ? engine.sequence.tickToStep(preview.ticks) : note.startStep;
            const durationSteps = preview
                ? engine.sequence.tickToStep(preview.durationTicks)
                : note.durationSteps;
            const x = KEYBOARD_WIDTH + startStep * STEP_WIDTH - scrollLeft;
            const y = RULER_HEIGHT + (highestPitch - note.midi) * ROW_HEIGHT - scrollTop;
            const noteWidth = durationSteps * STEP_WIDTH;
            if (
                x + noteWidth < KEYBOARD_WIDTH ||
                x > width ||
                y + ROW_HEIGHT < RULER_HEIGHT ||
                y > height
            ) {
                return;
            }
            const displayWidth = Math.max(8, noteWidth);
            drawingContext.fillStyle = preview?.deleteNote
                ? '#d44848'
                : note.id === selectedNoteId
                  ? '#e3a72f'
                  : noteColor(note.trackId);
            drawingContext.fillRect(x + 1, y + 3, Math.max(6, displayWidth - 2), ROW_HEIGHT - 6);
            drawingContext.strokeStyle = '#1b467f';
            drawingContext.strokeRect(x + 1, y + 3, Math.max(6, displayWidth - 2), ROW_HEIGHT - 6);
            if (note.id === selectedNoteId) {
                drawingContext.fillStyle = '#172b46';
                drawingContext.fillRect(x + 2, y + 6, 3, ROW_HEIGHT - 12);
                drawingContext.fillRect(x + displayWidth - 5, y + 6, 3, ROW_HEIGHT - 12);
            }
        });
        if (displayedStep !== null) {
            const x = KEYBOARD_WIDTH + displayedStep * STEP_WIDTH - scrollLeft;
            drawingContext.fillStyle = '#df941050';
            drawingContext.fillRect(x, RULER_HEIGHT, STEP_WIDTH, height);
        }
        drawingContext.restore();
    }

    function drawPianoKeys(height, scrollTop) {
        // Sticky keyboard and ruler are drawn last.
        drawingContext.fillStyle = '#fff';
        drawingContext.fillRect(0, RULER_HEIGHT, KEYBOARD_WIDTH, height);
        drawingContext.font = '11px system-ui';
        drawingContext.textAlign = 'right';
        for (
            let row = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
            row <=
            Math.min(highestPitch - lowestPitch, Math.ceil((scrollTop + height) / ROW_HEIGHT));
            row++
        ) {
            const midi = highestPitch - row;
            const y = RULER_HEIGHT + row * ROW_HEIGHT - scrollTop;
            if (y < RULER_HEIGHT) {
                continue;
            }
            const isBlackKey = [1, 3, 6, 8, 10].includes(midi % 12);
            drawingContext.fillStyle = isBlackKey ? '#273548' : '#fff';
            drawingContext.fillRect(0, y, KEYBOARD_WIDTH, ROW_HEIGHT - 1);
            drawingContext.fillStyle = isBlackKey ? '#fff' : '#213047';
            drawingContext.fillText(NoteSequence.pitchName(midi), KEYBOARD_WIDTH - 8, y + 16);
        }
    }

    function drawMeasureRuler(first, last, width, scrollLeft) {
        drawingContext.fillStyle = '#dfe7f2';
        drawingContext.fillRect(0, 0, width, RULER_HEIGHT);
        drawingContext.textAlign = 'left';
        drawingContext.fillStyle = '#213047';
        drawingContext.fillText('Pitch / Measure', 4, 20);
        for (let step = first; step < last; step++) {
            const x = KEYBOARD_WIDTH + step * STEP_WIDTH - scrollLeft;
            if (x < KEYBOARD_WIDTH) {
                continue;
            }
            const position = engine.sequence.positionAtTick(engine.sequence.stepToTick(step));
            drawingContext.fillText(
                position.onBeat && position.beat === 1 ? `M${position.measure}` : String(step + 1),
                x + 3,
                20
            );
        }
    }

    function noteColor(trackId) {
        const palette = ['#3474c9', '#47896c', '#9068b6', '#b86a4b', '#378b99', '#b27b23'];
        let hash = 0;
        for (const character of trackId) {
            hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
        }
        return palette[hash % palette.length];
    }

    function canvasPoint(event) {
        const bounds = pianoCanvas.getBoundingClientRect();
        // Pointer events use CSS pixels; the canvas transform alone handles device pixel ratio.
        return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    }

    function candidatesAt(point) {
        return PianoRollEditor.notesAtPoint(engine.sequence.notes, point, currentView());
    }

    function cycleOverlap() {
        const index = overlapIds.indexOf(selectedNoteId);
        const nextId = overlapIds[(index + 1) % overlapIds.length];
        selectNote(engine.sequence.notes.find((note) => note.id === nextId) ?? null);
        renderPianoRoll();
    }

    function handleCanvasClick(event) {
        if (suppressResizeClick) {
            suppressResizeClick = false;
            return;
        }
        const point = canvasPoint(event);
        if (point.x < KEYBOARD_WIDTH || point.y < RULER_HEIGHT) {
            return;
        }
        const candidates = candidatesAt(point);
        overlapIds = candidates.map((note) => note.id);
        if (candidates.length) {
            cycleOverlap();
        } else {
            const step = (point.x + pianoViewport.scrollLeft - KEYBOARD_WIDTH) / STEP_WIDTH;
            const midi =
                highestPitch -
                Math.floor((point.y + pianoViewport.scrollTop - RULER_HEIGHT) / ROW_HEIGHT);
            if (
                step < 0 ||
                step >= engine.totalSteps ||
                midi < lowestPitch ||
                midi > highestPitch
            ) {
                return;
            }
            try {
                const ticks = Math.round(engine.sequence.stepToTick(Math.floor(step)));
                const durationTicks = PianoRollEditor.durationTicks(
                    engine.sequence,
                    newNoteLengthSteps
                );
                if (
                    ticks + durationTicks >
                    Math.floor(engine.sequence.stepToTick(engine.totalSteps))
                ) {
                    throw new Error('Extend the pattern before adding a note this long.');
                }
                engine.sequence.addNote({
                    midi,
                    ticks,
                    durationTicks,
                    velocityMidi: newNoteVelocity,
                    trackId: engine.sequence.ensurePianoTrack()
                });
                selectNote(null);
            } catch (error) {
                showStatus(error.message);
            }
        }
        updateCompositionSummary();
        renderPianoRoll();
    }

    function deleteSelectedNote() {
        cancelResize();
        engine.sequence.removeById(selectedNoteId);
        overlapIds = overlapIds.filter((id) => id !== selectedNoteId);
        selectNote(null);
        updateCompositionSummary();
        renderPianoRoll();
    }

    function applyLengthTicks(durationTicks) {
        cancelResize();
        const note = selectedNote();
        if (note) {
            engine.sequence.updateNoteTiming(note.id, note.ticks, durationTicks);
        } else {
            newNoteLengthSteps = engine.sequence.tickToStep(durationTicks);
        }
        refreshNoteControls();
        renderPianoRoll();
    }

    function changeLength() {
        try {
            const durationTicks = PianoRollEditor.durationTicks(
                engine.sequence,
                Number(getElement('noteLength').value)
            );
            applyLengthTicks(durationTicks);
        } catch (error) {
            showStatus(error.message);
            refreshNoteControls();
        }
    }

    function adjustLength(direction) {
        try {
            const durationTicks =
                selectedNote()?.durationTicks ??
                PianoRollEditor.durationTicks(engine.sequence, newNoteLengthSteps);
            applyLengthTicks(
                PianoRollEditor.adjustedLength(engine.sequence, durationTicks, direction)
            );
        } catch (error) {
            showStatus(error.message);
            refreshNoteControls();
        }
    }

    function changeVelocity() {
        const value = Number(getElement('velocity').value);
        const note = selectedNote();
        if (!Number.isInteger(value) || value < 1 || value > 127) {
            showStatus('Velocity must be 1–127.');
            refreshNoteControls();
            return;
        }
        if (note) {
            note.velocityMidi = value;
            note.velocity = value / 127;
        } else {
            newNoteVelocity = value;
        }
    }

    // Dragging previews a single ID. Only pointer release commits to the model.
    function resizeTarget(point) {
        const candidates = candidatesAt(point);
        const selected = candidates.find((note) => note.id === selectedNoteId);
        const note = selected ?? candidates[0];
        const edge = note ? PianoRollEditor.edgeAtPoint(note, point, currentView()) : null;
        return edge ? { note, edge } : null;
    }

    function beginResize(event) {
        suppressResizeClick = false;
        if (event.button !== 0 || resizeGesture) {
            return;
        }
        const target = resizeTarget(canvasPoint(event));
        if (!target) {
            return;
        }
        selectNote(target.note);
        const point = canvasPoint(event);
        const pointerStep = (point.x + pianoViewport.scrollLeft - KEYBOARD_WIDTH) / STEP_WIDTH;
        const endpointStep =
            target.edge === 'left'
                ? target.note.startStep
                : target.note.startStep + target.note.durationSteps;
        resizeGesture = {
            noteId: target.note.id,
            pointerId: event.pointerId,
            edge: target.edge,
            original: { ticks: target.note.ticks, durationTicks: target.note.durationTicks },
            startX: event.clientX,
            startScrollLeft: pianoViewport.scrollLeft,
            grabOffsetSteps: pointerStep - endpointStep,
            preview: null,
            moved: false
        };
        suppressResizeClick = true;
        pianoCanvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        renderPianoRoll();
    }

    function movePointer(event) {
        if (!resizeGesture) {
            const target = resizeTarget(canvasPoint(event));
            pianoCanvas.style.cursor = target ? 'ew-resize' : 'default';
            return;
        }
        if (event.pointerId !== resizeGesture.pointerId) {
            return;
        }
        const distance =
            event.clientX -
            resizeGesture.startX +
            pianoViewport.scrollLeft -
            resizeGesture.startScrollLeft;
        if (Math.abs(distance) < 3 && !resizeGesture.moved) {
            return;
        }
        const point = canvasPoint(event);
        const pointerStep = (point.x + pianoViewport.scrollLeft - KEYBOARD_WIDTH) / STEP_WIDTH;
        const step = pointerStep - resizeGesture.grabOffsetSteps;
        try {
            resizeGesture.preview = PianoRollEditor.resizedTiming(
                engine.sequence,
                resizeGesture.original,
                resizeGesture.edge,
                step,
                pointerStep
            );
            resizeGesture.moved = true;
            refreshNoteControls(resizeGesture.preview);
            renderPianoRoll();
        } catch (error) {
            showStatus(error.message);
            cancelResize();
        }
    }

    function finishResize(event) {
        if (!resizeGesture || event.pointerId !== resizeGesture.pointerId) {
            return;
        }
        // The release can carry a newer position than the last coalesced move event.
        movePointer(event);
        if (!resizeGesture) {
            return;
        }
        const gesture = resizeGesture;
        resizeGesture = null;
        try {
            if (gesture.moved && gesture.preview) {
                if (gesture.preview.deleteNote) {
                    engine.sequence.removeById(gesture.noteId);
                    overlapIds = overlapIds.filter((id) => id !== gesture.noteId);
                    selectNote(null);
                    updateCompositionSummary();
                } else if (!gesture.preview.limited) {
                    engine.sequence.updateNoteTiming(
                        gesture.noteId,
                        gesture.preview.ticks,
                        gesture.preview.durationTicks
                    );
                }
            }
        } catch (error) {
            showStatus(error.message);
        }
        releasePointer(gesture.pointerId);
        refreshNoteControls();
        renderPianoRoll();
    }

    function releasePointer(pointerId) {
        if (pianoCanvas.hasPointerCapture(pointerId)) {
            pianoCanvas.releasePointerCapture(pointerId);
        }
        pianoCanvas.style.cursor = 'default';
    }

    function cancelResize() {
        if (!resizeGesture) {
            return;
        }
        const pointerId = resizeGesture.pointerId;
        resizeGesture = null;
        releasePointer(pointerId);
        refreshNoteControls();
        renderPianoRoll();
    }

    function cancelPointerGesture(event) {
        if (resizeGesture?.pointerId === event.pointerId) {
            cancelResize();
        }
    }

    pianoCanvas.onclick = handleCanvasClick;
    pianoCanvas.onpointerdown = beginResize;
    pianoCanvas.onpointermove = movePointer;
    pianoCanvas.onpointerup = finishResize;
    pianoCanvas.onpointercancel = cancelPointerGesture;
    pianoCanvas.onlostpointercapture = cancelPointerGesture;
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && resizeGesture) {
            event.preventDefault();
            cancelResize();
        }
    });
    getElement('nextOverlap').onclick = cycleOverlap;
    getElement('deleteNote').onclick = deleteSelectedNote;
    getElement('noteLength').onchange = changeLength;
    getElement('noteLength').onkeydown = (event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            adjustLength(event.key === 'ArrowUp' ? 1 : -1);
        }
    };
    getElement('lengthDecrease').onclick = () => adjustLength(-1);
    getElement('lengthIncrease').onclick = () => adjustLength(1);
    getElement('velocity').onchange = changeVelocity;

    // Pitch range, pattern length, and transport controls.
    function updatePitchRange() {
        cancelResize();
        const newLowestPitch = Number(getElement('pitchLow').value);
        const newHighestPitch = Number(getElement('pitchHigh').value);
        if (
            !Number.isInteger(newLowestPitch) ||
            !Number.isInteger(newHighestPitch) ||
            newLowestPitch < 0 ||
            newHighestPitch > 127 ||
            newLowestPitch > newHighestPitch
        ) {
            showStatus('Pitch range must satisfy 0 ≤ low ≤ high ≤ 127.');
        } else {
            lowestPitch = newLowestPitch;
            highestPitch = newHighestPitch;
            pianoViewport.scrollTop = 0;
            syncEditorState();
        }
        getElement('pitchLow').value = lowestPitch;
        getElement('pitchHigh').value = highestPitch;
    }

    getElement('pitchLow').onchange = getElement('pitchHigh').onchange = updatePitchRange;
    function resizePattern(steps) {
        cancelResize();
        try {
            engine.setPatternLength(steps);
            showStatus(`Pattern: ${steps} steps. No notes deleted.`);
        } catch (error) {
            showStatus(error.message);
        }
        syncEditorState();
    }

    getElement('patternSteps').onchange = () =>
        resizePattern(Number(getElement('patternSteps').value));
    const getStepsPerMeasure = () => {
        const position = engine.sequence.positionAtTick(
            engine.sequence.stepToTick(engine.totalSteps - 1)
        );
        return Math.max(1, Math.round((16 * position.meter[0]) / position.meter[1]));
    };

    getElement('addBar').onclick = () => resizePattern(engine.totalSteps + getStepsPerMeasure());
    getElement('removeBar').onclick = () => resizePattern(engine.totalSteps - getStepsPerMeasure());
    loopStartInput.onchange = loopEndInput.onchange = () => {
        try {
            if (!loopStartInput.value || !loopEndInput.value) {
                throw new Error('Enter both loop endpoints.');
            }
            engine.setLoopRange(Number(loopStartInput.value) - 1, Number(loopEndInput.value));
            showStatus(`Loop: ${engine.loopStart + 1}–${engine.loopEnd}.`);
        } catch (error) {
            showStatus(error.message);
        }
        syncEditorState();
    };
    bpmInput.onchange = () => {
        try {
            if (!bpmInput.value.trim() || !Number.isFinite(Number(bpmInput.value))) {
                throw new Error('Enter a BPM from 40 to 240.');
            }
            engine.setBpm(Number(bpmInput.value));
            showStatus(`Tempo: ${engine.bpm} BPM.`);
        } catch (error) {
            showStatus(error.message);
        }
        bpmInput.value = engine.bpm;
    };
    playButton.onclick = async () => {
        if (isStartingPlayback || engine.isPlaying) {
            return;
        }
        const requestId = ++playRequestId;
        isStartingPlayback = true;
        updateTransportControls();
        try {
            await engine.play();
            if (requestId === playRequestId && engine.isPlaying) {
                showStatus('Playing. Edits affect notes not already queued.');
            }
        } catch (error) {
            if (requestId === playRequestId) {
                showStatus(`Playback failed: ${error.message}`);
            }
        } finally {
            if (requestId === playRequestId) {
                isStartingPlayback = false;
                updateTransportControls();
            }
        }
    };
    function stopPlayback() {
        playRequestId++;
        cancelResize();
        engine.stop();
        isStartingPlayback = false;
        updateTransportControls();
        displayedStep = null;
        renderPianoRoll();
        showStatus('Stopped. Position reset to loop start.');
    }

    getElement('stopButton').onclick = stopPlayback;
    engine.onError = (error, details) => {
        if (details?.fatal !== false) {
            stopPlayback();
        }
        showStatus(`Audio ${details?.fatal === false ? 'warning' : 'failure'}: ${error.message}`);
    };
    // Only active sample triggers are listed, with a bounded number of controls per page.
    function renderSampleEditor() {
        const track = engine.tracks.get('uploaded');
        const triggers = [];
        track?.steps.forEach((active, step) => {
            if (active) {
                triggers.push(step);
            }
        });
        const lastPage = Math.max(0, Math.ceil(triggers.length / SAMPLE_PAGE_SIZE) - 1);
        sampleTriggerPage = Math.min(sampleTriggerPage, lastPage);
        const first = sampleTriggerPage * SAMPLE_PAGE_SIZE;
        const container = getElement('sampleTriggers');
        container.replaceChildren();
        triggers.slice(first, first + SAMPLE_PAGE_SIZE).forEach((step) => {
            const item = document.createElement('li');
            item.dataset.step = String(step);
            item.classList.toggle('current', step === displayedStep);
            const label = document.createElement('span');
            label.textContent = `Step ${step + 1}`;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', `Remove sample trigger at step ${step + 1}`);
            remove.onclick = () => {
                engine.setStep('uploaded', step, false);
                renderSampleEditor();
                getElement('sampleStatus').textContent = `Removed trigger at step ${step + 1}.`;
            };
            item.append(label);
            item.append(remove);
            container.append(item);
        });
        getElement('sampleTriggerStep').max = engine.totalSteps;
        getElement('sampleTriggerStep').disabled = !track;
        getElement('addSampleTrigger').disabled = !track;
        getElement('removeSample').disabled = !track && !isSampleLoading;
        getElement('samplePreviousPage').disabled = sampleTriggerPage === 0;
        getElement('sampleNextPage').disabled = sampleTriggerPage === lastPage;
        getElement('sampleName').textContent = track
            ? `Sample: ${loadedSampleName || 'uploaded audio'}`
            : 'No sample loaded.';
        getElement('sampleTriggerSummary').textContent = triggers.length
            ? `Active triggers ${first + 1}–${Math.min(first + SAMPLE_PAGE_SIZE, triggers.length)} of ${triggers.length}.`
            : 'No active triggers.';
    }

    function addSampleTrigger() {
        const track = engine.tracks.get('uploaded');
        const stepNumber = Number(getElement('sampleTriggerStep').value);
        if (
            !track ||
            !Number.isInteger(stepNumber) ||
            stepNumber < 1 ||
            stepNumber > engine.totalSteps
        ) {
            getElement('sampleStatus').textContent =
                `Load a sample and enter an integer step from 1 to ${engine.totalSteps}.`;
            return;
        }
        const step = stepNumber - 1;
        if (track.steps[step]) {
            getElement('sampleStatus').textContent = `Step ${stepNumber} already has a trigger.`;
            return;
        }
        engine.setStep('uploaded', step, true);
        const position = track.steps.slice(0, step).filter(Boolean).length;
        sampleTriggerPage = Math.floor(position / SAMPLE_PAGE_SIZE);
        renderSampleEditor();
        getElement('sampleStatus').textContent = `Added trigger at step ${stepNumber}.`;
    }

    function removeSample() {
        latestAudioUploadId++;
        isSampleLoading = false;
        engine.removeTrack('uploaded');
        loadedSampleName = '';
        sampleTriggerPage = 0;
        getElement('audioFile').value = '';
        getElement('sampleTriggerStep').value = '1';
        getElement('sampleStatus').textContent = EMPTY_SAMPLE_STATUS;
        renderSampleEditor();
    }

    getElement('addSampleTrigger').onclick = addSampleTrigger;
    getElement('removeSample').onclick = removeSample;
    getElement('sampleTriggerStep').onkeydown = (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            addSampleTrigger();
        }
    };
    getElement('samplePreviousPage').onclick = () => {
        sampleTriggerPage = Math.max(0, sampleTriggerPage - 1);
        renderSampleEditor();
    };
    getElement('sampleNextPage').onclick = () => {
        sampleTriggerPage++;
        renderSampleEditor();
    };

    // Audio and MIDI loading use separate tokens to ignore stale async results.
    getElement('audioFile').onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) {
            return;
        }
        const token = ++latestAudioUploadId;
        isSampleLoading = true;
        getElement('sampleStatus').textContent = `Loading ${file.name || 'audio sample'}…`;
        renderSampleEditor();
        try {
            engine.initContext();
            const buffer = await engine.audioContext.decodeAudioData(await file.arrayBuffer());
            if (token !== latestAudioUploadId) {
                return;
            }
            const steps = engine.tracks.get('uploaded')?.steps.slice();
            engine.addTrack('uploaded', buffer);
            loadedSampleName = file.name || 'uploaded audio';
            steps?.forEach((active, step) => engine.setStep('uploaded', step, active));
            renderSampleEditor();
            getElement('sampleStatus').textContent = `Loaded: ${file.name}`;
        } catch (error) {
            if (token === latestAudioUploadId) {
                getElement('sampleStatus').textContent =
                    `Could not load audio: ${error.message}. Previous sample retained.`;
            }
        } finally {
            if (token === latestAudioUploadId) {
                isSampleLoading = false;
                renderSampleEditor();
            }
        }
    };

    getElement('midiFile').onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) {
            return;
        }
        const token = ++latestMidiImportId;
        try {
            if (file.size > 10 * 1024 * 1024) {
                throw new Error('MIDI limit: 10 MB.');
            }
            const buffer = await file.arrayBuffer();
            if (token !== latestMidiImportId) {
                return;
            }
            const result = MidiIO.importInto(engine, buffer);
            cancelResize();
            overlapIds = [];
            selectNote(null);
            expandPitchRange(engine.sequence.notes);
            syncEditorState();
            const importId = engine.sequence.importInfo.id;
            findNotes(engine.sequence.notes.filter((note) => note.importId === importId));
            showStatus(
                `Imported ${engine.sequence.notes.length} notes in ${engine.sequence.tracks.length} tracks. ${result.warnings.join(' ')}`
            );
        } catch (error) {
            if (token === latestMidiImportId) {
                showStatus(`Import cancelled: ${error.message}. Existing composition retained.`);
            }
        } finally {
            if (token === latestMidiImportId) {
                event.target.value = '';
            }
        }
    };

    function resetEditorSelection() {
        overlapIds = [];
        suppressResizeClick = false;
        selectNote(null);
        displayedStep = null;
    }

    function resetPitchViewport() {
        lowestPitch = 36;
        highestPitch = 83;
        expandPitchRange(engine.sequence.notes);
        syncEditorState();
        pianoViewport.scrollLeft = 0;
        pianoViewport.scrollTop = Math.max(
            0,
            RULER_HEIGHT + (highestPitch - 60) * ROW_HEIGHT - 288
        );
        renderPianoRoll();
    }

    function removeImportedMidi() {
        latestMidiImportId++;
        stopPlayback();
        try {
            engine.removeImportedMidi();
            getElement('midiFile').value = '';
            resetEditorSelection();
            resetPitchViewport();
            if (engine.sequence.notes.length) {
                findNotes();
            }
            showStatus(
                'Imported MIDI removed, including edited imported notes. Manual notes and audio samples retained.'
            );
        } catch (error) {
            showStatus(`Could not remove MIDI: ${error.message}`);
        }
    }

    function startNewSequence() {
        if (
            !window.confirm(
                'Start a new sequence? This removes all notes, imported MIDI, and uploaded samples.'
            )
        ) {
            return;
        }
        latestMidiImportId++;
        latestAudioUploadId++;
        isSampleLoading = false;
        loadedSampleName = '';
        sampleTriggerPage = 0;
        stopPlayback();
        engine.newSequence();
        newNoteLengthSteps = 1;
        newNoteVelocity = 89;
        getElement('midiFile').value = '';
        getElement('audioFile').value = '';
        getElement('sampleStatus').textContent = EMPTY_SAMPLE_STATUS;
        getElement('sampleTriggerStep').value = '1';
        resetEditorSelection();
        resetPitchViewport();
        showStatus('New sequence. Add notes, then press Play.');
    }

    getElement('removeImportedMidi').onclick = removeImportedMidi;
    getElement('newSequence').onclick = startNewSequence;

    getElement('exportMidi').onclick = () => {
        try {
            const result = MidiIO.encode(engine.sequence);
            const url = URL.createObjectURL(new Blob([result.bytes], { type: 'audio/midi' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'jukebox.mid';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            showStatus(`Exported full composition. ${result.warnings.join(' ')}`);
        } catch (error) {
            showStatus(`Export failed: ${error.message}`);
        }
    };
    // Browser lifecycle and audio-clock playhead updates.
    pianoViewport.addEventListener('scroll', renderPianoRoll);
    window.addEventListener('resize', renderPianoRoll);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopPlayback();
        }
    });
    window.addEventListener('pagehide', stopPlayback);
    function updatePlayhead() {
        const step = engine.audioContext ? engine.getPlaybackStep() : null;
        if (step !== displayedStep) {
            displayedStep = step;
            renderPianoRoll();
            Array.from(getElement('sampleTriggers').children).forEach((item) => {
                item.classList.toggle('current', Number(item.dataset.step) === step);
            });
        }
        requestAnimationFrame(updatePlayhead);
    }

    selectNote(null);
    syncEditorState();
    pianoViewport.scrollTop = Math.max(0, RULER_HEIGHT + (highestPitch - 60) * ROW_HEIGHT - 288);
    renderPianoRoll();
    updatePlayhead();
    // Teammates register against this instance, without adding a global transport.
    document.dispatchEvent(new CustomEvent('jukebox:ready', { detail: { engine } }));
})();
