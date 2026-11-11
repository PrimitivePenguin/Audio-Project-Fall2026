const assert = require('node:assert/strict');
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
function noteData(h) {
    return JSON.parse(JSON.stringify(h.engine.sequence.toJSON()));
}
function near(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} should be near ${expected}`);
}
function setCursor(h, step) {
    h.clickAt(100 + step * 38 - h.elements.pianoViewport.scrollLeft, 15);
}
function atStep(h, step) {
    h.engine.audioContext.currentTime = h.engine.playbackAnchorTime +
        h.engine.stepSeconds(step) - h.engine.sequence.ticksToSeconds(h.engine.playbackAnchorTick);
    h.animate();
}
async function playing(h, steps = 128, startStep = 0) {
    h.engine.setPatternLength(steps);
    setCursor(h, startStep);
    await h.elements.playButton.onclick();
    h.animate();
}
function playheadX(h) {
    h.paint();
    const line = h.canvasCalls.find((call) => call.method === 'fillRect' && call.fillStyle === '#df9410');
    return line?.args[0];
}
function sample(overrides = {}) {
    return { playing: true, runId: 1, pass: 0, ticks: 0, contentX: 0,
        scrollLeft: 0, width: 1000, maxScroll: 10000, ...overrides };
}

(async () => {
    await test('four strict directional filters choose diagonal centers by PPQ-scaled Manhattan distance', () => {
        const h = createEditorHarness();
        const selected = { id: 'selected', ticks: 1000, durationTicks: 1, midi: 60 };
        const cases = {
            right: [{ id: 'near', ticks: 1120, durationTicks: 1, midi: 61 }, { id: 'aligned', ticks: 1480, durationTicks: 1, midi: 60 }],
            left: [{ id: 'near', ticks: 880, durationTicks: 1, midi: 59 }, { id: 'aligned', ticks: 520, durationTicks: 1, midi: 60 }],
            up: [{ id: 'near', ticks: 880, durationTicks: 1, midi: 61 }, { id: 'aligned', ticks: 1000, durationTicks: 1, midi: 64 }],
            down: [{ id: 'near', ticks: 1120, durationTicks: 1, midi: 59 }, { id: 'aligned', ticks: 1000, durationTicks: 1, midi: 56 }]
        };
        for (const [direction, candidates] of Object.entries(cases)) {
            const notes = [selected, ...candidates];
            assert.equal(h.PianoRollEditor.directionalNote(notes, selected, direction, 480).id, 'near');
            assert.equal(h.PianoRollEditor.directionalNote([selected, { ...selected, id: 'overlap' }], selected, direction, 480), null);
        }
    });

    await test('navigation reads musical duration but never screen geometry, clipping or step getters', () => {
        const h = createEditorHarness();
        const selected = { id: 'selected', ticks: 17, durationTicks: 3, midi: 60 };
        const candidates = [{ id: 'a', ticks: 137, durationTicks: 5, midi: 60 },
            { id: 'b', ticks: 257, durationTicks: 7, midi: 60 }];
        for (const note of [selected, ...candidates]) {
            for (const property of ['durationSteps', 'startStep', 'width', 'x', 'y']) {
                Object.defineProperty(note, property, { get() { throw new Error(`Read ${property}`); } });
            }
        }
        assert.equal(h.PianoRollEditor.directionalNote(candidates, selected, 'right', 480).id, 'a');
        const long = { id: 'long', ticks: 137, durationTicks: 100000, midi: 60 };
        const short = { id: 'short', ticks: 137, durationTicks: 1, midi: 60 };
        assert.equal(h.PianoRollEditor.directionalNote([long, short], selected, 'right', 480).id, 'short');
    });

    await test('horizontal ties prefer highest pitch; vertical ties prefer earliest center; final ties use stable ID', () => {
        const h = createEditorHarness();
        const selected = { id: 'selected', ticks: 1000, durationTicks: 1, midi: 60 };
        const cases = {
            right: [{ id: 'low', ticks: 1480, durationTicks: 1, midi: 60 }, { id: 'high', ticks: 1120, durationTicks: 1, midi: 63 }],
            left: [{ id: 'low', ticks: 880, durationTicks: 1, midi: 57 }, { id: 'high', ticks: 520, durationTicks: 1, midi: 60 }],
            up: [{ id: 'late', ticks: 1000, durationTicks: 1, midi: 62 }, { id: 'early', ticks: 880, durationTicks: 1, midi: 61 }],
            down: [{ id: 'late', ticks: 1000, durationTicks: 1, midi: 58 }, { id: 'early', ticks: 880, durationTicks: 1, midi: 59 }]
        };
        for (const [direction, candidates] of Object.entries(cases)) {
            const expected = ['left', 'right'].includes(direction) ? 'high' : 'early';
            assert.equal(h.PianoRollEditor.directionalNote(candidates, selected, direction, 480).id, expected);
            assert.equal(h.PianoRollEditor.directionalNote([...candidates].reverse(), selected, direction, 480).id, expected);
            const chosen = candidates.find((candidate) => candidate.id === expected);
            const ties = [{ ...chosen, id: 'z-track-note' }, { ...chosen, id: 'A-track-note' }];
            assert.equal(h.PianoRollEditor.directionalNote(ties, selected, direction, 480).id, 'A-track-note');
            assert.equal(h.PianoRollEditor.directionalNote([...ties].reverse(), selected, direction, 480).id, 'A-track-note');
        }
    });

    await test('fractional starts and arbitrary PPQ are compared as integers without step rounding', () => {
        const h = createEditorHarness();
        for (const ppq of [1, 7, 101, 480, 32767]) {
            const selected = { id: 'selected', ticks: 17, durationTicks: 1, midi: 60 };
            const aligned = { id: 'aligned', ticks: 17 + ppq, durationTicks: 1, midi: 60 };
            const diagonal = { id: 'diagonal', ticks: 18, durationTicks: 1, midi: 61 };
            const expected = ppq === 1 ? 'aligned' : 'diagonal';
            assert.equal(h.PianoRollEditor.directionalNote([aligned, diagonal], selected, 'right', ppq).id, expected);
        }
        const selected = { id: 'selected', ticks: 17, durationTicks: 1, midi: 60 };
        assert.equal(h.PianoRollEditor.directionalNote([{ id: 'a', ticks: 18, durationTicks: 1, midi: 61 },
            { id: 'b', ticks: 42, durationTicks: 1, midi: 60 }], selected, 'right', 101).id, 'b');
    });

    await test('All Notes, explicit track eligibility, hidden tracks and pitch limits share one filter', () => {
        const h = createEditorHarness();
        const sequence = h.engine.sequence;
        sequence.tracks.push({ id: 'strings', name: 'Strings', channel: 2 }, { id: 'hidden', name: 'Hidden', hidden: true });
        sequence.addNote({ id: 'piano-note', midi: 60, startStep: 1 });
        sequence.addNote({ id: 'strings-note', midi: 64, startStep: 2, trackId: 'strings' });
        sequence.addNote({ id: 'hidden-note', midi: 61, startStep: 1, trackId: 'hidden' });
        const ids = (view) => Array.from(h.PianoRollEditor.eligibleNotes(sequence, view), (note) => note.id);
        assert.deepEqual(ids({}), ['piano-note', 'strings-note']);
        assert.deepEqual(ids({ trackId: 'strings' }), ['strings-note']);
        assert.deepEqual(ids({ hiddenTrackIds: new Set(['piano']) }), ['strings-note']);
        assert.deepEqual(ids({ lowestPitch: 62, highestPitch: 127 }), ['strings-note']);
        sequence.tracks[1].visible = false;
        assert.deepEqual(ids({}), ['piano-note']);
        h.clickNote(sequence.notes[0]);
        assert.equal(key(h, 'ArrowRight'), false);
        assert.match(h.elements.noteInfo.textContent, /piano-note/);
        sequence.tracks[1].visible = true;
        assert.equal(key(h, 'ArrowRight'), true);
        assert.match(h.elements.noteInfo.textContent, /strings-note/);
    });

    await test('global arrows require exactly one selection, update inspector, and create no history or musical edits', () => {
        const h = createEditorHarness();
        const a = h.engine.sequence.addNote({ midi: 60, ticks: 17, durationTicks: 253 });
        const b = h.engine.sequence.addNote({ midi: 64, ticks: 257, durationTicks: 41 });
        const before = noteData(h);
        const cursor = h.elements.cursorPosition.textContent;
        assert.equal(key(h, 'ArrowRight'), false);
        h.clickNote(a);
        assert.equal(key(h, 'ArrowRight'), true);
        assert.match(h.elements.noteInfo.textContent, new RegExp(b.id));
        assert.equal(h.elements.selectionCount.textContent, '1 selected');
        assert.equal(Number(h.elements.noteLength.value), b.durationSteps);
        assert.equal(key(h, 'ArrowRight'), false);
        assert.equal(key(h, 'ArrowLeft'), true);
        assert.match(h.elements.noteInfo.textContent, new RegExp(a.id));
        assert.equal(key(h, 'ArrowUp'), true);
        assert.equal(key(h, 'ArrowDown'), true);
        key(h, 'a', { ctrlKey: true });
        assert.equal(key(h, 'ArrowRight'), false);
        assert.equal(h.elements.selectionCount.textContent, '2 selected');
        key(h, 'z', { ctrlKey: true });
        assert.deepEqual(noteData(h), before);
        assert.equal(h.elements.cursorPosition.textContent, cursor);
    });

    await test('arrow focus/modifier/dialog guards preserve native accessibility and Length-field arrows', () => {
        const h = createEditorHarness();
        const a = h.engine.sequence.addNote({ midi: 60, startStep: 1 });
        h.engine.sequence.addNote({ midi: 64, startStep: 2 });
        h.clickNote(a);
        for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
            { tagName: 'BUTTON' }, { tagName: 'SUMMARY' }, { tagName: 'A' }, { isContentEditable: true }]) {
            assert.equal(key(h, 'ArrowRight', { target }), false);
        }
        for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
            assert.equal(key(h, 'ArrowRight', { [modifier]: true }), false);
        }
        h.setModalOpen(true);
        assert.equal(key(h, 'ArrowRight'), false);
        h.setModalOpen(false);
        h.elements.shortcutsButton.onclick();
        assert.equal(key(h, 'ArrowRight'), false);
        h.elements.closeShortcuts.onclick();
        h.elements.noteLength.onkeydown({ key: 'ArrowUp', preventDefault() {} });
        assert.equal(a.durationSteps, 2);
        assert.match(h.elements.noteInfo.textContent, new RegExp(a.id));
        const guide = h.elements.keyboardGuide.children.map((element) => element.textContent).join(' ');
        for (const direction of ['Right', 'Left', 'Up', 'Down']) assert.ok(guide.includes(`Arrow ${direction}`));
    });

    await test('offscreen note reveal scrolls minimally in both axes and handles long blocks without chasing tails', () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(64);
        const a = h.engine.sequence.addNote({ midi: 60, ticks: 17, durationTicks: 120 });
        const b = h.engine.sequence.addNote({ midi: 37, ticks: 3001, durationTicks: 1 });
        h.clickNote(a);
        key(h, 'ArrowRight');
        near(h.elements.pianoViewport.scrollLeft, h.engine.sequence.tickToStep(3001) * 38 + 8 - 800);
        near(h.elements.pianoViewport.scrollTop, (83 - 37) * 24 + 24 - 568);
        const bounds = h.noteBounds(b);
        near(bounds.x + bounds.hitWidth, 900);
        near(bounds.y + bounds.height, 600);
        const long = { ticks: 240, durationTicks: 10000, midi: 60 };
        const reveal = h.PianoRollEditor.revealNote(long, h.engine.sequence,
            { width: 900, height: 600, scrollLeft: 0, scrollTop: 296, lowestPitch: 36, highestPitch: 83 });
        assert.equal(reveal.scrollLeft, 0);
        assert.equal(reveal.scrollTop, 296);
    });

    await test('directional search remains linear and deterministic for a large multi-track candidate list', () => {
        const h = createEditorHarness();
        const notes = Array.from({ length: 100000 }, (_, index) => ({ id: `id-${index}`, ticks: 1000 + index, durationTicks: 1, midi: 60 }));
        const selected = { id: 'selected', ticks: 17, durationTicks: 1, midi: 60 };
        assert.equal(h.PianoRollEditor.directionalNote(notes, selected, 'right', 480).id, 'id-0');
        assert.equal(h.PianoRollEditor.directionalNote(notes.reverse(), selected, 'right', 480).id, 'id-0');
    });

    await test('follow model arms from the left and locks only on advancing midpoint crossings', () => {
        const h = createEditorHarness();
        const follow = new h.PianoRollFollow();
        assert.equal(follow.update(sample()), null);
        assert.equal(follow.state, 'ARMED');
        assert.equal(follow.update(sample({ ticks: 1, contentX: 449 })), null);
        assert.equal(follow.update(sample({ ticks: 2, contentX: 450 })), 0);
        assert.equal(follow.state, 'FOLLOWING');
        assert.equal(follow.update(sample({ ticks: 3, contentX: 500 })), 50);
        for (const contentX of [450, 451, 900]) {
            follow.reset();
            assert.equal(follow.update(sample({ contentX })), null);
            assert.equal(follow.state, 'DISARMED');
            assert.equal(follow.update(sample({ contentX: contentX + 200, ticks: 20 })), null);
        }
    });

    await test('follow model releases on interruption and needs a new left-side observation before relocking', () => {
        const h = createEditorHarness();
        const follow = new h.PianoRollFollow();
        follow.update(sample());
        follow.update(sample({ ticks: 1, contentX: 500 }));
        follow.interrupt();
        assert.equal(follow.update(sample({ ticks: 2, contentX: 600, scrollLeft: 100 })), null);
        assert.equal(follow.state, 'DISARMED');
        assert.equal(follow.update(sample({ ticks: 3, contentX: 601, scrollLeft: 300 })), null);
        assert.equal(follow.state, 'ARMED');
        assert.equal(follow.update(sample({ ticks: 4, contentX: 751, scrollLeft: 300 })), 301);
        assert.equal(follow.state, 'FOLLOWING');
    });

    await test('follow model respects bounds and resets for wraps, seeks, runs, pause and resize', () => {
        const h = createEditorHarness();
        const follow = new h.PianoRollFollow();
        follow.update(sample());
        assert.equal(follow.update(sample({ ticks: 10, contentX: 1000, maxScroll: 300 })), 300);
        assert.equal(follow.update(sample({ ticks: 11, contentX: 1100, scrollLeft: 300, maxScroll: 300 })), 300);
        assert.equal(follow.update(sample({ ticks: 1, contentX: 10, scrollLeft: 300, pass: 1 })), null);
        assert.equal(follow.state, 'ARMED');
        assert.equal(follow.update(sample({ ticks: 12, contentX: 1200, scrollLeft: 300, pass: 3 })), null);
        assert.equal(follow.state, 'DISARMED');
        assert.equal(follow.update(sample({ ticks: 13, contentX: 1201, scrollLeft: 300, pass: 3, width: 2000 })), null);
        assert.equal(follow.state, 'ARMED');
        assert.equal(follow.update(sample({ playing: false })), null);
        assert.equal(follow.state, 'DISARMED');
        assert.equal(follow.previous, null);
        assert.equal(follow.update(sample({ ticks: 100, contentX: 800, runId: 2 })), null);
        assert.equal(follow.state, 'DISARMED');
    });

    await test('UI follow initially stays still, then centers the orange audio-clock playhead in the musical grid', async () => {
        const h = createEditorHarness();
        await playing(h);
        atStep(h, 10);
        assert.equal(h.elements.pianoViewport.scrollLeft, 0);
        atStep(h, 12);
        near(h.elements.pianoViewport.scrollLeft, 56);
        near(playheadX(h), 500);
        atStep(h, 14.125);
        near(h.elements.pianoViewport.scrollLeft, 14.125 * 38 - 400);
        near(playheadX(h), 500);
        near(h.engine.getPlaybackTick(), 14.125 * 120);
        assert.equal(h.elements.cursorPosition.textContent.includes('tick 0'), true);
        h.engine.stop();
    });

    await test('starting at or right of midpoint remains disarmed and the playhead may leave the viewport', async () => {
        for (const start of [400 / 38, 14]) {
            const h = createEditorHarness();
            await playing(h, 128, start);
            atStep(h, 30);
            assert.equal(h.elements.pianoViewport.scrollLeft, 0);
            near(playheadX(h), 1240);
            h.engine.stop();
        }
    });

    await test('manual scroll wins even before its event arrives; delayed automatic events never cancel follow', async () => {
        const h = createEditorHarness();
        await playing(h);
        atStep(h, 12);
        h.paint();
        atStep(h, 13);
        near(h.elements.pianoViewport.scrollLeft, 94);
        h.elements.pianoViewport.scrollLeft = 20;
        atStep(h, 14);
        assert.equal(h.elements.pianoViewport.scrollLeft, 20);
        h.paint();
        atStep(h, 20);
        assert.equal(h.elements.pianoViewport.scrollLeft, 20);
        near(h.engine.getPlaybackTick(), 2400);
        h.engine.stop();
    });

    await test('manual horizontal wheel and scrollbar intent release lock; vertical pitch scrolling preserves it', async () => {
        const h = createEditorHarness();
        await playing(h);
        atStep(h, 12);
        h.elements.pianoViewport.scrollTop += 24;
        h.paint();
        atStep(h, 13);
        near(h.elements.pianoViewport.scrollLeft, 94);
        h.elements.pianoViewport.listeners.wheel({ deltaX: 1, deltaY: 0 });
        atStep(h, 14);
        assert.equal(h.elements.pianoViewport.scrollLeft, 94);
        h.elements.pianoViewport.scrollLeft = 500;
        h.paint();
        atStep(h, 24);
        near(h.elements.pianoViewport.scrollLeft, 512);
        h.elements.pianoViewport.listeners.pointerdown({ clientY: 40 + 600 });
        atStep(h, 25);
        near(h.elements.pianoViewport.scrollLeft, 512);
        h.engine.stop();
    });

    await test('manual ahead scrolling repeatedly rearms without immediately centering and locks at the next crossing', async () => {
        const h = createEditorHarness();
        await playing(h);
        atStep(h, 12);
        for (const [ahead, before, crossing] of [[400, 20, 22], [800, 30, 32], [1200, 40, 43]]) {
            h.elements.pianoViewport.scrollLeft = ahead;
            h.paint();
            atStep(h, before);
            assert.equal(h.elements.pianoViewport.scrollLeft, ahead);
            atStep(h, crossing);
            near(h.elements.pianoViewport.scrollLeft, crossing * 38 - 400);
            near(playheadX(h), 500);
        }
        h.engine.stop();
    });

    await test('loop wraps and skipped complete passes reassess readiness without viewport jumps', async () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(64);
        h.engine.setLoopRange(0, 16);
        await h.elements.playButton.onclick();
        atStep(h, 12);
        near(h.elements.pianoViewport.scrollLeft, 56);
        h.engine.audioContext.currentTime = h.engine.playbackAnchorTime + 2;
        h.animate();
        assert.equal(h.elements.pianoViewport.scrollLeft, 56);
        h.engine.audioContext.currentTime += 13 / 8;
        h.animate();
        near(h.elements.pianoViewport.scrollLeft, 94);
        h.engine.audioContext.currentTime = h.engine.playbackAnchorTime + 6 + 14 / 8;
        h.animate();
        assert.equal(h.elements.pianoViewport.scrollLeft, 94);
        assert.equal(h.engine.getPlaybackPosition().pass, 3);
        h.engine.stop();
    });

    await test('pause, Resume, stopped restart and paused cursor seeking preserve user viewport without forced centering', async () => {
        const h = createEditorHarness();
        await playing(h);
        atStep(h, 12);
        h.elements.playButton.onclick();
        const left = h.elements.pianoViewport.scrollLeft;
        h.animate();
        assert.equal(h.elements.pianoViewport.scrollLeft, left);
        await h.elements.playButton.onclick();
        h.animate();
        assert.equal(h.elements.pianoViewport.scrollLeft, left);
        atStep(h, 14);
        assert.equal(h.elements.pianoViewport.scrollLeft, left);
        h.elements.playButton.onclick();
        setCursor(h, 30);
        await h.elements.playButton.onclick();
        h.animate();
        assert.equal(h.elements.pianoViewport.scrollLeft, left);
        atStep(h, 32);
        assert.equal(h.elements.pianoViewport.scrollLeft, left);
        h.elements.stopButton.onclick();
        const afterStop = h.elements.pianoViewport.scrollLeft;
        h.animate();
        h.animate();
        assert.equal(h.elements.pianoViewport.scrollLeft, afterStop);
        h.elements.pianoViewport.scrollLeft = 0;
        h.paint();
        setCursor(h, 0);
        await h.elements.playButton.onclick();
        atStep(h, 14);
        near(h.elements.pianoViewport.scrollLeft, 132);
        h.engine.stop();
    });

    await test('timeline bounds, short patterns, live resize and maximum-length patterns never create phantom space', async () => {
        const h = createEditorHarness();
        await playing(h, 32);
        atStep(h, 12);
        h.elements.pianoViewport.clientWidth = 1100;
        h.resize();
        h.animate();
        near(h.elements.pianoViewport.scrollLeft, 56);
        atStep(h, 16);
        near(h.elements.pianoViewport.scrollLeft, 108);
        atStep(h, 31);
        near(h.elements.pianoViewport.scrollLeft, 216);
        assert.ok(playheadX(h) > 600);
        h.engine.stop();
        const short = createEditorHarness();
        await playing(short, 4);
        atStep(short, 3);
        assert.equal(short.elements.pianoViewport.scrollLeft, 0);
        short.engine.stop();
        const long = createEditorHarness();
        long.elements.pianoViewport.scrollLeft = 64000 * 38;
        await playing(long, 65536, 64001);
        atStep(long, 64012);
        near(long.elements.pianoViewport.scrollLeft, 64012 * 38 - 400);
        near(playheadX(long), 500);
        long.engine.stop();
    });

    await test('offscreen arrow reveal cancels following while onscreen and vertical-only navigation do not fight it', async () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(128);
        const a = h.engine.sequence.addNote({ midi: 60, startStep: 4 });
        const b = h.engine.sequence.addNote({ midi: 64, startStep: 4 });
        const distant = h.engine.sequence.addNote({ midi: 64, startStep: 80 });
        h.clickNote(a);
        await h.elements.playButton.onclick();
        atStep(h, 12);
        assert.equal(key(h, 'ArrowUp'), true);
        assert.match(h.elements.noteInfo.textContent, new RegExp(b.id));
        atStep(h, 13);
        near(h.elements.pianoViewport.scrollLeft, 94);
        const tick = h.engine.getPlaybackTick();
        const cursor = h.elements.cursorPosition.textContent;
        assert.equal(key(h, 'ArrowRight'), true);
        assert.match(h.elements.noteInfo.textContent, new RegExp(distant.id));
        const revealLeft = h.elements.pianoViewport.scrollLeft;
        near(h.engine.getPlaybackTick(), tick);
        assert.equal(h.elements.cursorPosition.textContent, cursor);
        atStep(h, 14);
        assert.equal(h.elements.pianoViewport.scrollLeft, revealLeft);
        atStep(h, 60);
        assert.equal(h.elements.pianoViewport.scrollLeft, revealLeft);
        atStep(h, 80);
        near(h.elements.pianoViewport.scrollLeft, 80 * 38 - 400);
        atStep(h, 90);
        near(h.elements.pianoViewport.scrollLeft, 90 * 38 - 400);
        h.engine.stop();
    });

    await test('repeated transports use one animation chain and one set of listeners without changing audio/MIDI state', async () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(128);
        h.engine.sequence.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 1920, bpm: 90 }];
        h.engine.sequence.addNote({ midi: 60, ticks: 17, durationTicks: 241 });
        const before = noteData(h);
        for (let index = 0; index < 5; index++) {
            await h.elements.playButton.onclick();
            const requests = h.animationRequests;
            h.animate();
            assert.equal(h.animationRequests, requests + 1);
            assert.equal(h.intervals.size, 1);
            h.elements.stopButton.onclick();
            assert.equal(h.intervals.size, 0);
        }
        assert.equal(h.elements.pianoViewport.listenerCounts.scroll, 1);
        assert.equal(h.elements.pianoViewport.listenerCounts.wheel, 1);
        assert.equal(h.elements.pianoViewport.listenerCounts.pointerdown, 1);
        assert.equal(h.resizeObserverCount, 1);
        assert.deepEqual(noteData(h), before);
    });

    await test('upward offscreen reveal uses the top row boundary without horizontal recentering', () => {
        const h = createEditorHarness();
        const a = h.engine.sequence.addNote({ midi: 60, ticks: 17 });
        const upper = h.engine.sequence.addNote({ midi: 83, ticks: 17 });
        h.clickNote(a);
        const left = h.elements.pianoViewport.scrollLeft;
        key(h, 'ArrowUp');
        assert.match(h.elements.noteInfo.textContent, new RegExp(upper.id));
        assert.equal(h.elements.pianoViewport.scrollTop, 0);
        assert.equal(h.elements.pianoViewport.scrollLeft, left);
        key(h, 'ArrowDown');
        near(h.elements.pianoViewport.scrollTop, (83 - 60) * 24 + 24 - 568);
    });

    await test('leftward note reveal leaves the playhead to the right without an immediate follow relock', async () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(128);
        const first = h.engine.sequence.addNote({ midi: 60, startStep: 0 });
        const current = h.engine.sequence.addNote({ midi: 60, startStep: 4 });
        h.clickNote(current);
        await h.elements.playButton.onclick();
        atStep(h, 12);
        near(h.elements.pianoViewport.scrollLeft, 56);
        key(h, 'ArrowLeft');
        assert.match(h.elements.noteInfo.textContent, new RegExp(first.id));
        assert.equal(h.elements.pianoViewport.scrollLeft, 0);
        atStep(h, 14);
        atStep(h, 20);
        assert.equal(h.elements.pianoViewport.scrollLeft, 0);
        h.engine.stop();
    });

    await test('follow uses tempo-map ticks while sample scheduling and voice identities remain unchanged', async () => {
        const h = createEditorHarness();
        h.engine.setPatternLength(128);
        h.engine.sequence.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 480, bpm: 60 }];
        h.engine.sequence.addNote({ id: 'held', midi: 60, ticks: 0, durationTicks: 2000 });
        const events = [];
        h.engine.voiceFactory = (event) => {
            events.push(event);
            return { stop() {}, finished: new Promise(() => {}) };
        };
        h.engine.addTrack('sample', {});
        h.engine.setStep('sample', 0, true);
        const data = noteData(h);
        const track = h.engine.tracks.get('sample');
        await h.elements.playButton.onclick();
        h.engine.audioContext.currentTime = h.engine.playbackAnchorTime + h.engine.sequence.ticksToSeconds(1440);
        h.animate();
        near(h.engine.getPlaybackTick(), 1440);
        near(h.elements.pianoViewport.scrollLeft, 56);
        near(playheadX(h), 500);
        assert.equal(events.length, 1);
        assert.equal(events[0].id, 'held');
        assert.equal(track.activeSources.size, 1);
        assert.equal(h.engine.audioContext.sources.length, 1);
        assert.deepEqual(noteData(h), data);
        h.engine.stop();
    });

    await test('Shift+wheel interruption does not relock at center and tiny manual offsets do not flicker', async () => {
        const h = createEditorHarness();
        await playing(h);
        atStep(h, 12);
        h.elements.pianoViewport.listeners.wheel({ deltaX: 0, deltaY: 30, shiftKey: true });
        h.elements.pianoViewport.scrollLeft += 0.1;
        h.paint();
        const left = h.elements.pianoViewport.scrollLeft;
        atStep(h, 12.1);
        atStep(h, 13);
        assert.equal(h.elements.pianoViewport.scrollLeft, left);
        h.engine.stop();
    });

    await test('identical heads with unequal durations navigate by centers; equal centers exclude horizontal navigation', () => {
        const h = createEditorHarness();
        const short = { id: 'short', ticks: 100, durationTicks: 20, midi: 60 };
        const long = { id: 'long', ticks: 100, durationTicks: 200, midi: 60 };
        assert.equal(h.PianoRollEditor.directionalNote([long], short, 'right', 480), long);
        assert.equal(h.PianoRollEditor.directionalNote([short], long, 'left', 480), short);
        const equalCenter = { id: 'equal', ticks: 150, durationTicks: 100, midi: 60 };
        assert.equal(h.PianoRollEditor.directionalNote([equalCenter], long, 'right', 480), null);
        assert.equal(h.PianoRollEditor.directionalNote([equalCenter], long, 'left', 480), null);
        const earlierHead = { id: 'earlier-head', ticks: 0, durationTicks: 500, midi: 60 };
        assert.equal(h.PianoRollEditor.directionalNote([earlierHead], long, 'right', 480), earlierHead);
    });

    await test('all four directions choose musical-center winners that differ from head-distance winners', () => {
        const h = createEditorHarness();
        const selected = { id: 'selected', ticks: 100, durationTicks: 100, midi: 60 };
        const cases = {
            right: [{ id: 'head', ticks: 110, durationTicks: 1000, midi: 60 }, { id: 'center', ticks: 200, durationTicks: 20, midi: 60 }],
            left: [{ id: 'head', ticks: 90, durationTicks: 5, midi: 60 }, { id: 'center', ticks: 50, durationTicks: 180, midi: 60 }],
            up: [{ id: 'head', ticks: 100, durationTicks: 1000, midi: 61 }, { id: 'center', ticks: 130, durationTicks: 20, midi: 62 }],
            down: [{ id: 'head', ticks: 100, durationTicks: 1000, midi: 59 }, { id: 'center', ticks: 130, durationTicks: 20, midi: 58 }]
        };
        for (const [direction, notes] of Object.entries(cases)) {
            assert.equal(h.PianoRollEditor.directionalNote(notes, selected, direction, 480).id, 'center');
        }
    });

    await test('unequal-duration exact ties prioritize center coordinates and stable IDs in every direction', () => {
        const h = createEditorHarness();
        const selected = { id: 'selected', ticks: 900, durationTicks: 200, midi: 60 };
        const cases = {
            right: [{ id: 'winner', ticks: 1100, durationTicks: 40, midi: 63 }, { id: 'other', ticks: 0, durationTicks: 2960, midi: 60 }],
            left: [{ id: 'winner', ticks: 500, durationTicks: 40, midi: 60 }, { id: 'other', ticks: 0, durationTicks: 1760, midi: 57 }],
            up: [{ id: 'winner', ticks: 800, durationTicks: 160, midi: 61 }, { id: 'other', ticks: 0, durationTicks: 2000, midi: 62 }],
            down: [{ id: 'winner', ticks: 800, durationTicks: 160, midi: 59 }, { id: 'other', ticks: 0, durationTicks: 2000, midi: 58 }]
        };
        for (const [direction, notes] of Object.entries(cases)) {
            assert.equal(h.PianoRollEditor.directionalNote(notes, selected, direction, 480).id, 'winner');
            const winner = notes[0];
            const ties = [{ ...winner, id: 'z' }, { ...winner, id: 'a', ticks: winner.ticks + 5, durationTicks: winner.durationTicks - 10 }];
            assert.equal(h.PianoRollEditor.directionalNote(ties, selected, direction, 480).id, 'a');
            assert.equal(h.PianoRollEditor.directionalNote(ties.reverse(), selected, direction, 480).id, 'a');
        }
    });

    await test('odd tick durations preserve half-tick centers at every supported PPQ scale', () => {
        const h = createEditorHarness();
        const selected = { id: 'selected', ticks: 17, durationTicks: 3, midi: 60 };
        const same = { id: 'same', ticks: 18, durationTicks: 1, midi: 60 };
        const nearer = { id: 'nearer', ticks: 18, durationTicks: 2, midi: 60 };
        const farther = { id: 'farther', ticks: 20, durationTicks: 1, midi: 60 };
        for (const ppq of [1, 7, 101, 480, 32767]) {
            assert.equal(h.PianoRollEditor.directionalNote([same], selected, 'left', ppq), null);
            assert.equal(h.PianoRollEditor.directionalNote([same, farther, nearer], selected, 'right', ppq).id, 'nearer');
        }
    });

    await test('large supported safe-integer note tails use exact comparison beyond Number arithmetic bounds', () => {
        const h = createEditorHarness();
        const selected = { id: 'selected', ticks: 100, durationTicks: Number.MAX_SAFE_INTEGER - 100, midi: 60 };
        const nearer = { id: 'z-nearer', ticks: 100, durationTicks: Number.MAX_SAFE_INTEGER - 99, midi: 60 };
        const farther = { id: 'a-farther', ticks: 100, durationTicks: Number.MAX_SAFE_INTEGER - 98, midi: 60 };
        const earlier = { id: 'earlier', ticks: 100, durationTicks: Number.MAX_SAFE_INTEGER - 101, midi: 60 };
        assert.equal(h.PianoRollEditor.directionalNote([farther, nearer], selected, 'right', 32767).id, 'z-nearer');
        assert.equal(h.PianoRollEditor.directionalNote([nearer, earlier], selected, 'left', 32767).id, 'earlier');
    });

    await test('center-based navigation across tracks preserves selection rules, data, cursor and redo history', () => {
        const h = createEditorHarness();
        h.engine.sequence.tracks.push({ id: 'strings', name: 'Strings', channel: 3 });
        const short = h.engine.sequence.addNote({ midi: 60, startStep: 4, durationSteps: 4 });
        const long = h.engine.sequence.addNote({ midi: 60, startStep: 4, durationSteps: 8, trackId: 'strings' });
        h.clickNote(short);
        h.elements.nextOverlap.onclick();
        key(h, 'd', { ctrlKey: true });
        key(h, 'z', { ctrlKey: true });
        h.clickNote(short);
        h.elements.nextOverlap.onclick();
        const before = noteData(h);
        const cursor = h.elements.cursorPosition.textContent;
        assert.equal(key(h, 'ArrowRight'), true);
        assert.match(h.elements.noteInfo.textContent, new RegExp(long.id));
        assert.deepEqual(noteData(h), before);
        assert.equal(h.elements.cursorPosition.textContent, cursor);
        key(h, 'a', { ctrlKey: true });
        assert.equal(key(h, 'ArrowLeft'), false);
        key(h, 'Escape');
        assert.equal(key(h, 'ArrowRight'), false);
        key(h, 'z', { ctrlKey: true, shiftKey: true });
        assert.equal(h.engine.sequence.notes.length, 3);
    });

    console.log(`${passed} navigation/follow tests passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
