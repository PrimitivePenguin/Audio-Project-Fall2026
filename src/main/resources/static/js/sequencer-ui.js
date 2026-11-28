const initializeSequencer = (() => {
    let initialization;
    return (options) => {
        if (initialization) return initialization;
        let resolve;
        let reject;
        initialization = new Promise((onReady, onError) => {
            resolve = onReady;
            reject = onError;
        });
        startSequencer(options).then(resolve, reject);
        return initialization;
    };
})();

async function startSequencer({
    engine: sequencerEngine = new SequencerEngine(),
    createArrangement = (engine, hooks) => new ArrangementEditor(engine, hooks)
} = {}) {
    const editorState = createSequencerState(sequencerEngine);
    const actions = {};
    const { statusElement, getElement, engine, loopStartInput, loopEndInput, bpmInput, pianoCanvas, RULER_HEIGHT, pianoViewport, KEYBOARD_WIDTH } = editorState;

    function showStatus(text) {
        statusElement.textContent = text;
    }

    function syncEditorState() {
        actions.invalidateRenderIndex();
        actions.syncTrackControls();
        actions.syncEditingCursor();
        getElement('patternSteps').value = engine.totalSteps;
        loopStartInput.max = loopEndInput.max = engine.totalSteps;
        loopStartInput.value = engine.loopStart + 1;
        loopEndInput.value = engine.loopEnd;
        bpmInput.value = engine.bpm;
        actions.resizePianoContent();
        actions.updateTransportControls();
        actions.updateSnapInfo();
        updateCompositionSummary();
        actions.refreshNoteControls();
        actions.applyDatabasePermissions();
        actions.renderPianoRoll();
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

    function runEditorAction(action) {
        let result;
        try {
            result = action();
        } catch (error) {
            showStatus(error.message);
        }
        actions.refreshNoteControls();
        actions.applyDatabasePermissions();
        actions.renderPianoRoll();
        return result;
    }

    Object.assign(actions, { showStatus, syncEditorState, updateCompositionSummary, runEditorAction });

    // Each factory exposes actions before any DOM handlers or project loads run.
    const features = [];
    for (const create of [
        createTrackUI,
        createRendering,
        createSelection,
        createViewportUI,
        createHistory,
        createProjectUI,
        createTransportUI,
        createGestures,
        createMixerUI,
        createExportUI,
        createAutomationUI,
        createKeyboard,
        createDockLayout,
    ]) {
        const { bind, ...featureActions } = create(editorState, actions);
        Object.assign(actions, featureActions);
        if (bind) features.push(bind);
    }

    editorState.arrangement = createArrangement(engine, {
        onMutate: (type, targetId) => actions.broadcastSync(type, targetId),
        projectId: () => editorState.databaseProject?.id ?? null,
        readOnly: () => editorState.databaseProject?.role === 'VIEWER',
        onAssetUploaded: (asset) => {
            actions.broadcastSync('AUDIO_SYNC', asset.id);
            if (!editorState.collab.connected) getElement('rackStatus').textContent =
                'Sample uploaded. Save Project again to share its cloud URL.';
        },
        canvas: pianoCanvas, point: actions.canvasPoint, release: actions.releasePointer, run: runEditorAction,
        canEdit: () => !editorState.arrangement.deletingAsset && editorState.databaseProject?.role !== 'VIEWER' && !engine.isPlaying && !engine.startPromise && !editorState.isStartingPlayback,
        clearMidiTrack: () => { if (editorState.activeTrackId !== null) actions.setWorkspace('tracks', null); },
        tracksChanged: (id) => {
            syncEditorState();
            if (id) {
                const index = actions.overviewTracks().findIndex((track) => track.id === id);
                const bottom = RULER_HEIGHT + (index + 1) * TrackOverview.laneHeight;
                pianoViewport.scrollTop = Math.max(pianoViewport.scrollTop, bottom - pianoViewport.clientHeight);
                getElement('sampleRack').open = true;
            }
            actions.broadcastSync('TRACKS_SYNC', id ?? 'tracks');
        },
        createLane: (below) => {
            const ids = actions.overviewTracks().map((track) => track.id);
            const track = engine.arrangement.addTrack();
            ids.splice(below ? ids.indexOf(below) + 1 : ids.length, 0, track.id);
            engine.arrangement.laneOrder = ids;
            syncEditorState();
            return track.id;
        },
        redraw: () => { editorState.pendingViewportRender = true; },
        selectionChanged: actions.updateTrackActions,
        scrollTop: () => pianoViewport.scrollTop,
        snap: () => editorState.snapMode,
        laneAt: (point) => actions.overviewTrackAt(point),
        stepAt: (point) => (point.x + pianoViewport.scrollLeft - KEYBOARD_WIDTH) / editorState.STEP_WIDTH,
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
            actions.checkHistory();
            actions.pushHistory({ kind: 'audio-clip', before, after });
        },
        discardAssetHistory: actions.discardAssetHistory
    });

    for (const bind of features) bind();

    if (/^\/project\//.test(window.location.pathname) || localStorage.getItem('jukebox_pending_database_project')) {
        await actions.loadPendingDatabaseProject();
    }

    actions.selectNote(null);
    if (!engine.arrangement.assets.size) editorState.arrangement.refreshRack();
    syncEditorState();
    pianoViewport.scrollTop = Math.max(0, RULER_HEIGHT + (editorState.highestPitch - 60) * editorState.ROW_HEIGHT - 288);
    actions.renderPianoRoll();
    actions.updatePlayhead();

    const editor = Object.freeze({
        async addDrumSample(bytes, bpm) {
            if (editorState.databaseProject?.role === 'VIEWER') return;
            const model = engine.arrangement;
            const names = new Set([...model.assets.values()].map(({ name }) => name));
            let number = 1;
            let name = 'Drum Pattern';
            while (names.has(name)) name = `Drum Pattern ${++number}`;
            const added = await editorState.arrangement.importFiles([{ name, size: bytes.byteLength, arrayBuffer: async () => bytes }]);
            if (engine.arrangement !== model || !added?.length) return;
            actions.setWorkspace('tracks', null);
            getElement('sampleRack').open = true;
            showStatus(`${name} added to Sample Rack at ${Number(bpm.toFixed(3))} BPM.`);
        },
        getState: () => ({ mode: editorState.workspaceMode, activeTrackId: editorState.activeTrackId, ghostNotes: editorState.ghostNotesEnabled, editingCursorTick: editorState.editingCursorTick, readOnly: editorState.databaseProject?.role === 'VIEWER' }),
        setWorkspace: actions.setWorkspace,
        setGhostNotes: actions.setGhostNotes,
        instrumentChanged: () => actions.broadcastSync('INSTRUMENTS_SYNC', 'instruments'),
        refresh: syncEditorState
    });

    document.dispatchEvent(new CustomEvent('jukebox:ready', { detail: { engine, editor, instrumentState: editorState.loadedInstrumentState } }));
}
