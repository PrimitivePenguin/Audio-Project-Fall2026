const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createEditorHarness } = require('./editor-test-support');

const key = 'jukebox.workspace.docks.v1';
const height = (body) => Number.parseInt(body.style.height, 10);
const pointer = (clientY) => ({ pointerId: 8, button: 0, clientY,
    preventDefault() {}, stopPropagation() {} });

function chrome(h, viewportHeight = 720) {
    const e = h.elements;
    e.dawWorkspace.clientHeight = viewportHeight;
    e.meshContainer1.offsetHeight = 60;
    e.editingToolbar.offsetHeight = 50;
    e.workspaceStatus.offsetHeight = 32;
    e.sampleRackSummary.offsetHeight = e.automationSummary.offsetHeight = 30;
    h.resize();
    return e;
}

test('docks resize independently, clamp to viewport and keep one render lifecycle', async () => {
    const h = createEditorHarness();
    await h.ready;
    h.elements.tracksView.onclick();
    const e = chrome(h);
    await vm.runInContext('initializeSequencer()', h.scope);
    assert.equal(h.readyEvents.length, 1);
    assert.equal(h.resizeObserverCount, 1);
    assert.equal(e.automationPanel.listenerCounts.toggle, 1);
    assert.equal(e.sampleRack.listenerCounts.toggle, 1);
    assert.equal(e.automationResize.listenerCounts.pointerdown, 1);
    assert.equal(e.sampleRackResize.listenerCounts.keydown, 1);
    const originalSample = height(e.sampleRackBody);
    const originalAutomation = height(e.automationBody);
    e.automationResize.listeners.pointerdown(pointer(300));
    assert.equal(e.automationResize.hasPointerCapture(8), true);
    e.automationResize.listeners.pointermove(pointer(265));
    e.automationResize.listeners.pointerup(pointer(265));
    assert.equal(e.automationResize.hasPointerCapture(8), false);
    assert.equal(height(e.automationBody), originalAutomation + 35);
    assert.equal(height(e.sampleRackBody), originalSample);
    assert.equal(e.pianoCanvas.capturedPointers.size, 0);

    e.sampleRackResize.listeners.keydown({ key: 'Home', preventDefault() {} });
    assert.equal(height(e.sampleRackBody), Number(e.sampleRackResize.getAttribute('aria-valuemin')));
    assert.equal(height(e.automationBody), originalAutomation + 35);
    e.sampleRackResize.listeners.keydown({ key: 'End', preventDefault() {} });
    assert.equal(height(e.sampleRackBody), Number(e.sampleRackResize.getAttribute('aria-valuemax')));
    assert.equal(e.dawWorkspace.style['--piano-min-height'], '112px');

    const fitted = height(e.sampleRackBody);
    e.sampleRackResize.listeners.pointerdown(pointer(300));
    e.sampleRackResize.listeners.pointermove(pointer(350));
    e.sampleRackResize.listeners.pointercancel(pointer(350));
    assert.equal(height(e.sampleRackBody), fitted);
    const saved = JSON.parse(h.scope.localStorage.getItem(key));
    chrome(h, 520);
    assert(height(e.automationBody) + height(e.sampleRackBody) <= 520 - 142 - 62 - 112);
    assert.deepEqual(JSON.parse(h.scope.localStorage.getItem(key)), saved);
});

test('collapse cancels an uncommitted point and restores the lane and panel preferences', async () => {
    const h = createEditorHarness(2);
    await h.ready;
    h.elements.tracksView.onclick();
    const e = chrome(h);
    const parameter = h.scope.document.getElementById('automationParameter');
    parameter.value = 'pan';
    parameter.onchange();
    const automation = e.automationCanvas;
    const point = (x, y) => ({ ...pointer(y + 40), clientX: x + 20 });
    e.automationPlot.clientHeight = 100;
    h.resize();
    assert.equal(automation.height, 200);
    assert.equal(automation.width, e.pianoViewport.clientWidth * 2);
    automation.onpointerdown(point(176, 50));
    automation.onpointerup(point(176, 50));
    assert.deepEqual(JSON.parse(JSON.stringify(h.engine.getAutomation('piano', 'pan'))), [{ tick: 240, value: 0 }]);

    e.automationPlot.clientHeight = 180;
    h.resize();
    assert.equal(automation.height, 360);
    automation.onpointerdown(point(176, 90));
    automation.onpointermove(point(214, 14));
    automation.onpointerup(point(214, 14));
    assert.deepEqual(JSON.parse(JSON.stringify(h.engine.getAutomation('piano', 'pan'))), [{ tick: 360, value: 1 }]);

    automation.onpointerdown(point(252, 90));
    assert.equal(automation.hasPointerCapture(8), true);
    e.automationPanel.open = false;
    e.automationPanel.listeners.toggle();
    assert.equal(automation.hasPointerCapture(8), false);
    assert.equal(h.engine.getAutomation('piano', 'pan').length, 1);
    assert.equal(e.sampleRack.open, true);
    e.automationPanel.open = true;
    e.automationPanel.listeners.toggle();
    assert.equal(parameter.value, 'pan');
    e.undoNotes.onclick();
    assert.equal(h.engine.getAutomation('piano', 'pan')[0].tick, 240);

    e.sampleRack.open = false;
    e.sampleRack.listeners.toggle();
    assert.equal(e.automationPanel.open, true);
    e.automationResize.listeners.keydown({ key: 'ArrowUp', preventDefault() {} });
    const stored = h.scope.localStorage.getItem(key);
    const reload = createEditorHarness(1, { storage: { [key]: stored } });
    await reload.ready;
    reload.elements.tracksView.onclick();
    chrome(reload);
    assert.equal(reload.elements.sampleRack.open, false);
    assert.equal(reload.elements.automationPanel.open, true);
    assert.equal(height(reload.elements.automationBody), height(e.automationBody));
});

test('invalid stored preferences use the defaults and small windows retain accessible handles', async () => {
    const h = createEditorHarness(1, { storage: { [key]: JSON.stringify({
        animation: {}, automation: { open: 'yes', height: 'large' }, samples: { open: true, height: -10 }
    }) } });
    await h.ready;
    h.elements.tracksView.onclick();
    const e = chrome(h);
    assert.equal(e.automationPanel.open, true);
    assert.equal(height(e.automationBody), 180);
    assert.equal(height(e.sampleRackBody), 72);
    chrome(h, 220);
    assert.equal(height(e.automationBody), Number(e.automationResize.getAttribute('aria-valuemin')));
    assert.equal(height(e.sampleRackBody), Number(e.sampleRackResize.getAttribute('aria-valuemin')));
});
