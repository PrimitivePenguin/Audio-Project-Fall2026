const assert = require('node:assert/strict');
const { createEditorHarness } = require('./editor-test-support');
let passed = 0;
function test(name, run) {
    run();
    passed++;
    console.log(`PASS ${name}`);
}
function setup() {
    const h = createEditorHarness();
    h.engine.sequence.tracks.push(
        { id: 'bass', name: 'Bass', channel: 2, program: 33, importId: 'source', sourceTrack: 4 },
        { id: 'strings', name: 'Strings', channel: 4, program: 48 },
        { id: 'empty', name: 'Empty', channel: 7, program: 80 }
    );
    h.engine.sequence.addNote({ id: 'p', midi: 60, ticks: 17, durationTicks: 241 });
    h.engine.sequence.addNote({ id: 'b', midi: 48, ticks: 21, durationTicks: 361, trackId: 'bass', importId: 'source', velocityMidi: 43 });
    h.engine.sequence.addNote({ id: 's', midi: 67, ticks: 137, durationTicks: 481, trackId: 'strings' });
    h.readyEvents[0].detail.editor.refresh();
    h.elements.tracksView.onclick();
    return h;
}
const ids = (h) => Array.from(h.engine.sequence.tracks, (track) => track.id);
const json = (h) => JSON.stringify(h.engine.sequence.toJSON());
function select(h, id) {
    h.elements.activeTrack.value = id;
    h.elements.activeTrack.onchange();
}
function key(h, key, extra = {}) {
    h.documentListeners.keydown({ key, preventDefault() {}, ...extra });
}
const undo = (h) => key(h, 'z', { ctrlKey: true });
const redo = (h) => key(h, 'z', { ctrlKey: true, shiftKey: true });
function drag(h, from, boundary, cancel) {
    const canvas = h.elements.pianoCanvas;
    const start = h.pointer(12, 32 + from * 84 + 30);
    const end = h.pointer(12, 32 + boundary * 84);
    canvas.onpointerdown(start);
    canvas.onpointermove(end);
    if (cancel === 'escape') key(h, 'Escape');
    else if (cancel) canvas.onpointercancel(end);
    else canvas.onpointerup(end);
}

test('model moves first/last/middle tracks while preserving track and note references and routing metadata', () => {
    const h = setup();
    const tracks = [...h.engine.sequence.tracks];
    const notes = h.engine.sequence.notes;
    h.engine.reorderMidiTrack('piano', 3);
    assert.deepEqual(ids(h), ['bass', 'strings', 'empty', 'piano']);
    h.engine.reorderMidiTrack('piano', 0);
    h.engine.reorderMidiTrack('strings', 1);
    assert.deepEqual(ids(h), ['piano', 'strings', 'bass', 'empty']);
    assert.equal(h.engine.sequence.tracks[2], tracks[1]);
    assert.equal(h.engine.sequence.notes, notes);
    assert.equal(h.engine.sequence.tracks[2].program, 33);
    assert.throws(() => h.engine.reorderMidiTrack('missing', 0));
    assert.throws(() => h.engine.setMidiTrackOrder(['piano']));
});

test('drag previews without mutation, commits upward/downward and synchronizes dropdown/focused ID', () => {
    const h = setup();
    select(h, 'strings');
    const canvas = h.elements.pianoCanvas;
    const before = json(h);
    canvas.onpointerdown(h.pointer(12, 32 + 2 * 84 + 30));
    canvas.onpointermove(h.pointer(12, 32 + 84));
    assert.equal(json(h), before);
    assert.ok(h.canvasCalls.some((call) => call.method === 'fillRect' && call.args[3] === 3));
    canvas.onpointerup(h.pointer(12, 32 + 84));
    assert.deepEqual(ids(h), ['piano', 'strings', 'bass', 'empty']);
    assert.equal(h.elements.activeTrack.value, 'strings');
    assert.equal(h.elements.activeTrack.children[2].value, 'strings');
    undo(h);
    assert.equal(json(h), before);
    redo(h);
    drag(h, 0, 4);
    assert.deepEqual(ids(h), ['strings', 'bass', 'empty', 'piano']);
});

