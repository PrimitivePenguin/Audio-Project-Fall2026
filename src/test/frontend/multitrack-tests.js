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
function editor(h) {
    return h.readyEvents[0].detail.editor;
}
function setup() {
    const h = createEditorHarness();
    h.engine.setPatternLength(128);
    h.engine.sequence.tracks.push(
        { id: 'bass', name: 'Bass', channel: 2, program: 33 },
        { id: 'strings', name: 'Strings', channel: 4, program: 48 },
        { id: 'empty', name: 'Empty', channel: 7, program: 80 }
    );
    h.engine.sequence.addNote({ id: 'piano-a', midi: 60, ticks: 17, durationTicks: 241 });
    h.engine.sequence.addNote({ id: 'bass-a', midi: 48, ticks: 17, durationTicks: 361, trackId: 'bass', importId: 'source', velocityMidi: 43 });
    h.engine.sequence.addNote({ id: 'strings-a', midi: 67, ticks: 137, durationTicks: 481, trackId: 'strings' });
    editor(h).refresh();
    return h;
}
function key(h, value, options = {}) {
    let prevented = false;
    h.documentListeners.keydown({ key: value, preventDefault() { prevented = true; }, ...options });
    return prevented;
}
function command(h, value, options = {}) {
    return key(h, value, { ctrlKey: true, ...options });
}
function snapshot(h) {
    return JSON.parse(JSON.stringify(h.engine.sequence.toJSON()));
}
function near(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} should be near ${expected}`);
}
function selectTrack(h, id) {
    h.elements.activeTrack.value = id ?? '';
    h.elements.activeTrack.onchange();
}
function note(h, id) {
    return h.engine.sequence.notes.find((candidate) => candidate.id === id);
}
function setCursor(h, step) {
    h.clickAt(100 + step * 38 - h.elements.pianoViewport.scrollLeft, 15);
}
function enterLength(h, value) {
    h.elements.noteLength.value = String(value);
    h.elements.noteLength.onchange();
}
function ghostRects(h) {
    return h.canvasCalls.filter((call) => call.method === 'fillRect' && call.globalAlpha === 0.22);
}

(async () => {
    await test('overview has one lane per canonical track, including empty tracks, with note references and matching colors', () => {
        const h = setup();
        const before = snapshot(h);
        const lanes = h.TrackOverview.lanes(h.engine.sequence);
        assert.equal(lanes.length, 4);
        assert.equal(lanes[0].notes[0], note(h, 'piano-a'));
        assert.equal(lanes[1].notes[0], note(h, 'bass-a'));
        assert.equal(lanes[2].notes[0], note(h, 'strings-a'));
        assert.equal(lanes[3].notes.length, 0);
        h.elements.tracksView.onclick();
        assert.equal(editor(h).getState().mode, 'tracks');
        assert.equal(h.elements.pianoSpacer.style.height, `${32 + 4 * 84}px`);
        h.paint();
        for (const lane of lanes) {
            assert.ok(h.canvasCalls.some((call) => call.method === 'fillText' && call.args[0] === lane.track.name));
            if (lane.notes.length) {
                assert.ok(h.canvasCalls.some((call) => call.method === 'fillRect' && call.args[3] === 5 &&
                    call.fillStyle === h.TrackOverview.color(lane.track.id)));
            }
        }
        assert.deepEqual(snapshot(h), before);
    });

    await test('miniature previews use exact tick start/duration and lane-relative pitches at arbitrary PPQ', () => {
        const h = createEditorHarness();
        for (const ppq of [1, 7, 101, 480, 32767]) {
            const sequence = new h.NoteSequence(65536, ppq);
            sequence.addNote({ midi: 20, ticks: 17, durationTicks: 37 });
            sequence.addNote({ midi: 100, ticks: 18, durationTicks: 11 });
            const lane = h.TrackOverview.lanes(sequence)[0];
            const low = h.TrackOverview.rectangle(sequence.notes[0], lane, sequence, { scrollLeft: 13.25, scrollTop: 7 });
            const high = h.TrackOverview.rectangle(sequence.notes[1], lane, sequence, { scrollLeft: 13.25, scrollTop: 7 });
            near(low.x, 100 + 17 * 4 / ppq * 38 - 13.25);
            near(low.width, 37 * 4 / ppq * 38);
            assert.ok(high.y < low.y);
            assert.equal(low.height, 5);
        }
    });

    await test('long multi-track imports render only visible lanes/notes on a viewport-sized canvas after scrolling and resizing', async () => {
        const h = createEditorHarness(2);
        const source = new h.NoteSequence(4096, 101);
        source.tracks = Array.from({ length: 40 }, (_, index) => ({ id: `source-${index}`, name: `Track ${index}`, channel: index % 16, program: index % 128 }));
        for (let index = 0; index < 4000; index++) {
            source.addNote({ midi: 24 + index % 84, ticks: index * 20 + 1, durationTicks: 19 + index % 100,
                trackId: source.tracks[index % 40].id });
        }
        await h.importSequence(source);
        h.elements.tracksView.onclick();
        h.elements.pianoViewport.scrollLeft = 80000;
        h.elements.pianoViewport.scrollTop = 20 * 84;
        h.paint();
        assert.equal(h.elements.pianoCanvas.width, 1800);
        assert.equal(h.elements.pianoCanvas.height, 1200);
        assert.ok(h.canvasCalls.filter((call) => call.method === 'fillText' && /^Track /.test(call.args[0])).length <= 9);
        const previews = h.canvasCalls.filter((call) => call.method === 'fillRect' && call.args[3] === 5);
        assert.ok(previews.length < 150);
        h.elements.pianoViewport.clientWidth = 700;
        h.elements.pianoViewport.clientHeight = 400;
        h.resize();
        assert.equal(h.elements.pianoCanvas.width, 1400);
        assert.equal(h.elements.pianoCanvas.height, 800);
        assert.equal(h.engine.sequence.notes.length, 4000);
        assert.equal(h.engine.sequence.ppq, 101);
    });

    await test('single-click lane/header selects and double-click or Edit Track opens the same track without resetting time', () => {
        const h = setup();
        const before = snapshot(h);
        setCursor(h, 5.125);
        h.elements.pianoViewport.scrollLeft = 200;
        h.elements.tracksView.onclick();
        h.clickAt(30, 32 + 84 + 25);
        assert.equal(editor(h).getState().activeTrackId, 'bass');
        assert.equal(editor(h).getState().mode, 'tracks');
        assert.equal(h.elements.activeTrack.value, 'bass');
        h.elements.pianoCanvas.ondblclick(h.pointer(150, 32 + 84 + 25));
        assert.equal(editor(h).getState().mode, 'piano');
        assert.equal(h.elements.activeTrackName.textContent, 'Bass');
        assert.equal(h.elements.activeTrackName.style.color, h.TrackOverview.color('bass'));
        assert.equal(h.elements.pianoViewport.scrollLeft, 200);
        assert.equal(editor(h).getState().editingCursorTick, 615);
        h.elements.tracksView.onclick();
        h.elements.pianoRollView.onclick();
        assert.equal(editor(h).getState().activeTrackId, 'bass');
        assert.deepEqual(snapshot(h), before);
    });

    await test('track switching clears selection and All Notes restores cross-track selection without mutating notes', () => {
        const h = setup();
        const before = snapshot(h);
        command(h, 'a');
        assert.equal(h.elements.selectionCount.textContent, '3 selected');
        selectTrack(h, 'bass');
        assert.equal(h.elements.selectionCount.textContent, '0 selected');
        command(h, 'a');
        assert.equal(h.elements.selectionCount.textContent, '1 selected');
        assert.match(h.elements.noteInfo.textContent, /bass-a/);
        selectTrack(h, 'strings');
        assert.equal(h.elements.selectionCount.textContent, '0 selected');
        selectTrack(h, null);
        command(h, 'a');
        assert.equal(h.elements.selectionCount.textContent, '3 selected');
        assert.deepEqual(snapshot(h), before);
    });

    await test('focused new notes and inspector editing target the active track exclusively', () => {
        const h = setup();
        selectTrack(h, 'bass');
        const original = snapshot(h).notes;
        h.clickAt(100 + 8 * 38 + 12, 32 + 8 * 24 + 12);
        const created = h.engine.sequence.notes.at(-1);
        assert.equal(created.trackId, 'bass');
        assert.equal(created.importId, null);
        command(h, 'a');
        enterLength(h, 4);
        assert.equal(note(h, 'bass-a').durationTicks, 480);
        assert.equal(created.durationTicks, 480);
        assert.equal(note(h, 'piano-a').durationTicks, original[0].durationTicks);
        assert.equal(note(h, 'strings-a').durationTicks, original[2].durationTicks);
        assert.equal(note(h, 'bass-a').importId, 'source');
    });

    await test('ghost rendering reuses notes and cannot join Select All, hit testing, resize, deletion or clipboard', () => {
        const h = setup();
        selectTrack(h, 'bass');
        editor(h).setGhostNotes(true);
        const originalGhost = note(h, 'strings-a');
        const original = { ...originalGhost };
        h.paint();
        assert.ok(ghostRects(h).some((call) => call.fillStyle === h.TrackOverview.color('strings')));
        command(h, 'a');
        assert.equal(h.elements.selectionCount.textContent, '1 selected');
        const beforeGhostDrag = snapshot(h);
        h.drag(originalGhost, 'right', originalGhost.startStep + originalGhost.durationSteps + 2);
        assert.deepEqual(snapshot(h), beforeGhostDrag);
        command(h, 'a');
        command(h, 'c');
        setCursor(h, 10);
        command(h, 'v');
        assert.equal(h.engine.sequence.notes.at(-1).trackId, 'bass');
        assert.equal(h.engine.sequence.notes.at(-1).midi, 48);
        const bounds = h.noteBounds(originalGhost);
        const count = h.engine.sequence.notes.length;
        key(h, 'Escape');
        h.clickAt(bounds.x + 20, bounds.y + 12);
        assert.equal(h.engine.sequence.notes.length, count + 1);
        assert.equal(h.engine.sequence.notes.at(-1).trackId, 'bass');
        assert.equal(originalGhost, note(h, 'strings-a'));
        assert.deepEqual({ ...originalGhost }, original);
        command(h, 'a');
        key(h, 'Delete');
        assert.equal(h.engine.sequence.notes.length, 2);
        assert.equal(note(h, 'strings-a'), originalGhost);
        assert.ok(note(h, 'piano-a'));
        editor(h).setGhostNotes(false);
        h.paint();
        assert.equal(ghostRects(h).length, 0);
        selectTrack(h, null);
        command(h, 'a');
        assert.equal(h.elements.selectionCount.textContent, '2 selected');
    });

    await test('marquee and center-based arrow navigation exclude other-track ghosts', () => {
        const h = setup();
        const next = h.engine.sequence.addNote({ id: 'bass-b', midi: 52, ticks: 1000, durationTicks: 121, trackId: 'bass' });
        selectTrack(h, 'bass');
        editor(h).setGhostNotes(true);
        h.clickNote(note(h, 'bass-a'));
        assert.equal(key(h, 'ArrowRight'), true);
        assert.match(h.elements.noteInfo.textContent, /bass-b/);
        const canvas = h.elements.pianoCanvas;
        canvas.onpointerdown(h.pointer(110, 40));
        canvas.onpointermove(h.pointer(890, 590));
        canvas.onpointerup(h.pointer(890, 590));
        canvas.onclick(h.pointer(890, 590));
        assert.equal(h.elements.selectionCount.textContent, '2 selected');
        enterLength(h, 2);
        assert.equal(next.durationTicks, 240);
        assert.equal(note(h, 'strings-a').durationTicks, 481);
    });

    await test('focused paste maps all source notes to the destination track; All Notes and Duplicate preserve source IDs', () => {
        const h = setup();
        command(h, 'a');
        command(h, 'c');
        selectTrack(h, 'bass');
        setCursor(h, 10.125);
        command(h, 'v');
        const focused = h.engine.sequence.notes.slice(3);
        assert.equal(focused.length, 3);
        assert.equal(focused.every((note) => note.trackId === 'bass' && note.importId === null), true);
        assert.deepEqual(Array.from(focused, (note) => note.ticks), [1215, 1215, 1335]);
        assert.equal(new Set(h.engine.sequence.notes.map((note) => note.id)).size, 6);
        command(h, 'd');
        assert.equal(h.engine.sequence.notes.slice(6).every((note) => note.trackId === 'bass'), true);
        selectTrack(h, null);
        setCursor(h, 24);
        command(h, 'v');
        assert.equal(h.engine.sequence.notes.slice(9).every((note) => note.trackId === 'bass'), true);
        // Recopy only the original notes through the ordinary All Notes selection gestures.
        const canvas = h.elements.pianoCanvas;
        for (const [index, id] of ['piano-a', 'bass-a', 'strings-a'].entries()) {
            const bounds = h.noteBounds(note(h, id));
            const event = h.pointer(bounds.x + bounds.hitWidth / 2, bounds.y + 12, { shiftKey: index > 0 });
            canvas.onpointerdown(event);
            canvas.onpointerup(event);
            canvas.onclick(event);
        }
        assert.equal(h.elements.selectionCount.textContent, '3 selected');
        command(h, 'c');
        const count = h.engine.sequence.notes.length;
        setCursor(h, 24);
        command(h, 'v');
        assert.deepEqual(Array.from(h.engine.sequence.notes.slice(count), (note) => note.trackId), ['piano', 'bass', 'strings']);
    });

    await test('Undo/Redo across track and workspace changes edits original IDs but never selects invisible notes', () => {
        const h = setup();
        selectTrack(h, 'bass');
        command(h, 'a');
        enterLength(h, 4);
        selectTrack(h, 'strings');
        command(h, 'z');
        assert.equal(note(h, 'bass-a').durationTicks, 361);
        assert.equal(h.elements.selectionCount.textContent, '0 selected');
        assert.match(h.elements.status.textContent, /Bass/);
        command(h, 'z', { shiftKey: true });
        assert.equal(note(h, 'bass-a').durationTicks, 480);
        assert.equal(h.elements.selectionCount.textContent, '0 selected');
        h.elements.tracksView.onclick();
        command(h, 'z');
        assert.equal(note(h, 'bass-a').durationTicks, 361);
        assert.equal(h.elements.selectionCount.textContent, '0 selected');
        h.elements.pianoRollView.onclick();
        selectTrack(h, 'bass');
        command(h, 'z', { shiftKey: true });
        assert.equal(h.elements.selectionCount.textContent, '1 selected');
        assert.match(h.elements.noteInfo.textContent, /bass-a/);
    });

    await test('overview clicks and editor shortcuts never create/edit notes; timeline ruler remains precise', () => {
        const h = setup();
        const before = snapshot(h);
        command(h, 'a');
        command(h, 'c');
        h.elements.tracksView.onclick();
        for (const value of ['a', 'v', 'x', 'd', 'ArrowRight', 'Delete']) {
            key(h, value, { ctrlKey: ['a', 'v', 'x', 'd'].includes(value) });
        }
        h.clickAt(300, 32 + 84 + 30);
        assert.deepEqual(snapshot(h), before);
        assert.equal(h.elements.noteLength.disabled, true);
        assert.equal(h.elements.pasteNotes.disabled, true);
        const canvas = h.elements.pianoCanvas;
        canvas.onpointerdown(h.pointer(100 + 2.125 * 38, 15));
        canvas.onpointermove(h.pointer(100 + 3.375 * 38, 15));
        canvas.onpointerup(h.pointer(100 + 3.375 * 38, 15));
        canvas.onclick(h.pointer(100 + 3.375 * 38, 15));
        assert.equal(editor(h).getState().editingCursorTick, 405);
        assert.deepEqual(snapshot(h), before);
    });

    await test('mode changes preserve cursor, custom loops, samples, voices and the one running scheduler', async () => {
        const h = setup();
        const events = [];
        let stoppedVoices = 0;
        h.engine.voiceFactory = (event) => {
            events.push({ ...event });
            return { stop() { stoppedVoices++; }, finished: new Promise(() => {}) };
        };
        h.engine.addTrack('sample', {});
        h.engine.setStep('sample', 4, true);
        h.engine.setLoopRange(4, 16);
        setCursor(h, 4);
        await h.elements.playButton.onclick();
        const before = snapshot(h);
        const runId = h.engine.runId;
        const samples = h.engine.tracks.get('sample');
        const tick = h.engine.getPlaybackTick();
        h.elements.tracksView.onclick();
        selectTrack(h, 'bass');
        h.elements.pianoRollView.onclick();
        selectTrack(h, null);
        near(h.engine.getPlaybackTick(), tick);
        assert.equal(h.engine.runId, runId);
        assert.equal(h.intervals.size, 1);
        assert.equal(h.engine.tracks.get('sample'), samples);
        assert.equal(samples.activeSources.size, 1);
        assert.equal(stoppedVoices, 0);
        assert.ok(events.some((event) => event.trackId === 'strings' && event.channel === 4 && event.program === 48));
        assert.deepEqual(snapshot(h), before);
        assert.equal(editor(h).getState().editingCursorTick, 480);
        key(h, ' ');
        assert.equal(h.engine.isPaused, true);
        h.elements.tracksView.onclick();
        key(h, ' ');
        await h.engine.startPromise;
        assert.equal(h.engine.isPlaying, true);
        assert.equal(h.intervals.size, 1);
        h.elements.stopButton.onclick();
        key(h, ' ');
        await h.engine.startPromise;
        near(h.engine.playbackAnchorTick, 480);
        assert.equal(h.intervals.size, 1);
        h.engine.stop();
    });

    await test('overview shares midpoint follow and manual interruption/rearm with the piano roll', async () => {
        const h = setup();
        h.elements.tracksView.onclick();
        await h.elements.playButton.onclick();
        h.engine.audioContext.currentTime = h.engine.playbackAnchorTime + 12 / 8;
        h.animate();
        near(h.elements.pianoViewport.scrollLeft, 56);
        h.elements.pianoRollView.onclick();
        near(h.elements.pianoViewport.scrollLeft, 56);
        h.engine.audioContext.currentTime += 1 / 8;
        h.animate();
        near(h.elements.pianoViewport.scrollLeft, 56);
        h.elements.tracksView.onclick();
        h.elements.pianoViewport.scrollLeft = 400;
        h.paint();
        h.engine.audioContext.currentTime = h.engine.playbackAnchorTime + 22 / 8;
        h.animate();
        near(h.elements.pianoViewport.scrollLeft, 436);
        h.engine.stop();
    });

    await test('MIDI export retains active-track edits, note precision, imported metadata and new empty tracks', () => {
        const h = setup();
        const empty = h.engine.addMidiTrack('New Empty');
        const before = { ...h.engine.sequence.tracks[1] };
        h.engine.renameMidiTrack('bass', 'Electric Bass');
        selectTrack(h, 'bass');
        command(h, 'a');
        enterLength(h, 2.25);
        const exported = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
        const bass = exported.tracks.find((track) => track.name === 'Electric Bass');
        assert.equal(bass.channel, 2);
        assert.equal(bass.program, 33);
        const exportedNote = exported.notes.find((candidate) => candidate.trackId === bass.id);
        assert.equal(exportedNote.ticks, 17);
        assert.equal(exportedNote.durationTicks, 270);
        assert.equal(exportedNote.velocityMidi, 43);
        assert.ok(exported.tracks.some((track) => track.name === empty.name));
        assert.deepEqual(h.engine.sequence.tracks[1], { ...before, name: 'Electric Bass' });
    });

    await test('new track IDs avoid collisions across copies and renaming preserves every other track field', () => {
        const h = setup();
        const sequence = h.engine.sequence;
        sequence.tracks.push({ id: 'track-1', name: 'Reserved', channel: 9, program: 40, importId: 'source', sourceTrackId: 'original' });
        const created = sequence.addMusicalTrack({ name: '  Lead  ', channel: 5, program: 81 });
        assert.equal(created.id, 'track-2');
        assert.equal(created.name, 'Lead');
        const copied = sequence.copyAtPpq(sequence.ppq);
        const another = copied.addMusicalTrack({ name: 'Another' });
        assert.equal(another.id, 'track-3');
        const imported = sequence.tracks.find((track) => track.id === 'track-1');
        const before = { ...imported };
        sequence.renameMusicalTrack(imported.id, 'Renamed drums');
        assert.deepEqual(imported, { ...before, name: 'Renamed drums' });
        assert.equal(new Set(sequence.tracks.map((track) => track.id)).size, sequence.tracks.length);
    });

    await test('invalid track operations reject atomically and add/rename synchronize the existing instrument manager only when safe', async () => {
        const h = setup();
        const syncs = [];
        h.engine.registerInstrumentManager({
            syncTracks(tracks) { syncs.push(tracks); },
            createVoice() { return { stop() {}, finished: new Promise(() => {}) }; }
        });
        const sequence = h.engine.sequence;
        for (const name of ['', ' ', 'x'.repeat(129), null]) {
            const before = snapshot(h);
            assert.throws(() => h.engine.addMidiTrack(name));
            assert.throws(() => h.engine.renameMidiTrack('bass', name));
            assert.deepEqual(snapshot(h), before);
        }
        assert.throws(() => sequence.addMusicalTrack({ channel: 16 }));
        assert.throws(() => sequence.addMusicalTrack({ program: -1 }));
        assert.throws(() => sequence.renameMusicalTrack('missing', 'Valid'));
        const added = h.engine.addMidiTrack('Lead');
        h.engine.renameMidiTrack(added.id, 'Renamed Lead');
        assert.equal(syncs.at(-1).find((track) => track.id === added.id).name, 'Renamed Lead');
        await h.engine.play();
        const before = snapshot(h);
        assert.throws(() => h.engine.addMidiTrack('Unsafe'), /Pause or stop/);
        assert.throws(() => h.engine.renameMidiTrack('bass', 'Unsafe'), /Pause or stop/);
        assert.deepEqual(snapshot(h), before);
        assert.equal(h.engine.isPlaying, true);
        h.engine.pause();
        const paused = h.engine.pausedTick;
        h.engine.renameMidiTrack(added.id, 'Paused rename');
        assert.equal(h.engine.pausedTick, paused);
        h.engine.stop();
    });

    await test('new-track UI, rename controls and external workspace API validate safely and do not add another engine', () => {
        const h = setup();
        const initial = h.engine.sequence.tracks.length;
        h.elements.addMidiTrack.onclick();
        assert.equal(h.engine.sequence.tracks.length, initial + 1);
        const id = editor(h).getState().activeTrackId;
        assert.equal(h.elements.activeTrack.value, id);
        h.elements.trackName.value = 'Lead renamed';
        h.elements.renameMidiTrack.onclick();
        assert.equal(h.engine.sequence.tracks.at(-1).name, 'Lead renamed');
        assert.equal(h.elements.activeTrackName.textContent, 'Lead renamed');
        const before = editor(h).getState();
        assert.throws(() => editor(h).setWorkspace('invalid'));
        assert.throws(() => editor(h).setWorkspace('piano', 'missing'));
        assert.throws(() => editor(h).setGhostNotes('true'));
        assert.deepEqual(editor(h).getState(), before);
        assert.equal(h.readyEvents[0].detail.engine, h.engine);
        assert.equal(h.readyEvents.length, 1);
    });

    await test('many lanes use scroll-aware hit testing and keyboard selector reveals a selected lane minimally', () => {
        const h = setup();
        for (let index = 0; index < 40; index++) h.engine.sequence.addMusicalTrack({ name: `Lane ${index}` });
        h.elements.tracksView.onclick();
        h.elements.pianoViewport.scrollTop = 20 * 84;
        h.paint();
        h.clickAt(30, 32 + 40);
        assert.equal(editor(h).getState().activeTrackId, h.engine.sequence.tracks[20].id);
        selectTrack(h, h.engine.sequence.tracks.at(-1).id);
        near(h.elements.pianoViewport.scrollTop, 44 * 84 - (600 - 32));
        const top = h.elements.pianoViewport.scrollTop;
        h.elements.pianoRollView.onclick();
        h.elements.tracksView.onclick();
        near(h.elements.pianoViewport.scrollTop, top);
    });

    await test('sequence replacement/removal clears missing active IDs and selections without losing newly manual tracks', async () => {
        const h = setup();
        const source = new h.NoteSequence(64);
        source.addNote({ midi: 40, ticks: 17, durationTicks: 121 });
        await h.importSequence(source);
        const imported = h.engine.sequence.tracks.find((track) => track.importId);
        selectTrack(h, imported.id);
        command(h, 'a');
        h.engine.addMidiTrack('Survivor');
        h.elements.removeImportedMidi.onclick();
        assert.equal(editor(h).getState().activeTrackId, null);
        assert.equal(h.elements.selectionCount.textContent, '0 selected');
        assert.ok(h.engine.sequence.tracks.some((track) => track.name === 'Survivor'));
        h.elements.tracksView.onclick();
        h.elements.newSequence.onclick();
        assert.equal(h.engine.sequence.tracks.length, 1);
        assert.equal(h.elements.activeTrack.children.length, 2);
        assert.equal(editor(h).getState().editingCursorTick, 0);
    });

    await test('layout and help preserve native workspace controls, account/logout and dashboard integration', () => {
        const h = setup();
        const root = path.resolve(__dirname, '../../main/resources/static');
        const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
        for (const id of ['tracksView', 'pianoRollView', 'activeTrack', 'activeTrackName', 'ghostNotes', 'addMidiTrack', 'renameMidiTrack', 'trackName']) {
            assert.match(html, new RegExp(`id="${id}"`));
        }
        assert.match(html, /fetch\('\/api\/current-user'\)/);
        assert.match(html, /action="\/logout" method="post"/);
        assert.match(html, /href="\/dashboard.html"/);
        assert.ok(html.indexOf('/js/TrackOverview.js') < html.indexOf('/js/sequencer-ui.js'));
        assert.match(h.elements.mouseGuide.children.map((child) => child.textContent).join(' '), /double-click a lane/);
        h.elements.activeTrack.focus();
        assert.equal(key(h, 'ArrowDown', { target: { tagName: 'SELECT' } }), false);
    });

    await test('track limits and hidden/unknown track activation reject safely without touching note data', () => {
        const h = setup();
        h.engine.sequence.tracks.push({ id: 'hidden', name: 'Hidden', channel: 8, program: 20, hidden: true });
        editor(h).refresh();
        const before = snapshot(h);
        assert.throws(() => editor(h).setWorkspace('piano', 'hidden'), /visible/);
        assert.throws(() => editor(h).setWorkspace('tracks', 'missing'), /existing/);
        assert.deepEqual(snapshot(h), before);
        editor(h).setWorkspace('tracks', 'hidden');
        assert.equal(editor(h).getState().activeTrackId, 'hidden');
        const count = h.engine.sequence.notes.length;
        h.elements.pianoRollView.onclick();
        assert.equal(editor(h).getState().mode, 'tracks');
        assert.equal(h.engine.sequence.notes.length, count);
        while (h.engine.sequence.tracks.length < 255) {
            h.engine.sequence.addMusicalTrack({ name: 'Empty' });
        }
        const limited = snapshot(h);
        assert.throws(() => h.engine.addMidiTrack('Overflow'), /255/);
        assert.deepEqual(snapshot(h), limited);
    });

    await test('renaming and adding tracks do not discard existing note history or alter instrument routing IDs', () => {
        const h = setup();
        selectTrack(h, 'bass');
        command(h, 'a');
        enterLength(h, 4);
        h.engine.renameMidiTrack('bass', 'Renamed Bass');
        h.engine.addMidiTrack('Fresh');
        editor(h).refresh();
        command(h, 'z');
        assert.equal(note(h, 'bass-a').durationTicks, 361);
        assert.equal(note(h, 'bass-a').trackId, 'bass');
        assert.equal(h.engine.sequence.tracks.find((track) => track.id === 'bass').program, 33);
        assert.ok(h.engine.sequence.tracks.some((track) => track.name === 'Fresh'));
        command(h, 'z', { shiftKey: true });
        assert.equal(note(h, 'bass-a').durationTicks, 480);
    });

    await test('track management rejects pending playback preparation and keeps the active view stable', async () => {
        const h = setup();
        let release;
        h.engine.registerInstrumentManager({
            prepare() { return new Promise((resolve) => { release = resolve; }); },
            createVoice() { return { stop() {}, finished: new Promise(() => {}) }; }
        });
        const pending = h.elements.playButton.onclick();
        await new Promise(setImmediate);
        const before = snapshot(h);
        assert.equal(h.elements.addMidiTrack.disabled, true);
        assert.throws(() => h.engine.addMidiTrack('Pending'), /Pause or stop/);
        assert.throws(() => h.engine.renameMidiTrack('bass', 'Pending'), /Pause or stop/);
        h.elements.tracksView.onclick();
        assert.equal(editor(h).getState().mode, 'tracks');
        assert.deepEqual(snapshot(h), before);
        h.elements.stopButton.onclick();
        release();
        await pending;
        assert.equal(h.engine.isPlaying, false);
        assert.equal(h.intervals.size, 0);
    });

    await test('focused group movement/resize and cancelled gestures preserve other tracks and metadata', () => {
        const h = setup();
        h.engine.sequence.addNote({ id: 'bass-b', midi: 50, ticks: 497, durationTicks: 241, trackId: 'bass', velocityMidi: 77 });
        selectTrack(h, 'bass');
        editor(h).setGhostNotes(true);
        const otherTracks = snapshot(h).notes.filter((candidate) => candidate.trackId !== 'bass');
        command(h, 'a');
        const bass = note(h, 'bass-a');
        h.drag(bass, 'right', bass.startStep + bass.durationSteps + 2);
        assert.equal(bass.ticks, 17);
        assert.equal(bass.durationTicks, 601);
        assert.equal(note(h, 'bass-b').durationTicks, 481);
        const bounds = h.noteBounds(bass);
        const canvas = h.elements.pianoCanvas;
        canvas.onpointerdown(h.pointer(bounds.x + 30, bounds.y + 12));
        const finish = h.pointer(bounds.x + 68, bounds.y - 12);
        canvas.onpointermove(finish);
        canvas.onpointerup(finish);
        canvas.onclick(finish);
        assert.equal(bass.ticks, 137);
        assert.equal(bass.midi, 49);
        assert.equal(note(h, 'bass-b').ticks, 617);
        assert.equal(note(h, 'bass-b').midi, 51);
        assert.equal(note(h, 'bass-b').velocityMidi, 77);
        const moved = snapshot(h);
        const movedBounds = h.noteBounds(bass);
        canvas.onpointerdown(h.pointer(movedBounds.x + 30, movedBounds.y + 12));
        canvas.onpointermove(h.pointer(movedBounds.x + 150, movedBounds.y + 12));
        h.elements.tracksView.onclick();
        assert.deepEqual(snapshot(h), moved);
        assert.deepEqual(snapshot(h).notes.filter((candidate) => candidate.trackId !== 'bass'), otherTracks);
        assert.equal(h.elements.selectionCount.textContent, '0 selected');
    });

    await test('replacing MIDI while focused returns to All Notes in the current workspace and preserves track-view cursor rules', async () => {
        const h = setup();
        selectTrack(h, 'bass');
        const imported = new h.NoteSequence(64, 960);
        imported.addNote({ midi: 90, ticks: 117, durationTicks: 243 });
        await h.importSequence(imported);
        assert.equal(editor(h).getState().mode, 'piano');
        assert.equal(editor(h).getState().activeTrackId, null);
        assert.equal(editor(h).getState().editingCursorTick, 0);
        assert.ok(Number(h.elements.pitchHigh.value) >= 90);
        h.elements.tracksView.onclick();
        const next = new h.NoteSequence(32, 480);
        next.addNote({ midi: 60, ticks: 17, durationTicks: 121 });
        await h.importSequence(next);
        assert.equal(editor(h).getState().mode, 'tracks');
        assert.equal(editor(h).getState().activeTrackId, null);
        assert.equal(h.elements.activeTrack.children.length, h.engine.sequence.tracks.length + 1);
    });

    await test('external visibility changes plus editor refresh cannot leave invisible track notes selected or editable', () => {
        const h = setup();
        selectTrack(h, 'bass');
        command(h, 'a');
        h.engine.sequence.tracks.find((track) => track.id === 'bass').hidden = true;
        editor(h).refresh();
        assert.equal(editor(h).getState().activeTrackId, null);
        assert.equal(h.elements.selectionCount.textContent, '0 selected');
        h.elements.velocity.value = '100';
        h.elements.velocity.onchange();
        assert.equal(note(h, 'bass-a').velocityMidi, 43);
        command(h, 'a');
        assert.equal(h.elements.selectionCount.textContent, '2 selected');
    });

    console.log(`${passed} multitrack tests passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
