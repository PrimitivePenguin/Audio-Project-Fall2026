// Workspace mode, track selection, rail controls and track dialogs.
function createTrackUI(editorState, actions) {
    const { engine, pianoViewport, selectedIds, getElement, pianoCanvas, playbackFollow, RULER_HEIGHT } = editorState;

    let trackOptionsKey = '';
    let overviewScrollTop = 0;
    let pendingTrackDeletion = null;

    function overviewTracks() {
        return engine.arrangement.tracks.size
            ? engine.arrangement.orderedTracks(engine.sequence.tracks) : engine.sequence.tracks;
    }

    function overviewTrackAt(point) {
        const tracks = overviewTracks();
        return tracks[TrackOverview.laneAt(point, pianoViewport.scrollTop, tracks.length)];
    }

    function activeTrack() {
        return engine.sequence.tracks.find((track) => track.id === editorState.activeTrackId) ?? null;
    }

    function creationTrackName() {
        return activeTrack()?.name ?? engine.sequence.tracks.find((track) => track.id === 'piano')?.name ??
            engine.sequence.tracks[0]?.name ?? 'Piano';
    }

    function canDeleteTrack(track) {
        return editorState.databaseProject?.role !== 'VIEWER' && !editorState.isStartingPlayback && !engine.isPlaying &&
            !engine.isPaused && !engine.startPromise && !editorState.trackGesture && !editorState.arrangement.deletingAsset &&
            (track.audio || engine.sequence.tracks.length > 1);
    }

    function updateTrackActions() {
        for (const { track, remove } of editorState.laneButtons.values()) remove.disabled = !canDeleteTrack(track);
    }

    function syncTrackControls() {
        if (editorState.workspaceSequence !== engine.sequence) {
            editorState.workspaceSequence = engine.sequence;
            editorState.activeTrackId = null;
            selectedIds.clear();
            editorState.selectedNoteId = null;
            editorState.overlapIds = [];
        }
        const current = activeTrack();
        if (editorState.activeTrackId !== null && (!current ||
            (editorState.workspaceMode === 'piano' && (current.hidden || current.visible === false)))) {
            editorState.activeTrackId = null;
            selectedIds.clear();
            editorState.selectedNoteId = null;
            editorState.overlapIds = [];
        }
        const eligibleIds = new Set(editorState.workspaceMode === 'piano'
            ? PianoRollEditor.eligibleNotes(engine.sequence, { trackId: editorState.activeTrackId }).map((note) => note.id) : []);
        for (const id of selectedIds) {
            if (!eligibleIds.has(id)) {
                selectedIds.delete(id);
            }
        }
        editorState.overlapIds = editorState.overlapIds.filter((id) => eligibleIds.has(id));
        if (!selectedIds.has(editorState.selectedNoteId)) {
            editorState.selectedNoteId = [...selectedIds][0] ?? null;
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
        selector.value = editorState.activeTrackId ?? '';
        const track = activeTrack();
        getElement('activeTrackName').textContent = track?.name ?? 'All Notes';
        getElement('activeTrackName').style.color = track ? actions.noteColor(track.id) : '';
        getElement('activeTrackName').title = track ? `${track.name} · ${track.id}` : 'All musical tracks';
        getElement('tracksView').setAttribute('aria-pressed', String(editorState.workspaceMode === 'tracks'));
        getElement('pianoRollView').setAttribute('aria-pressed', String(editorState.workspaceMode === 'piano'));
        getElement('pianoRollView').disabled = Boolean(track && (track.hidden || track.visible === false));
        getElement('ghostNotes').checked = editorState.workspaceMode === 'piano' && Boolean(track) && editorState.ghostNotesEnabled;
        getElement('ghostNotes').disabled = editorState.workspaceMode !== 'piano' || !track;
        getElement('trackName').value = track?.name ?? '';
        getElement('trackMetadata').textContent = track
            ? `${track.id} · channel ${track.channel + 1} · program ${track.program} · ${track.importId ? 'imported' : 'manual'} · Delete requires Stop; the last track is protected.`
            : `All Notes: new notes use ${creationTrackName()}. Choose a track to manage it.`;
        const overview = editorState.workspaceMode === 'tracks';
        getElement('sampleRack').hidden = !overview;
        actions.layoutDocks();
        getElement('clipTools').hidden = !overview;
        editorState.arrangement.refreshInspector();
        pianoViewport.setAttribute('aria-label', overview ? 'Scrollable track overview' : 'Scrollable piano roll');
        for (const id of ['noteLength', 'lengthDecrease', 'lengthIncrease', 'velocity',
            'copyNotes', 'cutNotes', 'pasteNotes', 'duplicateNotes', 'pitchLow', 'pitchHigh']) {
            getElement(id).disabled = overview;
        }
        updateTrackActions();
        actions.syncMixer();
        actions.syncAutomationControls?.();
        pianoViewport.setAttribute('aria-label', overview ? (engine.arrangement.tracks.size ? 'Arrangement timeline' : 'MIDI track overview') : `Piano roll: ${track?.name ?? 'All Notes'}`);
        pianoCanvas.setAttribute('aria-label', overview
            ? `${engine.sequence.tracks.length} MIDI track lanes. Select a track with the Active track selector, then Piano Roll / Edit Track. Double-click a lane to edit.` +
                (engine.arrangement.tracks.size ? ` ${engine.arrangement.tracks.size} audio lanes. Use Sample Rack to place samples and inspect clips.` : '')
            : `Piano roll: ${track?.name ?? 'All Notes'}. Other tracks shown as ghosts cannot be edited.`);
    }

    function setWorkspace(mode, trackId = editorState.activeTrackId) {
        if (mode !== 'piano' && mode !== 'tracks') {
            throw new RangeError('Choose the piano or tracks workspace.');
        }
        const track = engine.sequence.tracks.find((candidate) => candidate.id === trackId);
        if (trackId !== null && (!track || (mode === 'piano' && (track.hidden || track.visible === false)))) {
            throw new RangeError('Choose an existing visible musical track or All Notes.');
        }
        if (editorState.workspaceMode === mode && editorState.activeTrackId === trackId) {
            actions.syncEditorState();
            return;
        }
        actions.cancelEditorGesture();
        if (editorState.workspaceMode === 'piano') {
            editorState.pianoScrollTop = pianoViewport.scrollTop;
        } else {
            overviewScrollTop = pianoViewport.scrollTop;
        }
        editorState.workspaceMode = mode;
        if (mode === 'piano') editorState.arrangement.selectRackAsset(null);
        if (mode === 'piano' || trackId) editorState.arrangement.select(null);
        editorState.activeTrackId = trackId;
        editorState.overlapIds = [];
        actions.selectNote(null);
        playbackFollow.interrupt();
        if (mode === 'piano') {
            actions.expandPitchRange(actions.editableNotes(true));
        }
        actions.syncEditorState();
        const contentHeight = mode === 'tracks' ? TrackOverview.laneHeight * overviewTracks().length
            : (editorState.highestPitch - editorState.lowestPitch + 1) * editorState.ROW_HEIGHT;
        const maxTop = Math.max(0, RULER_HEIGHT + contentHeight - pianoViewport.clientHeight);
        pianoViewport.scrollTop = Math.min(maxTop, mode === 'tracks' ? overviewScrollTop : editorState.pianoScrollTop);
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
            const notes = actions.editableNotes(true);
            const firstTick = engine.sequence.stepToTick(pianoViewport.scrollLeft / editorState.STEP_WIDTH);
            const note = notes.find((candidate) => candidate.ticks + candidate.durationTicks > firstTick) ?? notes[0];
            if (note) {
                pianoViewport.scrollTop = PianoRollEditor.revealNote(note, engine.sequence, actions.currentView()).scrollTop;
            }
        }
        actions.renderPianoRoll();
    }

    function setGhostNotes(enabled) {
        if (typeof enabled !== 'boolean') {
            throw new TypeError('Ghost Notes requires a boolean.');
        }
        editorState.ghostNotesEnabled = enabled;
        getElement('ghostNotes').checked = editorState.workspaceMode === 'piano' && editorState.activeTrackId !== null && enabled;
        actions.renderPianoRoll();
    }

    const laneControls = getElement('laneControls');

    editorState.laneButtons = new Map();

    function renderLaneControls(lanes, height, scrollTop) {
        const kept = new Set();
        for (const { track, index } of lanes) {
            const top = RULER_HEIGHT + (index + 1) * TrackOverview.laneHeight - scrollTop - 28;
            if (top < RULER_HEIGHT || top + 24 > height) continue;
            kept.add(track.id);
            let controls = editorState.laneButtons.get(track.id);
            if (!controls) {
                const mute = document.createElement('button');
                mute.type = 'button';
                mute.className = 'lane-control lane-mute';
                mute.onclick = () => {
                    if (editorState.databaseProject?.role === 'VIEWER') return;
                    engine.setLaneMuted(track.id, !engine.mutedLanes.has(track.id));
                    actions.renderPianoRoll();
                    actions.broadcastSync('SETTINGS_SYNC', track.id);
                };
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'lane-control lane-delete';
                remove.textContent = '🗑';
                remove.onclick = () => actions.runEditorAction(() => requestTrackDeletion(track.id));
                for (const button of [mute, remove]) {
                    button.addEventListener('pointerdown', (event) => event.stopPropagation());
                }
                controls = { track, mute, remove };
                editorState.laneButtons.set(track.id, controls);
                laneControls.append(mute, remove);
            }
            const { mute, remove } = controls;
            controls.track = track;
            const muted = engine.mutedLanes.has(track.id);
            mute.disabled = editorState.databaseProject?.role === 'VIEWER';
            remove.disabled = !canDeleteTrack(track);
            mute.style.top = remove.style.top = `${top}px`;
            const label = `Mute ${track.name}`;
            if (mute.getAttribute('aria-label') !== label) mute.setAttribute('aria-label', label);
            if (mute.getAttribute('aria-pressed') !== String(muted)) {
                mute.setAttribute('aria-pressed', String(muted));
                mute.textContent = muted ? '🔇' : '🔊';
            }
            mute.title = `${muted ? 'Unmute' : 'Mute'} ${track.name}`;
            const deleteLabel = `Delete track ${track.name}`;
            if (remove.getAttribute('aria-label') !== deleteLabel) remove.setAttribute('aria-label', deleteLabel);
            remove.title = !track.audio && engine.sequence.tracks.length <= 1
                ? 'The last MIDI track is protected.' : deleteLabel;
        }
        for (const [id, { mute, remove }] of editorState.laneButtons) {
            if (kept.has(id)) continue;
            mute.remove();
            remove.remove();
            editorState.laneButtons.delete(id);
        }
    }

    editorState.deleteTrackDialog = getElement('deleteTrackDialog');

    function closeTrackDeletion() {
        pendingTrackDeletion = null;
        editorState.deleteTrackDialog.close();
        pianoViewport.focus({ preventScroll: true });
    }

    function trackContents(track) {
        const items = track.audio ? engine.arrangement.clips.values() : engine.sequence.notes;
        return [...items].filter((item) => item.trackId === track.id);
    }

    function requestTrackDeletion(id) {
        const track = overviewTracks().find((candidate) => candidate.id === id);
        if (!track || !canDeleteTrack(track)) return;
        engine.assertTrackDeletionStopped();
        const items = trackContents(track);
        if (!items.length) {
            actions.deleteTrack(track);
            return;
        }
        pendingTrackDeletion = { sequence: engine.sequence, id, name: track.name, itemIds: new Set(items.map((item) => item.id)) };
        const noun = track.audio ? 'audio clip' : 'MIDI note';
        getElement('deleteTrackMessage').textContent =
            `Delete track '${track.name}' and its ${items.length} ${noun}${items.length === 1 ? '' : 's'}? Undo can restore it.`;
        editorState.deleteTrackDialog.showModal();
        getElement('cancelDeleteTrack').focus();
    }

    function bind() {
        getElement('tracksView').onclick = () => {
            actions.runEditorAction(() => setWorkspace('tracks'));
        };
        getElement('pianoRollView').onclick = () => {
            actions.runEditorAction(() => setWorkspace('piano'));
        };
        getElement('activeTrack').onchange = () => actions.runEditorAction(() =>
            setWorkspace(editorState.workspaceMode, getElement('activeTrack').value || null));
        getElement('ghostNotes').onchange = () => setGhostNotes(Boolean(getElement('ghostNotes').checked));
        getElement('addMidiTrack').onclick = (event) => actions.runEditorAction(() => {
            if (editorState.trackGesture) {
                return;
            }
            const track = engine.addMidiTrack(`MIDI Track ${engine.sequence.tracks.length + 1}`);
            setWorkspace(editorState.workspaceMode, track.id);
            actions.broadcastSync('TRACKS_SYNC', track.id);
            if (!event || event.detail === 0) {
                getElement('trackName').focus();
            }
        });
        getElement('renameMidiTrack').onclick = () => actions.runEditorAction(() => {
            if (editorState.trackGesture) {
                return;
            }
            engine.renameMidiTrack(editorState.activeTrackId, getElement('trackName').value);
            actions.syncEditorState();
            actions.broadcastSync('TRACKS_SYNC', editorState.activeTrackId);
        });
        getElement('cancelDeleteTrack').onclick = closeTrackDeletion;
        getElement('confirmDeleteTrack').onclick = () => actions.runEditorAction(() => {
            const request = pendingTrackDeletion;
            const track = overviewTracks().find((candidate) => candidate.id === request?.id);
            const items = track ? trackContents(track) : [];
            if (!request || request.sequence !== engine.sequence || track?.name !== request.name ||
                items.length !== request.itemIds.size || items.some((item) => !request.itemIds.has(item.id))) {
                closeTrackDeletion();
                throw new Error('The track changed. Request deletion again.');
            }
            if (!canDeleteTrack(track)) {
                closeTrackDeletion();
                return;
            }
            actions.deleteTrack(track);
            closeTrackDeletion();
        });
        editorState.deleteTrackDialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            closeTrackDeletion();
        });
    }

    return { bind, overviewTracks, overviewTrackAt, activeTrack, creationTrackName, updateTrackActions, syncTrackControls, setWorkspace, setGhostNotes, renderLaneControls, closeTrackDeletion };
}
