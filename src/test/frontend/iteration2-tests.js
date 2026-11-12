const assert = require('node:assert/strict');
const { createEditorHarness } = require('./editor-test-support');
let passed = 0;
function test(name, run) {
    run();
    passed++;
    console.log(`PASS ${name}`);
}
function key(h, value, options = {}) {
    let prevented = false;
    h.documentListeners.keydown({ key: value, ctrlKey: true,
        preventDefault() { prevented = true; }, ...options });
    return prevented;
}
function click(h, note, options = {}) {
    const bounds = h.noteBounds(note);
    const event = h.pointer(bounds.x + bounds.hitWidth / 2, bounds.y + 12, options);
    h.elements.pianoCanvas.onpointerdown(event);
    h.elements.pianoCanvas.onpointerup(event);
    h.elements.pianoCanvas.onclick(event);
}
function drag(h, start, end, cancel) {
    const canvas = h.elements.pianoCanvas;
    canvas.onpointerdown(start);
    canvas.onpointermove(end);
    if (cancel === 'escape') key(h, 'Escape');
    else if (cancel) canvas.onpointercancel(end);
    else canvas.onpointerup(end);
    canvas.onclick(end);
}
function move(h, note, steps, pitches, cancel) {
    const bounds = h.noteBounds(note);
    drag(h, h.pointer(bounds.x + bounds.hitWidth / 2, bounds.y + 12),
        h.pointer(bounds.x + bounds.hitWidth / 2 + steps * 38, bounds.y + 12 - pitches * 24), cancel);
}
function notes(h) {
    return JSON.parse(JSON.stringify(h.engine.sequence.toJSON().notes));
}

test('single click, Shift toggle, select all and Escape use independent stable IDs', () => {
    const h = createEditorHarness();
    const a = h.engine.sequence.addNote({ midi: 60, startStep: 1, durationSteps: 2 });
    const b = h.engine.sequence.addNote({ midi: 64, startStep: 6, durationSteps: 2 });
    const before = notes(h);
    click(h, a);
    assert.equal(h.elements.pianoViewport.focused, true);
    assert.equal(h.elements.pianoViewport.focusOptions.preventScroll, true);
    assert.equal(h.elements.selectionCount.textContent, '1 selected');
    click(h, b, { shiftKey: true });
    assert.equal(h.elements.selectionCount.textContent, '2 selected');
    click(h, a, { shiftKey: true });
    assert.equal(h.elements.selectionCount.textContent, '1 selected');
    key(h, 'a', { metaKey: true, ctrlKey: false });
    assert.equal(h.elements.selectionCount.textContent, '2 selected');
    key(h, 'Escape', { ctrlKey: false });
    assert.equal(h.elements.selectionCount.textContent, '0 selected');
    assert.deepEqual(notes(h), before);
});

test('marquee intersects actual note rectangles across tracks, preserves overlaps and cancels selection', () => {
    const h = createEditorHarness();
    h.engine.sequence.tracks.push({ id: 'strings', name: 'Strings', channel: 3, program: 48 });
    const a = h.engine.sequence.addNote({ midi: 60, startStep: 2, durationSteps: 3 });
    h.engine.sequence.addNote({ midi: 60, startStep: 2, durationSteps: 3, trackId: 'strings' });
    h.engine.sequence.addNote({ midi: 80, startStep: 10 });
    const bounds = h.noteBounds(a);
    const before = notes(h);
    drag(h, h.pointer(bounds.x - 12, bounds.y - 12), h.pointer(bounds.x + 20, bounds.y + 28));
    assert.equal(h.elements.selectionCount.textContent, '2 selected');
    drag(h, h.pointer(700, 50), h.pointer(720, 100), 'escape');
    assert.equal(h.elements.selectionCount.textContent, '2 selected');
    assert.deepEqual(notes(h), before);
    key(h, 'Delete', { ctrlKey: false });
    assert.equal(h.engine.sequence.notes.length, 1);
    key(h, 'z');
    assert.deepEqual(notes(h).sort((a, b) => a.id.localeCompare(b.id)), before.sort((a, b) => a.id.localeCompare(b.id)));
});

