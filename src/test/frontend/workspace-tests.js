const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEditorHarness } = require('./editor-test-support');
let passed = 0;
async function test(name, run) {
    await run();
    passed++;
    console.log(`PASS ${name}`);
}
function key(h, value, options = {}) {
    let prevented = false;
    h.documentListeners.keydown({ key: value, preventDefault() { prevented = true; }, ...options });
    return prevented;
}
function command(h, value, options = {}) {
    return key(h, value, { ctrlKey: true, ...options });
}
function noteData(h) {
    return JSON.parse(JSON.stringify(h.engine.sequence.toJSON().notes));
}
function selectAll(h) {
    command(h, 'a');
}
function setLength(h, value) {
    h.elements.noteLength.value = String(value);
    h.elements.noteLength.onchange();
}
function setCursor(h, step) {
    h.clickAt(100 + step * 38 - h.elements.pianoViewport.scrollLeft, 15);
}
function near(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} should be near ${expected}`);
}
function voiceRecorder(h) {
    const events = [];
    h.engine.voiceFactory = (event) => {
        const record = { ...event, stopped: false };
        events.push(record);
        return { stop() { record.stopped = true; }, finished: new Promise(() => {}) };
    };
    return events;
}

function cursorTick(h) {
    return Number(h.elements.cursorPosition.textContent.match(/tick (\d+)/)[1]);
}
function runClock(h, until) {
    const context = h.engine.audioContext;
    const first = context.currentTime;
    for (let time = first; time < until; time += 0.025) {
        context.currentTime = time;
        h.engine.scheduler();
    }
    context.currentTime = until;
    h.engine.scheduler();
}
function populateSteps(h) {
    h.engine.sequence.tracks.push({ id: 'lead', name: 'Lead', channel: 5, program: 81 });
    for (let step = 0; step < 16; step++) {
        h.engine.sequence.addNote({ midi: 60 + step, startStep: step,
            durationTicks: 1, trackId: 'lead', velocityMidi: 80, importId: 'source' });
    }
    return voiceRecorder(h);
}

// Model native button activation on keyup only when keydown did not prevent its default.
async function spaceWithNativeDefault(h) {
    const target = h.activeElement;
    const prevented = key(h, ' ', { target });
    if (!prevented && target?.tagName === 'BUTTON') {
        await target.onclick();
    } else if (h.engine.startPromise) {
        await h.engine.startPromise;
    }
    return prevented;
}

(async () => {
    for (const count of [3, 4]) {
        await test(`${count}-note absolute inspector editing is atomic and one undo/redo action`, () => {
            const h = createEditorHarness();
            h.engine.sequence.tracks.push({ id: 'lead', name: 'Lead', channel: 5, program: 81 });
            for (let index = 0; index < count; index++) {
                h.engine.sequence.addNote({ midi: 60 + index * 3, ticks: 17 + index * 120,
                    durationTicks: (index + 1) * 120, trackId: 'lead', importId: 'import',
                    velocityMidi: 42 + index, noteOffVelocity: 50 + index });
            }
            const before = noteData(h);
            selectAll(h);
            assert.equal(h.elements.noteLength.value, '');
            assert.equal(h.elements.noteLength.placeholder, 'Mixed');
            assert.deepEqual(noteData(h), before);
            setLength(h, 4);
            assert.equal(h.elements.noteLength.value, '4');
            assert.equal(h.elements.noteLength.placeholder, '');
            assert.deepEqual(noteData(h), before.map((note) => ({ ...note, durationTicks: 480 })));
            command(h, 'z');
            assert.deepEqual(noteData(h), before);
            command(h, 'z');
            assert.deepEqual(noteData(h), before);
            command(h, 'z', { shiftKey: true });
            assert.equal(h.engine.sequence.notes.every((note) => note.durationTicks === 480), true);
            const exported = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
            assert.equal(exported.notes.length, count);
            assert.equal(exported.notes.every((note) => note.durationTicks === 480), true);
        });
    }

    await test('relative buttons and Length arrows preserve fractional differences and share history', () => {
        const h = createEditorHarness();
        for (const durationTicks of [257, 497, 737]) {
            h.engine.sequence.addNote({ midi: 60, ticks: 17, durationTicks });
        }
        selectAll(h);
        const before = noteData(h);
        h.elements.lengthIncrease.onclick();
        assert.deepEqual(Array.from(h.engine.sequence.notes, (note) => note.durationTicks), [377, 617, 857]);
        assert.equal(h.elements.noteLength.placeholder, 'Mixed');
        h.elements.lengthDecrease.onclick();
        assert.deepEqual(noteData(h), before);
        h.elements.noteLength.onkeydown({ key: 'ArrowUp', preventDefault() {} });
        command(h, 'z');
        assert.deepEqual(noteData(h), before);
        setLength(h, 1.25);
        assert.equal(h.elements.noteLength.value, '1.25');
        assert.equal(h.engine.sequence.notes.every((note) => note.durationTicks === 150), true);
    });

    await test('unusual PPQ relative duration changes are integer, reversible and preserve precise starts', () => {
        const h = createEditorHarness();
        h.engine.replaceSequence(new h.NoteSequence(64, 102));
        h.engine.sequence.addNote({ midi: 60, ticks: 17, durationTicks: 51 });
        h.engine.sequence.addNote({ midi: 64, ticks: 19, durationTicks: 79 });
        selectAll(h);
        const before = noteData(h);
        h.elements.lengthIncrease.onclick();
        assert.deepEqual(Array.from(h.engine.sequence.notes, (note) => note.durationTicks), [77, 105]);
        h.elements.lengthDecrease.onclick();
        assert.deepEqual(noteData(h), before);
    });

    await test('invalid group durations and boundaries reject every note without adding history', () => {
        const h = createEditorHarness();
        h.engine.sequence.addNote({ midi: 60, startStep: 1, durationSteps: 2 });
        h.engine.sequence.addNote({ midi: 64, startStep: 15, durationSteps: 1 });
        selectAll(h);
        const before = noteData(h);
        for (const value of [4, 0, -1, '', 'NaN', 'Infinity']) {
            setLength(h, value);
            assert.deepEqual(noteData(h), before);
            assert.equal(h.elements.noteLength.placeholder, 'Mixed');
        }
        h.elements.lengthIncrease.onclick();
        assert.deepEqual(noteData(h), before);
        h.elements.lengthDecrease.onclick();
        assert.deepEqual(noteData(h), before);
        command(h, 'z');
        assert.deepEqual(noteData(h), before);
        assert.equal(h.engine.totalSteps, 16);
    });

    await test('mouse group resize and cancellation keep the mixed/common inspector synchronized', () => {
        const h = createEditorHarness();
        const a = h.engine.sequence.addNote({ midi: 60, startStep: 2, durationSteps: 2 });
        h.engine.sequence.addNote({ midi: 64, startStep: 4, durationSteps: 4 });
        selectAll(h);
        h.drag(a, 'right', 6);
        assert.equal(h.elements.noteLength.value, '');
        assert.equal(h.elements.noteLength.placeholder, 'Mixed');
        assert.deepEqual(Array.from(h.engine.sequence.notes, (note) => note.durationSteps), [4, 6]);
        setLength(h, 3);
        h.drag(a, 'right', 6);
        assert.equal(h.elements.noteLength.value, '4');
        h.drag(a, 'right', 8, true);
        assert.equal(h.elements.noteLength.value, '4');
        command(h, 'z');
        assert.equal(h.elements.noteLength.value, '3');
    });

    await test('Space plays, pauses at audio-clock tick, resumes and Stop resets to loop start', async () => {
        const h = createEditorHarness();
        assert.equal(key(h, ' '), true);
        await h.engine.startPromise;
        assert.equal(h.engine.isPlaying, true);
        assert.match(h.elements.playButton.textContent, /Pause/);
        h.engine.audioContext.currentTime = 0.3;
        near(h.engine.getPlaybackTick(), 240);
        key(h, ' ');
        assert.equal(h.engine.isPlaying, false);
        assert.equal(h.engine.isPaused, true);
        near(h.engine.pausedTick, 240);
        assert.equal(h.intervals.size, 0);
        assert.match(h.elements.playButton.textContent, /Resume/);
        h.engine.audioContext.currentTime = 10;
        key(h, ' ');
        await h.engine.startPromise;
        h.engine.audioContext.currentTime = 10.175;
        near(h.engine.getPlaybackTick(), 360);
        h.elements.stopButton.onclick();
        assert.equal(h.engine.isPaused, false);
        assert.equal(h.engine.pausedTick, null);
        near(h.engine.getPlaybackTick(), 0);
        assert.match(h.elements.playButton.textContent, /Play/);
    });

    await test('pause cancels queued voices and samples; resume chases held notes without replaying past onsets', async () => {
        const h = createEditorHarness();
        h.engine.sequence.addNote({ midi: 60, ticks: 0, durationTicks: 480 });
        h.engine.sequence.addNote({ midi: 64, ticks: 90, durationTicks: 120 });
        h.engine.sequence.addNote({ midi: 67, ticks: 10, durationTicks: 10 });
        const events = voiceRecorder(h);
        h.engine.addTrack('sample', {});
        h.engine.setStep('sample', 0, true);
        h.engine.setStep('sample', 1, true);
        await h.engine.play();
        assert.equal(events.length, 3);
        const sample = h.engine.audioContext.sources[0];
        h.engine.audioContext.currentTime = 0.1125;
        h.engine.pause();
        near(h.engine.pausedTick, 60);
        assert.equal(events.every((event) => event.stopped), true);
        assert.equal(sample.stopTime, 0);
        assert.equal(h.engine.pitchedVoices.size, 0);
        assert.equal(h.engine.tracks.get('sample').activeSources.size, 0);
        h.engine.audioContext.currentTime = 1;
        await h.engine.play();
        assert.equal(events.length, 5);
        assert.equal(events[3].midi, 60);
        near(events[3].when, 1.05);
        near(events[3].duration, 420 / 960);
        assert.equal(events[4].midi, 64);
        near(events[4].when, 1.05 + 30 / 960);
        assert.equal(h.engine.audioContext.sources.length, 1);
        h.engine.audioContext.currentTime = 1.08;
        h.engine.scheduler();
        assert.equal(h.engine.audioContext.sources.length, 2);
        near(h.engine.audioContext.sources[1].startTime, 1.1125);
        h.engine.stop();
    });

    await test('pause/resume integrates tempo segments and wraps custom loops on the same audio clock', async () => {
        const h = createEditorHarness();
        h.engine.sequence.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 600, bpm: 60 }];
        h.engine.setLoopRange(4, 12);
        await h.engine.play();
        h.engine.audioContext.currentTime = 0.425;
        near(h.engine.getPlaybackTick(), 720);
        h.engine.pause();
        near(h.engine.pausedTick, 720);
        h.engine.audioContext.currentTime = 5;
        await h.engine.play();
        h.engine.audioContext.currentTime = 5.3;
        near(h.engine.getPlaybackTick(), 840);
        const loopDuration = h.engine.stepSeconds(12) - h.engine.stepSeconds(4);
        h.engine.audioContext.currentTime = 5.05 + loopDuration;
        near(h.engine.getPlaybackTick(), 720);
        h.engine.stop();
        assert.equal(h.engine.currentStep, 4);
    });

    await test('rapid pending Play/Pause/Resume invalidates stale startup and repeated Space does not toggle', async () => {
        const h = createEditorHarness();
        h.engine.initContext();
        const resumes = [];
        h.engine.audioContext.resume = () => new Promise((resolve) => resumes.push(resolve));
        const old = h.elements.playButton.onclick();
        key(h, ' ');
        assert.equal(h.engine.isPaused, true);
        const newest = h.elements.playButton.onclick();
        resumes[0]();
        await old;
        assert.equal(h.engine.isPlaying, false);
        resumes[1]();
        await newest;
        assert.equal(h.engine.isPlaying, true);
        assert.equal(h.intervals.size, 1);
        assert.equal(key(h, ' ', { repeat: true }), true);
        assert.equal(h.engine.isPlaying, true);
        h.elements.stopButton.onclick();
        assert.equal(h.intervals.size, 0);
    });

    await test('Pause during instrument preparation cancels the old run and Resume prepares once for the new run', async () => {
        const h = createEditorHarness();
        const preparations = [];
        let managerStops = 0;
        h.engine.registerInstrumentManager({
            prepare(context, output, { signal }) {
                return new Promise((resolve) => preparations.push({ resolve, signal }));
            },
            createVoice() {
                return { stop() {}, finished: new Promise(() => {}) };
            },
            stop() { managerStops++; }
        });
        const first = h.elements.playButton.onclick();
        await new Promise(setImmediate);
        assert.equal(preparations.length, 1);
        key(h, ' ');
        assert.equal(preparations[0].signal.aborted, true);
        const second = h.elements.playButton.onclick();
        await new Promise(setImmediate);
        assert.equal(preparations.length, 2);
        preparations[0].resolve();
        await first;
        assert.equal(h.engine.isPlaying, false);
        preparations[1].resolve();
        await second;
        assert.equal(h.engine.isPlaying, true);
        assert.equal(h.intervals.size, 1);
        assert.equal(managerStops, 1);
        h.elements.stopButton.onclick();
        assert.equal(managerStops, 2);
    });

    await test('resumed held notes use remaining tempo-map duration and paused BPM/loop changes stay musical', async () => {
        const h = createEditorHarness();
        h.engine.sequence.addNote({ midi: 60, ticks: 0, durationTicks: 960 });
        h.engine.sequence.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 240, bpm: 60 }];
        const events = voiceRecorder(h);
        await h.engine.play();
        h.engine.audioContext.currentTime = 0.55;
        h.engine.pause();
        near(h.engine.pausedTick, 360);
        await h.engine.play();
        near(events[1].duration, h.engine.sequence.ticksToSeconds(960) - h.engine.sequence.ticksToSeconds(360));
        h.engine.pause();
        h.engine.setLoopRange(4, 12);
        assert.equal(h.engine.isPaused, false);
        await h.engine.play();
        near(h.engine.getPlaybackTick(), 480);
        h.engine.stop();
        h.engine.sequence.tempos = [{ ticks: 0, bpm: 120 }];
        await h.engine.play();
        h.engine.audioContext.currentTime += 0.3;
        h.engine.pause();
        const tick = h.engine.pausedTick;
        h.engine.setBpm(60);
        near(h.engine.pausedTick, tick);
        await h.engine.play();
        h.engine.audioContext.currentTime += 0.3;
        near(h.engine.getPlaybackTick(), tick + 120);
        h.engine.stop();
    });

    await test('Space respects typing, native button/menu accessibility and other modal dialogs', () => {
        const h = createEditorHarness();
        for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
            { isContentEditable: true }, { tagName: 'BUTTON' }, { tagName: 'A' }, { tagName: 'SUMMARY' },
            { closest: () => ({}) }]) {
            assert.equal(key(h, ' ', { target }), false);
        }
        h.setModalOpen(true);
        assert.equal(key(h, ' '), false);
        assert.equal(command(h, 'a'), false);
        assert.equal(h.engine.audioContext, null);
        h.setModalOpen(false);
        assert.equal(key(h, ' ', { ctrlKey: true }), false);
    });

    await test('ruler cursor uses precise ticks, scroll offsets and meter-aware compact labels without editing notes', () => {
        const h = createEditorHarness(2);
        h.engine.setPatternLength(65536);
        h.engine.sequence.addNote({ midi: 60, ticks: 17, durationTicks: 89 });
        const before = noteData(h);
        h.elements.pianoViewport.scrollLeft = 64000 * 38;
        h.clickAt(100 + 5.75 * 38, 15);
        assert.match(h.elements.cursorPosition.textContent, /absolute 64006/);
        assert.deepEqual(noteData(h), before);
        h.paint();
        assert.ok(h.canvasCalls.some((call) => call.method === 'fillRect' &&
            call.fillStyle === '#087e8b' && Math.abs(call.args[0] - (100 + 5.75 * 38)) < 1e-7));
        h.elements.pianoViewport.scrollLeft = 0;
        setCursor(h, 36);
        assert.match(h.elements.cursorPosition.textContent, /Measure 3 · Beat 2 · Step 1/);
        assert.equal(h.engine.loopStart, 0);
        assert.equal(h.engine.loopEnd, 65536);
    });

    await test('paste anchors at cursor with exact relative timing, fresh IDs, tracks, export and one-step history', () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(80);
        h.engine.sequence.tracks.push({ id: 'lead', name: 'Lead', channel: 5, program: 81 });
        h.engine.sequence.addNote({ midi: 60, ticks: 17, durationTicks: 253, trackId: 'lead', importId: 'source' });
        h.engine.sequence.addNote({ midi: 64, ticks: 91, durationTicks: 399, velocityMidi: 41 });
        selectAll(h);
        command(h, 'c');
        h.engine.setLoopRange(4, 16);
        setCursor(h, 64);
        command(h, 'v');
        const pasted = h.engine.sequence.notes.slice(2);
        assert.deepEqual(Array.from(pasted, (note) => note.ticks), [7680, 7754]);
        assert.equal(pasted[0].durationTicks, 253);
        assert.equal(pasted[0].trackId, 'lead');
        assert.equal(pasted[0].importId, null);
        assert.equal(pasted[1].velocityMidi, 41);
        assert.equal(new Set(h.engine.sequence.notes.map((note) => note.id)).size, 4);
        assert.equal(h.elements.selectionCount.textContent, '2 selected');
        const label = h.elements.cursorPosition.textContent;
        command(h, 'z');
        assert.equal(h.engine.sequence.notes.length, 2);
        assert.equal(h.elements.cursorPosition.textContent, label);
        command(h, 'z', { shiftKey: true });
        assert.equal(h.engine.sequence.notes.length, 4);
        const exported = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
        assert.ok(exported.notes.some((note) => note.ticks === 7754 && note.durationTicks === 399));
        assert.equal(h.engine.loopStart, 4);
        assert.equal(h.engine.loopEnd, 16);
    });

    await test('cursor end paste expands safely; cursor lifecycle stays separate from playback and Undo', async () => {
        const h = createEditorHarness();
        h.engine.sequence.addNote({ midi: 60, startStep: 0, durationSteps: 4 });
        selectAll(h);
        command(h, 'c');
        setCursor(h, 16);
        command(h, 'v');
        assert.equal(h.engine.totalSteps, 20);
        assert.equal(h.engine.sequence.notes[1].startStep, 16);
        assert.match(h.elements.cursorPosition.textContent, /absolute 17/);
        command(h, 'z');
        assert.equal(h.engine.totalSteps, 20);
        await h.elements.playButton.onclick();
        h.engine.audioContext.currentTime = 0.3;
        h.animate();
        assert.match(h.elements.cursorPosition.textContent, /absolute 17/);
        h.elements.playButton.onclick();
        h.elements.stopButton.onclick();
        assert.match(h.elements.cursorPosition.textContent, /absolute 17/);
        h.elements.patternSteps.value = '8';
        h.elements.patternSteps.onchange();
        assert.match(h.elements.cursorPosition.textContent, /absolute 9/);
        h.elements.newSequence.onclick();
        assert.match(h.elements.cursorPosition.textContent, /Measure 1 · Beat 1 · Step 1/);
    });

    await test('successful MIDI import/removal resets the editing cursor without reusing old clipboard ticks', async () => {
        const h = createEditorHarness();
        const imported = new h.NoteSequence(64, 960);
        imported.addNote({ midi: 60, ticks: 17, durationTicks: 241 });
        setCursor(h, 8);
        await h.importSequence(imported);
        assert.match(h.elements.cursorPosition.textContent, /absolute 1/);
        setCursor(h, 32);
        h.elements.removeImportedMidi.onclick();
        assert.match(h.elements.cursorPosition.textContent, /absolute 1/);
    });

    await test('help is generated from active shortcut metadata, blocks editor actions and restores focus', () => {
        const h = createEditorHarness();
        const note = h.engine.sequence.addNote({ midi: 60, startStep: 1 });
        h.clickNote(note);
        h.elements.shortcutsButton.focus();
        h.elements.shortcutsButton.onclick();
        assert.equal(h.elements.shortcutsDialog.open, true);
        assert.equal(h.activeElement, h.elements.closeShortcuts);
        const help = h.elements.keyboardGuide.children.map((child) => child.textContent).join(' ');
        for (const label of ['Space', 'Cmd/Ctrl+A', 'Cmd/Ctrl+C', 'Cmd/Ctrl+X', 'Cmd/Ctrl+V',
            'Cmd/Ctrl+D', 'Cmd/Ctrl+Z', 'Cmd/Ctrl+Shift+Z', 'Delete / Backspace', 'Escape', 'Arrow Up']) {
            assert.ok(help.includes(label), label);
        }
        assert.match(help, /Paste at editing cursor/);
        assert.match(h.elements.mouseGuide.children.map((child) => child.textContent).join(' '), /opposite edge/);
        assert.equal(key(h, ' '), false);
        assert.equal(key(h, 'Delete'), false);
        assert.equal(command(h, 'd'), false);
        assert.equal(h.engine.sequence.notes.length, 1);
        assert.equal(h.engine.audioContext, null);
        assert.equal(key(h, 'Escape'), true);
        assert.equal(h.elements.shortcutsDialog.open, false);
        assert.equal(h.activeElement, h.elements.shortcutsButton);
        assert.equal(h.elements.selectionCount.textContent, '1 selected');
        h.elements.shortcutsButton.onclick();
        h.elements.closeShortcuts.onclick();
        assert.equal(h.elements.shortcutsDialog.open, false);
    });

    await test('viewport resize observer and window/scroll events redraw with CSS-pixel coordinates', () => {
        const h = createEditorHarness(2);
        h.engine.setPatternLength(64);
        h.elements.pianoViewport.clientWidth = 700;
        h.elements.pianoViewport.clientHeight = 400;
        h.resize();
        assert.equal(h.elements.pianoCanvas.width, 1400);
        assert.equal(h.elements.pianoCanvas.height, 800);
        h.elements.pianoViewport.scrollLeft = 38 * 20;
        h.elements.pianoViewport.scrollTop = 24 * 5;
        h.paint();
        h.clickAt(100 + 2 * 38 + 4, 32 + 2 * 24 + 12);
        const note = h.engine.sequence.notes[0];
        assert.equal(note.startStep, 22);
        assert.equal(note.midi, 76);
        h.windowListeners.resize();
        assert.equal(h.elements.pianoCanvas.width, 1400);
    });

    await test('full-screen markup keeps every original control ID and account/dashboard integration', () => {
        const root = path.resolve(__dirname, '../../main/resources/static');
        const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'css/sequencer.css'), 'utf8');
        const ids = Array.from(html.matchAll(/id="([^"]+)"/g), (match) => match[1]);
        assert.equal(new Set(ids).size, ids.length);
        for (const id of ['playButton', 'stopButton', 'bpm', 'loopStart', 'loopEnd', 'noteLength',
            'lengthDecrease', 'lengthIncrease', 'velocity', 'pitchLow', 'pitchHigh', 'patternSteps',
            'addBar', 'removeBar', 'newSequence', 'removeImportedMidi', 'midiFile', 'exportMidi',
            'audioFile', 'removeSample', 'sampleTriggerStep', 'sampleTriggers', 'currentUser',
            'findNotes', 'nextOverlap', 'pianoViewport', 'pianoCanvas', 'cursorPosition', 'shortcutsDialog']) {
            assert.ok(ids.includes(id), id);
        }
        assert.match(html, /fetch\('\/api\/current-user'\)/);
        assert.match(html, /action="\/logout" method="post"/);
        assert.match(html, /href="\/dashboard.html"/);
        assert.match(html, /<dialog[^>]*aria-labelledby="shortcutsTitle"/);
        assert.match(css, /height: 100dvh/);
        assert.match(css, /minmax\(0, 1fr\)/);
        assert.match(css, /body \{ margin: 0; overflow: hidden/);
    });

    await test('cursor clicks and drags update immediately to integer ticks without snapping or note mutation', () => {
        const h = createEditorHarness(2);
        h.engine.sequence.addNote({ midi: 60, ticks: 17, durationTicks: 23 });
        selectAll(h);
        const before = noteData(h);
        const canvas = h.elements.pianoCanvas;
        canvas.onpointerdown(h.pointer(100 + 2.375 * 38, 15));
        assert.equal(cursorTick(h), 285);
        assert.equal(canvas.hasPointerCapture(1), true);
        canvas.onpointermove(h.pointer(100 + 3.125 * 38, 15));
        assert.equal(cursorTick(h), 375);
        canvas.onpointermove(h.pointer(100 + 1.225 * 38, 15));
        assert.equal(cursorTick(h), 147);
        canvas.onpointerup(h.pointer(100 + 1.325 * 38, 100));
        canvas.onclick(h.pointer(100 + 1.325 * 38, 100));
        assert.equal(cursorTick(h), 159);
        assert.equal(canvas.hasPointerCapture(1), false);
        assert.equal(h.elements.selectionCount.textContent, '1 selected');
        assert.deepEqual(noteData(h), before);
        command(h, 'z');
        assert.deepEqual(noteData(h), before);
        h.windowListeners.resize();
        assert.equal(cursorTick(h), 159);
    });

    await test('captured cursor dragging includes live horizontal scrolling, clamps bounds and rolls back cancellation', () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(65536);
        setCursor(h, 3.25);
        for (const cancellation of ['Escape', 'pointer', 'capture']) {
            const canvas = h.elements.pianoCanvas;
            h.elements.pianoViewport.scrollLeft = 64000 * 38;
            canvas.onpointerdown(h.pointer(100 + 2.125 * 38, 15));
            assert.equal(cursorTick(h), 7680255);
            h.elements.pianoViewport.scrollLeft += 38;
            h.paint();
            assert.equal(cursorTick(h), 7680375);
            canvas.onpointermove(h.pointer(-10000000, 15));
            assert.equal(cursorTick(h), 0);
            canvas.onpointermove(h.pointer(10000000, 15));
            assert.equal(cursorTick(h), 65536 * 120);
            if (cancellation === 'Escape') key(h, 'Escape');
            else if (cancellation === 'pointer') canvas.onpointercancel(h.pointer(400, 15));
            else canvas.onlostpointercapture(h.pointer(400, 15));
            canvas.onpointerup(h.pointer(400, 15));
            canvas.onclick(h.pointer(400, 15));
            assert.equal(cursorTick(h), 390);
            assert.equal(h.engine.sequence.notes.length, 0);
        }
    });

    await test('cursor conversion uses nearest integer ticks for arbitrary supported PPQ and maximum pattern length', () => {
        const h = createEditorHarness();
        for (const ppq of [1, 2, 7, 101, 480, 32767]) {
            const sequence = new h.NoteSequence(65536, ppq);
            const scroll = 64000 * 38;
            const step = 64005.376;
            const tick = h.PianoRollEditor.cursorTick(sequence, 100 + 5.376 * 38, scroll);
            assert.equal(tick, Math.round(sequence.stepToTick(step)));
            assert.equal(Number.isInteger(tick), true);
            assert.equal(h.PianoRollEditor.cursorTick(sequence, -10000, 0), 0);
            assert.equal(h.PianoRollEditor.cursorTick(sequence, 100000000, scroll), Math.floor(sequence.stepToTick(65536)));
        }
    });

    await test('sub-step cursor paste keeps exact imported offsets through expansion, undo/redo and export', () => {
        const h = createEditorHarness();
        h.engine.replaceSequence(new h.NoteSequence(16, 101));
        h.engine.sequence.addNote({ midi: 60, ticks: 17, durationTicks: 83, importId: 'source' });
        h.engine.sequence.addNote({ midi: 67, ticks: 29, durationTicks: 99 });
        selectAll(h);
        command(h, 'c');
        setCursor(h, 15.376);
        const destination = cursorTick(h);
        assert.equal(destination, 388);
        command(h, 'v');
        const pasted = h.engine.sequence.notes.slice(2);
        assert.deepEqual(Array.from(pasted, (note) => note.ticks), [388, 400]);
        assert.equal(pasted[0].importId, null);
        assert.equal(pasted[0].durationTicks, 83);
        assert.equal(h.engine.totalSteps, 20);
        command(h, 'z');
        assert.equal(h.engine.sequence.notes.length, 2);
        command(h, 'z', { shiftKey: true });
        assert.equal(h.engine.sequence.notes.length, 4);
        const exported = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
        assert.ok(exported.notes.some((note) => note.ticks === 400 && note.durationTicks === 99));
        assert.equal(cursorTick(h), destination);
    });

    await test('fresh Play starts at a sub-step cursor, then repeats the entire custom loop without duplicate voices or samples', async () => {
        const h = createEditorHarness();
        const events = populateSteps(h);
        h.engine.addTrack('sample', {});
        for (let step = 0; step < 16; step++) h.engine.setStep('sample', step, true);
        h.engine.setLoopRange(4, 8);
        setCursor(h, 6.25);
        await h.elements.playButton.onclick();
        near(h.engine.playbackAnchorTick, 750);
        runClock(h, 0.8);
        assert.deepEqual(events.map((event) => event.midi), [67, 64, 65, 66, 67, 64, 65]);
        const expected = [0.14375, 0.26875, 0.39375, 0.51875, 0.64375, 0.76875, 0.89375];
        events.forEach((event, index) => near(event.when, expected[index]));
        assert.equal(h.engine.audioContext.sources.length, expected.length);
        h.engine.audioContext.sources.forEach((source, index) => near(source.startTime, expected[index]));
        assert.equal(new Set(events.map((event) => `${event.id}@${event.when}`)).size, events.length);
        assert.equal(events.every((event) => event.channel === 5 && event.program === 81 && event.importId === 'source'), true);
        near(h.engine.getPlaybackTick(), 510);
        assert.equal(cursorTick(h), 750);
        assert.equal(h.engine.loopStart, 4);
        assert.equal(h.engine.loopEnd, 8);
        h.engine.stop();
    });

    for (const startStep of [2.5, 8, 10.5, 16]) {
        await test(`cursor at step ${startStep} follows the documented initial-pass and loop policy`, async () => {
            const h = createEditorHarness();
            const events = populateSteps(h);
            h.engine.setLoopRange(4, 8);
            setCursor(h, startStep);
            await h.elements.playButton.onclick();
            const actualStart = startStep === 16 ? 4 : startStep;
            near(h.engine.getPlaybackTick(), actualStart * 120);
            const initialEnd = actualStart < 8 ? 8 : 16;
            const initialDuration = (initialEnd - actualStart) * 0.125;
            const wrapTime = 0.05 + initialDuration;
            runClock(h, wrapTime + 0.51);
            const initialPitches = Array.from({ length: initialEnd - Math.ceil(actualStart) }, (_, index) =>
                60 + Math.ceil(actualStart) + index);
            assert.deepEqual(events.map((event) => event.midi), [...initialPitches, 64, 65, 66, 67, 64]);
            const loopEvents = events.slice(initialPitches.length);
            loopEvents.forEach((event, index) => near(event.when, wrapTime + index * 0.125));
            near(h.engine.getPlaybackTick(), 489.6);
            assert.equal(h.engine.loopStart, 4);
            assert.equal(h.engine.loopEnd, 8);
            h.engine.stop();
        });
    }

    await test('tempo-map initial audition and subsequent loops use mapped endpoints and late callbacks keep phase', async () => {
        const h = createEditorHarness();
        const events = populateSteps(h);
        h.engine.sequence.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 360, bpm: 60 }, { ticks: 720, bpm: 90 }];
        h.engine.setLoopRange(4, 8);
        await h.engine.play(300.5);
        const initialSeconds = h.engine.sequence.ticksToSeconds(300.5);
        const firstWrap = 0.05 + h.engine.stepSeconds(8) - initialSeconds;
        runClock(h, firstWrap + 0.05);
        const firstLoopNote = events.find((event) => event.midi === 64 && event.when >= firstWrap - 1e-7);
        near(firstLoopNote.when, firstWrap);
        h.engine.audioContext.currentTime = firstWrap + 50.25;
        const priorCount = events.length;
        h.engine.scheduler();
        for (const event of events.slice(priorCount)) assert.ok(event.when >= h.engine.audioContext.currentTime - 1e-7);
        const loopSeconds = h.engine.stepSeconds(8) - h.engine.stepSeconds(4);
        const expected = h.engine.sequence.secondsToTicks(h.engine.stepSeconds(4) + 50.25 % loopSeconds);
        near(h.engine.getPlaybackTick(), expected);
        assert.equal(h.engine.schedulingEndStep, 8);
        h.engine.stop();
    });

    await test('Pause preserves fractional ticks, ruler changes explicitly seek Resume, cancellation restores both positions', async () => {
        const h = createEditorHarness();
        const events = populateSteps(h);
        h.engine.setLoopRange(4, 8);
        setCursor(h, 10.125);
        await h.elements.playButton.onclick();
        h.engine.audioContext.currentTime = 0.10025;
        const paused = h.engine.getPlaybackTick();
        key(h, ' ');
        assert.equal(h.engine.isPaused, true);
        near(h.engine.pausedTick, paused);
        assert.equal(Number.isInteger(paused), false);
        const canvas = h.elements.pianoCanvas;
        canvas.onpointerdown(h.pointer(100 + 3.4 * 38, 15));
        near(h.engine.pausedTick, 408);
        canvas.onpointermove(h.pointer(100 + 5.4 * 38, 15));
        near(h.engine.pausedTick, 648);
        key(h, 'Escape');
        near(h.engine.pausedTick, paused);
        assert.equal(cursorTick(h), 1215);
        canvas.onpointerup(h.pointer(100 + 5.4 * 38, 15));
        canvas.onclick(h.pointer(100 + 5.4 * 38, 15));
        const originalEventCount = events.length;
        key(h, ' ');
        await h.engine.startPromise;
        near(h.engine.playbackAnchorTick, paused);
        h.engine.pause();
        setCursor(h, 2.125);
        near(h.engine.pausedTick, 255);
        key(h, ' ');
        await h.engine.startPromise;
        near(h.engine.playbackAnchorTick, 255);
        assert.ok(events.length >= originalEventCount);
        h.elements.stopButton.onclick();
        assert.equal(h.engine.isPaused, false);
        assert.equal(h.engine.currentStep, 4);
        await h.elements.playButton.onclick();
        near(h.engine.playbackAnchorTick, 255);
        h.engine.stop();
    });

    await test('moving the cursor during playback is stationary edit state and never seeks or restarts active audio', async () => {
        const h = createEditorHarness();
        const events = populateSteps(h);
        setCursor(h, 3.125);
        await h.elements.playButton.onclick();
        const run = h.engine.runId;
        const when = h.engine.playbackAnchorTime;
        h.engine.audioContext.currentTime = 0.15;
        const tick = h.engine.getPlaybackTick();
        const count = events.length;
        setCursor(h, 12.125);
        near(h.engine.getPlaybackTick(), tick);
        assert.equal(h.engine.runId, run);
        assert.equal(h.engine.playbackAnchorTime, when);
        assert.equal(events.length, count);
        assert.equal(events.some((event) => event.stopped), false);
        assert.equal(cursorTick(h), 1455);
        h.engine.stop();
    });

    await test('rapid cursor Play/Pause/seek/Resume discards stale async starts and uses the latest paused seek', async () => {
        const h = createEditorHarness();
        h.engine.initContext();
        const resumes = [];
        h.engine.audioContext.resume = () => new Promise((resolve) => resumes.push(resolve));
        h.engine.setLoopRange(4, 8);
        setCursor(h, 10.5);
        const old = h.elements.playButton.onclick();
        key(h, ' ');
        near(h.engine.pausedTick, 1260);
        setCursor(h, 2.25);
        const newest = h.elements.playButton.onclick();
        setCursor(h, 3.25);
        resumes[0]();
        await old;
        assert.equal(h.engine.isPlaying, false);
        resumes[1]();
        await newest;
        assert.equal(h.engine.isPlaying, true);
        near(h.engine.playbackAnchorTick, 390);
        assert.equal(h.intervals.size, 1);
        h.elements.stopButton.onclick();
        assert.equal(h.intervals.size, 0);
    });

    await test('late callbacks skip a non-loop initial tail before resuming the correct full-loop phase', async () => {
        const h = createEditorHarness();
        const events = populateSteps(h);
        h.engine.sequence.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 600, bpm: 60 }, { ticks: 1440, bpm: 90 }];
        h.engine.setLoopRange(4, 8);
        await h.engine.play(1260.375);
        const firstWrap = 0.05 + h.engine.stepSeconds(16) - h.engine.sequence.ticksToSeconds(1260.375);
        const loopSeconds = h.engine.stepSeconds(8) - h.engine.stepSeconds(4);
        h.engine.audioContext.currentTime = firstWrap + 23 * loopSeconds + 0.2;
        const prior = events.length;
        h.engine.scheduler();
        assert.equal(h.engine.schedulingEndStep, 8);
        assert.ok(events.length - prior <= 2);
        for (const event of events.slice(prior)) {
            assert.ok(event.startStep >= 4 && event.startStep < 8);
            assert.ok(event.when >= h.engine.audioContext.currentTime - 1e-7);
        }
        near(h.engine.getPlaybackTick(), h.engine.sequence.secondsToTicks(h.engine.stepSeconds(4) + 0.2));
        h.engine.stop();
    });

    await test('fractional-tick transport near an unusual PPQ pattern end survives Pause and cancelled ruler seeking', async () => {
        const h = createEditorHarness();
        h.engine.replaceSequence(new h.NoteSequence(17, 101));
        h.engine.setLoopRange(1, 4);
        h.elements.findNotes.onclick();
        await h.engine.play(429.125);
        near(h.engine.getPlaybackTick(), 429.125);
        h.engine.pause();
        near(h.engine.pausedTick, 429.125);
        const canvas = h.elements.pianoCanvas;
        canvas.onpointerdown(h.pointer(100 + 2.375 * 38, 15));
        assert.equal(h.engine.pausedTick, 60);
        canvas.onpointercancel(h.pointer(300, 15));
        near(h.engine.pausedTick, 429.125);
        canvas.onpointerup(h.pointer(300, 15));
        canvas.onclick(h.pointer(300, 15));
        setCursor(h, 17);
        assert.equal(cursorTick(h), 429);
        near(h.engine.pausedTick, 25.25);
        await h.elements.playButton.onclick();
        near(h.engine.playbackAnchorTick, 25.25);
        h.engine.stop();
        await h.engine.play(429);
        near(h.engine.playbackAnchorTick, 25.25);
        h.engine.stop();
    });

    await test('mouse Stop returns focus so immediate Space starts once from the editing cursor', async () => {
        const h = createEditorHarness();
        setCursor(h, 6.125);
        const events = voiceRecorder(h);
        h.engine.sequence.addNote({ midi: 60, ticks: 735, durationTicks: 120 });
        await spaceWithNativeDefault(h);
        assert.equal(h.engine.isPlaying, true);
        const stop = h.elements.stopButton;
        stop.tagName = 'BUTTON';
        await h.activateControl('stopButton');
        assert.equal(h.activeElement, h.elements.pianoViewport);
        assert.equal(h.elements.pianoViewport.focusOptions.preventScroll, true);
        assert.equal(h.engine.isPaused, false);
        assert.equal(await spaceWithNativeDefault(h), true);
        near(h.engine.playbackAnchorTick, 735);
        assert.equal(h.engine.isPlaying, true);
        assert.equal(h.intervals.size, 1);
        assert.equal(events.length, 2);
        assert.equal(events[0].stopped, true);
        assert.equal(events[1].stopped, false);
        h.engine.stop();
    });

    for (const activation of ['Enter', 'Space']) {
        await test(`native ${activation} keeps Stop keyboard-focused; subsequent Space retains native activation`, async () => {
            const h = createEditorHarness();
            setCursor(h, 3.375);
            await h.elements.playButton.onclick();
            let stops = 0;
            const original = h.engine.stop.bind(h.engine);
            h.engine.stop = () => { stops++; original(); };
            const stop = h.elements.stopButton;
            stop.tagName = 'BUTTON';
            stop.focus();
            if (activation === 'Space') {
                assert.equal(await spaceWithNativeDefault(h), false);
            } else {
                assert.equal(key(h, 'Enter', { target: stop }), false);
                stop.onclick();
            }
            assert.equal(stops, 1);
            assert.equal(h.engine.isPlaying, false);
            assert.equal(h.activeElement, stop);
            assert.equal(await spaceWithNativeDefault(h), false);
            assert.equal(stops, 2);
            assert.equal(h.intervals.size, 0);
            h.elements.pianoViewport.focus();
            assert.equal(await spaceWithNativeDefault(h), true);
            near(h.engine.playbackAnchorTick, 405);
            h.engine.stop();
        });
    }

    for (const phase of ['partial initial pass', 'repeated loop']) {
        await test(`Space Start/Pause/Resume/Stop/Start retains cursor and custom loops during ${phase}`, async () => {
            const h = createEditorHarness();
            h.engine.setPatternLength(32);
            h.engine.setLoopRange(4, 8);
            setCursor(h, 10.125);
            const cursor = h.elements.cursorPosition.textContent;
            await spaceWithNativeDefault(h);
            const initialDuration = h.engine.stepSeconds(32) - h.engine.sequence.ticksToSeconds(1215);
            h.engine.audioContext.currentTime = h.engine.playbackAnchorTime +
                (phase === 'partial initial pass' ? 0.1 : initialDuration + 0.1);
            h.animate();
            const tick = h.engine.getPlaybackTick();
            await spaceWithNativeDefault(h);
            assert.equal(h.engine.isPaused, true);
            near(h.engine.pausedTick, tick);
            await spaceWithNativeDefault(h);
            near(h.engine.playbackAnchorTick, tick);
            const stop = h.elements.stopButton;
            stop.tagName = 'BUTTON';
            await h.activateControl('stopButton');
            assert.equal(h.engine.pausedTick, null);
            assert.equal(h.intervals.size, 0);
            await spaceWithNativeDefault(h);
            near(h.engine.playbackAnchorTick, 1215);
            assert.equal(h.engine.loopStart, 4);
            assert.equal(h.engine.loopEnd, 8);
            assert.equal(h.intervals.size, 1);
            assert.equal(h.elements.cursorPosition.textContent, cursor);
            h.engine.stop();
        });
    }

    await test('Stop focus handoff keeps typing, dialogs and unrelated button Space protections intact', async () => {
        const h = createEditorHarness();
        h.elements.stopButton.onclick();
        for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
            { tagName: 'BUTTON' }, { tagName: 'SUMMARY' }, { isContentEditable: true }]) {
            assert.equal(key(h, ' ', { target }), false);
            assert.equal(h.engine.isPlaying, false);
        }
        h.setModalOpen(true);
        assert.equal(await spaceWithNativeDefault(h), false);
        assert.equal(h.engine.isPlaying, false);
        h.setModalOpen(false);
        h.elements.shortcutsButton.onclick();
        assert.equal(key(h, ' ', { target: h.elements.closeShortcuts }), false);
        assert.equal(h.engine.isPlaying, false);
        h.elements.closeShortcuts.onclick();
    });

    console.log(`${passed} workspace tests passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
