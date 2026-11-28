// Zoom, scrolling, pitch range and the local editing cursor.
function createViewportUI(editorState, actions) {
    const { KEYBOARD_WIDTH, engine, pianoViewport, playbackFollow, getElement, pianoSpacer, RULER_HEIGHT, baseGeometry } = editorState;

    let cursorSequence = null;
    let observedScrollLeft = pianoViewport.scrollLeft;

    function horizontalScrollLimit() {
        return Math.max(0, KEYBOARD_WIDTH + engine.totalSteps * editorState.STEP_WIDTH - pianoViewport.clientWidth);
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
            contentX: position ? engine.sequence.tickToStep(position.ticks) * editorState.STEP_WIDTH : 0,
            scrollLeft: pianoViewport.scrollLeft,
            width: pianoViewport.clientWidth,
            maxScroll: horizontalScrollLimit()
        };
    }

    function updatePlaybackFollow(position) {
        // Check actual position before every automatic write, not just on scroll-event delivery.
        // Delayed/coalesced events therefore cannot mistake our last applied offset for user input.
        const manuallyScrolled = reconcileHorizontalScroll();
        if (editorState.editGesture || editorState.resizeGesture || editorState.cursorGesture || editorState.trackGesture || editorState.arrangement.gesture) {
            playbackFollow.interrupt();
            return manuallyScrolled;
        }
        const left = playbackFollow.update(followSample(position));
        const automaticallyScrolled = left !== null && scrollHorizontally(left, true);
        return manuallyScrolled || automaticallyScrolled;
    }

    function syncEditingCursor() {
        if (cursorSequence !== engine.sequence) {
            cursorSequence = engine.sequence;
            editorState.editingCursorTick = 0;
        }
        editorState.editingCursorTick = Math.min(editorState.editingCursorTick,
            Math.floor(engine.sequence.stepToTick(engine.totalSteps)));
        getElement('cursorPosition').textContent = PianoRollEditor.cursorLabel(engine.sequence, editorState.editingCursorTick);
    }

    function resizePianoContent() {
        pianoSpacer.style.width = `${KEYBOARD_WIDTH + engine.totalSteps * editorState.STEP_WIDTH}px`;
        const contentHeight = editorState.workspaceMode === 'tracks' ? actions.overviewTracks().length * TrackOverview.laneHeight
            : (editorState.highestPitch - editorState.lowestPitch + 1) * editorState.ROW_HEIGHT;
        pianoSpacer.style.height = `${RULER_HEIGHT + contentHeight}px`;
    }

    const zoomInput = getElement('zoom');

    const zoomPercentage = getElement('zoomPercentage');

    let zoomPercent = 100;

    let zoomTarget = zoomPercent;

    editorState.pendingZoom = null;

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
        editorState.pendingZoom = { point };
    }

    function applyPendingZoom() {
        const { point: pointer } = editorState.pendingZoom;
        editorState.pendingZoom = null;
        const percent = Math.max(zoomMin, zoomTarget < 50 ? Number(zoomTarget.toPrecision(4)) : Math.round(zoomTarget));
        if (zoomInput.value !== String(percent)) zoomInput.value = String(percent);
        if (percent === zoomPercent) return;
        actions.cancelEditorGesture();
        const point = pointer ? actions.canvasPoint(pointer) : null;
        const gridWidth = Math.max(0, pianoViewport.clientWidth - KEYBOARD_WIDTH);
        const gridHeight = Math.max(0, pianoViewport.clientHeight - RULER_HEIGHT);
        const anchorX = point ? Math.max(0, Math.min(gridWidth, point.x - KEYBOARD_WIDTH)) : gridWidth / 2;
        const anchorY = point && editorState.workspaceMode === 'piano'
            ? Math.max(0, Math.min(gridHeight, point.y - RULER_HEIGHT)) : gridHeight / 2;
        const anchorStep = Math.min(engine.totalSteps, (pianoViewport.scrollLeft + anchorX) / editorState.STEP_WIDTH);
        const pitchScroll = editorState.workspaceMode === 'piano' ? pianoViewport.scrollTop : editorState.pianoScrollTop;
        const pitchCount = editorState.highestPitch - editorState.lowestPitch + 1;
        const anchorRow = Math.min(pitchCount, (pitchScroll + anchorY) / editorState.ROW_HEIGHT);

        zoomPercent = percent;
        editorState.STEP_WIDTH = PianoRollEditor.geometry.stepWidth = baseGeometry.stepWidth * percent / 100;
        editorState.ROW_HEIGHT = PianoRollEditor.geometry.rowHeight = baseGeometry.rowHeight * Math.max(50, percent) / 100;
        zoomInput.setAttribute('aria-valuetext', zoomLabel(percent));
        zoomPercentage.textContent = zoomLabel(percent);
        resizePianoContent();
        playbackFollow.interrupt();
        scrollHorizontally(anchorStep * editorState.STEP_WIDTH - anchorX);
        const maxTop = Math.max(0, RULER_HEIGHT + pitchCount * editorState.ROW_HEIGHT - pianoViewport.clientHeight);
        editorState.pianoScrollTop = Math.min(maxTop, Math.max(0, anchorRow * editorState.ROW_HEIGHT - anchorY));
        if (editorState.workspaceMode === 'piano') pianoViewport.scrollTop = editorState.pianoScrollTop;
        editorState.pendingViewportRender = true;
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

    function currentView() {
        return {
            width: pianoViewport.clientWidth,
            height: pianoViewport.clientHeight,
            scrollLeft: pianoViewport.scrollLeft,
            scrollTop: pianoViewport.scrollTop,
            lowestPitch: editorState.lowestPitch,
            highestPitch: editorState.highestPitch
        };
    }

    function expandPitchRange(notes) {
        for (const note of notes) {
            editorState.lowestPitch = Math.min(editorState.lowestPitch, note.midi);
            editorState.highestPitch = Math.max(editorState.highestPitch, note.midi);
        }
        getElement('pitchLow').value = editorState.lowestPitch;
        getElement('pitchHigh').value = editorState.highestPitch;
    }

    function findNotes(notes = editorState.workspaceMode === 'tracks'
        ? PianoRollEditor.eligibleNotes(engine.sequence) : actions.editableNotes(true)) {
        if (!notes.length) {
            actions.showStatus('No notes to find. Add a note or import MIDI.');
            return;
        }
        if (editorState.workspaceMode === 'tracks') {
            const first = notes.reduce((earliest, note) => note.ticks < earliest.ticks ? note : earliest);
            scrollHorizontally(engine.sequence.tickToStep(first.ticks) * editorState.STEP_WIDTH - 2 * editorState.STEP_WIDTH);
            const index = engine.sequence.tracks.findIndex((track) => track.id === first.trackId);
            const gridHeight = Math.max(0, pianoViewport.clientHeight - RULER_HEIGHT);
            const maxTop = Math.max(0, engine.sequence.tracks.length * TrackOverview.laneHeight - gridHeight);
            pianoViewport.scrollTop = Math.max(0, Math.min(maxTop, index * TrackOverview.laneHeight));
            actions.renderPianoRoll();
            return;
        }
        expandPitchRange(notes);
        actions.syncEditorState();
        const target = PianoRollEditor.navigation(notes, engine.sequence, currentView());
        const maxLeft = Math.max(
            0,
            KEYBOARD_WIDTH + engine.totalSteps * editorState.STEP_WIDTH - pianoViewport.clientWidth
        );
        const maxTop = Math.max(
            0,
            RULER_HEIGHT +
                (editorState.highestPitch - editorState.lowestPitch + 1) * editorState.ROW_HEIGHT -
                pianoViewport.clientHeight
        );
        scrollHorizontally(Math.min(maxLeft, target.scrollLeft));
        pianoViewport.scrollTop = Math.min(maxTop, target.scrollTop);
        actions.renderPianoRoll();
    }

    function setEditingCursor(ticks, seekPaused = true) {
        editorState.editingCursorTick = ticks;
        if (seekPaused && engine.isPaused) {
            const compositionEnd = engine.sequence.stepToTick(engine.totalSteps);
            // The cursor's last integer tick represents the end of a fractional-tick pattern.
            engine.seekPaused(ticks === Math.floor(compositionEnd) ? compositionEnd : ticks);
            editorState.displayedStep = engine.sequence.tickToStep(engine.getPlaybackTick());
        }
        getElement('cursorPosition').textContent = PianoRollEditor.cursorLabel(engine.sequence, ticks);
        actions.renderPianoRoll();
    }

    function updatePitchRange() {
        actions.cancelEditorGesture();
        const newLowestPitch = Number(getElement('pitchLow').value);
        const newHighestPitch = Number(getElement('pitchHigh').value);
        if (
            !Number.isInteger(newLowestPitch) ||
            !Number.isInteger(newHighestPitch) ||
            newLowestPitch < 0 ||
            newHighestPitch > 127 ||
            newLowestPitch > newHighestPitch
        ) {
            actions.showStatus('Pitch range must satisfy 0 ≤ low ≤ high ≤ 127.');
        } else {
            editorState.lowestPitch = newLowestPitch;
            editorState.highestPitch = newHighestPitch;
            pianoViewport.scrollTop = 0;
            actions.syncEditorState();
        }
        getElement('pitchLow').value = editorState.lowestPitch;
        getElement('pitchHigh').value = editorState.highestPitch;
    }

    function bind() {
        zoomInput.value = String(zoomPercent);
        zoomInput.oninput = () => queueZoom(Number(zoomInput.value));
        getElement('resetZoom').onclick = () => queueZoom(100);
        getElement('zoomControl').addEventListener('wheel', (event) => zoomFromWheel(event), { passive: false });
        getElement('findNotes').onclick = () => findNotes();
        getElement('pitchLow').onchange = getElement('pitchHigh').onchange = updatePitchRange;
        pianoViewport.addEventListener('wheel', (event) => {
            if ((event.ctrlKey || event.metaKey) && zoomFromWheel(event, zoomPointer(event))) return;
            if (event.deltaX || (event.shiftKey && event.deltaY)) {
                playbackFollow.interrupt();
            }
        }, { passive: false });
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
            editorState.pendingViewportRender = true;
            if (editorState.cursorGesture) {
                actions.moveCursor(editorState.cursorGesture);
            }
            if (editorState.trackGesture) {
                actions.moveTrackGesture(editorState.trackGesture);
            }
            if (editorState.arrangement.gesture) editorState.arrangement.move(editorState.arrangement.gesture);
        });
    }

    return { bind, scrollHorizontally, updatePlaybackFollow, syncEditingCursor, resizePianoContent, refreshZoomMinimum, applyPendingZoom, currentView, expandPitchRange, findNotes, setEditingCursor };
}