test('body movement previews until release, moves a group in ticks/pitch, and undo/redo restores metadata', () => {
    const h = createEditorHarness(2);
    h.engine.setPatternLength(128);
    h.elements.pianoViewport.scrollLeft = 120;
    const a = h.engine.sequence.addNote({ midi: 60, ticks: 497, durationTicks: 253, importId: 'source', noteOffVelocity: 41 });
    const b = h.engine.sequence.addNote({ midi: 64, ticks: 977, durationTicks: 250 });
    click(h, a);
    click(h, b, { shiftKey: true });
    const before = notes(h);
    const bounds = h.noteBounds(a);
    const canvas = h.elements.pianoCanvas;
    canvas.onpointerdown(h.pointer(bounds.x + 20, bounds.y + 12));
    const finish = h.pointer(bounds.x + 96, bounds.y - 36);
    canvas.onpointermove(finish);
    assert.deepEqual(notes(h), before);
    canvas.onpointerup(finish);
    canvas.onclick(finish);
    assert.equal(a.ticks, 737);
    assert.equal(b.ticks, 1217);
    assert.equal(a.midi, 62);
    assert.equal(b.midi, 66);
    assert.equal(a.importId, 'source');
    assert.equal(a.noteOffVelocity, 41);
    const after = notes(h);
    key(h, 'z');
    assert.deepEqual(notes(h), before);
    key(h, 'z', { shiftKey: true });
    assert.deepEqual(notes(h), after);
    const exported = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
    assert.deepEqual(Array.from(exported.notes, (note) => [note.ticks, note.durationTicks, note.midi]), [[737, 253, 62], [1217, 250, 66]]);
});

test('movement clamps the whole group to pitch/timeline bounds and cancellation keeps exact originals', () => {
    const h = createEditorHarness();
    const a = h.engine.sequence.addNote({ midi: 60, startStep: 1, durationSteps: 2 });
    click(h, a);
    for (const cancel of ['escape', 'pointer']) {
        const before = notes(h);
        move(h, a, 4, 2, cancel);
        assert.deepEqual(notes(h), before);
    }
    move(h, a, -100, 200);
    assert.equal(a.ticks, 0);
    assert.equal(a.midi, 127);
    h.elements.findNotes.onclick();
    move(h, a, 100, -200);
    assert.equal(a.ticks + a.durationTicks, h.engine.sequence.stepToTick(16));
    assert.equal(a.midi, 0);
});

test('copy/paste/duplicate/cut preserve tracks and velocities, clear provenance, and have atomic history', () => {
    const h = createEditorHarness();
    h.engine.sequence.tracks.push({ id: 'lead', name: 'Lead', channel: 7, program: 81 });
    const a = h.engine.sequence.addNote({ midi: 60, startStep: 2, durationSteps: 2, trackId: 'lead', velocityMidi: 37, importId: 'midi' });
    const b = h.engine.sequence.addNote({ midi: 67, startStep: 6, durationSteps: 2 });
    key(h, 'a');
    const before = notes(h);
    key(h, 'c');
    assert.deepEqual(notes(h), before);
    h.engine.setLoopRange(12, 16);
    h.clickAt(100 + 12 * 38, 16);
    key(h, 'v');
    const pasted = h.engine.sequence.notes.slice(2);
    assert.equal(h.engine.totalSteps, 18);
    assert.deepEqual(Array.from(pasted, (note) => note.startStep), [12, 16]);
    assert.equal(pasted[0].trackId, 'lead');
    assert.equal(pasted[0].velocityMidi, 37);
    assert.equal(pasted[0].importId, null);
    assert.notEqual(pasted[0].id, a.id);
    key(h, 'z');
    assert.equal(h.engine.sequence.notes.length, 2);
    key(h, 'z', { shiftKey: true });
    assert.equal(h.engine.sequence.notes.length, 4);
    key(h, 'd');
    assert.deepEqual(Array.from(h.engine.sequence.notes.slice(4), (note) => note.startStep), [18, 22]);
    key(h, 'x');
    assert.equal(h.engine.sequence.notes.length, 4);
    key(h, 'z');
    assert.equal(h.engine.sequence.notes.length, 6);
    const encoded = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
    assert.equal(encoded.notes.length, 6);
    assert.equal(a.id, before[0].id);
    assert.equal(b.id, before[1].id);
});

test('group resize changes durations together, preserves starts and never drag-deletes the group', () => {
    const h = createEditorHarness();
    const a = h.engine.sequence.addNote({ midi: 60, startStep: 2, durationSteps: 3 });
    const b = h.engine.sequence.addNote({ midi: 64, startStep: 6, durationSteps: 2.25 });
    key(h, 'a');
    h.drag(a, 'right', 7);
    assert.equal(a.durationSteps, 5);
    assert.equal(b.durationSteps, 4.25);
    assert.equal(a.startStep, 2);
    assert.equal(b.startStep, 6);
    key(h, 'z');
    assert.equal(a.durationSteps, 3);
    assert.equal(b.durationSteps, 2.25);
    h.drag(a, 'left', 0);
    assert.equal(a.durationSteps, 5);
    assert.equal(a.startStep, 2);
    h.drag(a, 'right', 0);
    assert.equal(h.engine.sequence.notes.length, 2);
    assert.ok(a.durationTicks >= 120 && b.durationTicks >= 120);
    const before = notes(h);
    h.drag(a, 'right', 14, true);
    assert.deepEqual(notes(h), before);
});

