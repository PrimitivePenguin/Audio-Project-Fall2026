// Database snapshots, permissions, MIDI imports and collaboration.
function createProjectUI(editorState, actions) {
    const { engine, selectedIds, pianoViewport, getElement, pianoCanvas, RULER_HEIGHT } = editorState;

    let latestMidiImportId = 0;
    let unavailableSample = null;
    let databaseSaveInFlight = false;

    let isApplyingRemote = false;

    function broadcastSync(type, targetId = null, payload = null) {
        if (isApplyingRemote || !editorState.databaseProject || editorState.databaseProject.role === 'VIEWER') return;
        editorState.collab.publish(type, targetId, payload);
    }

    let reviewingDraft = false;

    function applyProjectDataFromServer(data, serverName) {
        const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
        if (!data || !integer(data.stepCount, 1, 65536) || !integer(data.ppq, 1, 32767) ||
            !Array.isArray(data.tracks) || !data.tracks.length || !Array.isArray(data.notes)) {
            throw new Error('Invalid project timeline.');
        }
        const sequence = new NoteSequence(data.stepCount, data.ppq);
        sequence.name = [serverName, data.name].find((name) => typeof name === 'string' && name) || 'JukeBox';
        const ids = new Set();
        sequence.tracks = data.tracks.map((track) => {
            if (typeof track?.id !== 'string' || !track.id || ids.has(track.id) || typeof track.name !== 'string') {
                throw new Error('Invalid or duplicate project track.');
            }
            ids.add(track.id);
            return { ...track };
        });
        const validEvents = (events, validValue) => Array.isArray(events) && events.length > 0 &&
            events.every((event, index) => integer(event?.ticks, 0, Number.MAX_SAFE_INTEGER) &&
                (!index || event.ticks >= events[index - 1].ticks) && validValue(event));
        if (!validEvents(data.tempos, ({ bpm }) => Number.isFinite(bpm) && bpm > 0) ||
            !validEvents(data.timeSignatures, ({ timeSignature }) => Array.isArray(timeSignature) &&
                timeSignature.length === 2 && timeSignature.every((part) => integer(part, 1, 128)))) {
            throw new Error('Invalid tempo or meter map.');
        }
        sequence.tempos = data.tempos;
        sequence.timeSignatures = data.timeSignatures;
        sequence.importInfo = data.importInfo ?? null;
        for (const note of data.notes) sequence.addNote(note);
        const next = new AudioArrangement(data.arrangement);
        if (data.arrangement && (data.arrangement.version !== 1 ||
            next.tracks.size !== data.arrangement.tracks?.length ||
            next.assets.size !== data.arrangement.assets?.length ||
            next.clips.size !== data.arrangement.clips?.length ||
            [...next.tracks.keys()].some((id) => ids.has(id)))) {
            throw new Error('Invalid audio arrangement.');
        }
        const { loopStart, loopEnd } = data;
        if (!integer(loopStart, 0, data.stepCount - 1) || !integer(loopEnd, loopStart + 1, data.stepCount)) {
            throw new Error('Invalid project loop.');
        }
        for (const [id, asset] of next.assets) {
            const cached = engine.arrangement.assets.get(id);
            if (cached?.buffer) {
                for (const key of ['buffer', 'waveform', 'spectrogram', 'local', 'bytes', 'previewStatus']) {
                    asset[key] = cached[key];
                }
            }
        }

        const prevNotes = new Set(selectedIds);
        const prevClips = new Set(editorState.arrangement.selected);
        const prevTrack = editorState.activeTrackId;
        const cursorStep = engine.sequence.tickToStep(editorState.editingCursorTick);
        const { scrollLeft, scrollTop } = pianoViewport;
        isApplyingRemote = true;
        try {
            // Transport is local. Stop before replacing models to release old voices and clips.
            actions.stopPlayback();
            engine.arrangement = new AudioArrangement();
            engine.replaceSequence(sequence);
            engine.arrangement = next;
            engine.setLoopRange(loopStart, loopEnd);
            const instruments = data.instruments?.version === 1 ? data.instruments : null;
            window.jukeboxSynth?.restoreState(instruments?.synth ?? null);
            engine.restoreMix(instruments?.mixer, true);
            window.jukeboxDrums?.restoreState(instruments?.drums ?? null);
            engine.restoreAutomation(instruments?.automation);
            const mutes = new Set(Array.isArray(data.mutedLanes) ? data.mutedLanes : []);
            for (const id of new Set([...engine.mutedLanes, ...mutes])) engine.setLaneMuted(id, mutes.has(id));
            unavailableSample = data.sample ?? null;
            editorState.arrangement.restoreAssets();
            actions.checkHistory();
            editorState.workspaceSequence = sequence;
            editorState.activeTrackId = sequence.tracks.some((track) => track.id === prevTrack) ? prevTrack : null;
            for (const note of sequence.notes) if (prevNotes.has(note.id)) selectedIds.add(note.id);
            editorState.selectedNoteId = [...selectedIds][0] ?? null;
            editorState.arrangement.setSelection(prevClips, editorState.arrangement.trackId);
            actions.expandPitchRange(sequence.notes);
            actions.syncEditorState();
            actions.setEditingCursor(Math.min(Math.round(sequence.stepToTick(cursorStep)), Math.floor(sequence.stepToTick(sequence.stepCount))), false);
            pianoViewport.scrollLeft = scrollLeft;
            pianoViewport.scrollTop = scrollTop;
            editorState.pendingViewportRender = true;
            return true;
        } finally {
            isApplyingRemote = false;
        }
    }

    const draftButton = getElement('downloadCollabDraft');

    editorState.collab = new ProjectCollabClient({
        getProject: () => editorState.databaseProject,
        getSnapshot: () => databaseSnapshot(),
        canPublish: () => !databaseSaveInFlight,
        onRemoteEvent: (event, isFullSnapshot) => {
            if (!event.snapshot) return false;
            if (editorState.editGesture || editorState.resizeGesture || editorState.trackGesture || editorState.arrangement.gesture || editorState.autoGesture || editorState.pointerInput) {
                editorState.collab.conflict('A collaborator saved during an active edit.');
                broadcastSync('FULL_SYNC', 'draft');
                return false;
            }
            try {
                const applied = applyProjectDataFromServer(JSON.parse(event.snapshot), event.name);
                if (applied && !isFullSnapshot) actions.showStatus(`Project updated to revision ${event.revision}.`);
                return applied;
            } catch (error) {
                actions.showStatus(`Remote update could not be applied: ${error.message}`);
                return false;
            }
        },
        onConflict: (message, draft) => {
            draftButton.hidden = getElement('discardCollabDraft').hidden = getElement('reviewCollabDraft').hidden = !draft;
            actions.showStatus(`${message} ${draft ? 'Download the local draft before reloading or resolving manually.' : 'Reload to resume synchronization.'}`);
        },
        onStatus: (message) => {
            if (editorState.databaseProject) actions.showStatus(message);
        }
    });

    function databaseSnapshot() {
        return {
            ...engine.sequence.toJSON(),
            ...(engine.arrangement.assets.size || engine.arrangement.tracks.size
                ? { arrangement: engine.arrangement.toJSON() } : {}),
            instruments: {
                version: 1,
                automation: engine.snapshotAutomation(),
                synth: window.jukeboxSynth?.snapshot() ?? null,
                drums: window.jukeboxDrums?.snapshot() ?? null,
                mixer: engine.snapshotMix()
            },
            loopStart: engine.loopStart,
            loopEnd: engine.loopEnd,
            sample: unavailableSample,
            mutedLanes: actions.overviewTracks().filter((track) => engine.mutedLanes.has(track.id)).map((track) => track.id)
        };
    }

    async function saveDatabaseProject() {
        if (editorState.arrangement.deletingAsset) {
            actions.showStatus('Wait for the sample deletion to finish.');
            return;
        }
        if (!editorState.databaseProject || editorState.databaseProject.role === 'VIEWER' || databaseSaveInFlight) {
            return;
        }
        if ((editorState.collab.blocked && !reviewingDraft) || editorState.collab.inFlight) {
            actions.showStatus(editorState.collab.blocked ? 'Resolve the collaboration draft before saving.' : 'Wait for the current collaboration update.');
            return;
        }
        if (reviewingDraft && !window.confirm(
            `Replace server revision ${editorState.databaseProject.version} with the reviewed draft? A newer server revision will reject the save.`)) return;
        databaseSaveInFlight = true;
        try {
            const summary = editorState.arrangement.sampleSaveSummary();
            const project = editorState.databaseProject;
            const snapshot = JSON.stringify(databaseSnapshot());
            editorState.collab.publish('FULL_SYNC', 'manual-save');
            const pendingAtSave = editorState.collab.pending;
            const { response, body } = await editorState.arrangement.withDeadline(async (signal) => {
                const response = await fetch(`/api/projects/${project.id}`, {
                    method: 'PUT', signal, credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', 'X-Jukebox-Client': editorState.collab.clientId },
                    body: JSON.stringify({ name: engine.sequence.name, projectData: snapshot, version: project.version })
                });
                return { response, body: await response.json().catch(() => null) };
            });
            if (!response.ok) {
                if (response.status === 409) {
                    editorState.collab.conflict(body?.error || 'The server has a newer project revision.');
                    broadcastSync('FULL_SYNC', 'draft');
                    return;
                }
                throw new Error(body?.error || `Save failed (${response.status})`);
            }
            if (editorState.databaseProject !== project) return;
            if (!Number.isSafeInteger(body?.version)) throw new Error('The server did not confirm a saved revision.');
            project.version = Math.max(project.version, body.version);
            if (editorState.collab.pending === pendingAtSave || editorState.collab.pending?.snapshot === snapshot) {
                editorState.collab.pending = null;
                editorState.collab.clearDraft();
            }
            if (reviewingDraft) {
                reviewingDraft = false;
                if (!editorState.collab.pending) editorState.collab.clearDraft();
                draftButton.hidden = getElement('reviewCollabDraft').hidden = getElement('discardCollabDraft').hidden = true;
                editorState.collab.blocked = false;
                editorState.collab.requestState();
            }
            actions.showStatus(`Saved "${engine.sequence.name}" to the database.${summary}`);
            editorState.arrangement.ensureAssetsUploaded();
        } catch (error) {
            actions.showStatus(`Save failed: ${error.message}`);
        } finally {
            databaseSaveInFlight = false;
            editorState.collab.flush();
        }
    }

    function applyDatabasePermissions() {
        if (editorState.databaseProject?.role !== 'VIEWER') {
            return;
        }
        pianoCanvas.style.pointerEvents = editorState.workspaceMode === 'tracks' ? '' : 'none';
        [
            'saveProject', 'bpm', 'timeSignature', 'loopStart', 'loopEnd', 'patternSteps', 'addBar',
            'removeBar', 'midiFile', 'newSequence', 'noteLength', 'lengthDecrease',
            'lengthIncrease', 'velocity', 'deleteNote', 'nextOverlap', 'pitchLow',
            'pitchHigh',
            'removeImportedMidi', 'addMidiTrack', 'renameMidiTrack', 'trackName',
            'undoNotes', 'redoNotes',
            'cutNotes', 'pasteNotes', 'duplicateNotes'
        ].forEach((id) => {
            const element = getElement(id);
            if (element) element.disabled = true;
        });

    }

    function resetEditorSelection() {
        editorState.overlapIds = [];
        editorState.suppressResizeClick = false;
        actions.selectNote(null);
        editorState.displayedStep = null;
    }

    function resetPitchViewport() {
        editorState.lowestPitch = 36;
        editorState.highestPitch = 83;
        actions.expandPitchRange(engine.sequence.notes);
        actions.syncEditorState();
        actions.scrollHorizontally(0);
        pianoViewport.scrollTop = editorState.workspaceMode === 'tracks' ? 0 : Math.max(
            0,
            RULER_HEIGHT + (editorState.highestPitch - 60) * editorState.ROW_HEIGHT - 288
        );
        actions.renderPianoRoll();
    }

    function removeImportedMidi() {
        latestMidiImportId++;
        editorState.midiImportController?.abort();
        actions.stopPlayback();
        try {
            engine.removeImportedMidi();
            getElement('midiFile').value = '';
            resetEditorSelection();
            resetPitchViewport();
            if (engine.sequence.notes.length) {
                actions.findNotes();
            }
            actions.showStatus(
                'Imported MIDI removed, including edited imported notes. Manual notes and audio samples retained.'
            );
            broadcastSync('FULL_SYNC', 'removeMidi');
        } catch (error) {
            actions.showStatus(`Could not remove MIDI: ${error.message}`);
        }
    }

    function startNewSequence() {
        if (editorState.arrangement.deletingAsset) {
            actions.showStatus('Wait for the sample deletion to finish.');
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
        editorState.midiImportController?.abort();
        unavailableSample = null;
        getElement('legacySampleWarning').hidden = true;
        actions.stopPlayback();
        engine.newSequence();
        editorState.arrangement.reset();
        window.jukeboxSynth?.restoreState(null);
        window.jukeboxDrums?.restoreState(null);
        editorState.collab.disconnect();
        editorState.databaseProject = null;
        reviewingDraft = false;
        draftButton.hidden = getElement('reviewCollabDraft').hidden = getElement('discardCollabDraft').hidden = true;
        getElement('saveProject').disabled = false;
        editorState.newNoteLengthSteps = 1;
        editorState.newNoteVelocity = 89;
        getElement('midiFile').value = '';
        resetEditorSelection();
        resetPitchViewport();
        actions.showStatus('New sequence. Add notes, then press Play.');
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
                actions.showStatus('Could not load database project: invalid pending project data.');
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
                actions.showStatus(`Could not load project: ${error.message}`);
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
            editorState.databaseProject = {
                id: saved.id,
                name: saved.name,
                role: saved.role,
                version: saved.version
            };
            getElement('saveProject').disabled = editorState.databaseProject.role === 'VIEWER';
            engine.arrangement = new AudioArrangement(data.arrangement);
            editorState.arrangement.restoreAssets();
            editorState.loadedInstrumentState = data.instruments?.version === 1 ? data.instruments : null;
            engine.restoreMix(editorState.loadedInstrumentState?.mixer);
            engine.restoreAutomation(editorState.loadedInstrumentState?.automation);
            engine.mutedLanes = new Set(Array.isArray(data.mutedLanes) ? data.mutedLanes.filter((id) => typeof id === 'string') : []);
            if (data.sample && typeof data.sample === 'object') {
              unavailableSample = { ...data.sample, audioPersisted: false };
              const warning = getElement('legacySampleWarning');
              warning.hidden = false;
              warning.textContent = 'Legacy sample triggers are retained in project data and are silent. Import the original audio into Sample Rack to arrange it as clips.';
            }
            resetEditorSelection();
            resetPitchViewport();
            actions.showStatus(`Loaded "${sequence.name}" from the database.${unavailableSample ? ' Legacy sample triggers are archived and silent.' : ''}`);
            applyDatabasePermissions();
            editorState.collab.connect(editorState.databaseProject.id);
        } catch (error) {
            actions.showStatus(`Could not load database project: ${error.message}`);
        }
    }

    function bind() {
        draftButton.onclick = () => {
            const draft = editorState.collab.draft ?? editorState.collab.readDraft();
            if (!draft) return;
            const url = URL.createObjectURL(new Blob([draft.snapshot], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'jukebox-collaboration-draft.json';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
        };
        getElement('reviewCollabDraft').onclick = () => actions.runEditorAction(() => {
            const draft = editorState.collab.draft ?? editorState.collab.readDraft();
            if (!draft) return;
            if (applyProjectDataFromServer(JSON.parse(draft.snapshot), draft.name)) {
                reviewingDraft = true;
                actions.showStatus('Viewing the local draft. Save Project can submit this reviewed version after confirmation.');
            }
        });
        getElement('discardCollabDraft').onclick = () => {
            if (!window.confirm('Discard the saved local draft and reload the latest server version?')) return;
            editorState.collab.pending = editorState.collab.inFlight = null;
            editorState.collab.clearDraft();
            window.location.reload();
        };
        window.addEventListener('focus', () => {
            if (editorState.databaseProject && editorState.collab.connected && !editorState.collab.inFlight && !editorState.collab.pending) {
                editorState.collab.requestState();
            }
        });
        getElement('saveProject').onclick = saveDatabaseProject;
        window.addEventListener('online', () => {
            editorState.arrangement.restoreAssets(true);
            editorState.arrangement.ensureAssetsUploaded();
        });
        getElement('midiFile').onchange = async (event) => {
            const file = event.target.files[0];
            if (!file) {
                return;
            }
            const token = ++latestMidiImportId;
            editorState.midiImportController?.abort();
            editorState.midiImportController = new AbortController();
            try {
                if (file.size > 10 * 1024 * 1024) {
                    throw new Error('MIDI limit: 10 MB.');
                }
                const buffer = await file.arrayBuffer();
                if (token !== latestMidiImportId) {
                    return;
                }
                const result = await MidiIO.parseAsync(buffer, { signal: editorState.midiImportController.signal });
                if (token !== latestMidiImportId) return;
                result.sequence = engine.importMidiSequence(result.sequence);
                actions.cancelEditorGesture();
                editorState.overlapIds = [];
                actions.selectNote(null);
                actions.expandPitchRange(engine.sequence.notes);
                actions.syncEditorState();
                const importId = engine.sequence.importInfo.id;
                actions.findNotes(engine.sequence.notes.filter((note) => note.importId === importId));
                actions.showStatus(
                    `Imported ${engine.sequence.notes.length} notes in ${engine.sequence.tracks.length} tracks. ${result.warnings.join(' ')}`
                );
                broadcastSync('FULL_SYNC', 'midiImport');
            } catch (error) {
                if (token === latestMidiImportId) {
                    actions.showStatus(`Import cancelled: ${error.message}. Existing composition retained.`);
                }
            } finally {
                if (token === latestMidiImportId) {
                    event.target.value = '';
                }
            }
        };
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
                actions.showStatus(`Exported full composition. ${result.warnings.join(' ')}`);
            } catch (error) {
                actions.showStatus(`Export failed: ${error.message}`);
            }
        };
    }

    return { bind, broadcastSync, applyDatabasePermissions, loadPendingDatabaseProject };
}
