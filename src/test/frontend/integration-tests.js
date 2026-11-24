const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createEditorHarness } = require('./editor-test-support');
const staticDir = path.resolve(__dirname, '../../main/resources/static');
const scripts = ['instruments/SynthInstrumentManager.js', 'InstrumentPanel.js', 'SynthUI.js',
    'instruments/DrumMachine.js', 'DrumMachineUI.js'];
const registrationScript = `
for (const kind of ['synth', 'drum']) {
    const root = document.getElementById(kind + 'Menu');
    root.setAttribute('data-daw-controls', '');
    root.setAttribute('data-daw-pointer-inputs', '');
    const toggle = document.getElementById(kind + 'Toggle');
    toggle.tagName = 'BUTTON';
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', kind + 'Panel');
    root.appendChild(toggle);
}
`;
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
function setup(options = {}) { return createEditorHarness(1, { scripts, registrationScript, ...options }); }
function byLabel(h, label) { return h.nodes.find((node) => node.getAttribute('aria-label') === label); }
function snapshot(h) { return JSON.parse(JSON.stringify(h.engine.sequence.toJSON())); }
function key(h, value, target = h.activeElement, extra = {}) {
    let prevented = false;
    h.documentListeners.keydown({ key: value, target, preventDefault() { prevented = true; }, ...extra });
    return prevented;
}
async function space(h) {
    const prevented = key(h, ' ');
    if (h.engine.startPromise) await h.engine.startPromise;
    return prevented;
}
function pointerStart(h, control, id = 1) {
    h.documentListeners.pointerdown({ target: control, pointerId: id, button: 0 });
    control.focus();
}
function pointerEnd(h, control, id = 1) {
    h.documentListeners.pointerup({ target: control, pointerId: id });
    h.flushDeferredActions();
}
function savedData() {
    return {
        stepCount: 32, ppq: 101, tracks: [{ id: 'lead-stable', name: 'Lead', channel: 3, program: 42 }],
        notes: [{ id: 'note-original', trackId: 'lead-stable', midi: 60, ticks: 17, durationTicks: 31 }],
        loopStart: 4, loopEnd: 24,
        instruments: { version: 1,
            synth: { tracks: [{ trackId: 'lead-stable', settings: { waveform: 'triangle', attack: 0.7, decay: 0.3,
                sustain: 0.4, release: 1.2, filterCutoff: 777, gain: 0.12 } }] },
            drums: { stepCount: 32, tracks: [{ id: 'drum-kick', volume: 0.35,
                steps: Array.from({ length: 32 }, (_, i) => i === 0 || i === 19) }] }
        }
    };
}
async function databaseHarness(data = savedData(), role = 'EDITOR', saveStatus = 200) {
    const requests = [];
    const h = setup({ pathname: '/project/11111111-1111-1111-1111-111111111111',
        fetch: async (url, options = {}) => {
            requests.push({ url, ...options });
            const saving = options.method === 'PUT';
            return { ok: !saving || saveStatus === 200, status: saving ? saveStatus : 200,
                json: async () => saving
                    ? (saveStatus === 200 ? { version: 8 } : { error: 'Project is stale; reload it before saving' })
                    : { id: '11111111-1111-1111-1111-111111111111', name: 'Saved Song', role, version: 7,
                        projectData: JSON.stringify(data) } };
        }
    });
    await h.ready;
    return { h, requests };
}

