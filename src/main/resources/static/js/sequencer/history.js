// Shared note, automation, track and clip Undo/Redo.
function createHistory(editorState, actions) {
    const { engine, undoStack, redoStack, selectedIds } = editorState;

    let historySequence = null;

    function checkHistory() {
        if (historySequence !== engine.sequence) {
            historySequence = engine.sequence;
            undoStack.length = 0;
            redoStack.length = 0;
            editorState.clipboard = null;
            editorState.arrangement.clipboard = [];
            actions.syncEditingCursor();
        }
    }

    function snapshotNotes() {
        return new Map(engine.sequence.notes.map((note) => [note.id, { ...note }]));
    }

    function historyWeight(entry) {
        if (Array.isArray(entry)) return entry.length;
        if (entry.kind === 'audio-clip') return entry.before.length + entry.after.length;
        if (entry.kind === 'automation') return entry.before.length + entry.after.length + 1;
        return entry.kind.endsWith('-order') ? entry.before.length : (entry.record.notes ?? entry.record.clips).length + 1;
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
        if (editorState.databaseProject?.role === 'VIEWER') return;
        checkHistory();
        if (editorState.workspaceMode === 'tracks' && engine.arrangement.tracks.size) {
            const before = actions.overviewTracks().map((track) => track.id);
            const from = before.indexOf(id);
            if (from < 0 || index < 0 || index >= before.length || from === index) return;
            const after = [...before];
            after.splice(index, 0, ...after.splice(from, 1));
            setArrangementOrder(after);
            pushHistory({ kind: 'arrangement-order', before, after });
            actions.syncEditorState();
            actions.showStatus(`Moved lane to position ${index + 1}.`);
            actions.broadcastSync('TRACKS_SYNC', id);
            return;
        }
        const before = engine.sequence.tracks.map((track) => track.id);
        if (!engine.reorderMidiTrack(id, index)) {
            return;
        }
        pushHistory({ kind: 'track-order', before, after: engine.sequence.tracks.map((track) => track.id) });
        actions.syncEditorState();
        actions.showStatus(`Moved '${engine.sequence.tracks[index].name}' to track position ${index + 1}.`);
        actions.broadcastSync('TRACKS_SYNC', id);
    }

    function setArrangementOrder(ids) {
        const midiIds = new Set(engine.sequence.tracks.map((track) => track.id));
        const order = ids.filter((id) => midiIds.delete(id));
        engine.setMidiTrackOrder([...order, ...midiIds]);
        engine.arrangement.laneOrder = [...ids];
    }

    function restoreTrackHistory(entry, side) {
        if (entry.kind === 'automation') {
            engine.setAutomation(entry.channelId, entry.key, entry[side]);
            actions.renderPianoRoll();
            actions.showStatus(`${side === 'before' ? 'Undo' : 'Redo'}: automation (${entry.label}).`);
            return;
        }

        if (entry.kind === 'track-order') {
            const order = entry[side];
            const known = new Set(order);
            const extra = engine.sequence.tracks.filter((track) => !known.has(track.id)).map((track) => track.id);
            engine.setMidiTrackOrder([...order, ...extra]);
        } else if (entry.kind === 'audio-track-delete') {
            if (editorState.arrangement.deletingAsset) throw new Error('Wait for Sample Rack deletion to finish.');
            if (side === 'before') engine.restoreAudioTrack(entry.record);
            else {
                entry.record = engine.deleteAudioTrack(entry.record.track.id);
                editorState.arrangement.setSelection(editorState.arrangement.selected, editorState.arrangement.trackId);
            }
        } else if (side === 'before') {
            engine.restoreMidiTrack(entry.record);
        } else {
            // Capture out-of-history renames and any current position for the next Undo.
            entry.record = engine.deleteMidiTrack(entry.record.track.id);
        }
        editorState.overlapIds = [];
        actions.selectNote(null);
        actions.syncEditorState();
        actions.showStatus(`${side === 'before' ? 'Undo' : 'Redo'}: ${entry.kind === 'track-order' ? 'MIDI track order' : `track '${entry.record.track.name}' deletion`}.`);
    }

    function deleteTrack(track) {
        checkHistory();
        actions.cancelEditorGesture();
        editorState.arrangement.cancelDrop();
        const record = track.audio ? engine.deleteAudioTrack(track.id) : engine.deleteMidiTrack(track.id);
        pushHistory({ kind: track.audio ? 'audio-track-delete' : 'track-delete', record });
        if (track.audio) editorState.arrangement.setSelection(editorState.arrangement.selected, editorState.arrangement.trackId);
        else {
            editorState.overlapIds = [];
            actions.selectNote(null);
        }
        actions.syncEditorState();
        actions.broadcastSync('TRACKS_SYNC', track.id);
        const count = track.audio ? record.clips.length : record.notes.length;
        actions.showStatus(`Deleted track '${track.name}' and ${count} ${track.audio ? 'clips' : 'notes'}. Undo restores it.`);
    }

    function recordEdit(before) {
        actions.invalidateRenderIndex();
        checkHistory();
        const after = snapshotNotes();
        const ids = new Set([...before.keys(), ...after.keys()]);
        const changes = [...ids].filter((id) =>
            JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))
        ).map((id) => ({ before: before.get(id), after: after.get(id) }));
        if (changes.length) {
            pushHistory(changes);
            actions.broadcastSync('NOTES_SYNC', changes[0]?.after?.id ?? changes[0]?.before?.id ?? 'notes');
        }
    }

    function restoreHistory(source, destination, side) {
        if (editorState.databaseProject?.role === 'VIEWER') return;
        actions.invalidateRenderIndex();
        actions.cancelEditorGesture();
        editorState.arrangement.cancelDrop();
        checkHistory();
        const entry = source.at(-1);
        if (!entry) {
            return;
        }
        if (!Array.isArray(entry)) {
            if (entry.kind === 'audio-clip') {
                if (!editorState.arrangement.hooks.canEdit()) throw new Error('Pause or stop before changing audio clips.');
                if (editorState.workspaceMode === 'tracks') editorState.arrangement.hooks.clearMidiTrack();
                editorState.arrangement.restoreEdit(entry[side === 'before' ? 'after' : 'before'], entry[side]);
                actions.showStatus(`${side === 'before' ? 'Undo' : 'Redo'} audio clip edit.`);
            } else if (entry.kind === 'arrangement-order') {
                setArrangementOrder(entry[side]);
                actions.syncEditorState();
            } else {
                restoreTrackHistory(entry, side);
            }
            actions.broadcastSync('FULL_SYNC', 'history');
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
        const editableIds = new Set(actions.editableNotes(true).map((note) => note.id));
        for (const change of changes) {
            if (change[side] && editableIds.has(change[side].id)) {
                selectedIds.add(change[side].id);
            }
        }
        const trackIds = new Set(changes.map((change) => (change[side] ?? change.before ?? change.after).trackId));
        const names = engine.sequence.tracks.filter((track) => trackIds.has(track.id)).map((track) => track.name);
        actions.showStatus(`${side === 'before' ? 'Undo' : 'Redo'}: ${changes.length} note changes · ${names.join(', ')}`);
        editorState.selectedNoteId = [...selectedIds][0] ?? null;
        actions.refreshNoteControls();
        actions.syncEditorState();
        actions.broadcastSync('FULL_SYNC', 'history');
    }

    function discardAssetHistory(id) {
        for (const stack of [undoStack, redoStack]) {
            for (let i = stack.length - 1; i >= 0; i--) {
                const action = stack[i];
                if (action.kind === 'audio-track-delete') {
                    action.record.clips = action.record.clips.filter((clip) => clip.assetId !== id);
                }
                if (action.kind === 'audio-clip' &&
                    (action.before.some((clip) => clip.assetId === id) || action.after.some((clip) => clip.assetId === id))) {
                    stack.splice(i, 1);
                }
            }
        }
    }

    return { checkHistory, snapshotNotes, pushHistory, reorderTrack, deleteTrack, recordEdit, restoreHistory, discardAssetHistory };
}