test('creation, inspector resize, velocity and deletion undo; a new edit clears redo', () => {
    const h = createEditorHarness();
    h.clickAt(150, 590);
    assert.equal(h.engine.sequence.notes.length, 1);
    key(h, 'z');
    assert.equal(h.engine.sequence.notes.length, 0);
    key(h, 'z', { shiftKey: true });
    const note = h.engine.sequence.notes[0];
    click(h, note);
    h.elements.noteLength.value = '2.5';
    h.elements.noteLength.onchange();
    key(h, 'z');
    assert.equal(note.durationSteps, 1);
    h.elements.velocity.value = '22';
    h.elements.velocity.onchange();
    key(h, 'z', { shiftKey: true });
    assert.equal(note.durationSteps, 1);
    key(h, 'z');
    assert.equal(note.velocityMidi, 89);
    key(h, 'Delete', { ctrlKey: false });
    assert.equal(h.engine.sequence.notes.length, 0);
    key(h, 'z');
    assert.equal(h.engine.sequence.notes.length, 1);
});

test('keyboard ignores editable focus and unrelated browser shortcuts', () => {
    const h = createEditorHarness();
    const note = h.engine.sequence.addNote({ midi: 60, startStep: 1, durationSteps: 2 });
    click(h, note);
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }, { closest: () => ({}) }]) {
        assert.equal(key(h, 'Delete', { target, ctrlKey: false }), false);
        assert.equal(key(h, 'a', { target }), false);
        assert.equal(key(h, 'z', { target }), false);
    }
    assert.equal(key(h, 'p'), false);
    assert.equal(h.engine.sequence.notes.length, 1);
});
test('single resize and drag-delete undo/redo preserve exact imported-style metadata', () => {
    const h = createEditorHarness();
    const note = h.engine.sequence.addNote({ midi: 60, ticks: 257, durationTicks: 403,
        importId: 'original', velocityMidi: 54, noteOffVelocity: 78 });
    click(h, note);
    const before = notes(h);
    h.drag(note, 'right', 8);
    const resized = notes(h);
    key(h, 'z');
    assert.deepEqual(notes(h), before);
    key(h, 'z', { shiftKey: true });
    assert.deepEqual(notes(h), resized);
    h.drag(note, 'right', 0);
    assert.equal(h.engine.sequence.notes.length, 0);
    key(h, 'z');
    assert.deepEqual(notes(h), resized);
    key(h, 'z', { shiftKey: true });
    assert.equal(h.engine.sequence.notes.length, 0);
});

test('duplicated import notes survive Remove Imported MIDI and old history cannot restore an import', () => {
    const h = createEditorHarness();
    const source = new h.NoteSequence(16);
    source.addNote({ midi: 60, startStep: 2, durationSteps: 2 });
    h.engine.importMidiSequence(source);
    key(h, 'a');
    key(h, 'd');
    const duplicate = h.engine.sequence.notes[1];
    assert.equal(duplicate.importId, null);
    assert.equal(duplicate.trackId, h.engine.sequence.notes[0].trackId);
    h.elements.removeImportedMidi.onclick();
    assert.equal(h.engine.sequence.notes.length, 1);
    assert.equal(h.engine.sequence.notes[0].id, duplicate.id);
    assert.equal(h.engine.sequence.notes[0].trackId, 'piano');
    key(h, 'z');
    assert.equal(h.engine.sequence.notes.length, 1);
});

test('pure movement handles large groups and rejects incompatible tails; unusual PPQ stays integer', () => {
    const h = createEditorHarness();
    const sequence = new h.NoteSequence(65536, 7);
    const group = Array.from({ length: 100000 }, (_, index) => ({
        id: `dense-${index}`, midi: 60 + index % 12, ticks: 17, durationTicks: 3
    }));
    const preview = h.PianoRollEditor.movedNotes(sequence, group, 38, -24);
    assert.equal(preview.size, 100000);
    assert.equal(preview.get('dense-99999').ticks, 19);
    assert.equal(preview.get('dense-99999').midi, 64);
    const bad = [{ id: 'a', midi: 60, ticks: 0, durationTicks: 1 },
        { id: 'b', midi: 60, ticks: 10, durationTicks: sequence.stepToTick(65536) }];
    assert.equal(h.PianoRollEditor.movedNotes(sequence, bad, 38, 0), null);
    const resized = h.PianoRollEditor.resizedGroup(sequence, group, 1);
    assert.equal(resized.get('dense-0').durationTicks, 5);
});

