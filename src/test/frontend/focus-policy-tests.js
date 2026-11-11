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
    h.documentListeners.keydown({ key: value, target: h.activeElement,
        preventDefault() { prevented = true; }, ...options });
    return prevented;
}
async function space(h, options = {}) {
    const target = h.activeElement;
    const prevented = key(h, ' ', options);
    // Model the browser's keyup click only if keydown left native activation enabled.
    if (!prevented && ['BUTTON', 'SUMMARY'].includes(target?.tagName)) {
        await h.activateControl(target.testId, 0);
    }
    if (h.engine.startPromise) await h.engine.startPromise;
    return prevented;
}
function setup() {
    const h = createEditorHarness();
    h.elements.workspaceOptions = new h.elements.playButton.constructor();
    h.engine.sequence.addMusicalTrack({ name: 'Bass' });
    h.engine.sequence.addMusicalTrack({ name: 'Strings' });
    h.readyEvents[0].detail.editor.refresh();
    h.elements.activeTrack.value = h.engine.sequence.tracks[1].id;
    h.elements.activeTrack.onchange();
    return h;
}
const order = (h) => JSON.stringify(h.engine.sequence.tracks);
(async () => {
    for (const mode of ['tracksView', 'pianoRollView']) {
        for (const id of ['moveTrackUp', 'moveTrackDown']) {
            await test(`mouse ${id} in ${mode} releases focus and Space never repeats reorder`, async () => {
                const h = setup();
                await h.activateControl(mode);
                await h.activateControl(id);
                const after = order(h);
                assert.equal(h.activeElement, h.elements.pianoViewport);
                assert.equal(h.elements.pianoViewport.focusOptions.preventScroll, true);
                assert.equal(await space(h), true);
                assert.equal(h.engine.isPlaying, true);
                assert.equal(order(h), after);
                await space(h);
                assert.equal(h.engine.isPaused, true);
                await space(h);
                assert.equal(h.engine.isPlaying, true);
                assert.equal(order(h), after);
                h.engine.stop();
            });
        }
    }
    await test('pointer summary native action completes once and Space controls transport while options remain open', async () => {
        const h = setup();
        const summary = h.elements.workspaceOptions;
        summary.tagName = 'SUMMARY';
        summary.testId = 'workspaceOptions';
        let toggles = 0;
        summary.onclick = () => { summary.open = !summary.open; toggles++; };
        await h.activateControl('workspaceOptions');
        assert.equal(summary.open, true);
        assert.equal(h.activeElement, h.elements.pianoViewport);
        await space(h);
        await space(h);
        assert.equal(toggles, 1);
        assert.equal(summary.open, true);
        h.engine.stop();
    });
    await test('keyboard Space and Enter keep buttons and summary natively operable', async () => {
        const h = setup();
        const button = h.elements.moveTrackDown;
        button.testId = 'moveTrackDown';
        await h.activateControl('moveTrackDown', 0);
        assert.equal(h.activeElement, button);
        const before = order(h);
        assert.equal(await space(h), false);
        assert.equal(h.engine.isPlaying, false);
        // Enter is not an editor shortcut; its generated click retains focus as well.
        assert.equal(key(h, 'Enter'), false);
        assert.equal(h.activeElement, button);
        assert.equal(order(h), before); // Already at the end: invalid/no-op action stays safe.
        const summary = h.elements.workspaceOptions;
        summary.tagName = 'SUMMARY';
        summary.testId = 'workspaceOptions';
        summary.onclick = () => { summary.open = !summary.open; };
        await h.activateControl('workspaceOptions', 0);
        assert.equal(h.activeElement, summary);
        await space(h);
        assert.equal(summary.open, false);
        assert.equal(h.activeElement, summary);
    });
    await test('pointer Add returns to workspace while keyboard Add intentionally enters rename input', async () => {
        const h = setup();
        await h.activateControl('addMidiTrack');
        assert.equal(h.activeElement, h.elements.pianoViewport);
        await space(h);
        assert.equal(h.engine.isPlaying, true);
        h.engine.stop();
        await h.activateControl('addMidiTrack', 0);
        assert.equal(h.activeElement, h.elements.trackName);
        h.elements.trackName.tagName = 'INPUT';
        assert.equal(await space(h), false);
        h.elements.trackName.value = 'Renamed';
        await h.activateControl('renameMidiTrack');
        assert.equal(h.activeElement, h.elements.pianoViewport);
        await space(h);
        assert.equal(h.engine.isPlaying, true);
        h.engine.stop();
    });
    await test('pointer editing controls do not retain Space and focus handoff creates no extra note history', async () => {
        const h = setup();
        h.elements.activeTrack.value = '';
        h.elements.activeTrack.onchange();
        h.engine.sequence.addNote({ midi: 60, ticks: 0, durationTicks: 120 });
        key(h, 'a', { ctrlKey: true });
        const before = JSON.stringify(h.engine.sequence.toJSON());
        await h.activateControl('copyNotes');
        assert.equal(JSON.stringify(h.engine.sequence.toJSON()), before);
        key(h, 'z', { ctrlKey: true });
        assert.equal(JSON.stringify(h.engine.sequence.toJSON()), before);
        await h.activateControl('duplicateNotes');
        assert.equal(h.activeElement, h.elements.pianoViewport);
        key(h, 'z', { ctrlKey: true });
        assert.equal(JSON.stringify(h.engine.sequence.toJSON()), before);
        await space(h);
        assert.equal(h.engine.isPlaying, true);
        h.engine.stop();
    });
    await test('pointer Stop permits immediate fresh Space; held Space does not double toggle or scroll', async () => {
        const h = setup();
        h.clickAt(100 + 2.25 * 38, 15);
        await space(h);
        await h.activateControl('stopButton');
        const left = h.elements.pianoViewport.scrollLeft;
        await space(h);
        assert.equal(h.engine.playbackAnchorTick, 270);
        assert.equal(await space(h, { repeat: true }), true);
        assert.equal(h.engine.isPlaying, true);
        assert.equal(h.intervals.size, 1);
        assert.equal(h.elements.pianoViewport.scrollLeft, left);
        h.engine.stop();
    });
    await test('typing, native dropdowns, sliders and contenteditable remain protected', async () => {
        const h = setup();
        for (const target of [{ tagName: 'INPUT' }, { tagName: 'SELECT' }, { tagName: 'TEXTAREA' },
            { isContentEditable: true }, { closest: () => ({ role: 'slider' }) }]) {
            assert.equal(key(h, ' ', { target }), false);
            assert.equal(h.engine.isPlaying, false);
        }
        const input = h.elements.trackName;
        input.tagName = 'INPUT';
        input.closest = () => null;
        input.focus();
        h.documentListeners.click({ target: input, detail: 1 });
        await Promise.resolve();
        assert.equal(h.activeElement, input);
    });
    await test('pointer focus policy preserves newly opened dialogs and intended action focus', async () => {
        const h = setup();
        await h.activateControl('shortcutsButton');
        assert.equal(h.activeElement, h.elements.closeShortcuts);
        assert.equal(await space(h), false);
        h.elements.closeShortcuts.onclick();
        assert.equal(h.activeElement, h.elements.pianoViewport);
        const original = h.elements.copyNotes.onclick;
        h.elements.copyNotes.onclick = () => h.elements.trackName.focus();
        await h.activateControl('copyNotes');
        assert.equal(h.activeElement, h.elements.trackName);
        h.elements.copyNotes.onclick = original;
        h.setModalOpen(true);
        await h.activateControl('copyNotes');
        assert.notEqual(h.activeElement, h.elements.pianoViewport);
        assert.equal(key(h, ' '), false);
    });
    await test('unrelated account/navigation buttons and programmatic clicks retain their focus', async () => {
        const h = setup();
        const button = h.elements.playButton;
        button.closest = (selector) => selector === 'button, summary' ? button : null;
        await h.activateControl('playButton');
        assert.equal(h.activeElement, button);
        h.engine.stop();
        await h.activateControl('copyNotes', 0);
        assert.equal(h.activeElement, h.elements.copyNotes);
    });
    await test('confirmation dialog keeps focus and blocks Space after pointer Delete', async () => {
        const h = setup();
        const id = h.elements.activeTrack.value;
        h.engine.sequence.addNote({ trackId: id, midi: 60, ticks: 0, durationTicks: 120 });
        h.readyEvents[0].detail.editor.refresh();
        await h.activateControl('deleteMidiTrack');
        assert.equal(h.elements.deleteTrackDialog.open, true);
        assert.equal(h.activeElement, h.elements.cancelDeleteTrack);
        assert.equal(await space(h), false);
        assert.equal(h.engine.isPlaying, false);
        assert.ok(h.engine.sequence.tracks.some((track) => track.id === id));
        h.elements.cancelDeleteTrack.onclick();
    });
    await test('deferred handoff does not steal focus from intervening Tab or another pointer interaction', async () => {
        const h = setup();
        await h.activateControl('copyNotes', 0);
        const control = h.elements.copyNotes;
        h.documentListeners.click({ target: control, detail: 1 });
        key(h, 'Tab');
        h.flushDeferredActions();
        assert.equal(h.activeElement, control);
        h.documentListeners.click({ target: control, detail: 1 });
        const input = h.elements.trackName;
        input.closest = () => null;
        input.focus();
        h.documentListeners.click({ target: input, detail: 1 });
        h.flushDeferredActions();
        assert.equal(h.activeElement, input);
    });
    await test('pointer action may disable itself and still release focus without any viewport movement', async () => {
        const h = setup();
        const control = h.elements.copyNotes;
        control.onclick = () => { control.disabled = true; };
        h.elements.pianoViewport.scrollLeft = 71;
        h.elements.pianoViewport.scrollTop = 35;
        await h.activateControl('copyNotes');
        assert.equal(h.activeElement, h.elements.pianoViewport);
        assert.equal(h.elements.pianoViewport.scrollLeft, 71);
        assert.equal(h.elements.pianoViewport.scrollTop, 35);
    });
    console.log(`${passed} focus-policy tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