for (const cancel of ['escape', 'pointer']) {
    test(`${cancel} cancellation leaves track order/history untouched`, () => {
        const h = setup();
        const before = json(h);
        drag(h, 3, 0, cancel);
        assert.equal(json(h), before);
        undo(h);
        assert.equal(json(h), before);
        assert.equal(h.elements.pianoCanvas.capturedPointers.size, 0);
    });
}

test('same-position drops do not create history and accessible buttons reorder with one Undo', () => {
    const h = setup();
    select(h, 'bass');
    h.elements.moveTrackUp.onclick();
    drag(h, 0, 0);
    undo(h);
    assert.deepEqual(ids(h), ['piano', 'bass', 'strings', 'empty']);
    redo(h);
    h.elements.moveTrackDown.onclick();
    assert.deepEqual(ids(h), ['piano', 'bass', 'strings', 'empty']);
});

test('long-list drag edge scrolling uses the existing animation and cancels cleanly', () => {
    const h = setup();
    for (let i = 0; i < 40; i++) h.engine.sequence.addMusicalTrack({ name: `Track ${i}` });
    h.readyEvents[0].detail.editor.refresh();
    h.elements.pianoCanvas.onpointerdown(h.pointer(12, 60));
    h.elements.pianoCanvas.onpointermove(h.pointer(12, 595));
    h.animate(20);
    h.animate(60);
    assert.ok(h.elements.pianoViewport.scrollTop > 0);
    key(h, 'Escape');
    const top = h.elements.pianoViewport.scrollTop;
    h.animate(100);
    assert.equal(h.elements.pianoViewport.scrollTop, top);
});

test('empty deletion is immediate, active selection falls back and last track is protected', () => {
    const h = setup();
    select(h, 'empty');
    h.elements.deleteMidiTrack.onclick();
    assert.ok(!ids(h).includes('empty'));
    assert.equal(Boolean(h.elements.deleteTrackDialog.open), false);
    assert.notEqual(h.elements.activeTrack.value, 'empty');
    undo(h);
    assert.equal(ids(h).at(-1), 'empty');
    h.engine.deleteMidiTrack('empty');
    h.engine.deleteMidiTrack('strings');
    h.engine.deleteMidiTrack('bass');
    assert.throws(() => h.engine.deleteMidiTrack('piano'), /last MIDI track/);
});

test('nonempty deletion requires confirmation; Cancel/Escape have no data or history effects', () => {
    const h = setup();
    select(h, 'bass');
    const before = json(h);
    h.elements.deleteMidiTrack.onclick();
    assert.equal(h.elements.deleteTrackDialog.open, true);
    assert.match(h.elements.deleteTrackMessage.textContent, /Bass.*1 MIDI notes/);
    h.elements.cancelDeleteTrack.onclick();
    assert.equal(json(h), before);
    h.elements.deleteMidiTrack.onclick();
    key(h, 'Escape');
    assert.equal(h.elements.deleteTrackDialog.open, false);
    undo(h);
    assert.equal(json(h), before);
});

test('confirmed imported-track deletion and Undo/Redo preserve exact order, note IDs, timing and metadata', () => {
    const h = setup();
    select(h, 'bass');
    const before = json(h);
    h.elements.deleteMidiTrack.onclick();
    h.elements.confirmDeleteTrack.onclick();
    assert.deepEqual(ids(h), ['piano', 'strings', 'empty']);
    assert.deepEqual(Array.from(h.engine.sequence.notes, (note) => note.id), ['p', 's']);
    undo(h);
    assert.equal(json(h), before);
    assert.equal(h.engine.sequence.notes[1].startStep, 21 / 120);
    redo(h);
    assert.ok(!ids(h).includes('bass'));
    undo(h);
    assert.equal(json(h), before);
});

test('confirmation identifies stable IDs after reordering and rejects stale changed tracks', () => {
    const h = setup();
    select(h, 'bass');
    h.elements.deleteMidiTrack.onclick();
    h.engine.reorderMidiTrack('bass', 3);
    h.elements.confirmDeleteTrack.onclick();
    assert.ok(!ids(h).includes('bass'));
    undo(h);
    select(h, 'bass');
    h.elements.deleteMidiTrack.onclick();
    h.engine.renameMidiTrack('bass', 'Changed');
    h.elements.confirmDeleteTrack.onclick();
    assert.ok(ids(h).includes('bass'));
    assert.match(h.elements.status.textContent, /changed/i);
});

