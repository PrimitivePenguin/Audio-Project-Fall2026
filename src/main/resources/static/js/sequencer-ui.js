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
    const selectedIds = new Set();
    let editGesture = null;
    let cursorGesture = null;
    let clipboard = null;
    let editingCursorTick = 0;
    let cursorSequence = null;
    let historySequence = null;
    const undoStack = [];
    const redoStack = [];
    const playbackFollow = new PianoRollFollow();
    let observedScrollLeft = pianoViewport.scrollLeft;

    function editableNotes(includeOutsidePitchRange = false) {
        return PianoRollEditor.eligibleNotes(engine.sequence, includeOutsidePitchRange
            ? {} : { lowestPitch, highestPitch });
    }

    function horizontalScrollLimit() {
        return Math.max(0, KEYBOARD_WIDTH + engine.totalSteps * STEP_WIDTH - pianoViewport.clientWidth);
    }

    function scrollHorizontally(left, automatic = false) {
        const target = Math.max(0, Math.min(horizontalScrollLimit(), left));
        if (Math.abs(target - pianoViewport.scrollLeft) < 0.01) {
            return false;
        }
        if (!automatic) {
            playbackFollow.interrupt();
        }
        pianoViewport.scrollLeft = target;
        // Read back the browser's actual (possibly rounded/clamped) value immediately.
        observedScrollLeft = pianoViewport.scrollLeft;
        if (!automatic) {
            playbackFollow.update(followSample(engine.getPlaybackPosition()));
        }
        return true;
    }

    function reconcileHorizontalScroll() {
        const actual = pianoViewport.scrollLeft;
        if (Math.abs(actual - observedScrollLeft) >= 0.01) {
            playbackFollow.interrupt();
            observedScrollLeft = actual;
            playbackFollow.update(followSample(engine.getPlaybackPosition()));
            return true;
        }
        return false;
    }

    function followSample(position) {
        return {
            playing: engine.isPlaying,
            runId: engine.runId,
            pass: position?.pass,
            ticks: position?.ticks,
            contentX: position ? engine.sequence.tickToStep(position.ticks) * STEP_WIDTH : 0,
            scrollLeft: pianoViewport.scrollLeft,
            width: pianoViewport.clientWidth,
            maxScroll: horizontalScrollLimit()
        };
    }

    function updatePlaybackFollow(position) {
        // Check actual position before every automatic write, not just on scroll-event delivery.
        // Delayed/coalesced events therefore cannot mistake our last applied offset for user input.
        const manuallyScrolled = reconcileHorizontalScroll();
        if (editGesture || resizeGesture || cursorGesture) {
            playbackFollow.interrupt();
            return manuallyScrolled;
        }
        const left = playbackFollow.update(followSample(position));
        const automaticallyScrolled = left !== null && scrollHorizontally(left, true);
        return manuallyScrolled || automaticallyScrolled;
    }

    function directionalTarget(direction) {
        if (selectedIds.size !== 1) {
            return null;
        }
        const notes = editableNotes();
        const selected = notes.find((note) => selectedIds.has(note.id));
        return selected ? PianoRollEditor.directionalNote(notes, selected, direction, engine.sequence.ppq) : null;
    }

    function navigateSelection(direction) {
        const target = directionalTarget(direction);
        if (!target) {
            return;
        }
        const reveal = PianoRollEditor.revealNote(target, engine.sequence, currentView());
        scrollHorizontally(reveal.scrollLeft);
        pianoViewport.scrollTop = reveal.scrollTop;
        overlapIds = [];
        selectNote(target);
        renderPianoRoll();
    }

    function selectedNotes() {
        return engine.sequence.notes.filter((note) => selectedIds.has(note.id));
    }

    function checkHistory() {
        if (historySequence !== engine.sequence) {
            historySequence = engine.sequence;
            undoStack.length = 0;
            redoStack.length = 0;
            clipboard = null;
            syncEditingCursor();
        }
    }

    function snapshotNotes() {
        return new Map(engine.sequence.notes.map((note) => [note.id, { ...note }]));
    }

    function recordEdit(before) {
        checkHistory();
        const after = snapshotNotes();
        const ids = new Set([...before.keys(), ...after.keys()]);
        const changes = [...ids].filter((id) =>
            JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))
        ).map((id) => ({ before: before.get(id), after: after.get(id) }));
        if (changes.length) {
            undoStack.push(changes);
            let storedNotes = undoStack.reduce((count, edit) => count + edit.length, 0);
            while (undoStack.length > 1 && (undoStack.length > 100 || storedNotes > 200000)) {
                storedNotes -= undoStack.shift().length;
            }
            redoStack.length = 0;
        }
    }

    function restoreHistory(source, destination, side) {
        cancelEditorGesture();
        checkHistory();
        const changes = source.pop();
        if (!changes) {
            return;
        }
        const deletedIds = new Set(changes.filter((change) => !change[side])
            .map((change) => (change.before ?? change.after).id));
        engine.sequence.notes = engine.sequence.notes.filter((note) => !deletedIds.has(note.id));
        const existingNotes = new Map(engine.sequence.notes.map((note) => [note.id, note]));
        for (const change of changes) {
            const data = change[side];
            if (!data) {
                continue;
            }
            const existing = existingNotes.get(data.id);
            if (existing) {
                Object.assign(existing, data);
            } else {
                engine.sequence.addNote(data);
            }
        }
        destination.push(changes);
        selectedIds.clear();
        for (const change of changes) {
            if (change[side]) {
                selectedIds.add(change[side].id);
            }
        }
        selectedNoteId = [...selectedIds][0] ?? null;
        refreshNoteControls();
        syncEditorState();
    }

    function clipboardEdit(action) {
        cancelEditorGesture();
        checkHistory();
        const notes = selectedNotes();
        if (action === 'copy' || action === 'cut' || action === 'duplicate') {
            if (!notes.length) {
                return;
            }
            clipboard = notes.map((note) => ({ ...note }));
            if (action === 'copy') {
                return;
            }
            if (action === 'cut') {
                deleteSelectedNote();
                return;
            }
        }
        if (!clipboard?.length) {
            return;
        }
        const first = clipboard.reduce((start, note) => Math.min(start, note.ticks), Infinity);
        const end = clipboard.reduce((last, note) => Math.max(last, note.ticks + note.durationTicks), 0);
        // Paste anchors the earliest copied note at the independent editing cursor.
        const target = action === 'duplicate' ? end : editingCursorTick;
        const requiredSteps = Math.ceil(engine.sequence.tickToStep(target + end - first));
        if (requiredSteps > 65536) {
            throw new Error('Pasted notes exceed the maximum pattern length.');
        }
        const before = snapshotNotes();
        if (requiredSteps > engine.totalSteps) {
            engine.setPatternLength(requiredSteps);
        }
        selectedIds.clear();
        for (const data of clipboard) {
            const note = engine.sequence.addNote({
                ...data,
                id: undefined,
                ticks: target + data.ticks - first,
                importId: null
            });
            selectedIds.add(note.id);
        }
        selectedNoteId = [...selectedIds][0];
        recordEdit(before);
        refreshNoteControls();
        syncEditorState();
    }
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
        playButton.disabled = false;
        playButton.textContent = busy ? 'Ⅱ Pause' : engine.isPaused ? '▶ Resume' : '▶ Play';
        playButton.setAttribute('aria-label', busy ? 'Pause playback (Space)' : engine.isPaused ? 'Resume playback (Space)' : 'Play (Space)');
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

    function syncEditingCursor() {
        if (cursorSequence !== engine.sequence) {
            cursorSequence = engine.sequence;
            editingCursorTick = 0;
        }
        editingCursorTick = Math.min(editingCursorTick,
            Math.floor(engine.sequence.stepToTick(engine.totalSteps)));
        getElement('cursorPosition').textContent = PianoRollEditor.cursorLabel(engine.sequence, editingCursorTick);
    }

    function syncEditorState() {
        syncEditingCursor();
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
        selectedIds.clear();
        if (note) {
            selectedIds.add(note.id);
        }
        selectedNoteId = note?.id ?? null;
        refreshNoteControls();
    }

    function refreshNoteControls(preview = null) {
        const note = selectedNote();
        getElement('deleteNote').disabled = !selectedIds.size;
        getElement('selectionCount').textContent = `${selectedIds.size} selected`;
        getElement('nextOverlap').disabled = overlapIds.length < 2;
        const lengthInput = getElement('noteLength');
        lengthInput.placeholder = '';
        const durations = selectedNotes().map((selected) =>
            resizeGesture?.previews?.get(selected.id)?.durationTicks ??
            (selected.id === selectedNoteId ? preview?.durationTicks : null) ?? selected.durationTicks);
        const mixed = durations.some((duration) => duration !== durations[0]);
        if (!note) {
            getElement('noteLength').value = String(newNoteLengthSteps);
            getElement('velocity').value = newNoteVelocity;
            getElement('noteInfo').textContent =
                'All Notes view. New notes use Piano. ' +
                'Click a note to select; Shift-click toggles. An empty click clears selection, or creates a note if none are selected. Drag empty space to select, a body to move, or an edge to resize. Drag the ruler to position the cursor. Escape cancels.';
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
        lengthInput.value = mixed ? '' : String(engine.sequence.tickToStep(durationTicks));
        lengthInput.placeholder = mixed ? 'Mixed' : '';
        getElement('velocity').value = note.velocityMidi;
        getElement('noteInfo').textContent =
            `${NoteSequence.pitchName(preview?.midi ?? note.midi)} · ` +
            `${track?.name ?? note.trackId} (channel ${(track?.channel ?? 0) + 1}) · ` +
            `${note.id} · start ${ticks}, duration ${durationTicks} ticks at ${engine.sequence.ppq} PPQ` +
            (note.importId ? ' · imported' : ' · manual') +
            (preview?.limited
                ? ' · extend the pattern for whole-step resizing'
                : preview
                  ? ' · edit preview'
                  : '');
    }

    function currentView() {
        return {
            width: pianoViewport.clientWidth,
            height: pianoViewport.clientHeight,
            scrollLeft: pianoViewport.scrollLeft,
            scrollTop: pianoViewport.scrollTop,
            lowestPitch,
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

    function findNotes(notes = editableNotes(true)) {
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
        scrollHorizontally(Math.min(maxLeft, target.scrollLeft));
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
        if (editGesture?.kind === 'marquee' && editGesture.moved) {
            const a = editGesture.start;
            const b = editGesture.point;
            drawingContext.strokeStyle = '#244eb2';
            drawingContext.fillStyle = '#244eb230';
            const x = Math.min(a.x, b.x) - scrollLeft;
            const y = Math.min(a.y, b.y) - scrollTop;
            drawingContext.fillRect(x, y, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
            drawingContext.strokeRect(x, y, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
        }
        drawPianoKeys(height, scrollTop);
        drawMeasureRuler(first, last, width, scrollLeft);
        const cursorX = KEYBOARD_WIDTH + engine.sequence.tickToStep(editingCursorTick) * STEP_WIDTH - scrollLeft;
        if (cursorX >= KEYBOARD_WIDTH && cursorX <= width) {
            drawingContext.fillStyle = '#087e8b';
            drawingContext.fillRect(cursorX, 0, 2, height);
            drawingContext.beginPath();
            drawingContext.moveTo(cursorX - 5, 0);
            drawingContext.lineTo(cursorX + 7, 0);
            drawingContext.lineTo(cursorX + 1, 8);
            drawingContext.fill();
        }
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
        const eligible = editableNotes();
        const notes = eligible.filter((note) => note.id !== selectedNoteId);
        const selected = eligible.find((note) => note.id === selectedNoteId);
        if (selected) {
            notes.push(selected);
        }
        notes.forEach((note) => {
            if (note.midi < lowestPitch || note.midi > highestPitch) {
                return;
            }
            const preview = editGesture?.previews?.get(note.id) ??
                resizeGesture?.previews?.get(note.id) ??
                (resizeGesture?.noteId === note.id ? resizeGesture.preview : null);
            const startStep = preview ? engine.sequence.tickToStep(preview.ticks) : note.startStep;
            const durationSteps = preview
                ? engine.sequence.tickToStep(preview.durationTicks)
                : note.durationSteps;
            const x = KEYBOARD_WIDTH + startStep * STEP_WIDTH - scrollLeft;
            const y = RULER_HEIGHT + (highestPitch - (preview?.midi ?? note.midi)) * ROW_HEIGHT - scrollTop;
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
                : selectedIds.has(note.id)
                  ? '#e3a72f'
                  : noteColor(note.trackId);
            drawingContext.fillRect(x + 1, y + 3, Math.max(6, displayWidth - 2), ROW_HEIGHT - 6);
            drawingContext.strokeStyle = '#1b467f';
            drawingContext.strokeRect(x + 1, y + 3, Math.max(6, displayWidth - 2), ROW_HEIGHT - 6);
            if (selectedIds.has(note.id)) {
                drawingContext.fillStyle = '#172b46';
                drawingContext.fillRect(x + 2, y + 6, 3, ROW_HEIGHT - 12);
                drawingContext.fillRect(x + displayWidth - 5, y + 6, 3, ROW_HEIGHT - 12);
            }
        });
        if (displayedStep !== null) {
            const x = KEYBOARD_WIDTH + displayedStep * STEP_WIDTH - scrollLeft;
            drawingContext.fillStyle = '#df9410';
            drawingContext.fillRect(x, RULER_HEIGHT, 2, height);
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
        return PianoRollEditor.notesAtPoint(editableNotes(), point, currentView());
    }

    function cycleOverlap() {
        const index = overlapIds.indexOf(selectedNoteId);
        const nextId = overlapIds[(index + 1) % overlapIds.length];
        selectNote(engine.sequence.notes.find((note) => note.id === nextId) ?? null);
        renderPianoRoll();
    }

    function setEditingCursor(ticks, seekPaused = true) {
        editingCursorTick = ticks;
        if (seekPaused && engine.isPaused) {
            const compositionEnd = engine.sequence.stepToTick(engine.totalSteps);
            // The cursor's last integer tick represents the end of a fractional-tick pattern.
            engine.seekPaused(ticks === Math.floor(compositionEnd) ? compositionEnd : ticks);
            displayedStep = engine.sequence.tickToStep(engine.getPlaybackTick());
            renderSampleEditor();
        }
        getElement('cursorPosition').textContent = PianoRollEditor.cursorLabel(engine.sequence, ticks);
        renderPianoRoll();
    }

    function moveCursor(event) {
        cursorGesture.clientX = event.clientX;
        cursorGesture.clientY = event.clientY;
        if (engine.isPaused && cursorGesture.originalPausedTick === null) {
            cursorGesture.originalPausedTick = engine.pausedTick;
        }
        const point = canvasPoint(event);
        setEditingCursor(PianoRollEditor.cursorTick(engine.sequence, point.x, pianoViewport.scrollLeft));
    }

    function handleCanvasClick(event) {
        if (suppressResizeClick) {
            suppressResizeClick = false;
            return;
        }
        const point = canvasPoint(event);
        if (point.x >= KEYBOARD_WIDTH && point.y >= 0 && point.y < RULER_HEIGHT) {
            setEditingCursor(PianoRollEditor.cursorTick(engine.sequence, point.x, pianoViewport.scrollLeft));
            return;
        }
        if (point.x < KEYBOARD_WIDTH || point.y < RULER_HEIGHT) {
            return;
        }
        const candidates = candidatesAt(point);
        overlapIds = candidates.map((note) => note.id);
        if (candidates.length) {
            if (event.shiftKey) {
                const note = candidates.find((candidate) => candidate.id === selectedNoteId) ?? candidates[0];
                if (selectedIds.has(note.id)) {
                    selectedIds.delete(note.id);
                } else {
                    selectedIds.add(note.id);
                }
                selectedNoteId = selectedIds.has(note.id) ? note.id : [...selectedIds][0] ?? null;
                refreshNoteControls();
            } else {
                cycleOverlap();
            }
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
            if (selectedIds.size) {
                selectNote(null);
                renderPianoRoll();
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
                const before = snapshotNotes();
                engine.sequence.addNote({
                    midi,
                    ticks,
                    durationTicks,
                    velocityMidi: newNoteVelocity,
                    trackId: engine.sequence.ensurePianoTrack()
                });
                recordEdit(before);
                selectNote(null);
            } catch (error) {
                showStatus(error.message);
            }
        }
        updateCompositionSummary();
        renderPianoRoll();
    }

    function deleteSelectedNote() {
        cancelEditorGesture();
        const before = snapshotNotes();
        engine.sequence.notes = engine.sequence.notes.filter((note) => !selectedIds.has(note.id));
        overlapIds = overlapIds.filter((id) => !selectedIds.has(id));
        recordEdit(before);
        selectNote(null);
        updateCompositionSummary();
        renderPianoRoll();
    }

    function applySelectedDurations(durationForNote) {
        cancelEditorGesture();
        const sequence = engine.sequence;
        const updates = selectedNotes().map((note) => ({
            note,
            durationTicks: durationForNote(note)
        }));
        const patternEnd = Math.floor(sequence.stepToTick(sequence.stepCount));
        // Validate the complete selection before touching any canonical note record.
        for (const { note, durationTicks } of updates) {
            if (!Number.isSafeInteger(durationTicks) || durationTicks < 1 ||
                note.ticks + durationTicks > patternEnd) {
                throw new RangeError('Keep every selected note inside the pattern with a duration of at least one tick. Extend the pattern first.');
            }
        }
        const before = snapshotNotes();
        for (const { note, durationTicks } of updates) {
            sequence.updateNoteTiming(note.id, note.ticks, durationTicks);
        }
        recordEdit(before);
        refreshNoteControls();
        renderPianoRoll();
    }

    function applyLengthTicks(durationTicks) {
        if (selectedIds.size) {
            applySelectedDurations(() => durationTicks);
        } else {
            newNoteLengthSteps = engine.sequence.tickToStep(durationTicks);
            refreshNoteControls();
        }
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
            if (selectedIds.size) {
                applySelectedDurations((note) => {
                    const delta = direction * Math.round(engine.sequence.stepToTick(1));
                    const ticks = note.durationTicks + delta;
                    // A single note retains the original inspector's one-tick minimum.
                    return selectedIds.size === 1 ? Math.max(1, ticks) : ticks;
                });
            } else {
                const durationTicks = PianoRollEditor.durationTicks(engine.sequence, newNoteLengthSteps);
                applyLengthTicks(PianoRollEditor.adjustedLength(engine.sequence, durationTicks, direction));
            }
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
            const before = snapshotNotes();
            note.velocityMidi = value;
            note.velocity = value / 127;
            recordEdit(before);
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
        if (event.shiftKey) {
            return;
        }
        if (!selectedIds.has(target.note.id)) {
            selectNote(target.note);
        }
        selectedNoteId = target.note.id;
        const point = canvasPoint(event);
        const pointerStep = (point.x + pianoViewport.scrollLeft - KEYBOARD_WIDTH) / STEP_WIDTH;
        const endpointStep =
            target.edge === 'left'
                ? target.note.startStep
                : target.note.startStep + target.note.durationSteps;
        resizeGesture = {
            before: snapshotNotes(),
            originals: selectedNotes().map((note) => ({ ...note })),
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
            pianoCanvas.style.cursor = target ? 'ew-resize' : candidatesAt(canvasPoint(event)).length ? 'move' : 'crosshair';
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
            if (resizeGesture.originals.length > 1) {
                const sequence = engine.sequence;
                const originals = resizeGesture.originals;
                const requested = resizeGesture.edge === 'right'
                    ? step - sequence.tickToStep(resizeGesture.original.ticks + resizeGesture.original.durationTicks)
                    : sequence.tickToStep(resizeGesture.original.ticks) - step;
                resizeGesture.previews = PianoRollEditor.resizedGroup(sequence, originals, requested);
                resizeGesture.preview = resizeGesture.previews.get(resizeGesture.noteId);
            } else {
                resizeGesture.preview = PianoRollEditor.resizedTiming(
                    engine.sequence,
                    resizeGesture.original,
                    resizeGesture.edge,
                    step,
                    pointerStep
                );
            }
            resizeGesture.moved = true;
            refreshNoteControls(resizeGesture.preview);
            renderPianoRoll();
        } catch (error) {
            showStatus(error.message);
            cancelEditorGesture();
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
                if (gesture.previews) {
                    for (const [id, timing] of gesture.previews) {
                        if (!timing.limited) {
                            engine.sequence.updateNoteTiming(id, timing.ticks, timing.durationTicks);
                        }
                    }
                } else if (gesture.preview.deleteNote) {
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
        recordEdit(gesture.before);
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

    function cancelEditorGesture() {
        if (cursorGesture) {
            const gesture = cursorGesture;
            cursorGesture = null;
            suppressResizeClick = true;
            if (engine.isPaused && gesture.originalPausedTick !== null) {
                engine.seekPaused(gesture.originalPausedTick);
                displayedStep = engine.sequence.tickToStep(engine.getPlaybackTick());
            }
            setEditingCursor(gesture.originalTick, false);
            renderSampleEditor();
            releasePointer(gesture.pointerId);
        }
        if (editGesture) {
            const gesture = editGesture;
            editGesture = null;
            selectedIds.clear();
            gesture.selection.forEach((id) => selectedIds.add(id));
            selectedNoteId = [...selectedIds][0] ?? null;
            suppressResizeClick = gesture.moved;
            releasePointer(gesture.pointerId);
            refreshNoteControls();
            renderPianoRoll();
        }
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
        if (resizeGesture?.pointerId === event.pointerId || cursorGesture?.pointerId === event.pointerId) {
            cancelEditorGesture();
        }
    }

    function contentPoint(event) {
        const point = canvasPoint(event);
        return { x: point.x + pianoViewport.scrollLeft, y: point.y + pianoViewport.scrollTop };
    }

    function beginGesture(event) {
        if (editGesture || resizeGesture || cursorGesture || event.button !== 0) {
            return;
        }
        checkHistory();
        pianoViewport.focus({ preventScroll: true });
        const initialPoint = canvasPoint(event);
        if (initialPoint.x >= KEYBOARD_WIDTH && initialPoint.y >= 0 && initialPoint.y < RULER_HEIGHT) {
            cursorGesture = {
                pointerId: event.pointerId,
                originalTick: editingCursorTick,
                originalPausedTick: engine.isPaused ? engine.pausedTick : null,
                clientX: event.clientX,
                clientY: event.clientY
            };
            suppressResizeClick = true;
            pianoCanvas.setPointerCapture(event.pointerId);
            pianoCanvas.style.cursor = 'col-resize';
            event.preventDefault();
            moveCursor(event);
            return;
        }
        beginResize(event);
        if (resizeGesture || event.button !== 0) {
            return;
        }
        const point = canvasPoint(event);
        if (point.x < KEYBOARD_WIDTH || point.y < RULER_HEIGHT) {
            return;
        }
        const candidates = candidatesAt(point);
        const note = candidates.find((candidate) => selectedIds.has(candidate.id)) ?? candidates[0];
        const selection = [...selectedIds];
        editGesture = {
            kind: note ? 'move' : 'marquee',
            note,
            selection,
            start: contentPoint(event),
            point: contentPoint(event),
            pointerId: event.pointerId,
            moved: false,
            additive: event.shiftKey,
            before: snapshotNotes()
        };
        pianoCanvas.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    function moveGesture(event) {
        if (cursorGesture) {
            if (cursorGesture.pointerId === event.pointerId) {
                moveCursor(event);
            }
            return;
        }
        if (!editGesture) {
            movePointer(event);
            return;
        }
        const gesture = editGesture;
        if (event.pointerId !== gesture.pointerId) {
            return;
        }
        gesture.point = contentPoint(event);
        const dx = gesture.point.x - gesture.start.x;
        const dy = gesture.point.y - gesture.start.y;
        if (!gesture.moved && Math.hypot(dx, dy) < 3) {
            return;
        }
        if (!gesture.moved && gesture.note && !selectedIds.has(gesture.note.id)) {
            selectNote(gesture.note);
        }
        gesture.moved = true;
        if (gesture.kind === 'marquee') {
            selectedIds.clear();
            if (gesture.additive) {
                gesture.selection.forEach((id) => selectedIds.add(id));
            }
            for (const note of editableNotes()) {
                if (PianoRollEditor.intersects(note, gesture.start, gesture.point,
                    { highestPitch, scrollLeft: 0, scrollTop: 0 })) {
                    selectedIds.add(note.id);
                }
            }
            selectedNoteId = [...selectedIds][0] ?? null;
        } else {
            const notes = [...gesture.before.values()].filter((note) => selectedIds.has(note.id));
            gesture.previews = PianoRollEditor.movedNotes(engine.sequence, notes, dx, dy);
            if (!gesture.previews) {
                showStatus('Extend the pattern before moving notes with tails beyond its end.');
            }
        }
        refreshNoteControls(gesture.previews?.get(selectedNoteId));
        renderPianoRoll();
    }

    function finishGesture(event) {
        if (cursorGesture) {
            if (cursorGesture.pointerId === event.pointerId) {
                moveCursor(event);
                cursorGesture = null;
                suppressResizeClick = true;
                releasePointer(event.pointerId);
            }
            return;
        }
        if (!editGesture) {
            finishResize(event);
            return;
        }
        if (event.pointerId !== editGesture.pointerId) {
            return;
        }
        moveGesture(event);
        const gesture = editGesture;
        editGesture = null;
        if (gesture.previews) {
            for (const note of engine.sequence.notes) {
                const preview = gesture.previews.get(note.id);
                if (preview) {
                    Object.assign(note, preview);
                }
            }
            recordEdit(gesture.before);
            expandPitchRange(engine.sequence.notes);
        }
        suppressResizeClick = gesture.moved;
        releasePointer(gesture.pointerId);
        refreshNoteControls();
        syncEditorState();
    }

    pianoCanvas.onclick = handleCanvasClick;
    pianoCanvas.onpointerdown = beginGesture;
    pianoCanvas.onpointermove = moveGesture;
    pianoCanvas.onpointerup = finishGesture;
    pianoCanvas.onpointercancel = (event) => {
        if (editGesture?.pointerId === event.pointerId) {
            cancelEditorGesture();
        } else {
            cancelPointerGesture(event);
        }
    };
    pianoCanvas.onlostpointercapture = pianoCanvas.onpointercancel;
    const shortcutsDialog = getElement('shortcutsDialog');
    let helpReturnFocus = null;
    function selectAllNotes() {
        editableNotes(true).forEach((note) => selectedIds.add(note.id));
        selectedNoteId = [...selectedIds][0] ?? null;
    }

    function clearSelectionOrCancel() {
        if (resizeGesture || editGesture || cursorGesture) {
            cancelEditorGesture();
        } else {
            selectNote(null);
        }
    }

    const editorShortcuts = [
        {
            key: ' ',
            label: 'Space',
            description: 'Play from edit cursor, then repeat the full loop / Pause / Resume from saved or explicitly sought position',
            button: 'playButton',
            action: togglePlayback
        },
        {
            key: 'a',
            modifier: true,
            label: 'Cmd/Ctrl+A',
            description: 'Select all musical notes',
            action: selectAllNotes
        },
        {
            key: 'c',
            modifier: true,
            label: 'Cmd/Ctrl+C',
            description: 'Copy selected notes',
            button: 'copyNotes',
            action: () => clipboardEdit('copy')
        },
        {
            key: 'x',
            modifier: true,
            label: 'Cmd/Ctrl+X',
            description: 'Cut selected notes',
            button: 'cutNotes',
            action: () => clipboardEdit('cut')
        },
        {
            key: 'v',
            modifier: true,
            label: 'Cmd/Ctrl+V',
            description: 'Paste at editing cursor',
            button: 'pasteNotes',
            action: () => clipboardEdit('paste')
        },
        {
            key: 'd',
            modifier: true,
            label: 'Cmd/Ctrl+D',
            description: 'Duplicate after the selected passage',
            button: 'duplicateNotes',
            action: () => clipboardEdit('duplicate')
        },
        {
            key: 'z',
            modifier: true,
            label: 'Cmd/Ctrl+Z',
            description: 'Undo a note edit',
            button: 'undoNotes',
            action: () => restoreHistory(undoStack, redoStack, 'before')
        },
        {
            key: 'z',
            modifier: true,
            shift: true,
            label: 'Cmd/Ctrl+Shift+Z',
            description: 'Redo a note edit',
            button: 'redoNotes',
            action: () => restoreHistory(redoStack, undoStack, 'after')
        },
        {
            key: 'delete',
            aliases: ['backspace'],
            label: 'Delete / Backspace',
            description: 'Delete selected notes',
            button: 'deleteNote',
            action: deleteSelectedNote
        },
        {
            key: 'escape',
            label: 'Escape',
            description: 'Cancel active gesture / clear selection',
            action: clearSelectionOrCancel
        },
        {
            key: 'arrowright',
            navigation: 'right',
            label: 'Arrow Right',
            description: 'Select the nearest musical note center right (one note selected)',
            action: () => navigateSelection('right')
        },
        {
            key: 'arrowleft',
            navigation: 'left',
            label: 'Arrow Left',
            description: 'Select the nearest musical note center left (one note selected)',
            action: () => navigateSelection('left')
        },
        {
            key: 'arrowup',
            navigation: 'up',
            label: 'Arrow Up',
            description: 'Select the nearest musical note center up (one note selected)',
            action: () => navigateSelection('up')
        },
        {
            key: 'arrowdown',
            navigation: 'down',
            label: 'Arrow Down',
            description: 'Select the nearest musical note center down (one note selected)',
            action: () => navigateSelection('down')
        },
        {
            key: 'arrowup',
            local: true,
            label: 'Arrow Up in Length',
            description: 'Lengthen each selected note by one step',
            action: () => adjustLength(1)
        },
        {
            key: 'arrowdown',
            local: true,
            label: 'Arrow Down in Length',
            description: 'Shorten each selected note by one step',
            action: () => adjustLength(-1)
        }
    ];
    const mouseControls = [
        ['Click empty grid space', 'Clear the selection without creating a note. With nothing selected, create a Piano note using the current new-note length and velocity.'],
        ['Click a note', 'Select it. Repeated clicks cycle independent overlapping notes.'],
        ['Shift-click a note', 'Add or remove that note from selection.'],
        ['Drag empty grid space', 'Marquee-select intersecting notes; Shift adds to the selection.'],
        ['Drag note body', 'Move in time and pitch. Dragging a selected note moves the selected group.'],
        ['Drag note edge', 'Resize the note. A selected group shares a duration change and keeps every start fixed.'],
        ['Cross the opposite edge', 'Single-note resizing previews deletion; release deletes. Group resizing never deletes.'],
        ['Playback follow', 'The orange playhead locks to the musical-grid midpoint only after crossing from the left. Horizontal navigation releases it; scrolling ahead rearms a later crossing. Pause, wraps and resizing reassess readiness without recentering.'],
        ['Stop button', 'Stop and clear pause, then return focus to the piano roll. The next Space starts from the editing cursor. Stop keeps native mouse, Enter and Space activation.'],
        ['Play button / Space', 'Before or inside the loop, audition from the cursor to loop end; at or beyond loop end, audition to composition end. Then repeat the configured full loop. A cursor at composition end starts at loop start.'],
        ['Click or drag timeline ruler', 'Position the edit/paste cursor to the nearest MIDI tick without grid snapping. Escape or pointer cancellation restores its original position. While paused, moving it also seeks Resume; during playback it does not seek.'],
        ['Scroll / horizontal scroll', 'Explore pitches vertically and measures horizontally using scrollbars or your trackpad.'],
        ['Next overlapping note', 'Use Workspace options to cycle overlapping stable note IDs.'],
        ['Length / ±1 step', 'Enter an absolute length for all selected notes, or change each duration relatively.']
    ];

    function appendGuideEntry(container, label, description) {
        const term = document.createElement('dt');
        const definition = document.createElement('dd');
        term.textContent = label;
        definition.textContent = description;
        container.append(term, definition);
    }

    for (const shortcut of editorShortcuts) {
        appendGuideEntry(getElement('keyboardGuide'), shortcut.label, shortcut.description);
        if (shortcut.button) {
            const button = getElement(shortcut.button);
            button.title = `${shortcut.description} (${shortcut.label})`;
            button.onclick = () => runEditorAction(shortcut.action);
        }
    }
    for (const [label, description] of mouseControls) {
        appendGuideEntry(getElement('mouseGuide'), label, description);
    }

    function runEditorAction(action) {
        let result;
        try {
            result = action();
        } catch (error) {
            showStatus(error.message);
        }
        refreshNoteControls();
        renderPianoRoll();
        return result;
    }

    function closeShortcuts() {
        shortcutsDialog.close();
    }

    getElement('shortcutsButton').onclick = () => {
        cancelEditorGesture();
        helpReturnFocus = getElement('shortcutsButton');
        shortcutsDialog.showModal();
        getElement('closeShortcuts').focus();
    };
    getElement('closeShortcuts').onclick = closeShortcuts;
    shortcutsDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeShortcuts();
    });
    shortcutsDialog.addEventListener('close', () => helpReturnFocus?.focus());

    function matchesShortcut(shortcut, event) {
        const key = event.key.toLowerCase();
        return (shortcut.key === key || shortcut.aliases?.includes(key)) &&
            Boolean(shortcut.modifier) === Boolean(event.metaKey || event.ctrlKey) &&
            Boolean(shortcut.shift) === Boolean(event.shiftKey) && !event.altKey;
    }

    document.addEventListener('keydown', (event) => {
        if (shortcutsDialog.open) {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeShortcuts();
            }
            return;
        }
        if (document.querySelector?.('dialog[open], [role="dialog"][aria-modal="true"]')) {
            return;
        }
        if (event.key === 'Escape' && (resizeGesture || editGesture || cursorGesture)) {
            event.preventDefault();
            cancelEditorGesture();
            return;
        }
        const target = event.target;
        if (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]') ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) {
            return;
        }
        const shortcut = editorShortcuts.find((entry) => !entry.local && matchesShortcut(entry, event));
        if (!shortcut || resizeGesture || editGesture || cursorGesture) {
            return;
        }
        if ((shortcut.key === ' ' || shortcut.navigation) &&
            (target?.closest?.('button, a, summary, [role="button"], [role="menuitem"], [role="menu"], [role="tab"], [role="slider"], [role="radio"], [role="listbox"], [role="tree"]') ||
            ['BUTTON', 'A', 'SUMMARY'].includes(target?.tagName))) {
            return;
        }
        if (shortcut.navigation && !directionalTarget(shortcut.navigation)) {
            return;
        }
        if (shortcut.key === 'delete' && !selectedIds.size) {
            return;
        }
        event.preventDefault();
        if (shortcut.key === ' ' && event.repeat) {
            return;
        }
        runEditorAction(shortcut.action);
    });
    getElement('nextOverlap').onclick = cycleOverlap;
    getElement('deleteNote').onclick = deleteSelectedNote;
    getElement('noteLength').onchange = changeLength;
    getElement('noteLength').onkeydown = (event) => {
        const shortcut = editorShortcuts.find((entry) => entry.local && matchesShortcut(entry, event));
        if (shortcut) {
            event.preventDefault();
            runEditorAction(shortcut.action);
        }
    };
    getElement('lengthDecrease').onclick = () => adjustLength(-1);
    getElement('lengthIncrease').onclick = () => adjustLength(1);
    getElement('velocity').onchange = changeVelocity;

    // Pitch range, pattern length, and transport controls.
    function updatePitchRange() {
        cancelEditorGesture();
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
        cancelEditorGesture();
        try {
            engine.setPatternLength(steps);
            undoStack.length = 0;
            redoStack.length = 0;
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
    async function togglePlayback() {
        if (isStartingPlayback || engine.isPlaying || engine.startPromise) {
            playRequestId++;
            engine.pause();
            playbackFollow.reset();
            isStartingPlayback = false;
            displayedStep = engine.sequence.tickToStep(engine.getPlaybackTick());
            updateTransportControls();
            renderPianoRoll();
            renderSampleEditor();
            showStatus('Paused. Space or Resume continues from this position.');
            return;
        }
        const requestId = ++playRequestId;
        isStartingPlayback = true;
        updateTransportControls();
        try {
            await engine.play(editingCursorTick);
            if (requestId === playRequestId && engine.isPlaying) {
                updatePlaybackFollow(engine.getPlaybackPosition());
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
    }
    function stopPlayback() {
        playRequestId++;
        playbackFollow.reset();
        cancelEditorGesture();
        engine.stop();
        isStartingPlayback = false;
        updateTransportControls();
        displayedStep = null;
        renderPianoRoll();
        renderSampleEditor();
        showStatus('Stopped. Position reset to loop start.');
    }

    getElement('stopButton').onclick = () => {
        stopPlayback();
        // Native button activation has completed; return subsequent Space presses to the
        // editor transport shortcut without relaxing protections for focused controls.
        pianoViewport.focus({ preventScroll: true });
    };
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
            item.classList.toggle('current', displayedStep !== null && step === Math.floor(displayedStep));
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
            cancelEditorGesture();
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
        scrollHorizontally(0);
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
    pianoViewport.addEventListener('wheel', (event) => {
        if (event.deltaX || (event.shiftKey && event.deltaY)) {
            playbackFollow.interrupt();
        }
    }, { passive: true });
    pianoViewport.addEventListener('pointerdown', (event) => {
        const bounds = pianoViewport.getBoundingClientRect();
        if (event.clientY >= bounds.top + pianoViewport.clientHeight) {
            playbackFollow.interrupt();
        }
    });
    pianoViewport.addEventListener('scroll', () => {
        reconcileHorizontalScroll();
        // Reposition the viewport canvas before mapping the captured screen coordinate.
        renderPianoRoll();
        if (cursorGesture) {
            moveCursor(cursorGesture);
        }
    });
    window.addEventListener('resize', renderPianoRoll);
    if (typeof ResizeObserver !== 'undefined') {
        const viewportObserver = new ResizeObserver(renderPianoRoll);
        viewportObserver.observe(pianoViewport);
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopPlayback();
        }
    });
    window.addEventListener('pagehide', stopPlayback);
    function updatePlayhead() {
        const position = engine.audioContext && (engine.isPlaying || engine.isPaused)
            ? engine.getPlaybackPosition() : null;
        const step = position ? engine.sequence.tickToStep(position.ticks) : null;
        const scrolled = updatePlaybackFollow(position);
        // Drain legacy step markers while the continuous line follows the same audio clock.
        if (engine.audioContext) {
            engine.getPlaybackStep();
        }
        if (step !== displayedStep || scrolled) {
            displayedStep = step;
            renderPianoRoll();
            Array.from(getElement('sampleTriggers').children).forEach((item) => {
                item.classList.toggle('current', step !== null && Number(item.dataset.step) === Math.floor(step));
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