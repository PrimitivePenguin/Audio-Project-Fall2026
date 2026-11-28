// Viewport culling and drawing for the piano roll and track overview.
function createRendering(editorState, actions) {
    const { engine, RULER_HEIGHT, KEYBOARD_WIDTH, pianoViewport, drawingContext, ROLL, pianoCanvas, selectedIds } = editorState;

    let renderIndex = null;
    let renderIndexSequence = null;
    let renderIndexNotes = null;
    let renderIndexLength = -1;
    let renderLanes = null;
    let lastHighlightKey = null;
    let canvasSizeKey = '';

    function invalidateRenderIndex() {
        renderIndex = null;
        renderLanes = null;
    }

    function getRenderIndex() {
        const sequence = engine.sequence;
        if (!renderIndex || renderIndexSequence !== sequence || renderIndexNotes !== sequence.notes ||
            renderIndexLength !== sequence.notes.length) {
            renderIndex = new NoteRenderIndex(sequence);
            renderLanes = TrackOverview.lanes(sequence, actions.overviewTracks());
            renderIndexSequence = sequence;
            renderIndexNotes = sequence.notes;
            renderIndexLength = sequence.notes.length;
        }
        return renderIndex;
    }

    function visibleRenderNotes(width, height, scrollLeft, scrollTop, allPitches = false) {
        const index = getRenderIndex();
        const low = allPitches ? 0 : Math.max(editorState.lowestPitch,
            Math.floor(editorState.highestPitch - (height + scrollTop - RULER_HEIGHT) / editorState.ROW_HEIGHT));
        const high = allPitches ? 127 : Math.min(editorState.highestPitch,
            Math.ceil(editorState.highestPitch - scrollTop / editorState.ROW_HEIGHT + 1));
        return index.query(engine.sequence.stepToTick((scrollLeft - 8) / editorState.STEP_WIDTH),
            engine.sequence.stepToTick((scrollLeft + width - KEYBOARD_WIDTH) / editorState.STEP_WIDTH), low, high);
    }

    function renderPianoRoll() {
        editorState.pendingViewportRender = false;
        actions.refreshZoomMinimum();
        const width = pianoViewport.clientWidth;
        const height = pianoViewport.clientHeight;
        const scrollLeft = pianoViewport.scrollLeft;
        const scrollTop = pianoViewport.scrollTop;
        prepareCanvas(width, height);
        let noteRects = [];
        const first = Math.max(0, Math.floor(scrollLeft / editorState.STEP_WIDTH));
        const endStep = Math.min(engine.totalSteps, (scrollLeft + Math.max(0, width - KEYBOARD_WIDTH)) / editorState.STEP_WIDTH);
        const last = Math.ceil(endStep);
        const sequence = engine.sequence;
        const meterMarks = [...sequence.meterMarks(sequence.stepToTick(scrollLeft / editorState.STEP_WIDTH),
            sequence.stepToTick(endStep), sequence.stepToTick(4 / editorState.STEP_WIDTH))].filter((mark) => editorState.STEP_WIDTH >= 4 || mark.kind === 'measure');

        if (editorState.workspaceMode === 'tracks') {
            noteRects = drawTrackOverview(width, height, first, last, scrollLeft, scrollTop, meterMarks);
        } else {
            if (editorState.laneButtons.size) actions.renderLaneControls([], height, scrollTop);
            drawPitchRows(width, height, scrollTop);
            drawTimingGrid(first, last, height, scrollLeft, meterMarks);
            drawLoopRegion(width, height, scrollLeft);
            noteRects = drawNoteBlocks(width, height, scrollLeft, scrollTop);
        }
        if (editorState.editGesture?.kind === 'marquee' && editorState.editGesture.moved) {
            const a = editorState.editGesture.start;
            const b = editorState.editGesture.point;
            drawingContext.strokeStyle = ROLL.marquee;
            drawingContext.fillStyle = ROLL.marqueeFill;
            const x = Math.min(a.x, b.x) - scrollLeft;
            const y = Math.min(a.y, b.y) - scrollTop;
            drawingContext.fillRect(x, y, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
            drawingContext.strokeRect(x, y, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
        }
        if (editorState.workspaceMode === 'piano') {
            drawPianoKeys(height, scrollTop);
        }
        drawMeasureRuler(first, last, width, scrollLeft, meterMarks);
        const cursorX = KEYBOARD_WIDTH + engine.sequence.tickToStep(editorState.editingCursorTick) * editorState.STEP_WIDTH - scrollLeft;
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
        actions.drawAutomationLane();
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
            let row = Math.max(0, Math.floor(scrollTop / editorState.ROW_HEIGHT));
            row <=
            Math.min(editorState.highestPitch - editorState.lowestPitch, Math.ceil((scrollTop + height) / editorState.ROW_HEIGHT));
            row++
        ) {
            const midi = editorState.highestPitch - row;
            const y = RULER_HEIGHT + row * editorState.ROW_HEIGHT - scrollTop;
            const isBlackKey = [1, 3, 6, 8, 10].includes(midi % 12);
            drawingContext.fillStyle = isBlackKey ? ROLL.rowSharp : ROLL.bg;
            drawingContext.fillRect(KEYBOARD_WIDTH, y, width - KEYBOARD_WIDTH, editorState.ROW_HEIGHT);
            drawingContext.strokeStyle = ROLL.rowLine;
            drawingContext.beginPath();
            drawingContext.moveTo(KEYBOARD_WIDTH, y + editorState.ROW_HEIGHT);
            drawingContext.lineTo(width, y + editorState.ROW_HEIGHT);
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

        const subdivision = editorState.snapMode === 'thirty-second' ? 0.5 : 1;
        drawingContext.strokeStyle = ROLL.rowLine;
        drawingContext.lineWidth = 1;
        drawingContext.beginPath();
        for (let step = first; editorState.STEP_WIDTH * subdivision >= 5 && step <= last; step += subdivision) {
            const x = KEYBOARD_WIDTH + step * editorState.STEP_WIDTH - scrollLeft;
            if (x < KEYBOARD_WIDTH) continue;
            drawingContext.moveTo(x, RULER_HEIGHT);
            drawingContext.lineTo(x, height);
        }
        drawingContext.stroke();
        for (const mark of meterMarks) {
            const x = KEYBOARD_WIDTH + engine.sequence.tickToStep(mark.ticks) * editorState.STEP_WIDTH - scrollLeft;
            const weight = mark.kind === 'measure' ? 2 : mark.kind === 'group' ? 1.5 : 1;
            drawLine(x, mark.kind === 'subdivision' ? ROLL.rowLine : ROLL.beatLine, weight);
        }
        drawingContext.lineWidth = 1;
    }

    function drawLoopRegion(width, height, scrollLeft) {
        const loopX = KEYBOARD_WIDTH + engine.loopStart * editorState.STEP_WIDTH - scrollLeft;
        const loopEndX = KEYBOARD_WIDTH + engine.loopEnd * editorState.STEP_WIDTH - scrollLeft;
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
            if (note.midi < editorState.lowestPitch || note.midi > editorState.highestPitch) {
                return;
            }
            const startStep = preview ? engine.sequence.tickToStep(preview.ticks) : note.startStep;
            const durationSteps = preview
                ? engine.sequence.tickToStep(preview.durationTicks)
                : note.durationSteps;
            const x = KEYBOARD_WIDTH + startStep * editorState.STEP_WIDTH - scrollLeft;
            const y = RULER_HEIGHT + (editorState.highestPitch - (preview?.midi ?? note.midi)) * editorState.ROW_HEIGHT - scrollTop;
            const displayWidth = Math.max(8, durationSteps * editorState.STEP_WIDTH);
            if (
                x + displayWidth < KEYBOARD_WIDTH ||
                x > width ||
                y + editorState.ROW_HEIGHT < RULER_HEIGHT ||
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
            const block = { x: x + 1, y: y + 1, width: Math.max(6, displayWidth - 2), height: editorState.ROW_HEIGHT - 2 };
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
        if (editorState.activeTrackId !== null && editorState.ghostNotesEnabled) {
            drawingContext.globalAlpha = 0.22;
            for (const note of visible) {
                if (eligibleTrack(note) && note.trackId !== editorState.activeTrackId) drawBlock(note, null, false);
            }
            drawingContext.globalAlpha = 1;
        }
        const eligible = visible.filter((note) => eligibleTrack(note) &&
            (editorState.activeTrackId === null || note.trackId === editorState.activeTrackId));
        // An originally offscreen selected note can move into view during a preview.
        const visibleIds = new Set(eligible.map((note) => note.id));
        const previewIds = new Set([...(editorState.editGesture?.previews?.keys() ?? []),
            ...(editorState.resizeGesture?.previews?.keys() ?? []), ...(editorState.resizeGesture?.noteId ? [editorState.resizeGesture.noteId] : [])]);
        for (const id of previewIds) {
            const note = getRenderIndex().byId.get(id);
            if (note && !visibleIds.has(id) && eligibleTrack(note) &&
                (editorState.activeTrackId === null || note.trackId === editorState.activeTrackId)) eligible.push(note);
        }
        const notes = eligible.filter((note) => note.id !== editorState.selectedNoteId);
        const selected = eligible.find((note) => note.id === editorState.selectedNoteId);
        if (selected) {
            notes.push(selected);
        }
        for (const note of notes) {
            const preview = editorState.editGesture?.previews?.get(note.id) ?? editorState.resizeGesture?.previews?.get(note.id) ??
                (editorState.resizeGesture?.noteId === note.id ? editorState.resizeGesture.preview : null);
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
        if (editorState.displayedStep !== null) {
            const x = KEYBOARD_WIDTH + editorState.displayedStep * editorState.STEP_WIDTH - scrollLeft;
            drawingContext.fillStyle = ROLL.playback;
            drawingContext.fillRect(x, RULER_HEIGHT, 2, height);
        }
    }

    function drawTrackOverview(width, height, first, last, scrollLeft, scrollTop, meterMarks) {
        getRenderIndex();
        const lanes = renderLanes;
        const visible = lanes.filter((lane) => {
            const y = RULER_HEIGHT + lane.index * TrackOverview.laneHeight - scrollTop;
            return y + TrackOverview.laneHeight > RULER_HEIGHT && y < height;
        });
        actions.renderLaneControls(visible, height, scrollTop);
        for (const lane of visible) {
            const y = RULER_HEIGHT + lane.index * TrackOverview.laneHeight - scrollTop;
            drawingContext.fillStyle = lane.track.id === (editorState.activeTrackId ?? editorState.arrangement.trackId) ? ROLL.laneActive : lane.index % 2 ? ROLL.laneAlt : ROLL.bg;
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
            const from = sequence.stepToTick((scrollLeft - 8) / editorState.STEP_WIDTH);
            const to = sequence.stepToTick((scrollLeft + width - KEYBOARD_WIDTH) / editorState.STEP_WIDTH);
            for (const entry of engine.arrangement.query(sequence, from, to, true)) {
                clipsByLane.get(entry.clip.trackId)?.push(entry);
            }
        }
        for (const lane of visible) {
            const muted = engine.mutedLanes.has(lane.track.id);
            drawingContext.globalAlpha = muted ? 0.55 : 1;
            if (lane.track.audio) {
                editorState.arrangement.draw(drawingContext, lane, { width, height, scrollLeft, scrollTop, clipsByLane, clipMasks });
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
            drawingContext.fillStyle = lane.track.id === (editorState.activeTrackId ?? editorState.arrangement.trackId) ? ROLL.laneHeaderActive : ROLL.laneHeader;
            drawingContext.fillRect(0, y, KEYBOARD_WIDTH, TrackOverview.laneHeight - 1);
            drawingContext.fillStyle = noteColor(lane.track.id);
            drawingContext.fillRect(0, y, 5, TrackOverview.laneHeight - 1);
            drawingContext.fillStyle = ROLL.text;
            const label = lane.track.name.length > 10 ? lane.track.name.slice(0, 9) + '…' : lane.track.name;
            for (const x of [10, 16]) {
                for (const offset of [12, 18, 24]) {
                    drawingContext.fillRect(x, y + offset, 2, 2);
                }
            }
            drawingContext.fillText(label, 28, y + 28, 69);
            const count = lane.track.audio ? engine.arrangement.getIndex(sequence).counts.get(lane.track.id) ?? 0 : lane.notes.length;
            const noun = lane.track.audio ? 'clip' : 'note';
            drawingContext.fillText(`${count} ${noun}${count === 1 ? '' : 's'}`, 28, y + 48);
        }
        drawingContext.restore();
        if (editorState.trackGesture) {
            const y = RULER_HEIGHT + editorState.trackGesture.fromIndex * TrackOverview.laneHeight - scrollTop;
            drawingContext.fillStyle = ROLL.marqueeFill;
            drawingContext.fillRect(0, Math.max(RULER_HEIGHT, y), width,
                Math.max(0, Math.min(height, y + TrackOverview.laneHeight) - Math.max(RULER_HEIGHT, y)));
            if (editorState.trackGesture.valid) {
                const line = RULER_HEIGHT + editorState.trackGesture.boundary * TrackOverview.laneHeight - scrollTop;
                if (line >= RULER_HEIGHT && line <= height) {
                    drawingContext.fillStyle = ROLL.marquee;
                    drawingContext.fillRect(0, line, width, 3);
                }
            }
        }
        const destination = editorState.arrangement.dropPreview;
        if (destination && !destination.trackId) {
            const index = destination.below ? lanes.findIndex(({ track }) => track.id === destination.below) + 1 : lanes.length;
            const y = Math.max(RULER_HEIGHT, Math.min(height - 4,
                RULER_HEIGHT + index * TrackOverview.laneHeight - scrollTop));
            const x = Math.max(KEYBOARD_WIDTH, KEYBOARD_WIDTH + sequence.tickToStep(destination.startTick) * editorState.STEP_WIDTH - scrollLeft);
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
        drawingContext.font = `${Math.min(11, editorState.ROW_HEIGHT - 2)}px system-ui`;
        drawingContext.textAlign = 'right';
        for (
            let row = Math.max(0, Math.floor(scrollTop / editorState.ROW_HEIGHT));
            row <=
            Math.min(editorState.highestPitch - editorState.lowestPitch, Math.ceil((scrollTop + height) / editorState.ROW_HEIGHT));
            row++
        ) {
            const midi = editorState.highestPitch - row;
            const y = RULER_HEIGHT + row * editorState.ROW_HEIGHT - scrollTop;
            const isBlackKey = [1, 3, 6, 8, 10].includes(midi % 12);
            drawingContext.fillStyle = isBlackKey ? ROLL.keyBlack : ROLL.keyWhite;
            drawingContext.fillRect(0, y, KEYBOARD_WIDTH, editorState.ROW_HEIGHT - 1);
            drawingContext.fillStyle = isBlackKey ? ROLL.keyLabelOnBlack : ROLL.keyLabel;
            drawingContext.fillText(NoteSequence.pitchName(midi), KEYBOARD_WIDTH - 8, y + editorState.ROW_HEIGHT / 2 + 4);
        }
    }

    function drawMeasureRuler(first, last, width, scrollLeft, meterMarks) {
        drawingContext.fillStyle = ROLL.rulerBg;
        drawingContext.fillRect(0, 0, width, RULER_HEIGHT);
        drawingContext.textAlign = 'left';
        drawingContext.font = '11px system-ui';
        drawingContext.fillStyle = ROLL.text;
        drawingContext.fillText(editorState.workspaceMode === 'tracks' ? 'Tracks / Time' : 'Pitch / Measure', 4, 20);
        const bars = meterMarks.filter((mark) => mark.kind === 'measure');
        if (editorState.STEP_WIDTH < 18) first = last;
        let barIndex = 0;
        let labelEnd = KEYBOARD_WIDTH;
        for (let step = first; step < last || barIndex < bars.length;) {
            const bar = bars[barIndex];
            const barStep = bar ? engine.sequence.tickToStep(bar.ticks) : Infinity;
            const isBar = barStep <= step || step >= last;
            const x = KEYBOARD_WIDTH + (isBar ? barStep : step) * editorState.STEP_WIDTH - scrollLeft;
            const label = isBar ? `M${bar.measure}` : String(step + 1);
            if (isBar) {
                barIndex++;
                if (barStep === step) step++;
            } else {
                step++;
            }
            const labelWidth = 7 * label.length + 5;
            const nextBarX = KEYBOARD_WIDTH + barStep * editorState.STEP_WIDTH - scrollLeft;
            if (x + 1e-8 >= labelEnd && x + 3 < width && (isBar || x + labelWidth <= nextBarX)) {
                drawingContext.fillText(label, x + 3, 20);
                labelEnd = x + labelWidth;
            }
        }
    }

    function noteColor(trackId) {
        return TrackOverview.color(trackId);
    }

    return { invalidateRenderIndex, getRenderIndex, renderPianoRoll, noteColor };
}