test('deleting default Piano does not resurrect it on note creation; samples and other notes survive', () => {
    const h = setup();
    const sample = { sentinel: true };
    h.engine.sampleBuffer = sample;
    const record = h.engine.deleteMidiTrack('piano');
    assert.equal(h.engine.sequence.ensurePianoTrack(), 'bass');
    assert.ok(!ids(h).includes('piano'));
    assert.equal(h.engine.sampleBuffer, sample);
    assert.equal(h.engine.sequence.notes.length, 2);
    h.engine.restoreMidiTrack(record);
    assert.equal(ids(h)[0], 'piano');
});

test('invalid restore is atomic, including duplicate note IDs and invalid metadata', () => {
    const h = setup();
    const record = h.engine.deleteMidiTrack('bass');
    const before = json(h);
    assert.throws(() => h.engine.restoreMidiTrack({ ...record, track: { ...record.track, channel: 16 } }));
    assert.throws(() => h.engine.restoreMidiTrack({ ...record, notes: [...record.notes, ...record.notes] }));
    assert.equal(json(h), before);
    h.engine.restoreMidiTrack(record);
    assert.throws(() => h.engine.restoreMidiTrack(record));
});

test('deletion and restore require Stop in playing, paused and preparing states; reorder remains safe', () => {
    const h = setup();
    const record = h.engine.deleteMidiTrack('empty');
    for (const field of ['isPlaying', 'isPaused', 'startPromise']) {
        h.engine[field] = true;
        assert.throws(() => h.engine.deleteMidiTrack('bass'), /Stop/);
        assert.throws(() => h.engine.restoreMidiTrack(record), /Stop/);
        h.engine.reorderMidiTrack('strings', 0);
        h.engine[field] = false;
    }
    h.engine.restoreMidiTrack(record);
});

test('blocked structural Undo retains its transaction until Stop, then restores and supports note history', () => {
    const h = setup();
    select(h, 'empty');
    h.elements.deleteMidiTrack.onclick();
    h.engine.isPaused = true;
    undo(h);
    assert.ok(!ids(h).includes('empty'));
    h.engine.isPaused = false;
    undo(h);
    assert.ok(ids(h).includes('empty'));
    redo(h);
    assert.ok(!ids(h).includes('empty'));
});

test('MIDI export and JSON retain reordered survivors and restore deleted tracks in original position', () => {
    const h = setup();
    h.engine.reorderMidiTrack('strings', 0);
    const record = h.engine.deleteMidiTrack('bass');
    const exported = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
    assert.deepEqual(Array.from(exported.tracks, (track) => track.name), ['Strings', 'Piano', 'Empty']);
    const saved = JSON.parse(json(h));
    assert.deepEqual(saved.tracks.map((track) => track.id), ['strings', 'piano', 'empty']);
    assert.ok(saved.notes.every((note) => note.trackId !== 'bass'));
    h.engine.restoreMidiTrack(record);
    assert.deepEqual(ids(h), ['strings', 'piano', 'bass', 'empty']);
});

test('instrument synchronization removes/restores stable IDs while reorder never calls routing hooks', () => {
    const h = setup();
    const syncs = [];
    h.engine.registerInstrumentManager({
        syncTracks(tracks) { syncs.push(tracks); },
        createVoice() { return { stop() {}, finished: new Promise(() => {}) }; }
    });
    const count = syncs.length;
    h.engine.reorderMidiTrack('bass', 0);
    assert.equal(syncs.length, count);
    const record = h.engine.deleteMidiTrack('bass');
    assert.equal(syncs.length, count + 1);
    assert.ok(!syncs.at(-1).some((track) => track.id === 'bass'));
    h.engine.restoreMidiTrack(record);
    assert.equal(syncs.at(-1).find((track) => track.id === 'bass').program, 33);
});

