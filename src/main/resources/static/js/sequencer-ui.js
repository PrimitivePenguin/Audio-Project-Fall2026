 (async () => {
    const engine = new SequencerEngine();
    const getElement = (id) => document.getElementById(id);
    // Canvas colours come from the --roll-* variables in css/sequencer.css,
    // so the piano roll matches the rest of the site. Read once on load.
    const ROLL = (() => {
        const css = getComputedStyle(document.documentElement);
        const v = (name) => {
            const value = css.getPropertyValue(`--roll-${name}`).trim();
            // An empty value is ignored by the canvas, which would silently reuse the previous colour.
            if (!value) console.warn(`sequencer-ui: CSS variable --roll-${name} is not set in css/sequencer.css`);
            return value;
        };
        return {
            bg: v('bg'), rowSharp: v('row-sharp'), rowLine: v('row-line'), beatLine: v('beat-line'),
            loopShade: v('loop-shade'), keyWhite: v('key-white'), keyBlack: v('key-black'),
            keyLabel: v('key-label'), keyLabelOnBlack: v('key-label-on-black'), rulerBg: v('ruler-bg'),
            text: v('text'), noteOutline: v('note-outline'), noteSelected: v('note-selected'),
            noteDelete: v('note-delete'), grip: v('grip'), cursor: v('cursor'), playback: v('playback'),
            marquee: v('marquee'), marqueeFill: v('marquee-fill'), laneActive: v('lane-active'),
            laneAlt: v('lane-alt'), laneHeader: v('lane-header'), laneHeaderActive: v('lane-header-active')
        };
    })();
    const statusElement = getElement('status');
    const bpmInput = getElement('bpm');
    const loopStartInput = getElement('loopStart');
    const loopEndInput = getElement('loopEnd');
    const playButton = getElement('playButton');
    const pianoViewport = getElement('pianoViewport');
    const pianoCanvas = getElement('pianoCanvas');
    const pianoSpacer = getElement('pianoSpacer');
    const drawingContext = pianoCanvas.getContext('2d');
    const arrangement = new ArrangementEditor(engine, {
        canvas: pianoCanvas, point: canvasPoint, release: releasePointer, run: runEditorAction,
        canEdit: () => !arrangement.deletingAsset && databaseProject?.role !== 'VIEWER' && !engine.isPlaying && !engine.startPromise && !isStartingPlayback,
        clearMidiTrack: () => { if (activeTrackId !== null) setWorkspace('tracks', null); },
        tracksChanged: (id) => {
            syncEditorState();
            if (id) {
                const index = overviewTracks().findIndex((track) => track.id === id);
                const bottom = RULER_HEIGHT + (index + 1) * TrackOverview.laneHeight;
                pianoViewport.scrollTop = Math.max(pianoViewport.scrollTop, bottom - pianoViewport.clientHeight);
                getElement('sampleRack').open = true;
            }
        },
        createLane: (below) => {
            const ids = overviewTracks().map((track) => track.id);
            const track = engine.arrangement.addTrack();
            ids.splice(below ? ids.indexOf(below) + 1 : ids.length, 0, track.id);
            engine.arrangement.laneOrder = ids;
            syncEditorState();
            return track.id;
        },
        redraw: () => { pendingViewportRender = true; },
        selectionChanged: updateTrackActions,
        scrollTop: () => pianoViewport.scrollTop,
        snap: () => snapMode,
        laneAt: (point) => overviewTrackAt(point),
        stepAt: (point) => (point.x + pianoViewport.scrollLeft - KEYBOARD_WIDTH) / STEP_WIDTH,
        inGrid: (point) => point.x >= KEYBOARD_WIDTH && point.x < pianoViewport.clientWidth &&
            point.y >= RULER_HEIGHT && point.y < pianoViewport.clientHeight,
        extendPattern: (endTick) => {
            const sequence = engine.sequence;
            if (endTick <= sequence.stepToTick(engine.totalSteps) + 1e-8) return;
            const existingEnd = engine.arrangement.getIndex(sequence).root?.maxEnd ?? 0;
            engine.setPatternLength(Math.ceil(sequence.tickToStep(Math.max(endTick, existingEnd)) - 1e-10));
            syncEditorState();
        },
        record: (before, after) => {
            checkHistory();
            pushHistory({ kind: 'audio-clip', before, after });
        },
        discardAssetHistory: (id) => {
            for (const stack of [undoStack, redoStack]) {
                for (let i = stack.length - 1; i >= 0; i--) {
                    const action = stack[i];
                    if (action.kind === 'audio-clip' &&
                        (action.before.some((clip) => clip.assetId === id) || action.after.some((clip) => clip.assetId === id))) {
                        stack.splice(i, 1);
                    }
                }
            }
        }
    });

    // Grid geometry and editor state. Musical timing stays in NoteSequence.
    const { keyboardWidth: KEYBOARD_WIDTH, rulerHeight: RULER_HEIGHT } = PianoRollEditor.geometry;
    const baseGeometry = { ...PianoRollEditor.geometry };
    let { rowHeight: ROW_HEIGHT, stepWidth: STEP_WIDTH } = baseGeometry;
    let workspaceMode = 'piano';
    let snapMode = 'sixteenth';
    const supportedMeters = ['4/4', '3/4', '6/8', '5/4', '7/8'];
    let activeTrackId = null;
    let ghostNotesEnabled = false;
    let trackOptionsKey = '';
    let workspaceSequence = null;
    let pianoScrollTop = 0;
    let overviewScrollTop = 0;
    let selectedNoteId = null;
    const selectedIds = new Set();
    let editGesture = null;
    let cursorGesture = null;
    let trackGesture = null;
    let suppressTrackOpen = false;
    let pendingTrackDeletion = null;
    let clipboard = null;
    let editingCursorTick = 0;
    let cursorSequence = null;
    let historySequence = null;
    const undoStack = [];
    const redoStack = [];
    const playbackFollow = new PianoRollFollow();
    let observedScrollLeft = pianoViewport.scrollLeft;

    let renderIndex = null;
    let renderIndexSequence = null;
    let renderIndexNotes = null;
    let renderIndexLength = -1;
    let renderLanes = null;
    let lastHighlightKey = null;
    let pendingViewportRender = false;

    function overviewTracks() {
        return engine.arrangement.tracks.size
            ? engine.arrangement.orderedTracks(engine.sequence.tracks) : engine.sequence.tracks;
    }

    function overviewTrackAt(point) {
        const tracks = overviewTracks();
        return tracks[TrackOverview.laneAt(point, pianoViewport.scrollTop, tracks.length)];
    }

    function invalidateRenderIndex() {
        renderIndex = null;
        renderLanes = null;
    }

    function getRenderIndex() {
        const sequence = engine.sequence;
        if (!renderIndex || renderIndexSequence !== sequence || renderIndexNotes !== sequence.notes ||
            renderIndexLength !== sequence.notes.length) {
            renderIndex = new NoteRenderIndex(sequence);
            renderLanes = TrackOverview.lanes(sequence, overviewTracks());
            renderIndexSequence = sequence;
            renderIndexNotes = sequence.notes;
            renderIndexLength = sequence.notes.length;
        }
        return renderIndex;
    }

    function visibleRenderNotes(width, height, scrollLeft, scrollTop, allPitches = false) {
        const index = getRenderIndex();
        const low = allPitches ? 0 : Math.max(lowestPitch,
            Math.floor(highestPitch - (height + scrollTop - RULER_HEIGHT) / ROW_HEIGHT));
        const high = allPitches ? 127 : Math.min(highestPitch,
            Math.ceil(highestPitch - scrollTop / ROW_HEIGHT + 1));
        return index.query(engine.sequence.stepToTick((scrollLeft - 8) / STEP_WIDTH),
            engine.sequence.stepToTick((scrollLeft + width - KEYBOARD_WIDTH) / STEP_WIDTH), low, high);
    }

    function editableNotes(includeOutsidePitchRange = false) {
        if (workspaceMode !== 'piano') {
            return [];
        }
        return PianoRollEditor.eligibleNotes(engine.sequence, {
            trackId: activeTrackId,
            ...(includeOutsidePitchRange ? {} : { lowestPitch, highestPitch })
        });
    }

    function activeTrack() {
        return engine.sequence.tracks.find((track) => track.id === activeTrackId) ?? null;
    }

    function creationTrackName() {
        return activeTrack()?.name ?? engine.sequence.tracks.find((track) => track.id === 'piano')?.name ??
            engine.sequence.tracks[0]?.name ?? 'Piano';
    }

    function updateTrackActions() {
        const track = activeTrack();
        const readOnly = databaseProject?.role === 'VIEWER';
        const stopped = !engine.isPlaying && !engine.isPaused && !engine.startPromise && !isStartingPlayback;
        getElement('deleteMidiTrack').disabled = readOnly || !track || !stopped || Boolean(trackGesture) || engine.sequence.tracks.length <= 1;
        getElement('deleteMidiTrack').textContent = track ? `Delete ${track.name}` : 'Delete Track';
        getElement('deleteMidiTrack').title = track
            ? `Delete MIDI track '${track.name}'. Press Stop first; the last track is protected.`
            : 'Select a MIDI track to delete. Press Stop first.';
    }

    function syncTrackControls() {
        if (workspaceSequence !== engine.sequence) {
            workspaceSequence = engine.sequence;
            activeTrackId = null;
            selectedIds.clear();
            selectedNoteId = null;
            overlapIds = [];
        }
        const current = activeTrack();
        if (activeTrackId !== null && (!current ||
            (workspaceMode === 'piano' && (current.hidden || current.visible === false)))) {
            activeTrackId = null;
            selectedIds.clear();
            selectedNoteId = null;
            overlapIds = [];
        }
        const eligibleIds = new Set(workspaceMode === 'piano'
            ? PianoRollEditor.eligibleNotes(engine.sequence, { trackId: activeTrackId }).map((note) => note.id) : []);
        for (const id of selectedIds) {
            if (!eligibleIds.has(id)) {
                selectedIds.delete(id);
            }
        }
        overlapIds = overlapIds.filter((id) => eligibleIds.has(id));
        if (!selectedIds.has(selectedNoteId)) {
            selectedNoteId = [...selectedIds][0] ?? null;
        }
        const key = JSON.stringify(engine.sequence.tracks.map((track) => [track.id, track.name, track.hidden, track.visible]));
        const selector = getElement('activeTrack');
        if (key !== trackOptionsKey) {
            trackOptionsKey = key;
            selector.replaceChildren();
            const all = document.createElement('option');
            all.value = '';
            all.textContent = 'All Notes';
            selector.append(all);
            for (const track of engine.sequence.tracks) {
                const option = document.createElement('option');
                option.value = track.id;
                option.textContent = track.name + (track.hidden || track.visible === false ? ' (hidden)' : '');
                option.disabled = Boolean(track.hidden || track.visible === false);
                selector.append(option);
            }
        }
        selector.value = activeTrackId ?? '';
        const track = activeTrack();
        getElement('activeTrackName').textContent = track?.name ?? 'All Notes';
        getElement('activeTrackName').style.color = track ? noteColor(track.id) : '';
        getElement('activeTrackName').title = track ? `${track.name} · ${track.id}` : 'All musical tracks';
        getElement('tracksView').setAttribute('aria-pressed', String(workspaceMode === 'tracks'));
        getElement('pianoRollView').setAttribute('aria-pressed', String(workspaceMode === 'piano'));
        getElement('pianoRollView').disabled = Boolean(track && (track.hidden || track.visible === false));
        getElement('ghostNotes').checked = workspaceMode === 'piano' && Boolean(track) && ghostNotesEnabled;
        getElement('ghostNotes').disabled = workspaceMode !== 'piano' || !track;
        getElement('trackName').value = track?.name ?? '';
        getElement('trackMetadata').textContent = track
            ? `${track.id} · channel ${track.channel + 1} · program ${track.program} · ${track.importId ? 'imported' : 'manual'} · Delete requires Stop; the last track is protected.`
            : `All Notes: new notes use ${creationTrackName()}. Choose a track to manage it.`;
        const overview = workspaceMode === 'tracks';
        getElement('sampleRack').hidden = !overview;
        getElement('clipTools').hidden = !overview;
        arrangement.refreshInspector();
        pianoViewport.setAttribute('aria-label', overview ? 'Scrollable track overview' : 'Scrollable piano roll');
        for (const id of ['noteLength', 'lengthDecrease', 'lengthIncrease', 'velocity',
            'copyNotes', 'cutNotes', 'pasteNotes', 'duplicateNotes', 'pitchLow', 'pitchHigh']) {
            getElement(id).disabled = overview;
        }
        updateTrackActions();
        pianoViewport.setAttribute('aria-label', overview ? (engine.arrangement.tracks.size ? 'Arrangement timeline' : 'MIDI track overview') : `Piano roll: ${track?.name ?? 'All Notes'}`);
        pianoCanvas.setAttribute('aria-label', overview
            ? `${engine.sequence.tracks.length} MIDI track lanes. Select a track with the Active track selector, then Piano Roll / Edit Track. Double-click a lane to edit.` +
                (engine.arrangement.tracks.size ? ` ${engine.arrangement.tracks.size} audio lanes. Use Sample Rack to place samples and inspect clips.` : '')
            : `Piano roll: ${track?.name ?? 'All Notes'}. Other tracks shown as ghosts cannot be edited.`);
    }

    function setWorkspace(mode, trackId = activeTrackId) {
        if (mode !== 'piano' && mode !== 'tracks') {
            throw new RangeError('Choose the piano or tracks workspace.');
        }
        const track = engine.sequence.tracks.find((candidate) => candidate.id === trackId);
        if (trackId !== null && (!track || (mode === 'piano' && (track.hidden || track.visible === false)))) {
            throw new RangeError('Choose an existing visible musical track or All Notes.');
        }
        if (workspaceMode === mode && activeTrackId === trackId) {
            syncEditorState();
            return;
        }
        cancelEditorGesture();
        if (workspaceMode === 'piano') {
            pianoScrollTop = pianoViewport.scrollTop;
        } else {
            overviewScrollTop = pianoViewport.scrollTop;
        }
        workspaceMode = mode;
        if (mode === 'piano') arrangement.selectRackAsset(null);
        if (mode === 'piano' || trackId) arrangement.select(null);
        activeTrackId = trackId;
        overlapIds = [];
        selectNote(null);
        playbackFollow.interrupt();
        if (mode === 'piano') {
            expandPitchRange(editableNotes(true));
        }
        syncEditorState();
        const contentHeight = mode === 'tracks' ? TrackOverview.laneHeight * overviewTracks().length
            : (highestPitch - lowestPitch + 1) * ROW_HEIGHT;
        const maxTop = Math.max(0, RULER_HEIGHT + contentHeight - pianoViewport.clientHeight);
        pianoViewport.scrollTop = Math.min(maxTop, mode === 'tracks' ? overviewScrollTop : pianoScrollTop);
        if (mode === 'tracks' && trackId !== null) {
            const index = overviewTracks().findIndex((candidate) => candidate.id === trackId);
            const top = index * TrackOverview.laneHeight;
            const gridHeight = Math.max(0, pianoViewport.clientHeight - RULER_HEIGHT);
            if (top < pianoViewport.scrollTop) {
                pianoViewport.scrollTop = top;
            } else if (top + TrackOverview.laneHeight > pianoViewport.scrollTop + gridHeight) {
                pianoViewport.scrollTop = Math.min(maxTop, top + TrackOverview.laneHeight - gridHeight);
            }
        }
        if (mode === 'piano' && trackId !== null) {
            const notes = editableNotes(true);
            const firstTick = engine.sequence.stepToTick(pianoViewport.scrollLeft / STEP_WIDTH);
            const note = notes.find((candidate) => candidate.ticks + candidate.durationTicks > firstTick) ?? notes[0];
            if (note) {
                pianoViewport.scrollTop = PianoRollEditor.revealNote(note, engine.sequence, currentView()).scrollTop;
            }
        }
        renderPianoRoll();
    }

    function setGhostNotes(enabled) {
        if (typeof enabled !== 'boolean') {
            throw new TypeError('Ghost Notes requires a boolean.');
        }
        ghostNotesEnabled = enabled;
        getElement('ghostNotes').checked = workspaceMode === 'piano' && activeTrackId !== null && enabled;
        renderPianoRoll();
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
        if (editGesture || resizeGesture || cursorGesture || trackGesture || arrangement.gesture) {
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
        return editableNotes(true).filter((note) => selectedIds.has(note.id));
    }

    function checkHistory() {
        if (historySequence !== engine.sequence) {
            historySequence = engine.sequence;
            undoStack.length = 0;
            redoStack.length = 0;
            clipboard = null;
            arrangement.clipboard = [];
            syncEditingCursor();
        }
    }

    function snapshotNotes() {
        return new Map(engine.sequence.notes.map((note) => [note.id, { ...note }]));
    }

    function historyWeight(entry) {
        if (Array.isArray(entry)) return entry.length;
        if (entry.kind === 'audio-clip') return entry.before.length + entry.after.length;
        return entry.kind.endsWith('-order') ? entry.before.length : entry.record.notes.length + 1;
    }

    function pushHistory(entry) {
        undoStack.push(entry);
        let weight = undoStack.reduce((count, action) => count + historyWeight(action), 0);
        while (undoStack.length > 1 && (undoStack.length > 100 || weight > 200000)) {
            weight -= historyWeight(undoStack.shift());
        }
        redoStack.length = 0;
    }

    function reorderTrack(id, index) {
        if (databaseProject?.role === 'VIEWER') return;
        checkHistory();
        if (workspaceMode === 'tracks' && engine.arrangement.tracks.size) {
            const before = overviewTracks().map((track) => track.id);
            const from = before.indexOf(id);
            if (from < 0 || index < 0 || index >= before.length || from === index) return;
            const after = [...before];
            after.splice(index, 0, ...after.splice(from, 1));
            setArrangementOrder(after);
            pushHistory({ kind: 'arrangement-order', before, after });
            syncEditorState();
            showStatus(`Moved lane to position ${index + 1}.`);
            return;
        }
        const before = engine.sequence.tracks.map((track) => track.id);
        if (!engine.reorderMidiTrack(id, index)) {
            return;
        }
        pushHistory({ kind: 'track-order', before, after: engine.sequence.tracks.map((track) => track.id) });
        syncEditorState();
        showStatus(`Moved '${engine.sequence.tracks[index].name}' to track position ${index + 1}.`);
    }

    function setArrangementOrder(ids) {
        const midiIds = new Set(engine.sequence.tracks.map((track) => track.id));
        const order = ids.filter((id) => midiIds.delete(id));
        engine.setMidiTrackOrder([...order, ...midiIds]);
        engine.arrangement.laneOrder = [...ids];
    }

    function restoreTrackHistory(entry, side) {
        if (entry.kind === 'track-order') {
            const order = entry[side];
            const known = new Set(order);
            const extra = engine.sequence.tracks.filter((track) => !known.has(track.id)).map((track) => track.id);
            engine.setMidiTrackOrder([...order, ...extra]);
        } else if (side === 'before') {
            engine.restoreMidiTrack(entry.record);
        } else {
            // Capture out-of-history renames and any current position for the next Undo.
            entry.record = engine.deleteMidiTrack(entry.record.track.id);
        }
        overlapIds = [];
        selectNote(null);
        syncEditorState();
        showStatus(`${side === 'before' ? 'Undo' : 'Redo'}: ${entry.kind === 'track-order' ? 'MIDI track order' : `track '${entry.record.track.name}' deletion`}.`);
    }

    function deleteTrack(id) {
        checkHistory();
        const record = engine.deleteMidiTrack(id);
        pushHistory({ kind: 'track-delete', record });
        overlapIds = [];
        selectNote(null);
        syncEditorState();
        showStatus(`Deleted track '${record.track.name}' and ${record.notes.length} notes. Undo restores it.`);
    }

    function recordEdit(before) {
        invalidateRenderIndex();
        checkHistory();
        const after = snapshotNotes();
        const ids = new Set([...before.keys(), ...after.keys()]);
        const changes = [...ids].filter((id) =>
            JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))
        ).map((id) => ({ before: before.get(id), after: after.get(id) }));
        if (changes.length) {
            pushHistory(changes);
        }
    }

    function restoreHistory(source, destination, side) {
        invalidateRenderIndex();
        cancelEditorGesture();
        checkHistory();
        const entry = source.at(-1);
        if (!entry) {
            return;
        }
        if (!Array.isArray(entry)) {
            if (entry.kind === 'audio-clip') {
                if (!arrangement.hooks.canEdit()) throw new Error('Pause or stop before changing audio clips.');
                if (workspaceMode === 'tracks') arrangement.hooks.clearMidiTrack();
                arrangement.restoreEdit(entry[side === 'before' ? 'after' : 'before'], entry[side]);
                showStatus(`${side === 'before' ? 'Undo' : 'Redo'} audio clip edit.`);
            } else if (entry.kind === 'arrangement-order') {
                setArrangementOrder(entry[side]);
                syncEditorState();
            } else {
                restoreTrackHistory(entry, side);
            }
            source.pop();
            destination.push(entry);
            return;
        }
        for (const change of entry) {
            if (change[side] && !engine.sequence.tracks.some((track) => track.id === change[side].trackId)) {
                throw new Error('History references a missing MIDI track; restore the track before its notes.');
            }
        }
        const changes = source.pop();
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
        const editableIds = new Set(editableNotes(true).map((note) => note.id));
        for (const change of changes) {
            if (change[side] && editableIds.has(change[side].id)) {
                selectedIds.add(change[side].id);
            }
        }
        const trackIds = new Set(changes.map((change) => (change[side] ?? change.before ?? change.after).trackId));
        const names = engine.sequence.tracks.filter((track) => trackIds.has(track.id)).map((track) => track.name);
        showStatus(`${side === 'before' ? 'Undo' : 'Redo'}: ${changes.length} note changes · ${names.join(', ')}`);
        selectedNoteId = [...selectedIds][0] ?? null;
        refreshNoteControls();
        syncEditorState();
    }

    function clipboardEdit(action) {
        if (workspaceMode !== 'piano') {
            return;
        }
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
                trackId: action === 'paste' && activeTrackId !== null ? activeTrackId : data.trackId,
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
    let latestMidiImportId = 0;
    let midiImportController = null;
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
    let unavailableSample = null;
    let databaseProject = null;
    let databaseSaveInFlight = false;
    let loadedInstrumentState = null;

    // Controls and selected-note details.
    function showStatus(text) {
        statusElement.textContent = text;
    }

    function databaseSnapshot() {
        return {
            ...engine.sequence.toJSON(),
            ...(engine.arrangement.assets.size || engine.arrangement.tracks.size
                ? { arrangement: engine.arrangement.toJSON() } : {}),
            instruments: {
                version: 1,
                synth: window.jukeboxSynth?.snapshot() ?? null,
                drums: window.jukeboxDrums?.snapshot() ?? null
            },
            loopStart: engine.loopStart,
            loopEnd: engine.loopEnd,
            sample: unavailableSample,
            mutedLanes: overviewTracks().filter((track) => engine.mutedLanes.has(track.id)).map((track) => track.id)
        };
    }

    async function saveDatabaseProject() {
        if (arrangement.deletingAsset) {
            showStatus('Wait for the sample deletion to finish.');
            return;
        }
        if (!databaseProject || databaseProject.role === 'VIEWER' || databaseSaveInFlight) {
            return;
        }
        databaseSaveInFlight = true;
        try {
            const response = await fetch(`/api/projects/${databaseProject.id}`, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: engine.sequence.name,
                    projectData: JSON.stringify(databaseSnapshot()),
                    version: databaseProject.version
                })
            });
            const body = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(body?.error || `Save failed (${response.status})`);
            }
            databaseProject.version = body.version;
            showStatus(`Saved "${engine.sequence.name}" to the database.`);
        } catch (error) {
            showStatus(`Save failed: ${error.message}`);
        } finally {
            databaseSaveInFlight = false;
        }
    }

    function applyDatabasePermissions() {
        if (databaseProject?.role !== 'VIEWER') {
            return;
        }
        pianoCanvas.style.pointerEvents = workspaceMode === 'tracks' ? '' : 'none';
        [
            'saveProject', 'bpm', 'timeSignature', 'loopStart', 'loopEnd', 'patternSteps', 'addBar',
            'removeBar', 'midiFile', 'newSequence', 'noteLength', 'lengthDecrease',
            'lengthIncrease', 'velocity', 'deleteNote', 'nextOverlap', 'pitchLow',
            'pitchHigh',
            'removeImportedMidi', 'addMidiTrack', 'renameMidiTrack', 'trackName',
            'deleteMidiTrack', 'undoNotes', 'redoNotes',
            'cutNotes', 'pasteNotes', 'duplicateNotes'
        ].forEach((id) => {
            const element = getElement(id);
            if (element) element.disabled = true;
        });

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
            'midiFile',
            'addMidiTrack',
            'renameMidiTrack'
        ]) {
            getElement(id).disabled = busy;
        }
        getElement('addMidiTrack').disabled = busy || engine.sequence.tracks.length >= 255;
        updateTrackActions();
        getElement('renameMidiTrack').disabled = busy || Boolean(trackGesture) || !activeTrack();
        getElement('trackName').disabled = busy || !activeTrack();
        bpmInput.disabled = engine.sequence.tempos.length > 1 || (busy && engine.arrangement.clips.size > 0);
        bpmInput.min = bpmInput.disabled ? '' : '40';
        bpmInput.max = bpmInput.disabled ? '' : '240';
        getElement('tempoInfo').textContent = engine.sequence.tempos.length > 1
            ? 'Imported tempo map active; BPM editing disabled.'
            : bpmInput.disabled ? 'Pause or stop before changing BPM with audio clips.'
            : 'BPM edits replace the constant tempo (40–240).';
        updateMeterControls(busy);
        arrangement.refreshInspector();
        applyDatabasePermissions();
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

    function resizePianoContent() {
        pianoSpacer.style.width = `${KEYBOARD_WIDTH + engine.totalSteps * STEP_WIDTH}px`;
        const contentHeight = workspaceMode === 'tracks' ? overviewTracks().length * TrackOverview.laneHeight
            : (highestPitch - lowestPitch + 1) * ROW_HEIGHT;
        pianoSpacer.style.height = `${RULER_HEIGHT + contentHeight}px`;
    }

    const zoomInput = getElement('zoom');
    const zoomPercentage = getElement('zoomPercentage');
    let zoomPercent = 100;
    let zoomTarget = zoomPercent;
    let pendingZoom = null;
    let pinchStartZoom = null;

    let zoomMin = 50;
    let zoomFit = null;

    function refreshZoomMinimum() {
        const sequence = engine.sequence;
        const width = Math.max(1, pianoViewport.clientWidth - KEYBOARD_WIDTH - 1);
        if (zoomFit?.sequence === sequence && zoomFit.meters === sequence.timeSignatures &&
            zoomFit.steps === engine.totalSteps && zoomFit.width === width) return;
        zoomFit = { sequence, meters: sequence.timeSignatures, steps: engine.totalSteps, width };
        const pixels = sequence.tickToStep(sequence.measureFitTicks(50)) * baseGeometry.stepWidth;
        const fit = 100 * width / pixels;
        zoomMin = Math.min(50, fit >= 0.01 ? Math.floor(fit * 100) / 100 : fit);
        zoomInput.min = String(zoomMin);
        zoomInput.title = `Minimum zoom: ${zoomLabel(zoomMin)}`;
        if (zoomTarget < zoomMin) queueZoom(zoomMin);
    }

    function zoomLabel(percent) {
        return `${Number(percent.toPrecision(4))}%`;
    }

    function queueZoom(percent, point = null) {
        zoomTarget = Math.max(zoomMin, Math.min(250, percent));
        pendingZoom = { point };
    }

    function applyPendingZoom() {
        const { point: pointer } = pendingZoom;
        pendingZoom = null;
        const percent = Math.max(zoomMin, zoomTarget < 50 ? Number(zoomTarget.toPrecision(4)) : Math.round(zoomTarget));
        if (zoomInput.value !== String(percent)) zoomInput.value = String(percent);
        if (percent === zoomPercent) return;
        cancelEditorGesture();
        const point = pointer ? canvasPoint(pointer) : null;
        const gridWidth = Math.max(0, pianoViewport.clientWidth - KEYBOARD_WIDTH);
        const gridHeight = Math.max(0, pianoViewport.clientHeight - RULER_HEIGHT);
        const anchorX = point ? Math.max(0, Math.min(gridWidth, point.x - KEYBOARD_WIDTH)) : gridWidth / 2;
        const anchorY = point && workspaceMode === 'piano'
            ? Math.max(0, Math.min(gridHeight, point.y - RULER_HEIGHT)) : gridHeight / 2;
        const anchorStep = Math.min(engine.totalSteps, (pianoViewport.scrollLeft + anchorX) / STEP_WIDTH);
        const pitchScroll = workspaceMode === 'piano' ? pianoViewport.scrollTop : pianoScrollTop;
        const pitchCount = highestPitch - lowestPitch + 1;
        const anchorRow = Math.min(pitchCount, (pitchScroll + anchorY) / ROW_HEIGHT);

        zoomPercent = percent;
        STEP_WIDTH = PianoRollEditor.geometry.stepWidth = baseGeometry.stepWidth * percent / 100;
        ROW_HEIGHT = PianoRollEditor.geometry.rowHeight = baseGeometry.rowHeight * Math.max(50, percent) / 100;
        zoomInput.setAttribute('aria-valuetext', zoomLabel(percent));
        zoomPercentage.textContent = zoomLabel(percent);
        resizePianoContent();
        playbackFollow.interrupt();
        scrollHorizontally(anchorStep * STEP_WIDTH - anchorX);
        const maxTop = Math.max(0, RULER_HEIGHT + pitchCount * ROW_HEIGHT - pianoViewport.clientHeight);
        pianoScrollTop = Math.min(maxTop, Math.max(0, anchorRow * ROW_HEIGHT - anchorY));
        if (workspaceMode === 'piano') pianoViewport.scrollTop = pianoScrollTop;
        pendingViewportRender = true;
    }

    function zoomPointer(event) {
        const { clientX, clientY } = event;
        return Number.isFinite(clientX) && Number.isFinite(clientY) ? { clientX, clientY } : null;
    }

    function zoomFromWheel(event, point = null) {
        // Line-mode wheels typically send three lines per notch. Pixel-mode
        // trackpads send many smaller events, so retain fractional changes.
        const { deltaMode, deltaY } = event;
        if (!Number.isFinite(deltaY) || deltaY === 0) return false;
        event.preventDefault();
        if (pinchStartZoom === null) {
            const units = deltaMode === 1 ? 3 : deltaMode === 2 ? 1 : 100;
            const delta = Math.max(-40, Math.min(40, deltaY * 35 / units));
            queueZoom(zoomTarget - delta * (zoomTarget < 50 ? zoomTarget / 50 : 1), point);
        }
        return true;
    }

    zoomInput.value = String(zoomPercent);
    zoomInput.oninput = () => queueZoom(Number(zoomInput.value));
    getElement('resetZoom').onclick = () => queueZoom(100);
    getElement('zoomControl').addEventListener('wheel', (event) => zoomFromWheel(event), { passive: false });

    function syncEditorState() {
        invalidateRenderIndex();
        syncTrackControls();
        syncEditingCursor();
        getElement('patternSteps').value = engine.totalSteps;
        loopStartInput.max = loopEndInput.max = engine.totalSteps;
        loopStartInput.value = engine.loopStart + 1;
        loopEndInput.value = engine.loopEnd;
        bpmInput.value = engine.bpm;
        resizePianoContent();
        updateTransportControls();
        updateSnapInfo();
        updateCompositionSummary();
        refreshNoteControls();
        applyDatabasePermissions();
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
            getElement('noteLength').value = PianoRollEditor.formatDuration(engine.sequence, newNoteDurationTicks());
            getElement('velocity').value = newNoteVelocity;
            getElement('noteInfo').textContent =
                `${activeTrack()?.name ?? 'All Notes'} view. New notes use ${creationTrackName()}. ` +
                'Click a note to select; Shift-click toggles. An empty click clears selection, or creates a note if none are selected. Drag empty space to select, a body to move, or an edge to resize. Drag the ruler to position the cursor. Escape cancels.';
            return;
        }
        if (preview?.deleteNote) {
            getElement('noteLength').value = PianoRollEditor.formatDuration(engine.sequence, note.durationTicks);
            getElement('noteInfo').textContent =
                'Release to delete this note. Drag back to keep resizing; Escape cancels.';
            return;
        }
        const ticks = preview?.ticks ?? note.ticks;
        const durationTicks = preview?.durationTicks ?? note.durationTicks;
        const track = engine.sequence.tracks.find((candidate) => candidate.id === note.trackId);
        lengthInput.value = mixed ? '' : PianoRollEditor.formatDuration(engine.sequence, durationTicks);
        lengthInput.placeholder = mixed ? 'Mixed' : '';
        getElement('velocity').value = note.velocityMidi;
        getElement('noteInfo').textContent =
            `${NoteSequence.pitchName(preview?.midi ?? note.midi)} · ` +
            `${track?.name ?? note.trackId} (channel ${(track?.channel ?? 0) + 1}) · ` +
            `${note.id} · start ${ticks}, duration ${durationTicks} ticks at ${engine.sequence.ppq} PPQ` +
            (note.importId ? ' · imported' : ' · manual') +
            (preview?.limited
                ? ' · extend the pattern to resize'
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

    function findNotes(notes = workspaceMode === 'tracks'
        ? PianoRollEditor.eligibleNotes(engine.sequence) : editableNotes(true)) {
        if (!notes.length) {
            showStatus('No notes to find. Add a note or import MIDI.');
            return;
        }
        if (workspaceMode === 'tracks') {
            const first = notes.reduce((earliest, note) => note.ticks < earliest.ticks ? note : earliest);
            scrollHorizontally(engine.sequence.tickToStep(first.ticks) * STEP_WIDTH - 2 * STEP_WIDTH);
            const index = engine.sequence.tracks.findIndex((track) => track.id === first.trackId);
            const gridHeight = Math.max(0, pianoViewport.clientHeight - RULER_HEIGHT);
            const maxTop = Math.max(0, engine.sequence.tracks.length * TrackOverview.laneHeight - gridHeight);
            pianoViewport.scrollTop = Math.max(0, Math.min(maxTop, index * TrackOverview.laneHeight));
            renderPianoRoll();
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
    }

    getElement('findNotes').onclick = () => findNotes();

    // Canvas rendering: keep the original layer order and drawing state.
    function renderPianoRoll() {
        pendingViewportRender = false;
        refreshZoomMinimum();
        const width = pianoViewport.clientWidth;
        const height = pianoViewport.clientHeight;
        const scrollLeft = pianoViewport.scrollLeft;
        const scrollTop = pianoViewport.scrollTop;
        prepareCanvas(width, height);
        let noteRects = [];
        const first = Math.max(0, Math.floor(scrollLeft / STEP_WIDTH));
        const endStep = Math.min(engine.totalSteps, (scrollLeft + Math.max(0, width - KEYBOARD_WIDTH)) / STEP_WIDTH);
        const last = Math.ceil(endStep);
        const sequence = engine.sequence;
        const meterMarks = [...sequence.meterMarks(sequence.stepToTick(scrollLeft / STEP_WIDTH),
            sequence.stepToTick(endStep), sequence.stepToTick(4 / STEP_WIDTH))].filter((mark) => STEP_WIDTH >= 4 || mark.kind === 'measure');

        if (workspaceMode === 'tracks') {
            noteRects = drawTrackOverview(width, height, first, last, scrollLeft, scrollTop, meterMarks);
        } else {
            if (muteButtons.size) renderMuteControls([], height, scrollTop);
            drawPitchRows(width, height, scrollTop);
            drawTimingGrid(first, last, height, scrollLeft, meterMarks);
            drawLoopRegion(width, height, scrollLeft);
            noteRects = drawNoteBlocks(width, height, scrollLeft, scrollTop);
        }
        if (editGesture?.kind === 'marquee' && editGesture.moved) {
            const a = editGesture.start;
            const b = editGesture.point;
            drawingContext.strokeStyle = ROLL.marquee;
            drawingContext.fillStyle = ROLL.marqueeFill;
            const x = Math.min(a.x, b.x) - scrollLeft;
            const y = Math.min(a.y, b.y) - scrollTop;
            drawingContext.fillRect(x, y, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
            drawingContext.strokeRect(x, y, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
        }
        if (workspaceMode === 'piano') {
            drawPianoKeys(height, scrollTop);
        }
        drawMeasureRuler(first, last, width, scrollLeft, meterMarks);
        const cursorX = KEYBOARD_WIDTH + engine.sequence.tickToStep(editingCursorTick) * STEP_WIDTH - scrollLeft;
        if (cursorX >= KEYBOARD_WIDTH && cursorX <= width) {
            drawingContext.fillStyle = ROLL.cursor;
            drawingContext.fillRect(cursorX, 0, 2, height);
            drawingContext.beginPath();
            drawingContext.moveTo(cursorX - 5, 0);
            drawingContext.lineTo(cursorX + 7, 0);
            drawingContext.lineTo(cursorX + 1, 8);
            drawingContext.fill();
        }
        // Lets the contour overlay (index.html) highlight the area under each note.
        const highlightKey = JSON.stringify(noteRects);
        if (highlightKey !== lastHighlightKey) {
            lastHighlightKey = highlightKey;
            document.dispatchEvent(new CustomEvent('jukebox:notes', { detail: noteRects }));
        }
    }

    function prepareCanvas(width, height) {
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
        drawingContext.fillStyle = ROLL.bg;
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
            drawingContext.fillStyle = isBlackKey ? ROLL.rowSharp : ROLL.bg;
            drawingContext.fillRect(KEYBOARD_WIDTH, y, width - KEYBOARD_WIDTH, ROW_HEIGHT);
            drawingContext.strokeStyle = ROLL.rowLine;
            drawingContext.beginPath();
            drawingContext.moveTo(KEYBOARD_WIDTH, y + ROW_HEIGHT);
            drawingContext.lineTo(width, y + ROW_HEIGHT);
            drawingContext.stroke();
        }
    }

    function drawTimingGrid(first, last, height, scrollLeft, meterMarks) {
        function drawLine(x, color, weight) {
            if (x < KEYBOARD_WIDTH) return;
            drawingContext.strokeStyle = color;
            drawingContext.lineWidth = weight;
            drawingContext.beginPath();
            drawingContext.moveTo(x, RULER_HEIGHT);
            drawingContext.lineTo(x, height);
            drawingContext.stroke();
        }

        const subdivision = snapMode === 'thirty-second' ? 0.5 : 1;
        drawingContext.strokeStyle = ROLL.rowLine;
        drawingContext.lineWidth = 1;
        drawingContext.beginPath();
        for (let step = first; STEP_WIDTH * subdivision >= 5 && step <= last; step += subdivision) {
            const x = KEYBOARD_WIDTH + step * STEP_WIDTH - scrollLeft;
            if (x < KEYBOARD_WIDTH) continue;
            drawingContext.moveTo(x, RULER_HEIGHT);
            drawingContext.lineTo(x, height);
        }
        drawingContext.stroke();
        for (const mark of meterMarks) {
            const x = KEYBOARD_WIDTH + engine.sequence.tickToStep(mark.ticks) * STEP_WIDTH - scrollLeft;
            const weight = mark.kind === 'measure' ? 2 : mark.kind === 'group' ? 1.5 : 1;
            drawLine(x, mark.kind === 'subdivision' ? ROLL.rowLine : ROLL.beatLine, weight);
        }
        drawingContext.lineWidth = 1;
    }

    function drawLoopRegion(width, height, scrollLeft) {
        const loopX = KEYBOARD_WIDTH + engine.loopStart * STEP_WIDTH - scrollLeft;
        const loopEndX = KEYBOARD_WIDTH + engine.loopEnd * STEP_WIDTH - scrollLeft;
        drawingContext.fillStyle = ROLL.loopShade;
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
        // Paint ghosts first, then editable notes, with the primary selection last for resize handles.
        // Returns the editable notes' rectangles in scrolled-content coordinates.
        const noteRects = [];
        drawingContext.save();
        drawingContext.beginPath();
        drawingContext.rect(
            KEYBOARD_WIDTH,
            RULER_HEIGHT,
            width - KEYBOARD_WIDTH,
            height - RULER_HEIGHT
        );
        drawingContext.clip();
        const drawBlock = (note, preview, selected) => {
            if (note.midi < lowestPitch || note.midi > highestPitch) {
                return;
            }
            const startStep = preview ? engine.sequence.tickToStep(preview.ticks) : note.startStep;
            const durationSteps = preview
                ? engine.sequence.tickToStep(preview.durationTicks)
                : note.durationSteps;
            const x = KEYBOARD_WIDTH + startStep * STEP_WIDTH - scrollLeft;
            const y = RULER_HEIGHT + (highestPitch - (preview?.midi ?? note.midi)) * ROW_HEIGHT - scrollTop;
            const displayWidth = Math.max(8, durationSteps * STEP_WIDTH);
            if (
                x + displayWidth < KEYBOARD_WIDTH ||
                x > width ||
                y + ROW_HEIGHT < RULER_HEIGHT ||
                y > height
            ) {
                return;
            }
            drawingContext.fillStyle = preview?.deleteNote
                ? ROLL.noteDelete
                : selected
                  ? ROLL.noteSelected
                  : noteColor(note.trackId);
            // Note rectangle: 1px gap inside the row (was y + 3 / ROW_HEIGHT - 6).
            // The fill, outline, grips and the contour highlight all follow it.
            const block = { x: x + 1, y: y + 1, width: Math.max(6, displayWidth - 2), height: ROW_HEIGHT - 2 };
            drawingContext.fillRect(block.x, block.y, block.width, block.height);
            drawingContext.strokeStyle = ROLL.noteOutline;
            // outline and selection grips follow `block`, so resizing the block above resizes them too
            drawingContext.strokeRect(block.x, block.y, block.width, block.height);
            if (selected) {
                const gripInset = 1;   // gap between the grips and the top/bottom of the block
                drawingContext.fillStyle = ROLL.grip;
                drawingContext.fillRect(block.x + 1, block.y + gripInset, 3, block.height - 2 * gripInset);
                drawingContext.fillRect(block.x + block.width - 4, block.y + gripInset, 3, block.height - 2 * gripInset);
            }
            return block;
        };
        const visible = visibleRenderNotes(width, height, scrollLeft, scrollTop);
        const tracks = new Map(engine.sequence.tracks.map((track) => [track.id, track]));
        const eligibleTrack = (note) => {
            const track = tracks.get(note.trackId);
            return track && !track.hidden && track.visible !== false;
        };
        if (activeTrackId !== null && ghostNotesEnabled) {
            drawingContext.globalAlpha = 0.22;
            for (const note of visible) {
                if (eligibleTrack(note) && note.trackId !== activeTrackId) drawBlock(note, null, false);
            }
            drawingContext.globalAlpha = 1;
        }
        const eligible = visible.filter((note) => eligibleTrack(note) &&
            (activeTrackId === null || note.trackId === activeTrackId));
        // An originally offscreen selected note can move into view during a preview.
        const visibleIds = new Set(eligible.map((note) => note.id));
        const previewIds = new Set([...(editGesture?.previews?.keys() ?? []),
            ...(resizeGesture?.previews?.keys() ?? []), ...(resizeGesture?.noteId ? [resizeGesture.noteId] : [])]);
        for (const id of previewIds) {
            const note = getRenderIndex().byId.get(id);
            if (note && !visibleIds.has(id) && eligibleTrack(note) &&
                (activeTrackId === null || note.trackId === activeTrackId)) eligible.push(note);
        }
        const notes = eligible.filter((note) => note.id !== selectedNoteId);
        const selected = eligible.find((note) => note.id === selectedNoteId);
        if (selected) {
            notes.push(selected);
        }
        for (const note of notes) {
            const preview = editGesture?.previews?.get(note.id) ?? resizeGesture?.previews?.get(note.id) ??
                (resizeGesture?.noteId === note.id ? resizeGesture.preview : null);
            const block = drawBlock(note, preview, selectedIds.has(note.id));
            if (!block) {
                continue;
            }
            // Visible part of the block (not under the keyboard or ruler), in
            // scrolled-content coordinates instead of canvas coordinates.
            const left = Math.max(block.x, KEYBOARD_WIDTH);
            const top = Math.max(block.y, RULER_HEIGHT);
            const right = Math.min(width, block.x + block.width);
            const bottom = Math.min(height, block.y + block.height);
            if (right > left && bottom > top) {
                noteRects.push({ x: left + scrollLeft, y: top + scrollTop, width: right - left, height: bottom - top });
            }
        }
        drawPlaybackLine(height, scrollLeft);
        drawingContext.restore();
        return noteRects;
    }

    function drawPlaybackLine(height, scrollLeft) {
        if (displayedStep !== null) {
            const x = KEYBOARD_WIDTH + displayedStep * STEP_WIDTH - scrollLeft;
            drawingContext.fillStyle = ROLL.playback;
            drawingContext.fillRect(x, RULER_HEIGHT, 2, height);
        }
    }

    const muteControls = getElement('laneMuteControls');
    const muteButtons = new Map();

    function renderMuteControls(lanes, height, scrollTop) {
        const kept = new Set();
        for (const lane of lanes) {
            const { track, index } = lane;
            const top = RULER_HEIGHT + index * TrackOverview.laneHeight - scrollTop + TrackOverview.laneHeight - 28;
            if (top < RULER_HEIGHT || top + 24 > height) continue;
            kept.add(track.id);
            let button = muteButtons.get(track.id);
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.className = 'lane-mute';
                button.onclick = () => {
                    if (databaseProject?.role === 'VIEWER') return;
                    engine.setLaneMuted(track.id, !engine.mutedLanes.has(track.id));
                    renderPianoRoll();
                };
                muteButtons.set(track.id, button);
                muteControls.append(button);
            }
            const muted = engine.mutedLanes.has(track.id);
            button.disabled = databaseProject?.role === 'VIEWER';
            button.style.top = `${top}px`;
            const label = `Mute ${track.name}`;
            if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
            if (button.getAttribute('aria-pressed') !== String(muted)) {
                button.setAttribute('aria-pressed', String(muted));
                button.textContent = muted ? '🔇' : '🔊';
            }
            button.title = `${muted ? 'Unmute' : 'Mute'} ${track.name}`;
        }
        for (const [id, button] of muteButtons) {
            if (kept.has(id)) continue;
            button.remove();
            muteButtons.delete(id);
        }
    }

    function drawTrackOverview(width, height, first, last, scrollLeft, scrollTop, meterMarks) {
        getRenderIndex();
        const lanes = renderLanes;
        const visible = lanes.filter((lane) => {
            const y = RULER_HEIGHT + lane.index * TrackOverview.laneHeight - scrollTop;
            return y + TrackOverview.laneHeight > RULER_HEIGHT && y < height;
        });
        renderMuteControls(visible, height, scrollTop);
        for (const lane of visible) {
            const y = RULER_HEIGHT + lane.index * TrackOverview.laneHeight - scrollTop;
            drawingContext.fillStyle = lane.track.id === (activeTrackId ?? arrangement.trackId) ? ROLL.laneActive : lane.index % 2 ? ROLL.laneAlt : ROLL.bg;
            drawingContext.fillRect(KEYBOARD_WIDTH, y, width - KEYBOARD_WIDTH, TrackOverview.laneHeight - 1);
        }
        drawTimingGrid(first, last, height, scrollLeft, meterMarks);
        drawLoopRegion(width, height, scrollLeft);
        drawingContext.save();
        drawingContext.beginPath();
        drawingContext.rect(KEYBOARD_WIDTH, RULER_HEIGHT, width - KEYBOARD_WIDTH, height - RULER_HEIGHT);
        drawingContext.clip();
        const visibleByTrack = new Map(visible.map((lane) => [lane.track.id, []]));
        for (const note of visibleRenderNotes(width, height, scrollLeft, scrollTop, true)) {
            visibleByTrack.get(note.trackId)?.push(note);
        }
        const sequence = engine.sequence;
        const clipsByLane = new Map(visible.filter((lane) => lane.track.audio).map((lane) => [lane.track.id, []]));
        const clipMasks = [];
        if (clipsByLane.size) {
            const from = sequence.stepToTick((scrollLeft - 8) / STEP_WIDTH);
            const to = sequence.stepToTick((scrollLeft + width - KEYBOARD_WIDTH) / STEP_WIDTH);
            for (const entry of engine.arrangement.query(sequence, from, to, true)) {
                clipsByLane.get(entry.clip.trackId)?.push(entry);
            }
        }
        for (const lane of visible) {
            const muted = engine.mutedLanes.has(lane.track.id);
            drawingContext.globalAlpha = muted ? 0.55 : 1;
            if (lane.track.audio) {
                arrangement.draw(drawingContext, lane, { width, height, scrollLeft, scrollTop, clipsByLane, clipMasks });
                continue;
            }
            drawingContext.fillStyle = noteColor(lane.track.id);
            drawingContext.globalAlpha = lane.track.hidden || lane.track.visible === false ? 0.35 : muted ? 0.55 : 1;
            for (const note of visibleByTrack.get(lane.track.id)) {
                const bounds = TrackOverview.rectangle(note, lane, engine.sequence, { scrollLeft, scrollTop });
                if (bounds.x + Math.max(2, bounds.width) < KEYBOARD_WIDTH || bounds.x > width) {
                    continue;
                }
                drawingContext.fillRect(bounds.x, bounds.y, Math.max(2, bounds.width), bounds.height);
            }
        }
        drawingContext.globalAlpha = 1;
        drawPlaybackLine(height, scrollLeft);
        drawingContext.restore();
        // Sticky lane headers mirror the existing frozen keyboard column.
        drawingContext.save();
        drawingContext.beginPath();
        drawingContext.rect(0, RULER_HEIGHT, KEYBOARD_WIDTH, height - RULER_HEIGHT);
        drawingContext.clip();
        drawingContext.font = '12px system-ui';
        drawingContext.textAlign = 'left';
        for (const lane of visible) {
            const y = RULER_HEIGHT + lane.index * TrackOverview.laneHeight - scrollTop;
            drawingContext.fillStyle = lane.track.id === (activeTrackId ?? arrangement.trackId) ? ROLL.laneHeaderActive : ROLL.laneHeader;
            drawingContext.fillRect(0, y, KEYBOARD_WIDTH, TrackOverview.laneHeight - 1);
            drawingContext.fillStyle = noteColor(lane.track.id);
            drawingContext.fillRect(0, y, 5, TrackOverview.laneHeight - 1);
            drawingContext.fillStyle = ROLL.text;
            const label = lane.track.name.length > 10 ? lane.track.name.slice(0, 9) + '…' : lane.track.name;
            for (const x of [10, 16]) {
                for (const offset of [24, 30, 36]) {
                    drawingContext.fillRect(x, y + offset, 2, 2);
                }
            }
            drawingContext.fillText(label, 28, y + 28, 69);
            const count = lane.track.audio ? engine.arrangement.getIndex(sequence).counts.get(lane.track.id) ?? 0 : lane.notes.length;
            const noun = lane.track.audio ? 'clip' : 'note';
            drawingContext.fillText(`${count} ${noun}${count === 1 ? '' : 's'}`, 28, y + 48);
        }
        drawingContext.restore();
        if (trackGesture) {
            const y = RULER_HEIGHT + trackGesture.fromIndex * TrackOverview.laneHeight - scrollTop;
            drawingContext.fillStyle = ROLL.marqueeFill;
            drawingContext.fillRect(0, Math.max(RULER_HEIGHT, y), width,
                Math.max(0, Math.min(height, y + TrackOverview.laneHeight) - Math.max(RULER_HEIGHT, y)));
            if (trackGesture.valid) {
                const line = RULER_HEIGHT + trackGesture.boundary * TrackOverview.laneHeight - scrollTop;
                if (line >= RULER_HEIGHT && line <= height) {
                    drawingContext.fillStyle = ROLL.marquee;
                    drawingContext.fillRect(0, line, width, 3);
                }
            }
        }
        const destination = arrangement.dropPreview;
        if (destination && !destination.trackId) {
            const index = destination.below ? lanes.findIndex(({ track }) => track.id === destination.below) + 1 : lanes.length;
            const y = Math.max(RULER_HEIGHT, Math.min(height - 4,
                RULER_HEIGHT + index * TrackOverview.laneHeight - scrollTop));
            const x = Math.max(KEYBOARD_WIDTH, KEYBOARD_WIDTH + sequence.tickToStep(destination.startTick) * STEP_WIDTH - scrollLeft);
            drawingContext.fillStyle = ROLL.marquee;
            drawingContext.fillRect(KEYBOARD_WIDTH, y, width - KEYBOARD_WIDTH, 3);
            drawingContext.fillRect(x, y - 8, 3, 11);
        }
        return clipMasks;
    }

    function drawPianoKeys(height, scrollTop) {
        // Sticky keyboard and ruler are drawn last.
        drawingContext.fillStyle = ROLL.keyWhite;
        drawingContext.fillRect(0, RULER_HEIGHT, KEYBOARD_WIDTH, height);
        drawingContext.font = `${Math.min(11, ROW_HEIGHT - 2)}px system-ui`;
        drawingContext.textAlign = 'right';
        for (
            let row = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
            row <=
            Math.min(highestPitch - lowestPitch, Math.ceil((scrollTop + height) / ROW_HEIGHT));
            row++
        ) {
            const midi = highestPitch - row;
            const y = RULER_HEIGHT + row * ROW_HEIGHT - scrollTop;
            const isBlackKey = [1, 3, 6, 8, 10].includes(midi % 12);
            drawingContext.fillStyle = isBlackKey ? ROLL.keyBlack : ROLL.keyWhite;
            drawingContext.fillRect(0, y, KEYBOARD_WIDTH, ROW_HEIGHT - 1);
            drawingContext.fillStyle = isBlackKey ? ROLL.keyLabelOnBlack : ROLL.keyLabel;
            drawingContext.fillText(NoteSequence.pitchName(midi), KEYBOARD_WIDTH - 8, y + ROW_HEIGHT / 2 + 4);
        }
    }

    function drawMeasureRuler(first, last, width, scrollLeft, meterMarks) {
        drawingContext.fillStyle = ROLL.rulerBg;
        drawingContext.fillRect(0, 0, width, RULER_HEIGHT);
        drawingContext.textAlign = 'left';
        drawingContext.font = '11px system-ui';
        drawingContext.fillStyle = ROLL.text;
        drawingContext.fillText(workspaceMode === 'tracks' ? 'Tracks / Time' : 'Pitch / Measure', 4, 20);
        const bars = meterMarks.filter((mark) => mark.kind === 'measure');
        if (STEP_WIDTH < 18) first = last;
        let barIndex = 0;
        let labelEnd = KEYBOARD_WIDTH;
        for (let step = first; step < last || barIndex < bars.length;) {
            const bar = bars[barIndex];
            const barStep = bar ? engine.sequence.tickToStep(bar.ticks) : Infinity;
            const isBar = barStep <= step || step >= last;
            const x = KEYBOARD_WIDTH + (isBar ? barStep : step) * STEP_WIDTH - scrollLeft;
            const label = isBar ? `M${bar.measure}` : String(step + 1);
            if (isBar) {
                barIndex++;
                if (barStep === step) step++;
            } else {
                step++;
            }
            const labelWidth = 7 * label.length + 5;
            const nextBarX = KEYBOARD_WIDTH + barStep * STEP_WIDTH - scrollLeft;
            if (x + 1e-8 >= labelEnd && x + 3 < width && (isBar || x + labelWidth <= nextBarX)) {
                drawingContext.fillText(label, x + 3, 20);
                labelEnd = x + labelWidth;
            }
        }
    }

    function noteColor(trackId) {
        return TrackOverview.color(trackId);
    }

    function canvasPoint(event) {
        const bounds = pianoCanvas.getBoundingClientRect();
        // Pointer events use CSS pixels; the canvas transform alone handles device pixel ratio.
        return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    }

    function candidatesAt(point) {
        if (point.x < KEYBOARD_WIDTH || point.y < RULER_HEIGHT) return [];
        const view = currentView();
        const pitch = highestPitch - Math.floor((point.y + view.scrollTop - RULER_HEIGHT) / ROW_HEIGHT);
        if (pitch < lowestPitch || pitch > highestPitch) return [];
        const sequence = engine.sequence;
        const tracks = new Set(sequence.tracks.filter((track) => !track.hidden && track.visible !== false &&
            (activeTrackId === null || activeTrackId === track.id)).map((track) => track.id));
        const contentX = point.x + view.scrollLeft - KEYBOARD_WIDTH;
        const notes = getRenderIndex().query(sequence.stepToTick((contentX - 8) / STEP_WIDTH),
            sequence.stepToTick(contentX / STEP_WIDTH), pitch, pitch, (note) => tracks.has(note.trackId));
        return PianoRollEditor.notesAtPoint(notes, point, view);
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
        if (point.y < RULER_HEIGHT || (workspaceMode === 'piano' && point.x < KEYBOARD_WIDTH)) {
            return;
        }
        if (workspaceMode === 'tracks') {
            const track = overviewTrackAt(point);
            if (track?.audio) {
                arrangement.hooks.clearMidiTrack();
                const hit = arrangement.clipAt(point, track);
                arrangement.select(track.id, hit?.clip.id, event.shiftKey && Boolean(hit));
                updateTrackActions();
            } else if (track) {
                arrangement.select(null);
                setWorkspace('tracks', track.id);
            } else {
                arrangement.select(null);
            }
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
                const ticks = PianoRollEditor.snappedTicks(engine.sequence, step, snapMode, true);
                const durationTicks = newNoteDurationTicks();
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
                    trackId: activeTrackId ?? engine.sequence.ensurePianoTrack()
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
        const ids = new Set(selectedNotes().map((note) => note.id));
        engine.sequence.notes = engine.sequence.notes.filter((note) => !ids.has(note.id));
        overlapIds = overlapIds.filter((id) => !ids.has(id));
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

    function newNoteDurationTicks() {
        return Math.max(1, Math.round(engine.sequence.stepToTick(newNoteLengthSteps)));
    }

    function dragThreshold() {
        return snapMode === 'free' ? Math.min(3, STEP_WIDTH * engine.sequence.tickToStep(0.5)) : 3;
    }

    function updateSnapInfo() {
        const info = getElement('snapInfo');
        const interval = PianoRollEditor.snapInterval(snapMode);
        info.hidden = !interval || Number.isInteger(engine.sequence.stepToTick(interval));
        info.textContent = info.hidden ? '' : `${engine.sequence.ppq} PPQ: grid positions round to the nearest MIDI tick.`;
    }

    getElement('noteSnap').onchange = (event) => {
        cancelEditorGesture();
        snapMode = event.target.value;
        updateSnapInfo();
        renderPianoRoll();
    };

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
                const durationTicks = newNoteDurationTicks();
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
        if (Math.abs(distance) < dragThreshold() && !resizeGesture.moved) {
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
                resizeGesture.previews = PianoRollEditor.resizedGroup(sequence, originals, requested, snapMode);
                resizeGesture.preview = resizeGesture.previews.get(resizeGesture.noteId);
            } else {
                resizeGesture.preview = PianoRollEditor.resizedTiming(
                    engine.sequence,
                    resizeGesture.original,
                    resizeGesture.edge,
                    step,
                    pointerStep,
                    snapMode
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
        if (gesture.moved && gesture.preview) {
        }
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
        arrangement.cancelGesture();
        if (trackGesture) {
            const pointerId = trackGesture.pointerId;
            trackGesture = null;
            suppressResizeClick = true;
            releasePointer(pointerId);
            updateTrackActions();
            renderPianoRoll();
        }
        if (cursorGesture) {
            const gesture = cursorGesture;
            cursorGesture = null;
            suppressResizeClick = true;
            if (engine.isPaused && gesture.originalPausedTick !== null) {
                engine.seekPaused(gesture.originalPausedTick);
                displayedStep = engine.sequence.tickToStep(engine.getPlaybackTick());
            }
            setEditingCursor(gesture.originalTick, false);
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
        if (resizeGesture?.pointerId === event.pointerId || cursorGesture?.pointerId === event.pointerId || trackGesture?.pointerId === event.pointerId) {
            cancelEditorGesture();
        }
    }

    function contentPoint(event) {
        const point = canvasPoint(event);
        return { x: point.x + pianoViewport.scrollLeft, y: point.y + pianoViewport.scrollTop };
    }

    function moveTrackGesture(event) {
        trackGesture.clientX = event.clientX;
        trackGesture.clientY = event.clientY;
        const point = canvasPoint(event);
        const drop = TrackOverview.dropPosition(point.y, pianoViewport.scrollTop,
            overviewTracks().length, trackGesture.fromIndex);
        trackGesture.boundary = drop.boundary;
        trackGesture.toIndex = drop.index;
        trackGesture.valid = point.y >= RULER_HEIGHT && point.y <= pianoViewport.clientHeight &&
            point.x >= 0 && point.x <= pianoViewport.clientWidth;
        renderPianoRoll();
    }

    function updateTrackDragScroll(timestamp) {
        if (!trackGesture) {
            return false;
        }
        const bounds = pianoCanvas.getBoundingClientRect();
        const y = trackGesture.clientY - bounds.top;
        const elapsed = trackGesture.lastFrameTime === null ? 16 : Math.min(50, Math.max(0, timestamp - trackGesture.lastFrameTime));
        trackGesture.lastFrameTime = timestamp;
        const direction = y < RULER_HEIGHT + 24 ? -1 : y > pianoViewport.clientHeight - 24 ? 1 : 0;
        const maximum = Math.max(0, RULER_HEIGHT + overviewTracks().length * TrackOverview.laneHeight - pianoViewport.clientHeight);
        const top = Math.max(0, Math.min(maximum, pianoViewport.scrollTop + direction * elapsed * 0.6));
        if (top === pianoViewport.scrollTop) {
            return false;
        }
        pianoViewport.scrollTop = top;
        // Place the viewport canvas first, then recompute the captured screen coordinate.
        renderPianoRoll();
        moveTrackGesture(trackGesture);
        return true;
    }

    function beginGesture(event) {
        if (editGesture || resizeGesture || cursorGesture || trackGesture || arrangement.gesture || event.button !== 0) {
            return;
        }
        arrangement.selectRackAsset(null);
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
        if (workspaceMode === 'tracks') {
            const tracks = overviewTracks();
            const index = TrackOverview.laneAt(initialPoint, pianoViewport.scrollTop, tracks.length);
            if (index >= 0 && initialPoint.x >= 6 && initialPoint.x < 24 && databaseProject?.role !== 'VIEWER') {
                trackGesture = {
                    pointerId: event.pointerId,
                    sequence: engine.sequence,
                    id: tracks[index].id,
                    fromIndex: index,
                    toIndex: index,
                    boundary: index,
                    valid: true,
                    order: tracks.map((track) => track.id),
                    clientX: event.clientX,
                    clientY: event.clientY,
                    lastFrameTime: null
                };
                suppressTrackOpen = true;
                suppressResizeClick = true;
                pianoCanvas.setPointerCapture(event.pointerId);
                pianoCanvas.style.cursor = 'grabbing';
                playbackFollow.interrupt();
                updateTrackActions();
                event.preventDefault();
                moveTrackGesture(event);
            } else {
                suppressTrackOpen = false;
                suppressResizeClick = false;
                if (tracks[index]?.audio && initialPoint.x >= KEYBOARD_WIDTH) {
                    arrangement.begin(event, initialPoint, tracks[index]);
                    suppressResizeClick = true;
                    updateTrackActions();
                }
            }
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
        if (arrangement.gesture) { arrangement.move(event); return; }
        if (trackGesture) {
            if (trackGesture.pointerId === event.pointerId) {
                moveTrackGesture(event);
            }
            return;
        }
        if (cursorGesture) {
            if (cursorGesture.pointerId === event.pointerId) {
                moveCursor(event);
            }
            return;
        }
        if (!editGesture) {
            if (workspaceMode === 'tracks') {
                const point = canvasPoint(event);
                const lane = overviewTrackAt(point);
                const hit = lane?.audio && arrangement.clipAt(point, lane);
                pianoCanvas.style.cursor = hit && arrangement.razor && arrangement.hooks.canEdit() ? 'crosshair'
                    : hit ? 'move' : lane && point.x >= 6 && point.x < 24 ? 'grab' : 'pointer';
                pianoCanvas.title = lane ? lane.name : '';
                return;
            }
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
        if (!gesture.moved && Math.hypot(dx, dy) < (gesture.kind === 'marquee' ? 3 : dragThreshold())) {
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
            gesture.previews = PianoRollEditor.movedNotes(engine.sequence, notes, dx, dy, snapMode);
            if (!gesture.previews) {
                showStatus('Extend the pattern before moving notes with tails beyond its end.');
            }
        }
        refreshNoteControls(gesture.previews?.get(selectedNoteId));
        renderPianoRoll();
    }

    function finishGesture(event) {
        if (arrangement.gesture) {
            if (arrangement.gesture.pointerId === event.pointerId) {
                arrangement.finish(event);
                suppressResizeClick = true;
            }
            return;
        }
        if (trackGesture) {
            if (trackGesture.pointerId !== event.pointerId) {
                return;
            }
            moveTrackGesture(event);
            const gesture = trackGesture;
            trackGesture = null;
            suppressResizeClick = true;
            releasePointer(event.pointerId);
            const tracks = overviewTracks();
            const unchanged = gesture.sequence === engine.sequence &&
                gesture.order.length === tracks.length && gesture.order.every((id, index) => id === tracks[index].id);
            if (gesture.valid && unchanged) {
                runEditorAction(() => reorderTrack(gesture.id, gesture.toIndex));
            } else {
                showStatus('Track drag cancelled; drop inside the overview with an unchanged track list.');
            }
            syncEditorState();
            return;
        }
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
    pianoCanvas.ondblclick = (event) => {
        if (workspaceMode !== 'tracks' || trackGesture || suppressTrackOpen || canvasPoint(event).x < 24) {
            return;
        }
        const track = overviewTrackAt(canvasPoint(event));
        if (track && !track.audio) runEditorAction(() => setWorkspace('piano', track.id));
    };
    getElement('tracksView').onclick = () => {
        runEditorAction(() => setWorkspace('tracks'));
    };
    getElement('pianoRollView').onclick = () => {
        runEditorAction(() => setWorkspace('piano'));
    };
    getElement('activeTrack').onchange = () => runEditorAction(() =>
        setWorkspace(workspaceMode, getElement('activeTrack').value || null));
    getElement('ghostNotes').onchange = () => setGhostNotes(Boolean(getElement('ghostNotes').checked));
    getElement('addMidiTrack').onclick = (event) => runEditorAction(() => {
        if (trackGesture) {
            return;
        }
        const track = engine.addMidiTrack(`MIDI Track ${engine.sequence.tracks.length + 1}`);
        setWorkspace(workspaceMode, track.id);
        if (!event || event.detail === 0) {
            getElement('trackName').focus();
        }
    });
    getElement('renameMidiTrack').onclick = () => runEditorAction(() => {
        if (trackGesture) {
            return;
        }
        engine.renameMidiTrack(activeTrackId, getElement('trackName').value);
        syncEditorState();
    });
    pianoCanvas.onpointerdown = beginGesture;
    pianoCanvas.onpointermove = moveGesture;
    pianoCanvas.onpointerup = finishGesture;
    pianoCanvas.onpointercancel = (event) => {
        if (editGesture?.pointerId === event.pointerId || arrangement.gesture?.pointerId === event.pointerId) {
            cancelEditorGesture();
        } else {
            cancelPointerGesture(event);
        }
    };
    pianoCanvas.onlostpointercapture = pianoCanvas.onpointercancel;
    const deleteTrackDialog = getElement('deleteTrackDialog');
    function closeTrackDeletion() {
        pendingTrackDeletion = null;
        deleteTrackDialog.close();
        pianoViewport.focus({ preventScroll: true });
    }

    function requestTrackDeletion() {
        if (trackGesture) {
            return;
        }
        engine.assertTrackDeletionStopped();
        const track = activeTrack();
        if (!track || engine.sequence.tracks.length <= 1) {
            throw new Error('Select a MIDI track; the last track cannot be deleted.');
        }
        const notes = engine.sequence.notes.filter((note) => note.trackId === track.id);
        if (!notes.length) {
            deleteTrack(track.id);
            return;
        }
        pendingTrackDeletion = { sequence: engine.sequence, id: track.id, name: track.name, noteIds: new Set(notes.map((note) => note.id)) };
        getElement('deleteTrackMessage').textContent = `Delete track '${track.name}' and its ${notes.length} MIDI notes? Undo can restore it.`;
        deleteTrackDialog.showModal();
        getElement('cancelDeleteTrack').focus();
    }

    getElement('deleteMidiTrack').onclick = () => runEditorAction(requestTrackDeletion);
    getElement('cancelDeleteTrack').onclick = closeTrackDeletion;
    getElement('confirmDeleteTrack').onclick = () => runEditorAction(() => {
        const request = pendingTrackDeletion;
        const track = engine.sequence.tracks.find((candidate) => candidate.id === request?.id);
        const notes = engine.sequence.notes.filter((note) => note.trackId === request?.id);
        if (!request || request.sequence !== engine.sequence || track?.name !== request.name ||
            notes.length !== request.noteIds.size || notes.some((note) => !request.noteIds.has(note.id))) {
            closeTrackDeletion();
            throw new Error('The track changed. Request deletion again.');
        }
        engine.assertTrackDeletionStopped();
        deleteTrack(request.id);
        closeTrackDeletion();
    });
    deleteTrackDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeTrackDeletion();
    });
    const shortcutsDialog = getElement('shortcutsDialog');
    let helpReturnFocus = null;
    function selectAllNotes() {
        editableNotes(true).forEach((note) => selectedIds.add(note.id));
        selectedNoteId = [...selectedIds][0] ?? null;
    }

    function clearSelectionOrCancel() {
        if (resizeGesture || editGesture || cursorGesture || trackGesture) {
            cancelEditorGesture();
        } else if (workspaceMode === 'tracks') {
            arrangement.select(arrangement.trackId);
        } else {
            selectNote(null);
        }
    }

    const editorShortcuts = [
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
            description: 'Copy selected notes or audio clips',
            button: 'copyNotes',
            action: () => clipboardEdit('copy')
        },
        {
            key: 'x',
            modifier: true,
            label: 'Cmd/Ctrl+X',
            description: 'Cut selected notes or audio clips',
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
            description: 'Undo an editor action',
            button: 'undoNotes',
            action: () => restoreHistory(undoStack, redoStack, 'before')
        },
        {
            key: 'z',
            modifier: true,
            shift: true,
            label: 'Cmd/Ctrl+Shift+Z',
            description: 'Redo an editor action',
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
        ['Track order / deletion', 'Drag the left grip in Tracks to an insertion line; release to reorder. Escape or pointer cancellation cancels. Delete names the active track, confirms nonempty tracks, requires Stop and protects the last track. Track order and deletion support Undo/Redo.'],
        ['Tracks / Piano Roll', 'Switch perspectives without resetting playback or the cursor. Click a lane to select it; double-click a lane or choose Piano Roll / Edit Track to edit. The Active track selector also supports keyboard selection and All Notes.'],
        ['Ghost Notes', 'In a focused piano roll, show other tracks as faded, non-interactive references. New notes and Paste target the active track. All Notes paste preserves source track identities.'],
        ['Click empty grid space', 'Clear the selection without creating a note. With nothing selected, create a note on the active track (All Notes uses Piano, or the first surviving track) with the current length and velocity.'],
        ['Click a note', 'Select it. Repeated clicks cycle independent overlapping notes.'],
        ['Shift-click a note', 'Add or remove that note from selection.'],
        ['Cut Mode in Tracks', 'Drag down across an audio clip to split it at the snapped position. Escape cancels.'],
        ['Shift-click an audio clip', 'Add or remove the clip from the arrangement selection.'],
        ['Drag empty grid space', 'Marquee-select intersecting notes; Shift adds to the selection.'],
        ['Drag note body', 'Move in time and pitch. Dragging a selected note moves the selected group.'],
        ['Drag note edge', 'Resize the note. A selected group shares a duration change and keeps every start fixed.'],
        ['Cross the opposite edge', 'Single-note resizing previews deletion; release deletes. Group resizing never deletes.'],
        ['Playback follow', 'The orange playhead locks to the musical-grid midpoint only after crossing from the left. Horizontal navigation releases it; scrolling ahead rearms a later crossing. Pause, wraps and resizing reassess readiness without recentering.'],
        ['Synth / Drums', 'Open instrument menus from the top toolbar; Close or Escape dismisses them. Pointer-operated sliders release focus on completion and native selects after an option change, so Space controls transport. Enter activates focused controls.'],
        ['Toolbar focus', 'Mouse-activated DAW buttons and Workspace Options return focus to the visible workspace so Space controls transport. Enter activates focused controls. Space controls playback. Inputs and dialogs keep their focus.'],
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

    appendGuideEntry(getElement('keyboardGuide'), 'Space', 'Play, pause, or resume the transport.');
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
        applyDatabasePermissions();
        renderPianoRoll();
        return result;
    }

    function closeShortcuts() {
        shortcutsDialog.close();
    }

    getElement('shortcutsButton').onclick = (event) => {
        cancelEditorGesture();
        helpReturnFocus = event?.detail > 0 ? pianoViewport : getElement('shortcutsButton');
        shortcutsDialog.showModal();
        getElement('closeShortcuts').focus();
    };
    getElement('closeShortcuts').onclick = closeShortcuts;
    shortcutsDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeShortcuts();
    });
    shortcutsDialog.addEventListener('close', () => helpReturnFocus?.focus());

    let focusPolicyRevision = 0;
    let pointerInput = null;

    function deferWorkspaceFocus(control, previousFocus) {
        const revision = focusPolicyRevision;
        // Use a task so all native click/change handlers finish before the handoff.
        setTimeout(() => {
            if (revision !== focusPolicyRevision || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) {
                return;
            }
            const focused = document.activeElement;
            if (focused !== control && focused !== document.body && focused !== previousFocus) {
                return;
            }
            pianoViewport.focus({ preventScroll: true });
        }, 0);
    }

    // Opt-in instrument ranges/selects release pointer focus only after completion.
    document.addEventListener('pointerdown', (event) => {
        focusPolicyRevision++;
        pointerInput = null;
        const control = event.target?.closest?.('input[type="range"], select');
        if (event.button !== 0 || !control?.closest?.('[data-daw-pointer-inputs]') ||
            control.closest('dialog, [role="dialog"]')) return;
        pointerInput = { control, pointerId: event.pointerId, previousFocus: document.activeElement };
    }, true);
    document.addEventListener('pointerup', (event) => {
        if (!pointerInput || pointerInput.pointerId !== event.pointerId || pointerInput.control.tagName === 'SELECT') return;
        const interaction = pointerInput;
        pointerInput = null;
        deferWorkspaceFocus(interaction.control, interaction.previousFocus);
    }, true);
    document.addEventListener('pointercancel', () => { pointerInput = null; }, true);
    document.addEventListener('change', (event) => {
        if (!pointerInput || pointerInput.control !== event.target || event.target.tagName !== 'SELECT') return;
        const interaction = pointerInput;
        pointerInput = null;
        deferWorkspaceFocus(interaction.control, interaction.previousFocus);
    }, true);
    document.addEventListener('click', (event) => {
        // Range/select clicks are part of the ongoing pointer interaction, not buttons.
        const control = event.target?.closest?.('button, summary');
        if (!control) return;
        focusPolicyRevision++;
        if (!(event.detail > 0) || !control.closest?.('[data-daw-controls]') ||
            control.closest('dialog, [role="dialog"], a, .account-menu') ||
            (control.tagName === 'BUTTON' && control.type !== 'button')) return;
        deferWorkspaceFocus(control, document.activeElement);
    }, true);

    function matchesShortcut(shortcut, event) {
        const key = event.key.toLowerCase();
        return (shortcut.key === key || shortcut.aliases?.includes(key)) &&
            Boolean(shortcut.modifier) === Boolean(event.metaKey || event.ctrlKey) &&
            Boolean(shortcut.shift) === Boolean(event.shiftKey) && !event.altKey;
    }

    // Capture both ends of the key press. Native buttons and summaries can
    // activate on keyup even when a different control held focus at keydown.
    let transportSpaceDown = false;
    const isSpace = (event) => event.key === ' ' || event.code === 'Space';
    function handleTransportSpace(event) {
        if (!isSpace(event)) return false;
        const target = event.target;
        const typing = target?.isContentEditable || target?.closest?.('textarea, [role="textbox"], [contenteditable="true"]') ||
            target?.tagName === 'TEXTAREA' ||
            (target?.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(target.type));
        if (!transportSpaceDown && (event.type === 'keyup' || event.altKey || event.ctrlKey || event.metaKey ||
            typing || deleteTrackDialog.open || shortcutsDialog.open ||
            document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]'))) return false;
        event.preventDefault();
        event.stopImmediatePropagation?.();
        if (event.type === 'keyup') transportSpaceDown = false;
        else if (!event.repeat && !transportSpaceDown) {
            transportSpaceDown = true;
            togglePlayback();
        }
        return true;
    }

    document.addEventListener('keyup', (event) => handleTransportSpace(event), true);
    window.addEventListener('blur', () => { transportSpaceDown = false; });

    document.addEventListener('keydown', (event) => {
        if (handleTransportSpace(event)) return;
        focusPolicyRevision++;
        pointerInput = null;
        if (deleteTrackDialog.open) {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeTrackDeletion();
            }
            return;
        }
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
        if (event.key === 'Escape' && (resizeGesture || editGesture || cursorGesture || trackGesture || arrangement.gesture)) {
            event.preventDefault();
            cancelEditorGesture();
            return;
        }
        const target = event.target;
        const nativeSelect = target?.tagName === 'SELECT' || target?.closest?.('select, [role="combobox"], [role="listbox"]');
        if (event.key === 'Escape' && !nativeSelect && window.jukeboxInstrumentPanels?.closeActive()) {
            event.preventDefault();
            return;
        }
        if (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]') ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) {
            return;
        }
        if (workspaceMode === 'tracks' && arrangement.rackAssetId &&
            (event.key === 'Delete' || event.key === 'Backspace') &&
            !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault();
            if (!event.repeat) return arrangement.deleteRackAsset();
            return;
        }
        if (workspaceMode === 'tracks' && !arrangement.gesture && !trackGesture && !cursorGesture &&
            !['BUTTON', 'A', 'SUMMARY'].includes(target?.tagName) &&
            !target?.closest?.('button, a, summary') && !event.altKey && !event.shiftKey) {
            const key = event.key.toLowerCase();
            const command = event.metaKey || event.ctrlKey;
            checkHistory();
            const editable = arrangement.hooks.canEdit();
            let action;
            if (command && key === 'c' && arrangement.clipId) action = () => arrangement.copySelected();
            if (editable) {
                if (command && key === 'v' && arrangement.clipboard.length) {
                    action = () => arrangement.pasteClips(arrangement.clipboard, editingCursorTick);
                } else if (arrangement.clipId) {
                    if (command && key === 'd') action = () => arrangement.duplicateSelected();
                    if (command && key === 'x') action = () => arrangement.copySelected(true);
                    if (!command && (key === 'delete' || key === 'backspace')) action = () => arrangement.deleteSelected();
                }
            }
            if (action) {
                event.preventDefault();
                runEditorAction(action);
                return;
            }
        }
        const shortcut = editorShortcuts.find((entry) => !entry.local && matchesShortcut(entry, event));
        if (!shortcut || resizeGesture || editGesture || cursorGesture || trackGesture) {
            return;
        }
        if (shortcut.navigation &&
            (target?.closest?.('button, a, summary, [role="button"], [role="menuitem"], [role="menu"], [role="tab"], [role="slider"], [role="radio"], [role="listbox"], [role="tree"], [role="checkbox"], [role="switch"], [role="combobox"], [role="spinbutton"], [role="textbox"]') ||
            ['BUTTON', 'A', 'SUMMARY'].includes(target?.tagName))) {
            return;
        }
        if (databaseProject?.role === 'VIEWER' && !shortcut.navigation &&
            !['escape', 'a', 'c'].includes(shortcut.key)) return;
        if (workspaceMode === 'tracks' && !['z', 'escape'].includes(shortcut.key)) {
            return;
        }
        if (shortcut.navigation && !directionalTarget(shortcut.navigation)) {
            return;
        }
        if (shortcut.key === 'delete' && !selectedIds.size) {
            return;
        }
        event.preventDefault();
        runEditorAction(shortcut.action);
    }, true);
    getElement('nextOverlap').onclick = cycleOverlap;
    getElement('deleteNote').onclick = deleteSelectedNote;
    getElement('saveProject').onclick = saveDatabaseProject;
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
    function meterSelection() {
        const sequence = engine.sequence;
        const signature = sequence.positionAtTick(0).meter.join('/');
        const hasMap = sequence.timeSignatures.length > 1 ||
            sequence.timeSignatures.some((event) => event.ticks !== 0);
        return { signature, hasMap, editable: !hasMap && supportedMeters.includes(signature) };
    }

    function updateMeterControls(busy) {
        const { signature, hasMap, editable } = meterSelection();
        const select = getElement('timeSignature');
        const info = getElement('meterInfo');
        getElement('importedMeter').textContent = hasMap ? `${signature} · meter changes` : signature;
        select.value = editable ? signature : 'imported';
        select.disabled = busy || !editable;
        info.hidden = editable;
        info.textContent = editable ? '' : hasMap
            ? 'This composition has a meter map. The timeline preserves each meter change.'
            : 'This meter is read-only. The timeline displays the saved signature.';
    }

    getElement('timeSignature').onchange = (event) => {
        const value = event.target.value;
        if (!meterSelection().editable || !supportedMeters.includes(value) ||
            databaseProject?.role === 'VIEWER' || engine.isPlaying || engine.startPromise) return;
        engine.sequence.timeSignatures = [{ ticks: 0, timeSignature: value.split('/').map(Number) }];
        syncEditingCursor();
        updateMeterControls(false);
        renderPianoRoll();
    };

    function changeMeasureLength(direction) {
        const sequence = engine.sequence;
        const endTick = sequence.stepToTick(engine.totalSteps);
        const { meter } = sequence.positionAtTick(direction > 0 ? endTick : Math.ceil(endTick) - 1);
        const steps = Math.max(1, Math.round(16 * meter[0] / meter[1]));
        resizePattern(engine.totalSteps + direction * steps);
    }

    getElement('addBar').onclick = () => changeMeasureLength(1);
    getElement('removeBar').onclick = () => changeMeasureLength(-1);
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
            pendingViewportRender = true;
            showStatus(`Tempo: ${engine.bpm} BPM.`);
        } catch (error) {
            showStatus(error.message);
        }
        bpmInput.value = engine.bpm;
    };
    async function togglePlayback() {
        if (arrangement.deletingAsset) {
            showStatus('Wait for the sample deletion to finish.');
            return;
        }
        if (isStartingPlayback || engine.isPlaying || engine.startPromise) {
            playRequestId++;
            engine.pause();
            playbackFollow.reset();
            isStartingPlayback = false;
            displayedStep = engine.sequence.tickToStep(engine.getPlaybackTick());
            updateTransportControls();
            renderPianoRoll();
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
        showStatus('Stopped. Position reset to loop start.');
    }

    playButton.onclick = togglePlayback;
    getElement('stopButton').onclick = stopPlayback;
    engine.onError = (error, details) => {
        if (details?.fatal !== false) {
            stopPlayback();
        }
        showStatus(`Audio ${details?.fatal === false ? 'warning' : 'failure'}: ${error.message}`);
    };


    getElement('midiFile').onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) {
            return;
        }
        const token = ++latestMidiImportId;
        midiImportController?.abort();
        midiImportController = new AbortController();
        try {
            if (file.size > 10 * 1024 * 1024) {
                throw new Error('MIDI limit: 10 MB.');
            }
            const buffer = await file.arrayBuffer();
            if (token !== latestMidiImportId) {
                return;
            }
            const result = await MidiIO.parseAsync(buffer, { signal: midiImportController.signal });
            if (token !== latestMidiImportId) return;
            result.sequence = engine.importMidiSequence(result.sequence);
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
        pianoViewport.scrollTop = workspaceMode === 'tracks' ? 0 : Math.max(
            0,
            RULER_HEIGHT + (highestPitch - 60) * ROW_HEIGHT - 288
        );
        renderPianoRoll();
    }

    function removeImportedMidi() {
        latestMidiImportId++;
        midiImportController?.abort();
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
        if (arrangement.deletingAsset) {
            showStatus('Wait for the sample deletion to finish.');
            return;
        }
        if (
            !window.confirm(
                'Start a new sequence? This clears this arrangement, MIDI notes, and legacy sample triggers.'
            )
        ) {
            return;
        }
        latestMidiImportId++;
        midiImportController?.abort();
        unavailableSample = null;
        getElement('legacySampleWarning').hidden = true;
        stopPlayback();
        engine.newSequence();
        arrangement.reset();
        window.jukeboxSynth?.restoreState(null);
        window.jukeboxDrums?.restoreState(null);
        databaseProject = null;
        getElement('saveProject').disabled = false;
        newNoteLengthSteps = 1;
        newNoteVelocity = 89;
        getElement('midiFile').value = '';
        resetEditorSelection();
        resetPitchViewport();
        showStatus('New sequence. Add notes, then press Play.');
    }

    async function loadPendingDatabaseProject() {
        const pending = localStorage.getItem('jukebox_pending_database_project');
        const routeMatch = window.location.pathname.match(/^\/project\/([0-9a-f-]+)$/i);
        let saved = null;
        if (pending && !routeMatch) {
            try {
                saved = JSON.parse(pending);
            } catch {
                localStorage.removeItem('jukebox_pending_database_project');
                showStatus('Could not load database project: invalid pending project data.');
                return;
            }
        }
        if (routeMatch) {
            try {
                const response = await fetch(`/api/projects/${routeMatch[1]}`, {
                    credentials: 'same-origin'
                });
                const project = await response.json().catch(() => null);
                if (!response.ok) {
                    throw new Error(project?.error || `Project load failed (${response.status})`);
                }
                saved = {
                    id: project.id,
                    name: project.name,
                    role: project.role,
                    version: project.version,
                    data: typeof project.projectData === 'string'
                        ? JSON.parse(project.projectData)
                        : project.projectData
                };
            } catch (error) {
                showStatus(`Could not load project: ${error.message}`);
                return;
            }
        }
        if (!saved) {
            return;
        }
        localStorage.removeItem('jukebox_pending_database_project');
        try {
            const data = saved.data;
            if (!data || typeof data !== 'object') {
                throw new Error('Saved project data is incomplete.');
            }
            const sequence = new NoteSequence(
                Number.isInteger(data.stepCount) ? data.stepCount : 16,
                Number.isInteger(data.ppq) ? data.ppq : 480
            );
            sequence.name = saved.name || data.name || 'JukeBox';
            sequence.tracks = Array.isArray(data.tracks) && data.tracks.length
                ? data.tracks
                : sequence.tracks;
            sequence.tempos = data.tempos || sequence.tempos;
            sequence.timeSignatures = data.timeSignatures || sequence.timeSignatures;
            sequence.importInfo = data.importInfo || null;
            (data.notes || []).forEach((note) => sequence.addNote(note));
            engine.replaceSequence(sequence);
            engine.setLoopRange(
                Number.isInteger(data.loopStart) ? data.loopStart : 0,
                Number.isInteger(data.loopEnd) ? data.loopEnd : sequence.stepCount
            );
            databaseProject = {
                id: saved.id,
                name: saved.name,
                role: saved.role,
                version: saved.version
            };
            getElement('saveProject').disabled = databaseProject.role === 'VIEWER';
            engine.arrangement = new AudioArrangement(data.arrangement);
            arrangement.restoreAssets();
            loadedInstrumentState = data.instruments?.version === 1 ? data.instruments : null;
            engine.mutedLanes = new Set(Array.isArray(data.mutedLanes) ? data.mutedLanes.filter((id) => typeof id === 'string') : []);
            if (data.sample && typeof data.sample === 'object') {
                unavailableSample = { ...data.sample, audioPersisted: false };
                const warning = getElement('legacySampleWarning');
                warning.hidden = false;
                warning.textContent = 'Legacy sample triggers are retained in project data and are silent. Import the original audio into Sample Rack to arrange it as clips.';
            }
            resetEditorSelection();
            resetPitchViewport();
            showStatus(`Loaded "${sequence.name}" from the database.${unavailableSample ? ' Legacy sample triggers are archived and silent.' : ''}`);
            applyDatabasePermissions();
        } catch (error) {
            showStatus(`Could not load database project: ${error.message}`);
        }
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
        if ((event.ctrlKey || event.metaKey) && zoomFromWheel(event, zoomPointer(event))) return;
        if (event.deltaX || (event.shiftKey && event.deltaY)) {
            playbackFollow.interrupt();
        }
    }, { passive: false });
    // Some browsers expose trackpad pinch as Ctrl+wheel, others via GestureEvent.
    pianoViewport.addEventListener('gesturestart', (event) => {
        event.preventDefault();
        pinchStartZoom = zoomTarget;
    }, { passive: false });
    pianoViewport.addEventListener('gesturechange', (event) => {
        if (pinchStartZoom === null || !Number.isFinite(event.scale) || event.scale <= 0) return;
        event.preventDefault();
        queueZoom(pinchStartZoom * event.scale ** 2.5, zoomPointer(event));
    }, { passive: false });
    pianoViewport.addEventListener('gestureend', (event) => {
        if (pinchStartZoom === null) return;
        event.preventDefault();
        pinchStartZoom = null;
    }, { passive: false });
    pianoViewport.addEventListener('pointerdown', (event) => {
        const bounds = pianoViewport.getBoundingClientRect();
        if (event.clientY >= bounds.top + pianoViewport.clientHeight) {
            playbackFollow.interrupt();
        }
    });
    pianoViewport.addEventListener('scroll', () => {
        reconcileHorizontalScroll();
        pendingViewportRender = true;
        if (cursorGesture) {
            moveCursor(cursorGesture);
        }
        if (trackGesture) {
            moveTrackGesture(trackGesture);
        }
        if (arrangement.gesture) arrangement.move(arrangement.gesture);
    });
    function requestViewportRender() {
        pendingViewportRender = true;
    }
    window.addEventListener('resize', requestViewportRender);
    if (typeof ResizeObserver !== 'undefined') {
        const viewportObserver = new ResizeObserver(requestViewportRender);
        viewportObserver.observe(pianoViewport);
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopPlayback();
        }
    });
    window.addEventListener('pagehide', () => {
        midiImportController?.abort();
        stopPlayback();
    });
    function updatePlayhead(timestamp = 0) {
        if (pendingZoom) applyPendingZoom();
        const trackScrolled = updateTrackDragScroll(timestamp);
        const position = engine.audioContext && (engine.isPlaying || engine.isPaused)
            ? engine.getPlaybackPosition() : null;
        const step = position ? engine.sequence.tickToStep(position.ticks) : null;
        const scrolled = updatePlaybackFollow(position);
        // Drain legacy step markers while the continuous line follows the same audio clock.
        if (engine.audioContext) {
            engine.getPlaybackStep();
        }
        if (step !== displayedStep || scrolled || trackScrolled || pendingViewportRender) {
            pendingViewportRender = false;
            displayedStep = step;
            renderPianoRoll();
        }
        requestAnimationFrame(updatePlayhead);
    }

    if (/^\/project\//.test(window.location.pathname) || localStorage.getItem('jukebox_pending_database_project')) {
        await loadPendingDatabaseProject();
    }
    selectNote(null);
    if (!engine.arrangement.assets.size) arrangement.refreshRack();
    syncEditorState();
    pianoViewport.scrollTop = Math.max(0, RULER_HEIGHT + (highestPitch - 60) * ROW_HEIGHT - 288);
    renderPianoRoll();
    updatePlayhead();
    // Teammates register against this instance, without adding a global transport.
    const editor = Object.freeze({
        async addDrumSample(bytes, bpm) {
            if (databaseProject?.role === 'VIEWER') return;
            const model = engine.arrangement;
            const names = new Set([...model.assets.values()].map(({ name }) => name));
            let number = 1;
            let name = 'Drum Pattern';
            while (names.has(name)) name = `Drum Pattern ${++number}`;
            const added = await arrangement.importFiles([{ name, size: bytes.byteLength, arrayBuffer: async () => bytes }]);
            if (engine.arrangement !== model || !added?.length) return;
            setWorkspace('tracks', null);
            getElement('sampleRack').open = true;
            showStatus(`${name} added to Sample Rack at ${Number(bpm.toFixed(3))} BPM.`);
        },
        getState: () => ({ mode: workspaceMode, activeTrackId, ghostNotes: ghostNotesEnabled, editingCursorTick, readOnly: databaseProject?.role === 'VIEWER' }),
        setWorkspace,
        setGhostNotes,
        refresh: syncEditorState
    });
    document.dispatchEvent(new CustomEvent('jukebox:ready', { detail: { engine, editor, instrumentState: loadedInstrumentState } }));
})();