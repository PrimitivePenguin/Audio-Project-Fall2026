// Selected notes, navigation, clipboard and note inspector edits.
function createSelection(editorState, actions) {
    const { engine, selectedIds, pianoViewport, getElement } = editorState;

    function editableNotes(includeOutsidePitchRange = false) {
        if (editorState.workspaceMode !== 'piano') {
            return [];
        }
        return PianoRollEditor.eligibleNotes(engine.sequence, {
            trackId: editorState.activeTrackId,
            ...(includeOutsidePitchRange ? {} : { lowestPitch: editorState.lowestPitch, highestPitch: editorState.highestPitch })
        });
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
        const reveal = PianoRollEditor.revealNote(target, engine.sequence, actions.currentView());
        actions.scrollHorizontally(reveal.scrollLeft);
        pianoViewport.scrollTop = reveal.scrollTop;
        editorState.overlapIds = [];
        selectNote(target);
        actions.renderPianoRoll();
    }

    function selectedNotes() {
        return editableNotes(true).filter((note) => selectedIds.has(note.id));
    }

    function clipboardEdit(action) {
        if (editorState.workspaceMode !== 'piano') {
            return;
        }
        actions.cancelEditorGesture();
        actions.checkHistory();
        const notes = selectedNotes();
        if (action === 'copy' || action === 'cut' || action === 'duplicate') {
            if (!notes.length) {
                return;
            }
            editorState.clipboard = notes.map((note) => ({ ...note }));
            if (action === 'copy') {
                return;
            }
            if (action === 'cut') {
                deleteSelectedNote();
                return;
            }
        }
        if (!editorState.clipboard?.length) {
            return;
        }
        const first = editorState.clipboard.reduce((start, note) => Math.min(start, note.ticks), Infinity);
        const end = editorState.clipboard.reduce((last, note) => Math.max(last, note.ticks + note.durationTicks), 0);
        // Paste anchors the earliest copied note at the independent editing cursor.
        const target = action === 'duplicate' ? end : editorState.editingCursorTick;
        const requiredSteps = Math.ceil(engine.sequence.tickToStep(target + end - first));
        if (requiredSteps > 65536) {
            throw new Error('Pasted notes exceed the maximum pattern length.');
        }
        const before = actions.snapshotNotes();
        if (requiredSteps > engine.totalSteps) {
            engine.setPatternLength(requiredSteps);
        }
        selectedIds.clear();
        for (const data of editorState.clipboard) {
            const note = engine.sequence.addNote({
                ...data,
                id: undefined,
                trackId: action === 'paste' && editorState.activeTrackId !== null ? editorState.activeTrackId : data.trackId,
                ticks: target + data.ticks - first,
                importId: null
            });
            selectedIds.add(note.id);
        }
        editorState.selectedNoteId = [...selectedIds][0];
        actions.recordEdit(before);
        refreshNoteControls();
        actions.syncEditorState();
    }

    function selectedNote() {
        return engine.sequence.notes.find((note) => note.id === editorState.selectedNoteId) ?? null;
    }

    function selectNote(note) {
        selectedIds.clear();
        if (note) {
            selectedIds.add(note.id);
        }
        editorState.selectedNoteId = note?.id ?? null;
        refreshNoteControls();
    }

    function refreshNoteControls(preview = null) {
        const note = selectedNote();
        getElement('deleteNote').disabled = !selectedIds.size;
        getElement('selectionCount').textContent = `${selectedIds.size} selected`;
        getElement('nextOverlap').disabled = editorState.overlapIds.length < 2;
        const lengthInput = getElement('noteLength');
        lengthInput.placeholder = '';
        const durations = selectedNotes().map((selected) =>
            editorState.resizeGesture?.previews?.get(selected.id)?.durationTicks ??
            (selected.id === editorState.selectedNoteId ? preview?.durationTicks : null) ?? selected.durationTicks);
        const mixed = durations.some((duration) => duration !== durations[0]);
        if (!note) {
            getElement('noteLength').value = PianoRollEditor.formatDuration(engine.sequence, newNoteDurationTicks());
            getElement('velocity').value = editorState.newNoteVelocity;
            getElement('noteInfo').textContent =
                `${actions.activeTrack()?.name ?? 'All Notes'} view. New notes use ${actions.creationTrackName()}. ` +
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

    function cycleOverlap() {
        const index = editorState.overlapIds.indexOf(editorState.selectedNoteId);
        const nextId = editorState.overlapIds[(index + 1) % editorState.overlapIds.length];
        selectNote(engine.sequence.notes.find((note) => note.id === nextId) ?? null);
        actions.renderPianoRoll();
    }

    function deleteSelectedNote() {
        actions.cancelEditorGesture();
        const before = actions.snapshotNotes();
        const ids = new Set(selectedNotes().map((note) => note.id));
        engine.sequence.notes = engine.sequence.notes.filter((note) => !ids.has(note.id));
        editorState.overlapIds = editorState.overlapIds.filter((id) => !ids.has(id));
        actions.recordEdit(before);
        selectNote(null);
        actions.updateCompositionSummary();
        actions.renderPianoRoll();
    }

    function applySelectedDurations(durationForNote) {
        actions.cancelEditorGesture();
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
        const before = actions.snapshotNotes();
        for (const { note, durationTicks } of updates) {
            sequence.updateNoteTiming(note.id, note.ticks, durationTicks);
        }
        actions.recordEdit(before);
        refreshNoteControls();
        actions.renderPianoRoll();
    }

    function applyLengthTicks(durationTicks) {
        if (selectedIds.size) {
            applySelectedDurations(() => durationTicks);
        } else {
            editorState.newNoteLengthSteps = engine.sequence.tickToStep(durationTicks);
            refreshNoteControls();
        }
    }

    function newNoteDurationTicks() {
        return Math.max(1, Math.round(engine.sequence.stepToTick(editorState.newNoteLengthSteps)));
    }

    function updateSnapInfo() {
        const info = getElement('snapInfo');
        const interval = PianoRollEditor.snapInterval(editorState.snapMode);
        info.hidden = !interval || Number.isInteger(engine.sequence.stepToTick(interval));
        info.textContent = info.hidden ? '' : `${engine.sequence.ppq} PPQ: grid positions round to the nearest MIDI tick.`;
    }

    function changeLength() {
        try {
            const durationTicks = PianoRollEditor.durationTicks(
                engine.sequence,
                Number(getElement('noteLength').value)
            );
            applyLengthTicks(durationTicks);
        } catch (error) {
            actions.showStatus(error.message);
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
            actions.showStatus(error.message);
            refreshNoteControls();
        }
    }

    function changeVelocity() {
        const value = Number(getElement('velocity').value);
        const note = selectedNote();
        if (!Number.isInteger(value) || value < 1 || value > 127) {
            actions.showStatus('Velocity must be 1–127.');
            refreshNoteControls();
            return;
        }
        if (note) {
            const before = actions.snapshotNotes();
            note.velocityMidi = value;
            note.velocity = value / 127;
            actions.recordEdit(before);
        } else {
            editorState.newNoteVelocity = value;
        }
    }

    function selectAllNotes() {
        editableNotes(true).forEach((note) => selectedIds.add(note.id));
        editorState.selectedNoteId = [...selectedIds][0] ?? null;
    }

    function bind() {
        getElement('noteSnap').onchange = (event) => {
            actions.cancelEditorGesture();
            editorState.snapMode = event.target.value;
            updateSnapInfo();
            actions.renderPianoRoll();
        };
        getElement('nextOverlap').onclick = cycleOverlap;
        getElement('deleteNote').onclick = deleteSelectedNote;
        getElement('noteLength').onchange = changeLength;
        getElement('lengthDecrease').onclick = () => adjustLength(-1);
        getElement('lengthIncrease').onclick = () => adjustLength(1);
        getElement('velocity').onchange = changeVelocity;
    }

    return { bind, editableNotes, directionalTarget, navigateSelection, selectedNotes, clipboardEdit, selectNote, refreshNoteControls, cycleOverlap, deleteSelectedNote, newNoteDurationTicks, updateSnapInfo, adjustLength, selectAllNotes };
}