test('paste overflow and playback expansion fail without partial note edits', () => {
    const h = createEditorHarness();
    const note = h.engine.sequence.addNote({ midi: 60, startStep: 2, durationSteps: 2 });
    click(h, note);
    key(h, 'c');
    h.engine.isPlaying = true;
    h.engine.loopStart = 15;
    h.clickAt(100 + 15 * 38, 16);
    const before = notes(h);
    key(h, 'v');
    assert.deepEqual(notes(h), before);
    assert.equal(h.engine.totalSteps, 16);
    h.engine.isPlaying = false;
    h.engine.setPatternLength(65536);
    h.engine.setLoopRange(65535, 65536);
    h.clickAt(100 + 65535 * 38, 16);
    key(h, 'v');
    assert.deepEqual(notes(h), before);
    assert.match(h.elements.status.textContent, /maximum pattern length/);
});

test('history is bounded and body dragging corrects both scroll offsets', () => {
    const h = createEditorHarness();
    h.engine.setPatternLength(128);
    const note = h.engine.sequence.addNote({ midi: 60, startStep: 4, durationSteps: 2 });
    click(h, note);
    const bounds = h.noteBounds(note);
    const canvas = h.elements.pianoCanvas;
    const start = h.pointer(bounds.x + 20, bounds.y + 12);
    canvas.onpointerdown(start);
    h.elements.pianoViewport.scrollLeft += 76;
    h.elements.pianoViewport.scrollTop += 24;
    canvas.onpointerup(start);
    canvas.onclick(start);
    assert.equal(note.startStep, 6);
    assert.equal(note.midi, 59);
    for (let index = 0; index < 105; index++) {
        h.elements.velocity.value = String(index % 2 ? 22 : 44);
        h.elements.velocity.onchange();
    }
    for (let index = 0; index < 105; index++) key(h, 'z');
    assert.equal(note.startStep, 6);
    assert.equal(note.midi, 59);
});

for (const count of [1, 3]) {
    test(`empty-grid click deselects ${count} notes without mutation; the next click creates normally`, () => {
        const h = createEditorHarness();
        for (let index = 0; index < count; index++) {
            h.engine.sequence.addNote({ midi: 60 + index * 4, startStep: 1, durationSteps: 2 });
        }
        key(h, 'a');
        const before = notes(h);
        h.clickAt(100 + 10 * 38 + 12, 32 + 5 * 24 + 12);
        assert.equal(h.elements.selectionCount.textContent, '0 selected');
        assert.deepEqual(notes(h), before);
        key(h, 'z');
        assert.deepEqual(notes(h), before);
        h.clickAt(100 + 10 * 38 + 12, 32 + 5 * 24 + 12);
        assert.equal(h.engine.sequence.notes.length, count + 1);
        assert.equal(h.engine.sequence.notes.at(-1).startStep, 10);
        key(h, 'z');
        assert.deepEqual(notes(h), before);
        key(h, 'z', { shiftKey: true });
        assert.equal(h.engine.sequence.notes.length, count + 1);
    });
}

test('deselection leaves Redo intact and selection gestures never manufacture a note', () => {
    const h = createEditorHarness();
    const a = h.engine.sequence.addNote({ midi: 60, startStep: 1, durationSteps: 2 });
    const b = h.engine.sequence.addNote({ midi: 64, startStep: 5, durationSteps: 2 });
    click(h, a);
    key(h, 'd');
    key(h, 'z');
    click(h, b);
    assert.match(h.elements.noteInfo.textContent, new RegExp(b.id));
    click(h, a, { shiftKey: true });
    assert.equal(h.elements.selectionCount.textContent, '2 selected');
    const before = notes(h);
    h.clickAt(100 + 12 * 38, 50);
    assert.deepEqual(notes(h), before);
    key(h, 'z', { shiftKey: true });
    assert.equal(h.engine.sequence.notes.length, 3);
    const bounds = h.noteBounds(b);
    const canvas = h.elements.pianoCanvas;
    canvas.onpointerdown(h.pointer(bounds.x - 12, bounds.y - 12));
    canvas.onpointermove(h.pointer(bounds.x + 10, bounds.y + 28));
    canvas.onpointerup(h.pointer(bounds.x + 10, bounds.y + 28));
    canvas.onclick(h.pointer(bounds.x + 10, bounds.y + 28));
    assert.equal(h.engine.sequence.notes.length, 3);
    assert.equal(h.elements.selectionCount.textContent, '1 selected');
    const duplicate = h.engine.sequence.addNote({ midi: b.midi, ticks: b.ticks, durationTicks: b.durationTicks });
    click(h, b);
    assert.match(h.elements.noteInfo.textContent, new RegExp(duplicate.id));
    click(h, b);
    assert.match(h.elements.noteInfo.textContent, new RegExp(b.id));
});

console.log(`${passed} iteration 2 tests passed`);
