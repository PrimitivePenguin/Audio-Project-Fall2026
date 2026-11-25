const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEditorHarness } = require('./editor-test-support');

function change(h, id, value) {
    const control = h.elements[id];
    control.value = value;
    control.onchange({ target: control });
}

function setZoom(h, percent) {
    h.elements.zoom.value = String(percent);
    h.elements.zoom.oninput();
    h.animate();
}

function wheel(element, data) {
    let prevented = false;
    element.listeners.wheel({ ...data, preventDefault() { prevented = true; } });
    return prevented;
}

function gesture(h, x, y, dx, dy = 0, preview = () => {}) {
    const canvas = h.elements.pianoCanvas;
    const start = h.pointer(x, y);
    const end = h.pointer(x + dx, y + dy);
    canvas.onpointerdown(start);
    canvas.onpointermove(end);
    preview();
    canvas.onpointerup(end);
}

function bodyMove(h, note, dx, dy) {
    const { x, y, hitWidth, height } = h.noteBounds(note);
    gesture(h, x + hitWidth / 2, y + height / 2, dx, dy);
}

function history(h, redo = false) {
    h.documentListeners.keydown({ key: 'z', ctrlKey: true, shiftKey: redo, preventDefault() {} });
}

const tests = [
    ['sticky canvas has no scripted scroll offsets and pointer coordinates match the scrolled rows', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../main/resources/static/css/sequencer.css'), 'utf8');
        assert.match(css, /#pianoCanvas\s*\{\s*position: sticky; top: 0; left: 0;/);
        const h = createEditorHarness();
        h.engine.setPatternLength(1024);
        h.elements.pianoViewport.scrollLeft = 3000;
        h.elements.pianoViewport.scrollTop = 480;
        h.paint();
        assert.equal(h.elements.pianoCanvas.style.left, undefined);
        assert.equal(h.elements.pianoCanvas.style.top, undefined);
        const note = h.engine.sequence.addNote({ midi: 60, ticks: 9600, durationTicks: 120 });
        h.clickNote(note);
        assert.match(h.elements.noteInfo.textContent, /C4/);
        const label = h.canvasCalls.find(({ method, args }) => method === 'fillText' && args[0] === 'C4');
        assert.deepEqual(label.args.slice(1), [92, h.noteBounds(note).y + 16]);
    }],
    ['default, half-step and Free moves preserve imported offsets and support Undo and Redo', () => {
        const h = createEditorHarness();
        const sequence = h.engine.sequence;
        const note = sequence.addNote({ midi: 67, ticks: 137, durationTicks: 120, importId: 'source' });
        bodyMove(h, note, 38, 0);
        assert.equal(note.ticks, 257);
        change(h, 'noteSnap', 'thirty-second');
        assert.equal(note.ticks, 257);
        bodyMove(h, note, 19, 0);
        assert.equal(note.ticks, 317);
        change(h, 'noteSnap', 'free');
        bodyMove(h, note, 37 * 38 / 120, -24);
        assert.equal(note.ticks, 354);
        assert.equal(note.midi, 68);
        history(h);
        assert.equal(sequence.notes[0].ticks, 317);
        history(h, true);
        assert.equal(sequence.notes[0].ticks, 354);
    }],
    ['creation floors to the configured grid and Free uses the preceding sixteenth', () => {
        for (const [snap, steps, expected] of [
            ['sixteenth', 2.7, 240],
            ['thirty-second', 2.7, 300],
            ['free', 3.7, 360]
        ]) {
            const h = createEditorHarness();
            change(h, 'noteSnap', snap);
            change(h, 'noteLength', '1.275');
            h.clickAt(100 + steps * 38, 200);
            const note = h.engine.sequence.notes[0];
            assert.equal(note.ticks, expected);
            assert.equal(note.durationTicks, 153);
            if (snap !== 'free') continue;

            bodyMove(h, note, 37 * 38 / 120, 0);
            assert.equal(note.ticks, 397);
            for (const mode of ['sixteenth', 'thirty-second', 'free']) {
                change(h, 'noteSnap', mode);
                assert.equal(note.ticks, 397);
                assert.equal(note.durationTicks, 153);
            }
            const { x, y } = h.noteBounds(note);
            gesture(h, x + 1, y + 12, -23 * 38 / 120);
            assert.equal(note.ticks, 374);
            assert.equal(note.durationTicks, 176);
            const roundTrip = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence.notes[0];
            assert.deepEqual([roundTrip.ticks, roundTrip.durationTicks], [374, 176]);
        }
    }],
    ['Free resize previews 153 ticks as 1.275 and exact re-entry and step adjustment preserve it', () => {
        const h = createEditorHarness();
        const note = h.engine.sequence.addNote({ midi: 67, ticks: 241, durationTicks: 120 });
        change(h, 'noteSnap', 'free');
        const { x, y, hitWidth } = h.noteBounds(note);
        gesture(h, x + hitWidth - 1, y + 12, 33 * 38 / 120, 0, () => {
            assert.equal(h.elements.noteLength.value, '1.275');
            assert.equal(note.durationTicks, 120);
        });
        assert.equal(note.durationTicks, 153);
        change(h, 'noteLength', h.elements.noteLength.value);
        assert.equal(note.durationTicks, 153);
        h.elements.lengthIncrease.onclick();
        assert.equal(note.durationTicks, 273);
        h.elements.lengthDecrease.onclick();
        assert.equal(note.durationTicks, 153);
        change(h, 'noteSnap', 'sixteenth');
        assert.equal(h.elements.noteLength.value, '1.275');
    }],
    ['unusual PPQ rounds grid positions to integer ticks and displayed durations round-trip', () => {
        const h = createEditorHarness();
        const { PianoRollEditor: editor } = h;
        for (const ppq of [1, 3, 4, 7, 101, 480, 32767]) {
            const sequence = new h.NoteSequence(65536, ppq);
            const end = Math.floor(sequence.stepToTick(sequence.stepCount));
            for (const ticks of [1, 2, 13, 153, end - 1, end]) {
                const text = editor.formatDuration(sequence, ticks);
                assert.equal(editor.durationTicks(sequence, Number(text)), ticks);
            }
        }
        h.engine.replaceSequence(new h.NoteSequence(32, 7));
        change(h, 'noteSnap', 'thirty-second');
        assert.match(h.elements.snapInfo.textContent, /7 PPQ/);
        assert.equal(editor.snappedTicks(h.engine.sequence, 0.5, 'thirty-second'), 1);
        assert.equal(editor.snappedTicks(h.engine.sequence, -0.5, 'thirty-second'), -1);
    }],
    ['common snap deltas preserve group offsets, duration differences and valid boundaries', () => {
        const h = createEditorHarness();
        const { PianoRollEditor: editor } = h;
        const sequence = h.engine.sequence;
        const a = sequence.addNote({ midi: 61, ticks: 137, durationTicks: 135 });
        const b = sequence.addNote({ midi: 64, ticks: 317, durationTicks: 153 });
        const moved = editor.movedNotes(sequence, [a, b], 19, -24, 'thirty-second');
        assert.equal(moved.get(a.id).ticks, 197);
        assert.equal(moved.get(b.id).ticks, 377);
        const resized = editor.resizedGroup(sequence, [a, b], 0.5, 'thirty-second');
        assert.equal(resized.get(a.id).durationTicks, 195);
        assert.equal(resized.get(b.id).durationTicks, 213);
        const shortened = editor.resizedGroup(sequence, [a, b], -100, 'free');
        assert.equal(shortened.get(a.id).durationTicks, 1);
        assert.equal(shortened.get(b.id).durationTicks, 19);
        const bounded = editor.movedNotes(sequence, [a, b], 10000, 10000, 'free');
        assert.equal(bounded.get(b.id).ticks + b.durationTicks, sequence.stepToTick(sequence.stepCount));
        assert.equal(bounded.get(a.id).midi, 0);
    }],
    ['zoom anchors content, preserves tick snapping and keeps tiny notes selectable', () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(256);
        const tiny = h.engine.sequence.addNote({ midi: 67, ticks: 4795, durationTicks: 1 });
        const note = h.engine.sequence.addNote({ midi: 64, ticks: 4823, durationTicks: 240 });
        const viewport = h.elements.pianoViewport;
        viewport.scrollLeft = 1120;
        setZoom(h, 50);
        assert.equal(viewport.scrollLeft, 360);
        const bounds = h.noteBounds(tiny);
        assert.equal(bounds.height, 12);
        assert.equal(bounds.hitWidth, 8);
        h.clickAt(bounds.x + 4, bounds.y + 6);
        assert.equal(h.elements.selectionCount.textContent, '1 selected');
        change(h, 'noteSnap', 'thirty-second');
        bodyMove(h, note, 9.5, 0);
        assert.equal(note.ticks, 4883);
        assert.equal(tiny.ticks, 4795);
        h.elements.resetZoom.onclick();
        h.animate();
        assert.equal(h.PianoRollEditor.geometry.stepWidth, 38);
        assert.equal(h.PianoRollEditor.geometry.rowHeight, 24);
    }],
    ['unified zoom updates proportions, percentage, boundaries and reset', () => {
        const h = createEditorHarness();
        const input = h.elements.zoom;
        assert.equal(input.value, '100');
        for (const [value, percent] of [[200, 200], [260, 250], [10, 50]]) {
            setZoom(h, value);
            assert.equal(input.value, String(percent));
            assert.equal(input.attributes['aria-valuetext'], `${percent}%`);
            assert.equal(h.elements.zoomPercentage.textContent, `${percent}%`);
            assert.equal(h.PianoRollEditor.geometry.stepWidth, 38 * percent / 100);
            assert.equal(h.PianoRollEditor.geometry.rowHeight, 24 * percent / 100);
        }
        h.elements.resetZoom.onclick();
        h.animate();
        assert.equal(h.elements.zoomPercentage.textContent, '100%');
        input.value = '175';
        input.oninput();
        h.elements.resetZoom.onclick();
        h.animate();
        assert.equal(input.value, '100');
    }],
    ['modified wheel anchors both coordinates and ordinary scroll leaves the zoom alone', () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(1024);
        const viewport = h.elements.pianoViewport;
        viewport.scrollLeft = 1400;
        viewport.scrollTop = 250;
        const point = h.pointer(250, 200);
        const zoomWheel = { ...point, deltaMode: 1, deltaY: -3, ctrlKey: true };
        const step = (viewport.scrollLeft + 150) / 38;
        const row = (viewport.scrollTop + 168) / 24;
        const frames = h.animationRequests;
        assert.equal(wheel(viewport, zoomWheel), true);
        assert.equal(wheel(viewport, { ...zoomWheel, ctrlKey: false, metaKey: true }), true);
        assert.equal(h.animationRequests, frames);
        h.animate();
        const { stepWidth, rowHeight } = h.PianoRollEditor.geometry;
        assert.equal(h.elements.zoomPercentage.textContent, '170%');
        assert.ok(Math.abs((viewport.scrollLeft + 150) / stepWidth - step) < 1e-8);
        assert.ok(Math.abs((viewport.scrollTop + 168) / rowHeight - row) < 1e-8);
        assert.equal(wheel(viewport, { ...point, deltaY: 40 }), false);
        assert.equal(wheel(viewport, { ...point, deltaX: 40, deltaY: 0 }), false);
        viewport.scrollTop += 40;
        h.paint();
        assert.equal(h.elements.zoomPercentage.textContent, '170%');
        assert.equal(h.elements.pianoCanvas.style.left, undefined);
        assert.equal(h.elements.pianoCanvas.style.top, undefined);
        assert.ok(h.canvasCalls.some(({ method, args }) => method === 'fillText' &&
            args[0] === 'Pitch / Measure' && args[1] === 4 && args[2] === 20));
        const note = h.engine.sequence.addNote({ midi: 67, ticks: 5400, durationTicks: 120 });
        h.paint();
        const label = h.canvasCalls.find(({ method, args }) => method === 'fillText' && args[0] === 'G4');
        assert.equal(label.args[1], 92);
        assert.equal(label.args[2], h.noteBounds(note).y + rowHeight / 2 + 4);
    }],
    ['toolbar wheel accumulates small trackpad deltas and native pinch is coalesced', () => {
        const h = createEditorHarness();
        const toolbar = h.elements.zoomControl;
        assert.equal(wheel(toolbar, { deltaY: -3, deltaMode: 1 }), true);
        h.animate();
        assert.equal(h.elements.zoomPercentage.textContent, '135%');
        for (let i = 0; i < 10; i++) {
            assert.equal(wheel(toolbar, { deltaY: 1, deltaMode: 0 }), true);
            h.animate();
        }
        assert.equal(h.elements.zoomPercentage.textContent, '132%');
        const viewport = h.elements.pianoViewport;
        let prevented = 0;
        const point = h.pointer(200, 150, { preventDefault: () => prevented++ });
        viewport.listeners.gesturestart(point);
        viewport.listeners.gesturechange({ ...point, scale: 1.1 });
        viewport.listeners.gesturechange({ ...point, scale: 1.25 });
        viewport.listeners.gestureend(point);
        assert.equal(prevented, 4);
        h.animate();
        assert.equal(h.elements.zoomPercentage.textContent, '230%');
    }],
    ['Minimum zoom adapts to laptop and desktop widths, 5/4 and meter maps', () => {
        for (const width of [640, 900, 1440]) {
            const h = createEditorHarness();
            h.elements.pianoViewport.clientWidth = width;
            h.engine.setPatternLength(16384);
            const sequence = h.engine.sequence;
            sequence.timeSignatures = [{ ticks: 0, timeSignature: [5, 4] },
                { ticks: 1200, timeSignature: [3, 4] }, { ticks: 3840, timeSignature: [5, 4] }];
            h.paint();
            setZoom(h, Number(h.elements.zoom.min));
            h.animate();
            const { stepWidth, rowHeight } = h.PianoRollEditor.geometry;
            assert.ok((width - 100) / stepWidth >= 51 * 20);
            assert.equal(rowHeight, 12);
            assert.ok(Number(h.elements.zoom.value) < 5);
            assert.match(h.elements.zoom.title, /Minimum zoom/);
            h.paint();
            assert.ok(h.canvasCalls.filter(({ method, args }) => method === 'fillText' && args[2] === 20).length < 65);
        }
    }],
    ['zoom renders only the viewport and reuses the long composition note index', () => {
        const h = createEditorHarness(2);
        const viewport = h.elements.pianoViewport;
        h.engine.setPatternLength(16384);
        const sequence = h.engine.sequence;
        for (let step = 0; step < 16384; step++) {
            sequence.addNote({ midi: 67, startStep: step });
        }
        viewport.scrollLeft = 12000 * 38;
        let forbidIteration = false;
        sequence.notes = new Proxy(sequence.notes, {
            get(target, property, receiver) {
                // Build an index once, then detect a full-composition pass during zoom.
                if (property === 'forEach' && forbidIteration) throw new Error('Unexpected note index rebuild');
                return Reflect.get(target, property, receiver);
            }
        });
        h.paint();
        forbidIteration = true;
        for (const percent of [250, 50, 100]) {
            setZoom(h, percent);
            assert.equal(h.elements.pianoCanvas.width, viewport.clientWidth * 2);
            assert.equal(h.elements.pianoCanvas.height, viewport.clientHeight * 2);
            assert.equal(parseFloat(h.elements.pianoSpacer.style.width), 100 + 16384 * 38 * percent / 100);
        }
        h.paint();
        setZoom(h, Number(h.elements.zoom.min));
        h.animate();
        assert.ok(Number(h.elements.zoom.value) < 5);
        assert.equal(h.elements.pianoCanvas.width, viewport.clientWidth * 2);
        assert.equal(h.elements.pianoCanvas.height, viewport.clientHeight * 2);
    }],
    ['meter changes place ruler labels and compound beats without retiming notes or loops', () => {
        const h = createEditorHarness();
        const sequence = h.engine.sequence;
        const note = sequence.addNote({ midi: 67, ticks: 123, durationTicks: 210 });
        h.engine.setPatternLength(64);
        h.engine.setLoopRange(4, 12);
        const seconds = sequence.ticksToSeconds(note.ticks + note.durationTicks);
        assert.equal(h.elements.timeSignature.value, '4/4');
        for (const [meter, steps] of [['4/4', 16], ['3/4', 12], ['6/8', 12], ['5/4', 20], ['7/8', 14]]) {
            change(h, 'timeSignature', meter);
            h.paint();
            const label = h.canvasCalls.find(({ method, args }) => method === 'fillText' && args[0] === 'M2');
            assert.deepEqual(label.args, ['M2', 103 + steps * 38, 20]);
            assert.equal(sequence.ticksToSeconds(note.ticks + note.durationTicks), seconds);
            assert.deepEqual([note.ticks, note.durationTicks, note.midi, h.engine.loopStart, h.engine.loopEnd],
                [123, 210, 67, 4, 12]);
            if (meter === '6/8') {
                const marks = [...sequence.meterMarks(0, 1440)];
                assert.equal(marks.find((mark) => mark.ticks === 720).kind, 'group');
                assert.equal(marks.find((mark) => mark.ticks === 240).kind, 'subdivision');
            }
        }
        change(h, 'timeSignature', '5/4');
        h.elements.addBar.onclick();
        assert.equal(h.engine.totalSteps, 84);
        h.elements.removeBar.onclick();
        assert.equal(h.engine.totalSteps, 64);
    }],
    ['imported meter events survive edits and MIDI round-trip, with fractional ruler boundaries', async () => {
        const h = createEditorHarness();
        const source = new h.NoteSequence(64, 101);
        source.timeSignatures = [
            { ticks: 0, timeSignature: [4, 4] },
            { ticks: 151, timeSignature: [7, 8] }
        ];
        source.addNote({ midi: 63, ticks: 1000, durationTicks: 13 });
        await h.importSequence(source);
        const sequence = h.engine.sequence;
        assert.equal(h.elements.timeSignature.disabled, true);
        assert.match(h.elements.meterInfo.textContent, /meter map/);
        change(h, 'timeSignature', '3/4');
        assert.equal(JSON.stringify(sequence.timeSignatures), JSON.stringify(source.timeSignatures));
        assert.equal(sequence.positionAtTick(151).measure, 2);
        assert.equal(sequence.positionAtTick(504.5).measure, 3);
        h.elements.pianoViewport.scrollLeft = 0;
        h.paint();
        const label = h.canvasCalls.find(({ method, args }) => method === 'fillText' && args[0] === 'M2');
        assert.deepEqual(label.args, ['M2', 103 + sequence.tickToStep(151) * 38, 20]);
        const roundTrip = h.MidiIO.parse(h.MidiIO.encode(sequence).bytes).sequence;
        assert.equal(JSON.stringify(roundTrip.timeSignatures), JSON.stringify(source.timeSignatures));
    }],
    ['remote ruler windows seek into long meter maps and thin dense subdivisions', () => {
        const h = createEditorHarness();
        const sequence = new h.NoteSequence(65536, 480);
        sequence.timeSignatures = Array.from({ length: 10000 }, (_, i) => ({
            ticks: i * 720, timeSignature: [1, 128]
        }));
        const start = 9999 * 720;
        const marks = [...sequence.meterMarks(start, start + 2000, 40)];
        assert.equal(marks[0].ticks, start);
        assert.ok(marks.length < 50);
    }]
];

(async () => {
    for (const [name, test] of tests) {
        await test();
        console.log('PASS', name);
    }
    console.log(`${tests.length} iteration 3 tests passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