(async () => {
    await test('all editor entry assets resolve from /index.html and forwarded /project/UUID without relative route leakage', () => {
        const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
        const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
            .map((match) => match[1]).filter((url) => /\.(js|css)$/.test(url));
        assets.push(...[...html.matchAll(/from "([^"]+)"/g)].map((match) => match[1]));
        for (const asset of assets) {
            assert.ok(asset.startsWith('/'), asset);
            assert.ok(fs.existsSync(path.join(staticDir, asset)));
            assert.equal(new URL(asset, 'http://localhost/project/uuid').pathname,
                new URL(asset, 'http://localhost/index.html').pathname);
        }
        assert.ok(html.indexOf('/js/instruments/SynthInstrumentManager.js') < html.indexOf('/js/SynthUI.js'));
        assert.ok(html.indexOf('/js/DrumMachineUI.js') < html.indexOf('/js/sequencer-ui.js'));
        assert.ok(html.indexOf('id="synthToggle"') < html.indexOf('Project Dashboard'));
    });
    await test('direct editor creates exactly one synth manager and toolbar panel per instrument, with lazy shared audio', async () => {
        const h = setup(); await h.ready;
        assert.equal(h.readyEvents.length, 1);
        assert.ok(h.scope.window.jukeboxSynth);
        assert.ok(h.scope.window.jukeboxDrums);
        assert.equal(h.engine.audioContext, null);
        assert.equal(h.nodes.filter((node) => node.className === 'synth-panel instrument-panel').length, 1);
        assert.equal(h.nodes.filter((node) => node.className === 'drum-panel instrument-panel').length, 1);
        h.documentListeners['jukebox:ready'](h.readyEvents[0]);
        assert.equal(h.nodes.filter((node) => node.className === 'synth-panel instrument-panel').length, 1);
    });
    await test('16-step drum exports use the original hit buffers and enter the rack as independent WAVs', async () => {
        const h = setup();
        await h.ready;
        const drums = h.scope.window.jukeboxDrums;
        h.engine.setPatternLength(16384);
        drums.setStep('drum-kick', 0, true);
        drums.setStep('drum-snare', 4, true);
        drums.setStep('drum-hat', 15, true);
        drums.setVolume('drum-kick', 0.25);
        drums.setVolume('drum-snare', 0.5);
        drums.setVolume('drum-hat', 0.4);
        assert.equal(drums.setStep('drum-hat', 16, true), false);
        assert.equal(drums.stepCount(), 16);
        await h.activateControl('drumToggle');
        assert.equal(h.nodes.filter((node) => /^(Kick|Snare|Hi-hat) step /.test(node.getAttribute('aria-label') ?? '')).length, 48);
        assert.ok(!byLabel(h, 'Next steps'));
        const rate = h.engine.audioContext.sampleRate;
        const initial = drums.renderPattern(120);
        const mix = new DataView(initial);
        assert.equal(mix.getUint32(64, true) / 2 / rate, 2);
        assert.ok(Math.abs(new DataView(drums.renderPattern(90)).getUint32(64, true) / 2 / rate - 8 / 3) <= 1 / rate);
        const sample = (frame) => mix.getInt16(68 + frame * 2, true);
        for (const [id, step, volume] of [['drum-kick', 0, .25], ['drum-snare', 4, .5], ['drum-hat', 15, .4]]) {
            const waveform = h.engine.tracks.get(id).buffer.getChannelData(0);
            assert.equal(sample(step * rate / 8 + 4), Math.round(waveform[4] * volume * 32767));
        }
        assert.equal(sample(rate / 2 - 1), 0);
        assert.equal(sample(2 * rate - 1), 0);
        const saved = new Map();
        h.SampleAssetStore.prototype.write = async (id, bytes) => saved.set(id, bytes);
        h.engine.audioContext.decodeAudioData = async (bytes) => {
            const view = new DataView(bytes);
            const buffer = h.engine.audioContext.createBuffer(1, view.getUint32(64, true) / 2, rate);
            const waveform = buffer.getChannelData(0);
            for (let frame = 0; frame < waveform.length; frame++) waveform[frame] = view.getInt16(68 + frame * 2, true) / 32768;
            return buffer;
        };
        const copy = h.nodes.find((node) => node.textContent === 'Copy to Sample Rack');
        await copy.listeners.click();
        await copy.listeners.click();
        const assets = [...h.engine.arrangement.assets.values()];
        assert.deepEqual(assets.map(({ name }) => name), ['Drum Pattern', 'Drum Pattern 2']);
        assert.notEqual(assets[0].id, assets[1].id);
        assert.ok(assets.every((asset) => asset.local && saved.has(asset.id) && asset.buffer.duration === 2));
        assert.equal(h.elements.sampleRack.open, true);
        assert.equal(h.engine.totalSteps, 16384);
        const first = assets[0].buffer.getChannelData(0)[4];
        drums.setStep('drum-kick', 0, false);
        assert.equal(assets[0].buffer.getChannelData(0)[4], first);
        await h.engine.play(0);
        assert.equal(h.engine.audioContext.sources.filter((source) => source.buffer).length, 0);
        h.engine.stop();
    });

    await test('Space cannot reactivate controls after rack, clip, drum, lane, or zoom edits', async () => {
        const h = setup();
        await h.ready;
        const { engine, elements } = h;
        const asset = { id: 'c'.repeat(64), name: 'Test sample', duration: 0.25, buffer: {} };
        engine.initContext();
        engine.audioContext.decodeAudioData = async () => ({ duration: 0.25, numberOfChannels: 1, length: 12000 });
        await elements.rackFiles.onchange({ target: { files: [{ name: asset.name, size: 1, arrayBuffer: async () => new ArrayBuffer(1) }] } });
        const canvas = elements.pianoCanvas;
        const spaceAfter = async (target) => {
            target.focus?.();
            const before = engine.runId;
            let swallowed = 0;
            for (const type of ['keydown', 'keyup']) {
                h.documentListeners[type]({ type, key: ' ', target,
                    preventDefault() { swallowed++; }, stopImmediatePropagation() {} });
            }
            if (engine.startPromise) await engine.startPromise;
            assert.equal(swallowed, 2);
            assert.equal(engine.runId, before + 1);
            assert.equal(engine.isPlaying, true);
            elements.stopButton.onclick();
        };
        await h.activateControl('drumToggle', 0);
        await spaceAfter(elements.drumToggle);
        const kick = byLabel(h, 'Kick step 1');
        kick.listeners.click();
        await spaceAfter(kick);
        assert.equal(h.scope.window.jukeboxDrums.getSteps('drum-kick')[0], true);
        await h.activateControl('tracksView', 0);
        await spaceAfter(elements.tracksView);
        elements.addAudioTrack.onclick();
        const card = elements.rackAssets.children[0].children[0];
        await spaceAfter(card);
        const dataTransfer = { setData() {} };
        card.listeners.dragstart({ dataTransfer });
        canvas.listeners.drop({ ...h.pointer(160, 148), dataTransfer });
        assert.equal(engine.arrangement.clips.size, 1);
        await spaceAfter(elements.pianoViewport);
        h.clickAt(155, 148);
        await spaceAfter(elements.pianoViewport);
        const mute = elements.laneMuteControls.children[0];
        mute.onclick();
        const muted = mute.getAttribute('aria-pressed');
        await spaceAfter(mute);
        assert.equal(mute.getAttribute('aria-pressed'), muted);
        h.clickAt(12, 60);
        await spaceAfter(elements.pianoViewport);
        elements.noteSnap.value = 'free';
        elements.noteSnap.onchange({ target: elements.noteSnap });
        await spaceAfter(elements.noteSnap);
        elements.zoom.type = 'range';
        elements.zoom.tagName = 'INPUT';
        elements.zoom.value = '125';
        elements.zoom.oninput();
        h.animate();
        await spaceAfter(elements.zoom);
        await h.activateControl('resetZoom', 0);
        await spaceAfter(elements.resetZoom);
        await h.activateControl('pianoRollView', 0);
        await spaceAfter(elements.pianoRollView);
    });

    await test('database composition loads before ready and instrument restoration retains exact notes, routing, loops and state', async () => {
        const { h, requests } = await databaseHarness();
        assert.equal(requests.length, 1);
        assert.equal(h.engine.sequence.ppq, 101);
        assert.equal(h.engine.sequence.notes[0].id, 'note-original');
        assert.equal(h.engine.sequence.notes[0].ticks, 17);
        assert.equal(h.engine.sequence.tracks[0].program, 42);
        assert.equal(h.scope.window.jukeboxSynth.getSettings('lead-stable').waveform, 'triangle');
        assert.equal(h.scope.window.jukeboxSynth.getSettings('lead-stable').gain, 0.12);
        assert.equal(h.scope.window.jukeboxDrums.getVolume('drum-kick'), 0.35);
        assert.equal(h.scope.window.jukeboxDrums.snapshot().tracks.find(({ id }) => id === 'drum-kick').legacySteps[3], true);
        assert.equal(h.engine.loopStart, 4);
        assert.equal(h.engine.loopEnd, 24);
        assert.equal(h.engine.tracks.size, 3);
        assert.equal(h.intervals.size, 0); // No second audio scheduler during load.
        await h.activateControl('synthToggle');
        assert.equal(byLabel(h, 'Waveform').value, 'triangle');
    });
    await test('save reads current synth/drum settings without resetting them and retains optimistic version', async () => {
        const { h, requests } = await databaseHarness();
        h.scope.window.jukeboxSynth.setParam('lead-stable', 'gain', 0.18);
        h.scope.window.jukeboxDrums.setVolume('drum-hat', 0.65);
        h.scope.window.jukeboxDrums.setStep('drum-snare', 7, true);
        await h.elements.saveProject.onclick();
        const payload = JSON.parse(requests.at(-1).body);
        const data = JSON.parse(payload.projectData);
        assert.equal(payload.version, 7);
        assert.equal(data.instruments.version, 1);
        assert.equal(data.instruments.synth.tracks[0].settings.gain, 0.18);
        assert.equal(data.instruments.drums.tracks.find((track) => track.id === 'drum-hat').volume, 0.65);
        assert.equal(data.instruments.drums.tracks.find((track) => track.id === 'drum-snare').steps[7], true);
        assert.equal(h.scope.window.jukeboxSynth.getSettings('lead-stable').gain, 0.18);
        await h.elements.saveProject.onclick();
        assert.equal(JSON.parse(requests.at(-1).body).version, 8);
    });
    await test('database project save and load preserve edited meters and imported meter maps', async () => {
        const meterMap = [{ ticks: 0, timeSignature: [3, 4] }, { ticks: 151, timeSignature: [7, 8] }];
        for (const timeSignatures of [undefined, meterMap]) {
            const { h, requests } = await databaseHarness({ ...savedData(), timeSignatures });
            const select = h.elements.timeSignature;
            assert.equal(select.disabled, Boolean(timeSignatures));
            if (!timeSignatures) {
                select.value = '6/8';
                select.onchange({ target: select });
            }
            await h.elements.saveProject.onclick();
            const data = JSON.parse(JSON.parse(requests.at(-1).body).projectData);
            assert.deepEqual(data.timeSignatures, timeSignatures ?? [{ ticks: 0, timeSignature: [6, 8] }]);
            assert.equal(data.notes[0].ticks, 17);
            assert.equal(data.notes[0].durationTicks, 31);
            assert.deepEqual([data.loopStart, data.loopEnd], [4, 24]);
            const { h: restored } = await databaseHarness(data);
            assert.equal(restored.elements.timeSignature.value, timeSignatures ? 'imported' : '6/8');
            assert.equal(restored.elements.timeSignature.disabled, Boolean(timeSignatures));
        }
        const { h: viewer } = await databaseHarness(savedData(), 'VIEWER');
        const select = viewer.elements.timeSignature;
        assert.equal(select.disabled, true);
        select.onchange({ target: { value: '5/4' } });
        assert.equal(viewer.engine.sequence.timeSignatures[0].timeSignature.join('/'), '4/4');
    });

    await test('stale saves surface conflicts without retrying or advancing the saved version', async () => {
        const { h, requests } = await databaseHarness(savedData(), 'OWNER', 409);
        await h.elements.saveProject.onclick();
        assert.match(h.elements.status.textContent, /stale/);
        await h.elements.saveProject.onclick();
        assert.equal(JSON.parse(requests.at(-1).body).version, 7);
        assert.equal(requests.filter((request) => request.method === 'PUT').length, 2);
    });
    await test('old projects load defaults; invalid instrument records clamp or skip safely without changing composition', async () => {
        const old = savedData(); delete old.instruments;
        const { h } = await databaseHarness(old);
        assert.equal(h.scope.window.jukeboxSynth.getSettings('lead-stable').waveform, 'sawtooth');
        assert.equal(h.engine.tracks.size, 0);
        const before = snapshot(h);
        h.scope.window.jukeboxSynth.restoreState({ tracks: [null, { trackId: 'missing', settings: { gain: 0.1 } },
            { trackId: 'lead-stable', settings: { waveform: 'invalid', gain: 99, attack: 'wrong', filterCutoff: -1 } }] });
        const settings = h.scope.window.jukeboxSynth.getSettings('lead-stable');
        assert.equal(settings.gain, 0.2);
        assert.equal(settings.filterCutoff, 50);
        assert.equal(settings.attack, 0.01);
        h.scope.window.jukeboxDrums.restoreState({ stepCount: 999999, tracks: [null,
            { id: 'uploaded', steps: [true] }, { id: 'drum-hat', volume: -5, steps: [true, 'true', false] }] });
        assert.equal(h.scope.window.jukeboxDrums.getVolume('drum-hat'), 0);
        assert.equal(h.scope.window.jukeboxDrums.getSteps('drum-hat').length, 16);
        assert.equal(h.scope.window.jukeboxDrums.getSteps('drum-hat')[1], false);
        assert.deepEqual(snapshot(h), before);
    });
    await test('viewer can inspect restored settings but cannot save or mutate synth/drum parameters', async () => {
        const { h, requests } = await databaseHarness(savedData(), 'VIEWER');
        assert.equal(h.elements.saveProject.disabled, true);
        assert.equal(h.scope.window.jukeboxSynth.setParam('lead-stable', 'gain', 0.2), false);
        assert.equal(h.scope.window.jukeboxDrums.setStep('drum-kick', 1, true), false);
        assert.equal(h.scope.window.jukeboxDrums.setVolume('drum-kick', 1), false);
        await h.activateControl('synthToggle');
        assert.equal(byLabel(h, 'Waveform').disabled, true);
        await h.activateControl('drumToggle');
        assert.equal(byLabel(h, 'Kick volume').disabled, true);
        await h.elements.saveProject.onclick();
        assert.equal(requests.length, 1);
        assert.equal(h.elements.addMidiTrack.disabled, true);
    });
    await test('panel toggles, Close and Escape preserve one instance and one polling loop without stopping playback', async () => {
        const h = setup(); await h.ready;
        await space(h);
        const timers = h.intervals.size;
        await h.activateControl('synthToggle');
        assert.equal(h.intervals.size, timers + 1);
        await h.activateControl('drumToggle');
        assert.equal(h.intervals.size, timers + 1);
        assert.equal(h.nodes.find((node) => node.className === 'synth-panel instrument-panel').hidden, true);
        assert.equal(key(h, 'Escape'), true);
        assert.equal(h.intervals.size, timers);
        assert.equal(h.engine.isPlaying, true);
        h.engine.stop();
    });
    for (const mode of ['tracksView', 'pianoRollView']) {
        await test(`pointer drum range waits for release then Space works in ${mode}`, async () => {
            const h = setup(); await h.ready;
            await h.activateControl(mode);
            await h.activateControl('drumToggle');
            const slider = byLabel(h, 'Kick volume');
            pointerStart(h, slider);
            slider.value = '0.45'; slider.listeners.input();
            assert.equal(h.activeElement, slider);
            pointerEnd(h, slider);
            assert.equal(h.activeElement, h.elements.pianoViewport);
            assert.equal(await space(h), true);
            assert.equal(h.engine.isPlaying, true);
            assert.equal(h.scope.window.jukeboxDrums.getVolume('drum-kick'), 0.45);
            assert.equal(key(h, ' ', h.activeElement, { repeat: true }), true);
            assert.equal(h.engine.isPlaying, true);
            h.engine.stop();
        });
    }
    await test('pointer synth selects release only after completed change; keyboard selection remains protected', async () => {
        const h = setup(); await h.ready;
        await h.activateControl('synthToggle');
        const wave = byLabel(h, 'Waveform');
        pointerStart(h, wave);
        pointerEnd(h, wave);
        assert.equal(h.activeElement, wave); // Native option chooser still owns focus.
        wave.value = 'square';
        h.documentListeners.change({ target: wave });
        wave.listeners.change();
        h.flushDeferredActions();
        assert.equal(h.activeElement, h.elements.pianoViewport);
        assert.equal(h.scope.window.jukeboxSynth.getSettings('piano').waveform, 'square');
        await space(h); assert.equal(h.engine.isPlaying, true); h.engine.stop();
        pointerStart(h, wave);
        key(h, 'ArrowDown', wave); // Deliberately switching to native keyboard interaction.
        h.documentListeners.change({ target: wave }); h.flushDeferredActions();
        assert.equal(h.activeElement, wave);
        assert.equal(key(h, ' ', wave), true);
        assert.equal(key(h, 'Escape', wave), false);
        assert.equal(h.nodes.find((node) => node.className === 'synth-panel instrument-panel').hidden, false);
    });
    await test('all synth ranges and drum step and preview buttons integrate with focus without changing MIDI data', async () => {
        const h = setup(); await h.ready;
        h.engine.setPatternLength(32);
        const before = snapshot(h);
        await h.activateControl('synthToggle');
        for (const label of ['Attack', 'Decay', 'Sustain', 'Release', 'Cutoff', 'Volume']) {
            const slider = byLabel(h, label);
            pointerStart(h, slider);
            slider.value = '0.3'; slider.listeners.input(); pointerEnd(h, slider);
            assert.equal(h.activeElement, h.elements.pianoViewport);
            key(h, 'Tab', slider);
            slider.focus();
            assert.equal(key(h, 'ArrowRight', slider), false);
            assert.equal(key(h, ' ', slider, { repeat: true }), true);
        }
        await h.activateControl('drumToggle');
        for (const label of ['Kick step 1']) {
            const button = byLabel(h, label);
            const event = { target: button, detail: 1 };
            button.focus(); h.documentListeners.click(event); button.listeners.click(event); h.flushDeferredActions();
            assert.equal(h.activeElement, h.elements.pianoViewport);
        }
        assert.deepEqual(snapshot(h), before);
        const context = h.engine.audioContext;
        await space(h);
        assert.equal(h.engine.audioContext, context);
        assert.equal(h.intervals.size, 2); // One UI poll and one existing audio scheduler.
        h.engine.stop();
    });
    await test('uploaded sample metadata does not fabricate a playable buffer; drums regenerate and export remains musical', async () => {
        const data = savedData(); data.sample = { name: 'missing.wav', steps: [true] };
        const { h } = await databaseHarness(data);
        assert.equal(h.engine.tracks.has('uploaded'), false);
        assert.match(h.elements.legacySampleWarning.textContent, /retained/);
        assert.ok(h.engine.tracks.get('drum-kick').buffer);
        const exported = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
        assert.equal(exported.notes[0].ticks, 17);
        assert.equal(exported.notes[0].durationTicks, 31);
        assert.equal(exported.tracks[0].program, 42);
    });
    for (const count of [0, 1, 5, 25]) {
        await test(`dashboard renders ${count} local and database projects with every action available`, async () => {
            const h = createEditorHarness();
            const projects = Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index), {
                id: String(index), name: 'Very long project name '.repeat(15) + index,
                updatedAt: new Date(0).toISOString(), data: h.engine.sequence.toJSON()
            }]));
            h.scope.localStorage.setItem('jukebox_dashboard_projects_v1', JSON.stringify(projects));
            h.scope.fetch = async () => ({ ok: true, json: async () => Array.from({ length: count }, (_, index) => ({
                id: String(index), name: 'Database project '.repeat(15) + index, role: 'OWNER', version: 0
            })) });
            for (const script of ['DashboardManager.js', 'Dashboard_ui.js', 'project-collaboration-test.js']) {
                vm.runInContext(fs.readFileSync(path.join(staticDir, 'js', script), 'utf8'), h.scope);
            }
            h.documentListeners.DOMContentLoaded();
            await new Promise(setImmediate);
            assert.equal(h.elements.projectList.children.length, count || 1);
            assert.equal(h.elements.databaseProjectList.children.length, count);
            if (count) {
                assert.ok(h.elements.projectList.children.at(-1).children[1].children.some((button) => button.textContent === 'Download MIDI'));
                const controls = h.elements.databaseProjectList.children.at(-1).children[1].children;
                assert.ok(controls.some((button) => button.textContent === 'Load in editor'));
                assert.ok(controls.some((button) => button.textContent === 'Share'));
                assert.ok(controls.some((button) => button.textContent === 'Delete'));
            }
        });
    }
    await test('dashboard overflow/contrast/wrapping is page-scoped and its script casing matches disk', () => {
        const html = fs.readFileSync(path.join(staticDir, '../templates/dashboard.html'), 'utf8');
        const css = fs.readFileSync(path.join(staticDir, 'css/dashboard.css'), 'utf8');
        assert.match(html, /body class="dashboard-page"/);
        assert.match(css, /body\.dashboard-page[\s\S]*?overflow-y: auto/);
        assert.match(css, /overflow-x: hidden/);
        assert.match(css, /overflow-wrap: anywhere/);
        assert.match(css, /flex-wrap: wrap/);
        assert.match(css, /color: #edf3fb/);
        assert.match(fs.readFileSync(path.join(staticDir, 'css/sequencer.css'), 'utf8'), /body \{ margin: 0; overflow: hidden; \}/);
        for (const [, asset] of html.matchAll(/src="([^"?]+)"/g)) {
            assert.ok(fs.existsSync(path.join(staticDir, asset)), asset);
        }
    });
    await test('instrument snapshot round-trip keeps settings across reload and New Sequence clears project-local state', async () => {
        const { h, requests } = await databaseHarness();
        h.scope.window.jukeboxSynth.setParam('lead-stable', 'waveform', 'sine');
        h.scope.window.jukeboxDrums.setStep('drum-hat', 14, true);
        await h.elements.saveProject.onclick();
        const data = JSON.parse(JSON.parse(requests.at(-1).body).projectData);
        const { h: restored } = await databaseHarness(data);
        assert.equal(restored.scope.window.jukeboxSynth.getSettings('lead-stable').waveform, 'sine');
        assert.equal(restored.scope.window.jukeboxDrums.getSteps('drum-hat')[14], true);
        assert.equal(restored.engine.tracks.size, 3);
        restored.elements.newSequence.onclick();
        assert.equal(restored.engine.tracks.size, 0);
        assert.equal(restored.scope.window.jukeboxSynth.getSettings('piano').waveform, 'sawtooth');
    });
    await test('legacy sample metadata survives saving and remains silent', async () => {
        const data = savedData(); data.sample = { name: 'original.wav', steps: [true, false, true] };
        const { h, requests } = await databaseHarness(data);
        await h.elements.saveProject.onclick();
        const saved = JSON.parse(JSON.parse(requests.at(-1).body).projectData);
        assert.equal(saved.sample.audioPersisted, false);
        assert.equal(saved.sample.steps[2], true);
        assert.deepEqual(saved.sample.steps, [true, false, true]);
        assert.equal(h.engine.tracks.has('uploaded'), false);
        assert.equal(h.elements.legacySampleWarning.hidden, false);
    });
    await test('keyboard instrument buttons send Space to transport and retain Enter', async () => {
        const h = setup(); await h.ready;
        await h.activateControl('synthToggle', 0);
        assert.equal(h.activeElement, h.elements.synthToggle);
        assert.equal(await space(h), true);
        h.engine.stop();
        assert.equal(key(h, 'Enter'), false);
        const trackSelect = byLabel(h, 'Synth track');
        pointerStart(h, trackSelect);
        trackSelect.value = 'piano';
        h.documentListeners.change({ target: trackSelect });
        trackSelect.listeners.change();
        h.flushDeferredActions();
        assert.equal(h.activeElement, h.elements.pianoViewport);
        const reset = h.nodes.find((node) => node.textContent === 'Reset to defaults');
        reset.focus();
        const event = { target: reset, detail: 1 };
        h.documentListeners.click(event); reset.listeners.click(event); h.flushDeferredActions();
        assert.equal(h.activeElement, h.elements.pianoViewport);
        await h.activateControl('drumToggle');
        const preview = h.nodes.find((node) => node.title === 'Preview Kick');
        const previewEvent = { target: preview, detail: 1 };
        preview.focus(); h.documentListeners.click(previewEvent); preview.listeners.click(previewEvent); h.flushDeferredActions();
        assert.equal(h.activeElement, h.elements.pianoViewport);
        assert.equal(await space(h), true);
        h.engine.stop();
    });
    await test('malformed pending project cannot abort ready or prevent instrument UI initialization', async () => {
        const h = setup({ storage: { jukebox_pending_database_project: '{bad JSON' } });
        await h.ready;
        assert.equal(h.readyEvents.length, 1);
        assert.ok(h.scope.window.jukeboxSynth);
        assert.ok(h.scope.window.jukeboxDrums);
    });
    await test('pointer Close releases transport focus while keyboard Close returns to the menu opener', async () => {
        const h = setup(); await h.ready;
        await h.activateControl('synthToggle');
        const close = byLabel(h, 'Close Synth settings');
        const pointer = { target: close, detail: 1 };
        close.focus();
        h.documentListeners.click(pointer); close.listeners.click(pointer); h.flushDeferredActions();
        assert.equal(h.activeElement, h.elements.pianoViewport);
        await h.activateControl('synthToggle', 0);
        const keyboard = { target: close, detail: 0 };
        close.focus();
        h.documentListeners.click(keyboard); close.listeners.click(keyboard); h.flushDeferredActions();
        assert.equal(h.activeElement, h.elements.synthToggle);
    });
    console.log(`${passed} integration tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
