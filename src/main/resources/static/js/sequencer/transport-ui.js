// Transport controls, meter and audio-clock playhead updates.
function createTransportUI(editorState, actions) {
    const { engine, playButton, getElement, bpmInput, undoStack, redoStack, supportedMeters, playbackFollow, loopStartInput, loopEndInput } = editorState;

    let playRequestId = 0;

    function updateTransportControls() {
        const busy = editorState.isStartingPlayback || engine.isPlaying || Boolean(engine.startPromise);
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
        actions.updateTrackActions();
        getElement('renameMidiTrack').disabled = busy || Boolean(editorState.trackGesture) || !actions.activeTrack();
        getElement('trackName').disabled = busy || !actions.activeTrack();
        bpmInput.disabled = engine.sequence.tempos.length > 1 || (busy && engine.arrangement.clips.size > 0);
        bpmInput.min = bpmInput.disabled ? '' : '40';
        bpmInput.max = bpmInput.disabled ? '' : '240';
        getElement('tempoInfo').textContent = engine.sequence.tempos.length > 1
            ? 'Imported tempo map active; BPM editing disabled.'
            : bpmInput.disabled ? 'Pause or stop before changing BPM with audio clips.'
            : 'BPM edits replace the constant tempo (40–240).';
        updateMeterControls(busy);
        editorState.arrangement.refreshInspector();
        actions.applyDatabasePermissions();
    }

    function resizePattern(steps) {
        actions.cancelEditorGesture();
        try {
            engine.setPatternLength(steps);
            undoStack.length = 0;
            redoStack.length = 0;
            actions.showStatus(`Pattern: ${steps} steps. No notes deleted.`);
            actions.broadcastSync('SETTINGS_SYNC', 'pattern');
        } catch (error) {
            actions.showStatus(error.message);
        }
        actions.syncEditorState();
    }

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

    function changeMeasureLength(direction) {
        const sequence = engine.sequence;
        const endTick = sequence.stepToTick(engine.totalSteps);
        const { meter } = sequence.positionAtTick(direction > 0 ? endTick : Math.ceil(endTick) - 1);
        const steps = Math.max(1, Math.round(16 * meter[0] / meter[1]));
        resizePattern(engine.totalSteps + direction * steps);
    }

    async function togglePlayback() {
        if (editorState.arrangement.deletingAsset) {
            actions.showStatus('Wait for the sample deletion to finish.');
            return;
        }
        if (editorState.isStartingPlayback || engine.isPlaying || engine.startPromise) {
            playRequestId++;
            engine.pause();
            playbackFollow.reset();
            editorState.isStartingPlayback = false;
            editorState.displayedStep = engine.sequence.tickToStep(engine.getPlaybackTick());
            updateTransportControls();
            actions.renderPianoRoll();
            actions.showStatus('Paused. Space or Resume continues from this position.');
            return;
        }
        const requestId = ++playRequestId;
        editorState.isStartingPlayback = true;
        updateTransportControls();
        try {
            await engine.play(editorState.editingCursorTick);
            if (requestId === playRequestId && engine.isPlaying) {
                actions.updatePlaybackFollow(engine.getPlaybackPosition());
                actions.showStatus('Playing. Edits affect notes not already queued.');
            }
        } catch (error) {
            if (requestId === playRequestId) {
                actions.showStatus(`Playback failed: ${error.message}`);
            }
        } finally {
            if (requestId === playRequestId) {
                editorState.isStartingPlayback = false;
                updateTransportControls();
            }
        }
    }

    function stopPlayback() {
        playRequestId++;
        playbackFollow.reset();
        actions.cancelEditorGesture();
        engine.stop();
        editorState.isStartingPlayback = false;
        updateTransportControls();
        editorState.displayedStep = null;
        actions.renderPianoRoll();
        actions.showStatus('Stopped. Position reset to loop start.');
    }

    function updatePlayhead(timestamp = 0) {
        if (editorState.pendingZoom) actions.applyPendingZoom();
        const trackScrolled = actions.updateTrackDragScroll(timestamp);
        const position = engine.audioContext && (engine.isPlaying || engine.isPaused)
            ? engine.getPlaybackPosition() : null;
        const step = position ? engine.sequence.tickToStep(position.ticks) : null;
        const scrolled = actions.updatePlaybackFollow(position);
        // Drain legacy step markers while the continuous line follows the same audio clock.
        if (engine.audioContext) {
            engine.getPlaybackStep();
        }
        if (step !== editorState.displayedStep || scrolled || trackScrolled || editorState.pendingViewportRender) {
            editorState.pendingViewportRender = false;
            editorState.displayedStep = step;
            actions.renderPianoRoll();
        }
        requestAnimationFrame(updatePlayhead);
    }

    function bind() {
        getElement('patternSteps').onchange = () =>
            resizePattern(Number(getElement('patternSteps').value));
        getElement('timeSignature').onchange = (event) => {
            const value = event.target.value;
            if (!meterSelection().editable || !supportedMeters.includes(value) ||
                editorState.databaseProject?.role === 'VIEWER' || engine.isPlaying || engine.startPromise) return;
            engine.sequence.timeSignatures = [{ ticks: 0, timeSignature: value.split('/').map(Number) }];
            actions.syncEditingCursor();
            updateMeterControls(false);
            actions.renderPianoRoll();
            actions.broadcastSync('SETTINGS_SYNC', 'timeSignature');
        };
        getElement('addBar').onclick = () => changeMeasureLength(1);
        getElement('removeBar').onclick = () => changeMeasureLength(-1);
        loopStartInput.onchange = loopEndInput.onchange = () => {
            try {
                if (!loopStartInput.value || !loopEndInput.value) {
                    throw new Error('Enter both loop endpoints.');
                }
                engine.setLoopRange(Number(loopStartInput.value) - 1, Number(loopEndInput.value));
                actions.showStatus(`Loop: ${engine.loopStart + 1}–${engine.loopEnd}.`);
                actions.broadcastSync('SETTINGS_SYNC', 'loop');
            } catch (error) {
                actions.showStatus(error.message);
            }
            actions.syncEditorState();
        };
        bpmInput.onchange = () => {
            try {
                if (!bpmInput.value.trim() || !Number.isFinite(Number(bpmInput.value))) {
                    throw new Error('Enter a BPM from 40 to 240.');
                }
                engine.setBpm(Number(bpmInput.value));
                editorState.pendingViewportRender = true;
                actions.showStatus(`Tempo: ${engine.bpm} BPM.`);
                actions.broadcastSync('SETTINGS_SYNC', 'bpm');
            } catch (error) {
                actions.showStatus(error.message);
            }
            bpmInput.value = engine.bpm;
        };
        playButton.onclick = togglePlayback;
        getElement('stopButton').onclick = stopPlayback;
        engine.onError = (error, details) => {
            if (details?.fatal !== false) {
                stopPlayback();
            }
            actions.showStatus(`Audio ${details?.fatal === false ? 'warning' : 'failure'}: ${error.message}`);
        };
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopPlayback();
            }
        });
        window.addEventListener('pagehide', () => {
            editorState.midiImportController?.abort();
            editorState.collab.disconnect();
            stopPlayback();
        });
    }

    return { bind, updateTransportControls, togglePlayback, stopPlayback, updatePlayhead };
}
