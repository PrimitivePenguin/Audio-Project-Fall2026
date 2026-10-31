const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEditorHarness } = require('./editor-test-support');

let passed = 0;
async function test(name, run) {
    await run();
    console.log('PASS', name);
    passed++;
}

function noteRectangles(harness) {
    return harness.canvasCalls.filter(
        (call) => call.method === 'strokeRect' && call.strokeStyle === '#1b467f'
    );
}

function ordinaryImport(harness, ppq = 480) {
    const sequence = new harness.NoteSequence(64, ppq);
    sequence.tracks = [
        { id: 'empty', name: 'Empty first track', channel: 0, program: 0 },
        { id: 'keys', name: 'Keys', channel: 1, program: 4 },
        { id: 'bass', name: 'Bass', channel: 2, program: 32 }
    ];
    sequence.addNote({
        midi: 60,
        startStep: 4,
        durationSteps: 4,
        trackId: 'keys',
        velocityMidi: 65
    });
    sequence.addNote({
        midi: 60,
        startStep: 4,
        durationSteps: 4,
        trackId: 'bass',
        velocityMidi: 91
    });
    sequence.tempos = [
        { ticks: 0, bpm: 90 },
        { ticks: ppq * 4, bpm: 180 }
    ];
    return sequence;
}

(async () => {
    await test('long MIDI with empty first track shows all tracks, auto-navigates, and keeps a viewport canvas', async () => {
        const h = createEditorHarness(2);
        const source = new h.NoteSequence(1696);
        source.tracks = Array.from({ length: 22 }, (_, index) => ({
            id: `track-${index}`,
            name: `Track ${index}`,
            channel: index % 16,
            program: index
        }));
        for (let index = 1; index < 22; index++) {
            source.addNote({
                midi: index === 21 ? 127 : 60 + (index % 4),
                startStep: index === 21 ? 1600 : 64,
                durationSteps: 2,
                trackId: source.tracks[index].id
            });
        }
        await h.importSequence(source);
        assert.equal(h.engine.sequence.notes.length, 21);
        assert.match(h.elements.compositionInfo.textContent, /21 notes total/);
        assert.equal(h.elements.pianoCanvas.width, 1800);
        assert.equal(h.elements.pianoCanvas.height, 1200);
        assert.ok(Number.parseFloat(h.elements.pianoSpacer.style.width) > 64000);
        assert.ok(h.elements.pianoViewport.scrollLeft > 0);
        assert.ok(noteRectangles(h).length >= 20);
        const first = h.engine.sequence.notes.find((note) => note.midi < 100);
        const bounds = h.noteBounds(first);
        assert.ok(bounds.x >= 100 && bounds.x < 900);
        assert.ok(bounds.y >= 32 && bounds.y < 600);
        const last = h.engine.sequence.notes.find((note) => note.midi === 127);
        h.elements.pianoViewport.scrollLeft = last.startStep * 38 - 76;
        h.elements.pianoViewport.scrollTop = 0;
        h.paint();
        assert.equal(noteRectangles(h).length, 1);
        assert.ok(noteRectangles(h)[0].args[0] >= 100);
        h.elements.findNotes.onclick();
        assert.ok(h.noteBounds(first).x < 900);
    });

    await test('full MIDI pitch range is accessible and Find Notes restores a narrowed viewport', async () => {
        const h = createEditorHarness();
        const source = new h.NoteSequence(64);
        source.addNote({ midi: 0, startStep: 32 });
        source.addNote({ midi: 127, startStep: 48 });
        await h.importSequence(source);
        assert.equal(Number(h.elements.pitchLow.value), 0);
        assert.equal(Number(h.elements.pitchHigh.value), 127);
        assert.ok(noteRectangles(h).length >= 1);
        h.elements.pitchLow.value = '36';
        h.elements.pitchHigh.value = '83';
        h.elements.pitchLow.onchange();
        h.elements.findNotes.onclick();
        assert.equal(Number(h.elements.pitchLow.value), 0);
        assert.equal(Number(h.elements.pitchHigh.value), 127);
        assert.ok(h.noteBounds(h.engine.sequence.notes[0]).y >= 32);
    });

    await test('overlap selection cycles IDs, edits only the selected track, and never merges notes', async () => {
        const h = createEditorHarness();
        await h.importSequence(ordinaryImport(h));
        const [first, second] = h.engine.sequence.notes;
        h.clickNote(first);
        assert.match(h.elements.noteInfo.textContent, /Bass/);
        h.elements.noteLength.value = '2';
        h.elements.noteLength.onchange();
        assert.equal(first.durationSteps, 4);
        assert.equal(second.durationSteps, 2);
        h.elements.nextOverlap.onclick();
        assert.match(h.elements.noteInfo.textContent, /Keys/);
        h.elements.velocity.value = '42';
        h.elements.velocity.onchange();
        assert.equal(first.velocityMidi, 42);
        assert.equal(second.velocityMidi, 91);
        const exported = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
        assert.equal(exported.notes.length, 2);
        assert.equal(exported.notes[0].trackId === exported.notes[1].trackId, false);
        assert.deepEqual(
            Array.from(
                exported.tracks.filter((track) => track.name === 'Keys' || track.name === 'Bass'),
                (track) => [track.name, track.channel, track.program]
            ),
            [
                ['Keys', 1, 4],
                ['Bass', 2, 32]
            ]
        );
    });

    await test('length controls increment 1–4 and decrement 4–1 without fractional offset', () => {
        const h = createEditorHarness();
        assert.equal(h.elements.noteLength.value, '1');
        for (const value of [2, 3, 4]) {
            h.elements.lengthIncrease.onclick();
            assert.equal(Number(h.elements.noteLength.value), value);
        }
        for (const value of [3, 2, 1]) {
            h.elements.lengthDecrease.onclick();
            assert.equal(Number(h.elements.noteLength.value), value);
        }
        const html = fs.readFileSync(
            path.resolve(__dirname, '../../main/resources/static/index.html'),
            'utf8'
        );
        assert.match(html, /id="noteLength" type="text"/);
        assert.doesNotMatch(html, /id="noteLength"[^>]*min="0\.001"/);
    });

    await test('fractional imported lengths stay tick-exact; input rejects invalid and out-of-bounds values', async () => {
        const h = createEditorHarness();
        const source = new h.NoteSequence(32, 101);
        source.addNote({ midi: 60, ticks: 17, durationTicks: 89 });
        await h.importSequence(source);
        const note = h.engine.sequence.notes[0];
        h.clickNote(note);
        assert.equal(Number(h.elements.noteLength.value), (89 * 4) / 101);
        for (const value of ['', '0', '-1', 'NaN', 'Infinity', '0.00001', '1000']) {
            h.elements.noteLength.value = value;
            h.elements.noteLength.onchange();
            assert.equal(note.durationTicks, 89);
            assert.equal(Number(h.elements.noteLength.value), (89 * 4) / 101);
        }
        h.elements.noteLength.value = '2';
        h.elements.noteLength.onchange();
        assert.equal(note.durationTicks, 51);
        assert.equal(note.ticks, 17);
    });

    await test('right-edge drag updates the same note, inspector, playback, and MIDI export', async () => {
        const h = createEditorHarness();
        const note = h.engine.sequence.addNote({ midi: 60, startStep: 0 });
        const id = note.id;
        h.drag(note, 'right', 4);
        assert.equal(h.engine.sequence.notes[0], note);
        assert.equal(note.id, id);
        assert.equal(note.ticks, 0);
        assert.equal(note.durationSteps, 4);
        assert.equal(Number(h.elements.noteLength.value), 4);
        h.elements.noteLength.value = '2';
        h.elements.noteLength.onchange();
        assert.equal(note.durationSteps, 2);
        const events = [];
        h.engine.voiceFactory = (event) => {
            events.push(event);
            return { stop() {}, finished: new Promise(() => {}) };
        };
        await h.engine.play();
        assert.equal(events[0].duration, 0.25);
        h.engine.stop();
        const round = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
        assert.equal(round.notes[0].durationTicks, note.durationTicks);
    });

    await test('left edge holds the end fixed across measures and preserves track and provenance', async () => {
        const h = createEditorHarness();
        await h.importSequence(ordinaryImport(h));
        const note = h.engine.sequence.notes[1];
        const identity = [note.id, note.trackId, note.importId];
        h.drag(note, 'left', 2);
        assert.equal(note.startStep, 2);
        assert.equal(note.startStep + note.durationSteps, 8);
        assert.equal(Number(h.elements.noteLength.value), 6);
        assert.deepEqual([note.id, note.trackId, note.importId], identity);
        h.drag(note, 'right', 40);
        assert.equal(note.startStep, 2);
        assert.equal(note.durationSteps, 38);
    });

    await test('resizing clamps both timeline ends and uses a whole-step drag minimum', () => {
        const h = createEditorHarness();
        const note = h.engine.sequence.addNote({ midi: 60, startStep: 4, durationSteps: 4 });
        h.drag(note, 'left', -20);
        assert.equal(note.ticks, 0);
        assert.equal(note.durationSteps, 8);
        h.drag(note, 'right', 100);
        assert.equal(note.durationSteps, 16);
        h.drag(note, 'left', 16);
        assert.equal(note.durationSteps, 1);
        assert.equal(note.ticks + note.durationTicks, h.engine.sequence.stepToTick(16));
        assert.throws(() => h.engine.sequence.updateNoteTiming(note.id, -1, 1));
        assert.throws(() => h.engine.sequence.updateNoteTiming(note.id, 0, 0));
    });

    await test('long-note resize handles horizontal offsets, DPR, and release beyond the canvas', () => {
        const h = createEditorHarness(2);
        h.engine.setPatternLength(1696);
        const note = h.engine.sequence.addNote({ midi: 60, startStep: 1000, durationSteps: 16 });
        h.elements.pianoViewport.scrollLeft = 1000 * 38 - 76;
        h.paint();
        h.drag(note, 'right', 1040);
        assert.equal(note.startStep, 1000);
        assert.equal(note.durationSteps, 40);
        assert.equal(h.elements.pianoCanvas.capturedPointers.size, 0);
        assert.equal(h.engine.sequence.notes.length, 1);
    });

    await test('pointer cancellation and lost capture roll back previews without quantizing imported notes', async () => {
        const h = createEditorHarness();
        const source = new h.NoteSequence(32, 101);
        source.addNote({ midi: 60, ticks: 17, durationTicks: 89 });
        await h.importSequence(source);
        const note = h.engine.sequence.notes[0];
        h.drag(note, 'right', 8, true);
        assert.equal(note.ticks, 17);
        assert.equal(note.durationTicks, 89);
        assert.equal(Number(h.elements.noteLength.value), note.durationSteps);
        const bounds = h.noteBounds(note);
        h.elements.pianoCanvas.onpointerdown(h.pointer(bounds.x + bounds.width - 1, bounds.y + 12));
        h.elements.pianoCanvas.onpointermove(h.pointer(500, bounds.y + 12));
        h.elements.pianoCanvas.onlostpointercapture(h.pointer(500, bounds.y + 12));
        assert.equal(note.durationTicks, 89);
        assert.equal(h.engine.sequence.notes.length, 1);
    });

    await test('removing MIDI preserves prior/new manual notes, migrates manual source-track notes, and retains samples', async () => {
        const h = createEditorHarness();
        h.engine.setBpm(140);
        h.engine.sequence.addNote({ midi: 48, startStep: 1 });
        h.engine.addTrack('uploaded', { sample: true });
        h.engine.setStep('uploaded', 7, true);
        await h.importSequence(ordinaryImport(h, 960));
        const imported = h.engine.sequence.notes.find((note) => note.importId);
        h.engine.sequence.updateNoteTiming(imported.id, imported.ticks, 100);
        h.engine.sequence.addNote({ midi: 72, startStep: 10, trackId: imported.trackId });
        await h.engine.play();
        h.elements.removeImportedMidi.onclick();
        assert.equal(h.engine.isPlaying, false);
        assert.equal(h.intervals.size, 0);
        assert.equal(h.engine.sequence.importInfo, null);
        assert.deepEqual(
            Array.from(h.engine.sequence.notes, (note) => note.midi),
            [48, 72]
        );
        assert.ok(h.engine.sequence.notes.every((note) => note.trackId === 'piano'));
        assert.equal(h.engine.sequence.notes[0].startStep, 1);
        assert.equal(h.engine.tracks.get('uploaded').steps[7], true);
        assert.equal(h.engine.bpm, 140);
        assert.equal(h.elements.bpm.disabled, false);
        assert.equal(h.engine.loopEnd, h.engine.totalSteps);
        assert.equal(h.engine.currentStep, 0);
        assert.equal(h.elements.midiFile.value, '');
        await h.importSequence(ordinaryImport(h, 960));
        assert.equal(h.engine.sequence.notes.length, 4);
    });

    await test('replacing an import preserves manual work and incompatible PPQ fails atomically', async () => {
        const h = createEditorHarness();
        h.engine.sequence.addNote({ midi: 48, ticks: 17, durationTicks: 89 });
        await h.importSequence(ordinaryImport(h));
        await h.importSequence(ordinaryImport(h));
        assert.equal(h.engine.sequence.notes.length, 3);
        const previous = h.engine.sequence;
        const incompatible = new h.NoteSequence(16, 32767);
        incompatible.addNote({ midi: 127, ticks: 17, durationTicks: 89 });
        await h.importSequence(incompatible);
        assert.equal(h.engine.sequence, previous);
        assert.match(h.elements.status.textContent, /PPQ/);
    });

    await test('New Sequence cancellation is a no-op; confirmation resets musical, audio, and UI state', async () => {
        const h = createEditorHarness();
        await h.importSequence(ordinaryImport(h));
        h.engine.addTrack('uploaded', {});
        h.engine.setStep('uploaded', 0, true);
        const factory = (event) => h.engine.createPitchedVoice(event);
        h.engine.voiceFactory = factory;
        await h.engine.play();
        const previous = h.engine.sequence;
        h.setConfirmation(false);
        h.elements.newSequence.onclick();
        assert.equal(h.engine.sequence, previous);
        assert.equal(h.engine.isPlaying, true);
        h.setConfirmation(true);
        h.elements.newSequence.onclick();
        assert.equal(h.confirmCount, 2);
        assert.equal(h.engine.isPlaying, false);
        assert.equal(h.intervals.size, 0);
        assert.equal(h.engine.sequence.notes.length, 0);
        assert.equal(h.engine.sequence.tracks.length, 1);
        assert.equal(h.engine.sequence.tracks[0].id, 'piano');
        assert.equal(h.engine.tracks.size, 0);
        assert.equal(h.engine.sequence.importInfo, null);
        assert.equal(h.engine.bpm, 120);
        assert.equal(h.engine.totalSteps, 16);
        assert.equal(h.engine.loopStart, 0);
        assert.equal(h.engine.loopEnd, 16);
        assert.equal(h.engine.currentStep, 0);
        assert.equal(h.elements.deleteNote.disabled, true);
        assert.equal(h.elements.bpm.disabled, false);
        assert.equal(h.elements.noteLength.value, '1');
        assert.equal(Number(h.elements.pitchLow.value), 36);
        assert.equal(Number(h.elements.pitchHigh.value), 83);
        assert.equal(h.elements.pianoViewport.scrollLeft, 0);
        assert.equal(h.elements.audioFile.value, '');
        assert.equal(h.elements.midiFile.value, '');
        assert.equal(h.engine.voiceFactory, factory);
        assert.ok(h.engine.audioContext.sources.every((source) => source.stopTime === 0));
    });

    await test('reset invalidates pending MIDI/audio loads and pending playback startup', async () => {
        const h = createEditorHarness();
        let resolveMidi;
        let resolveAudio;
        let resolveResume;
        const pendingMidi = h.elements.midiFile.onchange({
            target: {
                files: [
                    {
                        size: 10,
                        arrayBuffer: () =>
                            new Promise((resolve) => {
                                resolveMidi = resolve;
                            })
                    }
                ]
            }
        });
        const pendingAudio = h.elements.audioFile.onchange({
            target: {
                files: [
                    {
                        arrayBuffer: () =>
                            new Promise((resolve) => {
                                resolveAudio = resolve;
                            })
                    }
                ]
            }
        });
        h.engine.audioContext.resume = () =>
            new Promise((resolve) => {
                resolveResume = resolve;
            });
        const pendingPlay = h.elements.playButton.onclick();
        h.elements.newSequence.onclick();
        const readyStatus = h.elements.status.textContent;
        resolveMidi(h.MidiIO.encode(ordinaryImport(h)).bytes);
        resolveAudio({});
        resolveResume();
        await Promise.all([pendingMidi, pendingAudio, pendingPlay]);
        assert.equal(h.engine.sequence.notes.length, 0);
        assert.equal(h.engine.tracks.size, 0);
        assert.equal(h.engine.isPlaying, false);
        assert.equal(h.intervals.size, 0);
        assert.equal(h.elements.status.textContent, readyStatus);
    });

    await test('edge clicks without movement preserve exact timing and keyboard length edits use one-tick minimum', async () => {
        const h = createEditorHarness();
        const source = new h.NoteSequence(32, 101);
        source.addNote({ midi: 60, ticks: 17, durationTicks: 89 });
        await h.importSequence(source);
        const note = h.engine.sequence.notes[0];
        const bounds = h.noteBounds(note);
        h.clickAt(bounds.x + bounds.width - 1, bounds.y + 12);
        assert.equal(note.ticks, 17);
        assert.equal(note.durationTicks, 89);
        h.elements.noteLength.value = String(4 / 101);
        h.elements.noteLength.onchange();
        assert.equal(note.durationTicks, 1);
        h.elements.lengthDecrease.onclick();
        assert.equal(note.durationTicks, 1);
        h.elements.noteLength.onkeydown({ key: 'ArrowUp', preventDefault() {} });
        assert.equal(note.durationTicks, 26);
        h.elements.noteLength.onkeydown({ key: 'ArrowDown', preventDefault() {} });
        assert.equal(note.durationTicks, 1);
    });

    await test('drag preview does not change playback data until release and preserves the fixed fractional endpoint', async () => {
        const h = createEditorHarness();
        const source = new h.NoteSequence(32, 101);
        source.addNote({ midi: 60, ticks: 17, durationTicks: 89 });
        await h.importSequence(source);
        const note = h.engine.sequence.notes[0];
        const bounds = h.noteBounds(note);
        const start = h.pointer(bounds.x + bounds.width - 1, bounds.y + 12);
        const end = h.pointer(100 + 6 * 38 - h.elements.pianoViewport.scrollLeft, bounds.y + 12);
        h.elements.pianoCanvas.onpointerdown(start);
        h.elements.pianoCanvas.onpointermove(end);
        assert.equal(note.durationTicks, 89);
        assert.equal(Number(h.elements.noteLength.value), (126 * 4) / 101);
        h.elements.pianoCanvas.onpointerup(end);
        assert.equal(note.ticks, 17);
        assert.equal(note.durationTicks, 126);
    });

    await test('common PPQ preserves prior manual notes and imported notes without quantization', async () => {
        const h = createEditorHarness();
        h.engine.sequence.addNote({ midi: 48, ticks: 17, durationTicks: 89 });
        const source = new h.NoteSequence(32, 101);
        source.addNote({ midi: 60, ticks: 17, durationTicks: 89 });
        // 480 * 101 exceeds the SMF PPQ limit, so this must reject atomically.
        const before = h.engine.sequence;
        await h.importSequence(source);
        assert.equal(h.engine.sequence, before);
        const compatible = ordinaryImport(h, 960);
        await h.importSequence(compatible);
        const manual = h.engine.sequence.notes.find((note) => !note.importId);
        assert.equal(manual.ticks, 34);
        assert.equal(manual.durationTicks, 178);
        assert.equal(h.engine.sequence.ppq, 960);
        h.elements.removeImportedMidi.onclick();
        assert.equal(h.engine.sequence.notes[0].ticks, 34);
        assert.equal(h.engine.sequence.notes[0].durationTicks, 178);
    });

    await test('removing an import invalidates a pending replacement without touching pending sample upload', async () => {
        const h = createEditorHarness();
        await h.importSequence(ordinaryImport(h));
        let resolveMidi;
        let resolveAudio;
        const pendingMidi = h.elements.midiFile.onchange({
            target: {
                files: [
                    {
                        size: 10,
                        arrayBuffer: () =>
                            new Promise((resolve) => {
                                resolveMidi = resolve;
                            })
                    }
                ]
            }
        });
        const pendingAudio = h.elements.audioFile.onchange({
            target: {
                files: [
                    {
                        name: 'sample.wav',
                        arrayBuffer: () =>
                            new Promise((resolve) => {
                                resolveAudio = resolve;
                            })
                    }
                ]
            }
        });
        h.elements.removeImportedMidi.onclick();
        const readyStatus = h.elements.status.textContent;
        resolveMidi(h.MidiIO.encode(ordinaryImport(h)).bytes);
        resolveAudio({ sample: true });
        await Promise.all([pendingMidi, pendingAudio]);
        assert.equal(h.engine.sequence.notes.length, 0);
        assert.equal(h.engine.sequence.importInfo, null);
        assert.equal(h.engine.tracks.size, 1);
        assert.equal(h.elements.status.textContent, readyStatus);
    });

    await test('note ID indexing remains compatible with removal and explicit duplicate validation', () => {
        const h = createEditorHarness();
        const s = h.engine.sequence;
        const note = s.addNote({ midi: 60, startStep: 0, id: 'explicit' });
        assert.throws(() => s.addNote({ midi: 61, startStep: 0, id: note.id }));
        s.removeById(note.id);
        assert.equal(s.addNote({ midi: 61, startStep: 0, id: note.id }).id, note.id);
        s.removeNote(61, 0);
        assert.equal(s.addNote({ midi: 62, startStep: 0, id: note.id }).id, note.id);
    });

    await test('pointer release uses the latest coordinates and scroll offset even without a final move event', () => {
        const h = createEditorHarness();
        const note = h.engine.sequence.addNote({ midi: 60, startStep: 0 });
        let bounds = h.noteBounds(note);
        h.elements.pianoCanvas.onpointerdown(h.pointer(bounds.x + bounds.width - 1, bounds.y + 12));
        h.elements.pianoCanvas.onpointerup(h.pointer(100 + 4 * 38, bounds.y + 12));
        assert.equal(note.durationSteps, 4);
        const second = h.engine.sequence.addNote({ midi: 64, startStep: 4 });
        bounds = h.noteBounds(second);
        const pointer = h.pointer(bounds.x + bounds.width - 1, bounds.y + 12);
        h.elements.pianoCanvas.onpointerdown(pointer);
        h.elements.pianoViewport.scrollLeft = 38;
        h.elements.pianoCanvas.onpointerup(pointer);
        assert.equal(second.startStep, 4);
        assert.equal(second.durationSteps, 2);
    });

    await test('dense multi-track import keeps every note without scaling the canvas to the song width', async () => {
        const h = createEditorHarness();
        const source = new h.NoteSequence(1696);
        source.tracks = Array.from({ length: 20 }, (_, index) => ({
            id: `track-${index}`,
            name: `Track ${index}`,
            channel: index % 16,
            program: index
        }));
        for (let index = 0; index < 10000; index++) {
            source.addNote({
                midi: 36 + (index % 48),
                startStep: Math.floor(index / 20) * 3,
                durationSteps: 1,
                trackId: source.tracks[index % 20].id
            });
        }
        await h.importSequence(source);
        assert.equal(h.engine.sequence.notes.length, 10000);
        assert.equal(h.elements.pianoCanvas.width, 900);
        assert.equal(h.elements.pianoCanvas.height, 600);
        assert.ok(h.elements.sampleTriggers.children.length <= 50);
        assert.equal(
            h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence.notes.length,
            10000
        );
    });

    await test('Escape cancels resizing without committing timing or triggering a follow-up click', () => {
        const h = createEditorHarness();
        const note = h.engine.sequence.addNote({ midi: 60, startStep: 0 });
        const bounds = h.noteBounds(note);
        const start = h.pointer(bounds.x + bounds.width - 1, bounds.y + 12);
        const end = h.pointer(100 + 4 * 38, bounds.y + 12);
        h.elements.pianoCanvas.onpointerdown(start);
        h.elements.pianoCanvas.onpointermove(end);
        h.documentListeners.keydown({ key: 'Escape', preventDefault() {} });
        h.elements.pianoCanvas.onpointerup(end);
        h.elements.pianoCanvas.onclick(end);
        assert.equal(note.durationSteps, 1);
        assert.equal(h.engine.sequence.notes.length, 1);
        assert.equal(h.elements.pianoCanvas.capturedPointers.size, 0);
        assert.equal(Number(h.elements.noteLength.value), 1);
    });

    await test('right-edge deletion is a red preview until release and removes the selected note from playback/export', async () => {
        const h = createEditorHarness();
        await h.importSequence(ordinaryImport(h));
        const note = h.engine.sequence.notes[1];
        const survivor = h.engine.sequence.notes[0];
        const bounds = h.noteBounds(note);
        const down = h.pointer(bounds.x + bounds.hitWidth - 1, bounds.y + 12);
        const end = h.pointer(100 + 3 * 38 - h.elements.pianoViewport.scrollLeft, bounds.y + 12);
        h.elements.pianoCanvas.onpointerdown(down);
        h.elements.pianoCanvas.onpointermove(end);
        assert.equal(h.engine.sequence.notes.length, 2);
        assert.match(h.elements.noteInfo.textContent, /Release to delete/);
        assert.ok(
            h.canvasCalls.some((call) => call.method === 'fillRect' && call.fillStyle === '#d44848')
        );
        h.elements.pianoCanvas.onpointerup(end);
        h.elements.pianoCanvas.onclick(end);
        assert.equal(h.engine.sequence.notes.length, 1);
        assert.equal(h.engine.sequence.notes[0], survivor);
        assert.equal(h.elements.deleteNote.disabled, true);
        assert.equal(Number(h.elements.noteLength.value), 1);
        const round = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
        assert.equal(round.notes.length, 1);
        const events = [];
        h.engine.voiceFactory = (event) => {
            events.push(event);
            return { stop() {}, finished: new Promise(() => {}) };
        };
        h.engine.setLoopRange(4, 8);
        await h.engine.play();
        assert.equal(events.length, 1);
        assert.equal(events[0].id, survivor.id);
        h.engine.stop();
    });

    await test('left-edge deletion respects overlap selection and dragging back restores a valid preview', async () => {
        const h = createEditorHarness();
        await h.importSequence(ordinaryImport(h));
        const [lower, upper] = h.engine.sequence.notes;
        h.clickNote(upper);
        h.elements.nextOverlap.onclick();
        assert.match(h.elements.noteInfo.textContent, /Keys/);
        const bounds = h.noteBounds(lower);
        h.elements.pianoCanvas.onpointerdown(h.pointer(bounds.x + 1, bounds.y + 12));
        h.elements.pianoCanvas.onpointermove(
            h.pointer(100 + 9 * 38 - h.elements.pianoViewport.scrollLeft, bounds.y + 12)
        );
        assert.match(h.elements.noteInfo.textContent, /Release to delete/);
        h.elements.pianoCanvas.onpointermove(
            h.pointer(100 + 2 * 38 - h.elements.pianoViewport.scrollLeft, bounds.y + 12)
        );
        assert.doesNotMatch(h.elements.noteInfo.textContent, /Release to delete/);
        h.elements.pianoCanvas.onpointerup(
            h.pointer(100 + 2 * 38 - h.elements.pianoViewport.scrollLeft, bounds.y + 12)
        );
        assert.equal(h.engine.sequence.notes.length, 2);
        assert.equal(lower.startStep, 2);
        assert.equal(lower.durationSteps, 6);
        h.drag(lower, 'left', 9);
        assert.equal(h.engine.sequence.notes.length, 1);
        assert.equal(h.engine.sequence.notes[0], upper);
    });

    await test('Escape and pointer cancellation discard deletion previews; edge clicks never delete', () => {
        for (const cancel of ['escape', 'pointer']) {
            const h = createEditorHarness();
            const note = h.engine.sequence.addNote({ midi: 60, startStep: 4 });
            const bounds = h.noteBounds(note);
            h.clickAt(bounds.x + bounds.hitWidth - 1, bounds.y + 12);
            assert.equal(h.engine.sequence.notes.length, 1);
            h.elements.pianoCanvas.onpointerdown(
                h.pointer(bounds.x + bounds.hitWidth - 1, bounds.y + 12)
            );
            const finish = h.pointer(100 + 3 * 38, bounds.y + 12);
            h.elements.pianoCanvas.onpointermove(finish);
            if (cancel === 'escape') {
                h.documentListeners.keydown({ key: 'Escape', preventDefault() {} });
            } else {
                h.elements.pianoCanvas.onpointercancel(finish);
            }
            h.elements.pianoCanvas.onpointerup(finish);
            h.elements.pianoCanvas.onclick(finish);
            assert.equal(h.engine.sequence.notes[0], note);
            assert.equal(note.startStep, 4);
            assert.equal(note.durationSteps, 1);
        }
    });

    await test('mouse resize keeps a whole-step minimum, while fractional input and imported slivers remain precise', async () => {
        const h = createEditorHarness();
        const source = new h.NoteSequence(32, 960);
        source.addNote({ midi: 60, ticks: 17, durationTicks: 1 });
        await h.importSequence(source);
        const note = h.engine.sequence.notes[0];
        h.clickNote(note);
        assert.equal(note.durationTicks, 1);
        assert.ok(h.noteBounds(note).hitWidth >= 8);
        h.elements.noteLength.value = '0.25';
        h.elements.noteLength.onchange();
        assert.equal(note.durationTicks, 60);
        const start = note.ticks;
        h.drag(note, 'right', note.startStep + 0.1);
        assert.equal(note.ticks, start);
        assert.equal(note.durationTicks, 240);
        h.drag(note, 'right', note.startStep - 0.05);
        assert.equal(note.durationTicks, 240);
        assert.equal(h.engine.sequence.notes.length, 1);
        h.elements.noteLength.value = '0.5';
        h.elements.noteLength.onchange();
        assert.equal(note.durationTicks, 120);
    });

    await test('short imported notes at the pattern boundary remain unchanged when a whole-step resize cannot fit', async () => {
        const h = createEditorHarness();
        const source = new h.NoteSequence(16, 960);
        source.addNote({ midi: 60, ticks: 3839, durationTicks: 1 });
        await h.importSequence(source);
        const note = h.engine.sequence.notes[0];
        const original = [note.ticks, note.durationTicks, note.id, note.trackId];
        h.drag(note, 'right', 16);
        assert.deepEqual([note.ticks, note.durationTicks, note.id, note.trackId], original);
        h.drag(note, 'right', 15);
        assert.equal(h.engine.sequence.notes.length, 0);
    });

    await test('sample triggers accept arbitrary 1-based steps, sort numerically, reject invalid/duplicate positions, and remove individually', () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(1696);
        h.engine.addTrack('uploaded', {});
        for (const step of [1696, 1, 128]) {
            h.elements.sampleTriggerStep.value = String(step);
            h.elements.addSampleTrigger.onclick();
        }
        const triggers = h.elements.sampleTriggers.children;
        assert.deepEqual(
            triggers.map((item) => item.children[0].textContent),
            ['Step 1', 'Step 128', 'Step 1696']
        );
        for (const value of ['0', '-1', '1.5', '1697', '', 'NaN', 'Infinity', '128']) {
            h.elements.sampleTriggerStep.value = value;
            h.elements.addSampleTrigger.onclick();
            assert.equal(h.engine.tracks.get('uploaded').steps.filter(Boolean).length, 3);
        }
        triggers[1].children[1].onclick();
        assert.equal(h.engine.tracks.get('uploaded').steps[127], false);
        assert.deepEqual(
            h.elements.sampleTriggers.children.map((item) => item.children[0].textContent),
            ['Step 1', 'Step 1696']
        );
        assert.throws(() => h.engine.setPatternLength(16), /sample triggers/);
        assert.equal(h.engine.tracks.get('uploaded').steps[1695], true);
    });

    await test('sample trigger pagination avoids large DOM and remains independent from piano-roll scrolling', () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(2000);
        h.engine.addTrack('uploaded', {});
        for (let step = 0; step < 120; step++) {
            h.engine.setStep('uploaded', step, true);
        }
        h.elements.sampleTriggerStep.value = '1696';
        h.elements.addSampleTrigger.onclick();
        assert.ok(h.elements.sampleTriggers.children.length <= 50);
        assert.equal(
            h.elements.sampleTriggers.children.at(-1).children[0].textContent,
            'Step 1696'
        );
        h.elements.samplePreviousPage.onclick();
        assert.equal(h.elements.sampleTriggers.children.length, 50);
        const firstLabel = h.elements.sampleTriggers.children[0].children[0].textContent;
        h.elements.pianoViewport.scrollLeft = 40000;
        h.paint();
        assert.equal(h.elements.sampleTriggers.children[0].children[0].textContent, firstLabel);
        h.elements.sampleNextPage.onclick();
        assert.equal(
            h.elements.sampleTriggers.children.at(-1).children[0].textContent,
            'Step 1696'
        );
    });

    await test('sample removal during playback cancels only the sample and preserves notes, MIDI metadata, tempo, loops and voices', async () => {
        const h = createEditorHarness();
        await h.importSequence(ordinaryImport(h));
        h.engine.addTrack('uploaded', {});
        h.engine.setStep('uploaded', 4, true);
        h.engine.setLoopRange(4, 8);
        const sequence = h.engine.sequence;
        const before = JSON.stringify(sequence.toJSON());
        let stoppedVoices = 0;
        h.engine.voiceFactory = () => ({
            stop() {
                stoppedVoices++;
            },
            finished: new Promise(() => {})
        });
        await h.engine.play();
        const source = h.engine.audioContext.sources[0];
        const track = h.engine.tracks.get('uploaded');
        h.elements.removeSample.onclick();
        assert.equal(source.stopTime, 0);
        assert.equal(track.activeSources.size, 0);
        assert.equal(h.engine.tracks.has('uploaded'), false);
        assert.equal(h.engine.sequence, sequence);
        assert.equal(JSON.stringify(sequence.toJSON()), before);
        assert.equal(h.engine.loopStart, 4);
        assert.equal(h.engine.loopEnd, 8);
        assert.equal(h.engine.isPlaying, true);
        assert.equal(stoppedVoices, 0);
        assert.equal(h.engine.pitchedVoices.size, 2);
        assert.equal(h.elements.audioFile.value, '');
        assert.equal(h.elements.sampleName.textContent, 'No sample loaded.');
        assert.equal(h.elements.sampleTriggers.children.length, 0);
        h.engine.stop();
    });

    await test('Remove Sample invalidates a pending upload and replacement upload retains current triggers', async () => {
        const h = createEditorHarness();
        const upload = (name, data) =>
            h.elements.audioFile.onchange({
                target: {
                    files: [{ name, arrayBuffer: async () => data }]
                }
            });
        await upload('first.wav', { sample: 1 });
        h.elements.sampleTriggerStep.value = '5';
        h.elements.addSampleTrigger.onclick();
        await upload('second.wav', { sample: 2 });
        assert.equal(h.engine.tracks.get('uploaded').steps[4], true);
        assert.equal(h.elements.sampleName.textContent, 'Sample: second.wav');
        let resolve;
        const pending = h.elements.audioFile.onchange({
            target: {
                files: [
                    {
                        name: 'late.wav',
                        arrayBuffer: () =>
                            new Promise((done) => {
                                resolve = done;
                            })
                    }
                ]
            }
        });
        h.elements.removeSample.onclick();
        resolve({ sample: 3 });
        await pending;
        assert.equal(h.engine.tracks.size, 0);
        assert.equal(h.elements.sampleName.textContent, 'No sample loaded.');
        await upload('new.wav', { sample: 4 });
        assert.equal(h.engine.tracks.size, 1);
        assert.equal(h.engine.tracks.get('uploaded').steps.filter(Boolean).length, 0);
        assert.equal(h.elements.sampleName.textContent, 'Sample: new.wav');
    });

    await test('arbitrary sample trigger positions use the existing audio-clock scheduler', async () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(1696);
        h.engine.addTrack('uploaded', {});
        h.elements.sampleTriggerStep.value = '1696';
        h.elements.addSampleTrigger.onclick();
        h.engine.setLoopRange(1695, 1696);
        await h.engine.play();
        assert.equal(h.engine.audioContext.sources.length, 1);
        assert.ok(Math.abs(h.engine.audioContext.sources[0].startTime - 0.05) < 1e-9);
        h.engine.stop();
    });

    console.log(`${passed} editor tests passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