test('import deletion/removal leaves no orphans and keeps manually created notes on a surviving track', () => {
    const h = setup();
    const imported = new h.NoteSequence(32, 480);
    imported.addNote({ midi: 52, ticks: 19, durationTicks: 37 });
    h.engine.sequence = h.engine.sequence.withMidiImport(imported, 'import-session');
    const sourceTrack = h.engine.sequence.tracks.find((track) => track.importId === 'import-session');
    h.engine.sequence.addNote({ midi: 70, ticks: 22, durationTicks: 25, trackId: sourceTrack.id });
    h.engine.deleteMidiTrack('piano');
    const remaining = h.engine.sequence.withoutMidiImport();
    assert.ok(!remaining.tracks.some((track) => track.id === 'piano'));
    assert.ok(remaining.notes.every((note) => remaining.tracks.some((track) => track.id === note.trackId)));
    assert.ok(remaining.notes.some((note) => note.midi === 70));
    const record = h.engine.deleteMidiTrack(sourceTrack.id);
    assert.ok(!h.engine.sequence.notes.some((note) => note.trackId === sourceTrack.id));
    h.engine.restoreMidiTrack(record);
    assert.ok(h.engine.sequence.notes.some((note) => note.importId === 'import-session'));
});

test('note edits and structural transactions share ordered Undo/Redo without invisible selections', () => {
    const h = setup();
    select(h, 'bass');
    h.elements.pianoRollView.onclick();
    key(h, 'a', { ctrlKey: true });
    h.elements.noteLength.value = '4';
    h.elements.noteLength.onchange();
    h.elements.moveTrackUp.onclick();
    h.elements.deleteMidiTrack.onclick();
    h.elements.confirmDeleteTrack.onclick();
    undo(h);
    assert.equal(h.engine.sequence.notes.find((note) => note.id === 'b').durationTicks, 480);
    undo(h);
    assert.deepEqual(ids(h), ['piano', 'bass', 'strings', 'empty']);
    undo(h);
    assert.equal(h.engine.sequence.notes.find((note) => note.id === 'b').durationTicks, 361);
    redo(h);
    redo(h);
    redo(h);
    assert.ok(!ids(h).includes('bass'));
});

test('out-of-history added tracks survive order Undo and new order clears Redo', () => {
    const h = setup();
    select(h, 'bass');
    h.elements.moveTrackUp.onclick();
    const added = h.engine.addMidiTrack('Later');
    undo(h);
    assert.equal(ids(h).at(-1), added.id);
    h.elements.moveTrackDown.onclick();
    const current = ids(h);
    redo(h);
    assert.deepEqual(ids(h), current);
});

test('drag cannot open a piano roll or rename/add tracks and outside drops are cancelled', () => {
    const h = setup();
    select(h, 'bass');
    const before = json(h);
    const canvas = h.elements.pianoCanvas;
    canvas.onpointerdown(h.pointer(12, 32 + 84 + 30));
    h.elements.trackName.value = 'Unwanted';
    h.elements.renameMidiTrack.onclick();
    h.elements.addMidiTrack.onclick();
    canvas.ondblclick(h.pointer(12, 32 + 84 + 30));
    canvas.onpointerup(h.pointer(-10, 40));
    assert.equal(json(h), before);
    assert.equal(h.readyEvents[0].detail.editor.getState().mode, 'tracks');
});

test('existing DashboardManager storage round-trips reordered/deleted canonical tracks and exact notes', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const stored = new Map();
    const scope = vm.createContext({ localStorage: {
        getItem(name) { return stored.get(name) ?? null; },
        setItem(name, value) { stored.set(name, value); }
    } });
    vm.runInContext(fs.readFileSync(path.join(__dirname,
        '../../main/resources/static/js/DashboardManager.js'), 'utf8'), scope);
    const manager = vm.runInContext('new DashboardManager()', scope);
    const h = setup();
    h.engine.reorderMidiTrack('strings', 0);
    h.engine.deleteMidiTrack('bass');
    const id = manager.saveProject('Track changes', h.engine.sequence.toJSON());
    const data = manager.getProjects()[id].data;
    const loaded = new h.NoteSequence(data.stepCount, data.ppq);
    loaded.name = data.name;
    loaded.tracks = data.tracks;
    loaded.tempos = data.tempos;
    loaded.timeSignatures = data.timeSignatures;
    loaded.importInfo = data.importInfo;
    data.notes.forEach((note) => loaded.addNote(note));
    assert.equal(JSON.stringify(loaded.toJSON()), json(h));
});

console.log(`${passed} track-management tests passed.`);
