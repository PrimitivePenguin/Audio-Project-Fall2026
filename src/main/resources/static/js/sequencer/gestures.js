// Pointer gestures and canvas hit testing.
function createGestures(editorState, actions) {
    const { pianoCanvas, KEYBOARD_WIDTH, RULER_HEIGHT, engine, pianoViewport, selectedIds, playbackFollow } = editorState;

    let suppressTrackOpen = false;

    function canvasPoint(event) {
        const bounds = pianoCanvas.getBoundingClientRect();
        // Pointer events use CSS pixels; the canvas transform alone handles device pixel ratio.
        return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    }

    function candidatesAt(point) {
        if (point.x < KEYBOARD_WIDTH || point.y < RULER_HEIGHT) return [];
        const view = actions.currentView();
        const pitch = editorState.highestPitch - Math.floor((point.y + view.scrollTop - RULER_HEIGHT) / editorState.ROW_HEIGHT);
        if (pitch < editorState.lowestPitch || pitch > editorState.highestPitch) return [];
        const sequence = engine.sequence;
        const tracks = new Set(sequence.tracks.filter((track) => !track.hidden && track.visible !== false &&
            (editorState.activeTrackId === null || editorState.activeTrackId === track.id)).map((track) => track.id));
        const contentX = point.x + view.scrollLeft - KEYBOARD_WIDTH;
        const notes = actions.getRenderIndex().query(sequence.stepToTick((contentX - 8) / editorState.STEP_WIDTH),
            sequence.stepToTick(contentX / editorState.STEP_WIDTH), pitch, pitch, (note) => tracks.has(note.trackId));
        return PianoRollEditor.notesAtPoint(notes, point, view);
    }

    function moveCursor(event) {
        editorState.cursorGesture.clientX = event.clientX;
        editorState.cursorGesture.clientY = event.clientY;
        if (engine.isPaused && editorState.cursorGesture.originalPausedTick === null) {
            editorState.cursorGesture.originalPausedTick = engine.pausedTick;
        }
        const point = canvasPoint(event);
        actions.setEditingCursor(PianoRollEditor.cursorTick(engine.sequence, point.x, pianoViewport.scrollLeft));
    }

    function handleCanvasClick(event) {
        if (editorState.suppressResizeClick) {
            editorState.suppressResizeClick = false;
            return;
        }
        const point = canvasPoint(event);
        if (point.x >= KEYBOARD_WIDTH && point.y >= 0 && point.y < RULER_HEIGHT) {
            actions.setEditingCursor(PianoRollEditor.cursorTick(engine.sequence, point.x, pianoViewport.scrollLeft));
            return;
        }
        if (point.y < RULER_HEIGHT || (editorState.workspaceMode === 'piano' && point.x < KEYBOARD_WIDTH)) {
            return;
        }
        if (editorState.workspaceMode === 'tracks') {
            const track = actions.overviewTrackAt(point);
            if (track?.audio) {
                editorState.arrangement.hooks.clearMidiTrack();
                const hit = editorState.arrangement.clipAt(point, track);
                editorState.arrangement.select(track.id, hit?.clip.id, event.shiftKey && Boolean(hit));
                actions.updateTrackActions();
            } else if (track) {
                editorState.arrangement.select(null);
                actions.setWorkspace('tracks', track.id);
            } else {
                editorState.arrangement.select(null);
            }
            return;
        }
        const candidates = candidatesAt(point);
        editorState.overlapIds = candidates.map((note) => note.id);
        if (candidates.length) {
            if (event.shiftKey) {
                const note = candidates.find((candidate) => candidate.id === editorState.selectedNoteId) ?? candidates[0];
                if (selectedIds.has(note.id)) {
                    selectedIds.delete(note.id);
                } else {
                    selectedIds.add(note.id);
                }
                editorState.selectedNoteId = selectedIds.has(note.id) ? note.id : [...selectedIds][0] ?? null;
                actions.refreshNoteControls();
            } else {
                actions.cycleOverlap();
            }
        } else {
            const step = (point.x + pianoViewport.scrollLeft - KEYBOARD_WIDTH) / editorState.STEP_WIDTH;
            const midi =
                editorState.highestPitch -
                Math.floor((point.y + pianoViewport.scrollTop - RULER_HEIGHT) / editorState.ROW_HEIGHT);
            if (
                step < 0 ||
                step >= engine.totalSteps ||
                midi < editorState.lowestPitch ||
                midi > editorState.highestPitch
            ) {
                return;
            }
            if (selectedIds.size) {
                actions.selectNote(null);
                actions.renderPianoRoll();
                return;
            }
            try {
                const ticks = PianoRollEditor.snappedTicks(engine.sequence, step, editorState.snapMode, true);
                const durationTicks = actions.newNoteDurationTicks();
                if (
                    ticks + durationTicks >
                    Math.floor(engine.sequence.stepToTick(engine.totalSteps))
                ) {
                    throw new Error('Extend the pattern before adding a note this long.');
                }
                const before = actions.snapshotNotes();
                engine.sequence.addNote({
                    midi,
                    ticks,
                    durationTicks,
                    velocityMidi: editorState.newNoteVelocity,
                    trackId: editorState.activeTrackId ?? engine.sequence.ensurePianoTrack()
                });
                actions.recordEdit(before);
                actions.selectNote(null);
            } catch (error) {
                actions.showStatus(error.message);
            }
        }
        actions.updateCompositionSummary();
        actions.renderPianoRoll();
    }

    function dragThreshold() {
        return editorState.snapMode === 'free' ? Math.min(3, editorState.STEP_WIDTH * engine.sequence.tickToStep(0.5)) : 3;
    }

    function resizeTarget(point) {
        const candidates = candidatesAt(point);
        const selected = candidates.find((note) => note.id === editorState.selectedNoteId);
        const note = selected ?? candidates[0];
        const edge = note ? PianoRollEditor.edgeAtPoint(note, point, actions.currentView()) : null;
        return edge ? { note, edge } : null;
    }

    function beginResize(event) {
        editorState.suppressResizeClick = false;
        if (event.button !== 0 || editorState.resizeGesture) {
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
            actions.selectNote(target.note);
        }
        editorState.selectedNoteId = target.note.id;
        const point = canvasPoint(event);
        const pointerStep = (point.x + pianoViewport.scrollLeft - KEYBOARD_WIDTH) / editorState.STEP_WIDTH;
        const endpointStep =
            target.edge === 'left'
                ? target.note.startStep
                : target.note.startStep + target.note.durationSteps;
        editorState.resizeGesture = {
            before: actions.snapshotNotes(),
            originals: actions.selectedNotes().map((note) => ({ ...note })),
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
        editorState.suppressResizeClick = true;
        pianoCanvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        actions.renderPianoRoll();
    }

    function movePointer(event) {
        if (!editorState.resizeGesture) {
            const target = resizeTarget(canvasPoint(event));
            pianoCanvas.style.cursor = target ? 'ew-resize' : candidatesAt(canvasPoint(event)).length ? 'move' : 'crosshair';
            return;
        }
        if (event.pointerId !== editorState.resizeGesture.pointerId) {
            return;
        }
        const distance =
            event.clientX -
            editorState.resizeGesture.startX +
            pianoViewport.scrollLeft -
            editorState.resizeGesture.startScrollLeft;
        if (Math.abs(distance) < dragThreshold() && !editorState.resizeGesture.moved) {
            return;
        }
        const point = canvasPoint(event);
        const pointerStep = (point.x + pianoViewport.scrollLeft - KEYBOARD_WIDTH) / editorState.STEP_WIDTH;
        const step = pointerStep - editorState.resizeGesture.grabOffsetSteps;
        try {
            if (editorState.resizeGesture.originals.length > 1) {
                const sequence = engine.sequence;
                const originals = editorState.resizeGesture.originals;
                const requested = editorState.resizeGesture.edge === 'right'
                    ? step - sequence.tickToStep(editorState.resizeGesture.original.ticks + editorState.resizeGesture.original.durationTicks)
                    : sequence.tickToStep(editorState.resizeGesture.original.ticks) - step;
                editorState.resizeGesture.previews = PianoRollEditor.resizedGroup(sequence, originals, requested, editorState.snapMode);
                editorState.resizeGesture.preview = editorState.resizeGesture.previews.get(editorState.resizeGesture.noteId);
            } else {
                editorState.resizeGesture.preview = PianoRollEditor.resizedTiming(
                    engine.sequence,
                    editorState.resizeGesture.original,
                    editorState.resizeGesture.edge,
                    step,
                    pointerStep,
                    editorState.snapMode
                );
            }
            editorState.resizeGesture.moved = true;
            actions.refreshNoteControls(editorState.resizeGesture.preview);
            actions.renderPianoRoll();
        } catch (error) {
            actions.showStatus(error.message);
            cancelEditorGesture();
        }
    }

    function finishResize(event) {
        if (!editorState.resizeGesture || event.pointerId !== editorState.resizeGesture.pointerId) {
            return;
        }
        // The release can carry a newer position than the last coalesced move event.
        movePointer(event);
        if (!editorState.resizeGesture) {
            return;
        }
        const gesture = editorState.resizeGesture;
        editorState.resizeGesture = null;
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
                    editorState.overlapIds = editorState.overlapIds.filter((id) => id !== gesture.noteId);
                    actions.selectNote(null);
                    actions.updateCompositionSummary();
                } else if (!gesture.preview.limited) {
                    engine.sequence.updateNoteTiming(
                        gesture.noteId,
                        gesture.preview.ticks,
                        gesture.preview.durationTicks
                    );
                }
            }
        } catch (error) {
            actions.showStatus(error.message);
        }
        actions.recordEdit(gesture.before);
        releasePointer(gesture.pointerId);
        if (gesture.moved && gesture.preview) {
        }
        actions.refreshNoteControls();
        actions.renderPianoRoll();
    }

    function releasePointer(pointerId) {
        if (pianoCanvas.hasPointerCapture(pointerId)) {
            pianoCanvas.releasePointerCapture(pointerId);
        }
        pianoCanvas.style.cursor = 'default';
    }

    function cancelEditorGesture() {
        editorState.arrangement.cancelGesture();
        if (editorState.trackGesture) {
            const pointerId = editorState.trackGesture.pointerId;
            editorState.trackGesture = null;
            editorState.suppressResizeClick = true;
            releasePointer(pointerId);
            actions.updateTrackActions();
            actions.renderPianoRoll();
        }
        if (editorState.cursorGesture) {
            const gesture = editorState.cursorGesture;
            editorState.cursorGesture = null;
            editorState.suppressResizeClick = true;
            if (engine.isPaused && gesture.originalPausedTick !== null) {
                engine.seekPaused(gesture.originalPausedTick);
                editorState.displayedStep = engine.sequence.tickToStep(engine.getPlaybackTick());
            }
            actions.setEditingCursor(gesture.originalTick, false);
            releasePointer(gesture.pointerId);
        }
        if (editorState.editGesture) {
            const gesture = editorState.editGesture;
            editorState.editGesture = null;
            selectedIds.clear();
            gesture.selection.forEach((id) => selectedIds.add(id));
            editorState.selectedNoteId = [...selectedIds][0] ?? null;
            editorState.suppressResizeClick = gesture.moved;
            releasePointer(gesture.pointerId);
            actions.refreshNoteControls();
            actions.renderPianoRoll();
        }
        if (!editorState.resizeGesture) {
            return;
        }
        const pointerId = editorState.resizeGesture.pointerId;
        editorState.resizeGesture = null;
        releasePointer(pointerId);
        actions.refreshNoteControls();
        actions.renderPianoRoll();
    }

    function cancelPointerGesture(event) {
        if (editorState.resizeGesture?.pointerId === event.pointerId || editorState.cursorGesture?.pointerId === event.pointerId || editorState.trackGesture?.pointerId === event.pointerId) {
            cancelEditorGesture();
        }
    }

    function contentPoint(event) {
        const point = canvasPoint(event);
        return { x: point.x + pianoViewport.scrollLeft, y: point.y + pianoViewport.scrollTop };
    }

    function moveTrackGesture(event) {
        editorState.trackGesture.clientX = event.clientX;
        editorState.trackGesture.clientY = event.clientY;
        const point = canvasPoint(event);
        const drop = TrackOverview.dropPosition(point.y, pianoViewport.scrollTop,
            actions.overviewTracks().length, editorState.trackGesture.fromIndex);
        editorState.trackGesture.boundary = drop.boundary;
        editorState.trackGesture.toIndex = drop.index;
        editorState.trackGesture.valid = point.y >= RULER_HEIGHT && point.y <= pianoViewport.clientHeight &&
            point.x >= 0 && point.x <= pianoViewport.clientWidth;
        actions.renderPianoRoll();
    }

    function updateTrackDragScroll(timestamp) {
        if (!editorState.trackGesture) {
            return false;
        }
        const bounds = pianoCanvas.getBoundingClientRect();
        const y = editorState.trackGesture.clientY - bounds.top;
        const elapsed = editorState.trackGesture.lastFrameTime === null ? 16 : Math.min(50, Math.max(0, timestamp - editorState.trackGesture.lastFrameTime));
        editorState.trackGesture.lastFrameTime = timestamp;
        const direction = y < RULER_HEIGHT + 24 ? -1 : y > pianoViewport.clientHeight - 24 ? 1 : 0;
        const maximum = Math.max(0, RULER_HEIGHT + actions.overviewTracks().length * TrackOverview.laneHeight - pianoViewport.clientHeight);
        const top = Math.max(0, Math.min(maximum, pianoViewport.scrollTop + direction * elapsed * 0.6));
        if (top === pianoViewport.scrollTop) {
            return false;
        }
        pianoViewport.scrollTop = top;
        // Place the viewport canvas first, then recompute the captured screen coordinate.
        actions.renderPianoRoll();
        moveTrackGesture(editorState.trackGesture);
        return true;
    }

    function beginGesture(event) {
        if (editorState.editGesture || editorState.resizeGesture || editorState.cursorGesture || editorState.trackGesture || editorState.arrangement.gesture || event.button !== 0) {
            return;
        }
        editorState.arrangement.selectRackAsset(null);
        actions.checkHistory();
        pianoViewport.focus({ preventScroll: true });
        const initialPoint = canvasPoint(event);
        if (initialPoint.x >= KEYBOARD_WIDTH && initialPoint.y >= 0 && initialPoint.y < RULER_HEIGHT) {
            editorState.cursorGesture = {
                pointerId: event.pointerId,
                originalTick: editorState.editingCursorTick,
                originalPausedTick: engine.isPaused ? engine.pausedTick : null,
                clientX: event.clientX,
                clientY: event.clientY
            };
            editorState.suppressResizeClick = true;
            pianoCanvas.setPointerCapture(event.pointerId);
            pianoCanvas.style.cursor = 'col-resize';
            event.preventDefault();
            moveCursor(event);
            return;
        }
        if (editorState.workspaceMode === 'tracks') {
            const tracks = actions.overviewTracks();
            const index = TrackOverview.laneAt(initialPoint, pianoViewport.scrollTop, tracks.length);
            if (index >= 0 && initialPoint.x >= 6 && initialPoint.x < 24 && editorState.databaseProject?.role !== 'VIEWER') {
                editorState.trackGesture = {
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
                editorState.suppressResizeClick = true;
                pianoCanvas.setPointerCapture(event.pointerId);
                pianoCanvas.style.cursor = 'grabbing';
                playbackFollow.interrupt();
                actions.updateTrackActions();
                event.preventDefault();
                moveTrackGesture(event);
            } else {
                suppressTrackOpen = false;
                editorState.suppressResizeClick = false;
                if (tracks[index]?.audio && initialPoint.x >= KEYBOARD_WIDTH) {
                    editorState.arrangement.begin(event, initialPoint, tracks[index]);
                    editorState.suppressResizeClick = true;
                    actions.updateTrackActions();
                }
            }
            return;
        }
        beginResize(event);
        if (editorState.resizeGesture || event.button !== 0) {
            return;
        }
        const point = canvasPoint(event);
        if (point.x < KEYBOARD_WIDTH || point.y < RULER_HEIGHT) {
            return;
        }
        const candidates = candidatesAt(point);
        const note = candidates.find((candidate) => selectedIds.has(candidate.id)) ?? candidates[0];
        const selection = [...selectedIds];
        editorState.editGesture = {
            kind: note ? 'move' : 'marquee',
            note,
            selection,
            start: contentPoint(event),
            point: contentPoint(event),
            pointerId: event.pointerId,
            moved: false,
            additive: event.shiftKey,
            before: actions.snapshotNotes()
        };
        pianoCanvas.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    function moveGesture(event) {
        if (editorState.arrangement.gesture) { editorState.arrangement.move(event); return; }
        if (editorState.trackGesture) {
            if (editorState.trackGesture.pointerId === event.pointerId) {
                moveTrackGesture(event);
            }
            return;
        }
        if (editorState.cursorGesture) {
            if (editorState.cursorGesture.pointerId === event.pointerId) {
                moveCursor(event);
            }
            return;
        }
        if (!editorState.editGesture) {
            if (editorState.workspaceMode === 'tracks') {
                const point = canvasPoint(event);
                const lane = actions.overviewTrackAt(point);
                const hit = lane?.audio && editorState.arrangement.clipAt(point, lane);
                pianoCanvas.style.cursor = hit && editorState.arrangement.razor && editorState.arrangement.hooks.canEdit() ? 'crosshair'
                    : hit ? 'move' : lane && point.x >= 6 && point.x < 24 ? 'grab' : 'pointer';
                pianoCanvas.title = lane ? lane.name : '';
                return;
            }
            movePointer(event);
            return;
        }
        const gesture = editorState.editGesture;
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
            actions.selectNote(gesture.note);
        }
        gesture.moved = true;
        if (gesture.kind === 'marquee') {
            selectedIds.clear();
            if (gesture.additive) {
                gesture.selection.forEach((id) => selectedIds.add(id));
            }
            for (const note of actions.editableNotes()) {
                if (PianoRollEditor.intersects(note, gesture.start, gesture.point,
                    { highestPitch: editorState.highestPitch, scrollLeft: 0, scrollTop: 0 })) {
                    selectedIds.add(note.id);
                }
            }
            editorState.selectedNoteId = [...selectedIds][0] ?? null;
        } else {
            const notes = [...gesture.before.values()].filter((note) => selectedIds.has(note.id));
            gesture.previews = PianoRollEditor.movedNotes(engine.sequence, notes, dx, dy, editorState.snapMode);
            if (!gesture.previews) {
                actions.showStatus('Extend the pattern before moving notes with tails beyond its end.');
            }
        }
        actions.refreshNoteControls(gesture.previews?.get(editorState.selectedNoteId));
        actions.renderPianoRoll();
    }

    function finishGesture(event) {
        if (editorState.arrangement.gesture) {
            if (editorState.arrangement.gesture.pointerId === event.pointerId) {
                editorState.arrangement.finish(event);
                editorState.suppressResizeClick = true;
            }
            return;
        }
        if (editorState.trackGesture) {
            if (editorState.trackGesture.pointerId !== event.pointerId) {
                return;
            }
            moveTrackGesture(event);
            const gesture = editorState.trackGesture;
            editorState.trackGesture = null;
            editorState.suppressResizeClick = true;
            releasePointer(event.pointerId);
            const tracks = actions.overviewTracks();
            const unchanged = gesture.sequence === engine.sequence &&
                gesture.order.length === tracks.length && gesture.order.every((id, index) => id === tracks[index].id);
            if (gesture.valid && unchanged) {
                actions.runEditorAction(() => actions.reorderTrack(gesture.id, gesture.toIndex));
            } else {
                actions.showStatus('Track drag cancelled; drop inside the overview with an unchanged track list.');
            }
            actions.syncEditorState();
            return;
        }
        if (editorState.cursorGesture) {
            if (editorState.cursorGesture.pointerId === event.pointerId) {
                moveCursor(event);
                editorState.cursorGesture = null;
                editorState.suppressResizeClick = true;
                releasePointer(event.pointerId);
            }
            return;
        }
        if (!editorState.editGesture) {
            finishResize(event);
            return;
        }
        if (event.pointerId !== editorState.editGesture.pointerId) {
            return;
        }
        moveGesture(event);
        const gesture = editorState.editGesture;
        editorState.editGesture = null;
        if (gesture.previews) {
            for (const note of engine.sequence.notes) {
                const preview = gesture.previews.get(note.id);
                if (preview) {
                    Object.assign(note, preview);
                }
            }
            actions.recordEdit(gesture.before);
            actions.expandPitchRange(engine.sequence.notes);
        }
        editorState.suppressResizeClick = gesture.moved;
        releasePointer(gesture.pointerId);
        actions.refreshNoteControls();
        actions.syncEditorState();
    }

    function bind() {
        pianoCanvas.onclick = handleCanvasClick;
        pianoCanvas.ondblclick = (event) => {
            if (editorState.workspaceMode !== 'tracks' || editorState.trackGesture || suppressTrackOpen || canvasPoint(event).x < 24) {
                return;
            }
            const track = actions.overviewTrackAt(canvasPoint(event));
            if (track && !track.audio) actions.runEditorAction(() => actions.setWorkspace('piano', track.id));
        };
        pianoCanvas.onpointerdown = beginGesture;
        pianoCanvas.onpointermove = moveGesture;
        pianoCanvas.onpointerup = finishGesture;
        pianoCanvas.onpointercancel = (event) => {
            if (editorState.editGesture?.pointerId === event.pointerId || editorState.arrangement.gesture?.pointerId === event.pointerId) {
                cancelEditorGesture();
            } else {
                cancelPointerGesture(event);
            }
        };
        pianoCanvas.onlostpointercapture = pianoCanvas.onpointercancel;
    }

    return { bind, canvasPoint, moveCursor, releasePointer, cancelEditorGesture, moveTrackGesture, updateTrackDragScroll };
}
