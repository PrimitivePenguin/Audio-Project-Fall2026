const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createEditorHarness } = require('./editor-test-support');
const root = path.resolve(__dirname, '../../main/resources/static');
const load = (name) => import(pathToFileURL(path.join(root, 'contour', name)));
let passed = 0;
async function test(name, action) { await action(); passed++; console.log(`PASS ${name}`); }
const args = { res: 10, levels: 5, scale: 0.5, dampening: 0.25,
    colorlist: [[255, 0, 0], [0, 255, 0]], offcolorlist: [[255, 255, 255], [0, 0, 0]],
    settings: { curve: 'catmullRom', tension: 1, height: 1.5, points: 'interpolate', lineWidth: 1 } };
class Svg {
    constructor(tag = 'svg') { this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.classList = { add() {} }; }
    set innerHTML(value) {
        this.parts = { '.base': new Svg('g'), '.hi': new Svg('g'), clipPath: new Svg('clipPath'), mask: new Svg('mask') };
        this.parts.clipPath.id = 'clip'; this.parts.mask.id = 'mask';
        this.parts.mask.appendChild(new Svg('rect'));
    }
    setAttribute(key, value) { this.attributes[key] = value; if (key === 'id') this.id = value; }
    querySelector(key) { return this.parts[key]; }
    querySelectorAll() { return this.children.filter((child) => child.tag === 'rect' && child.dataset.area === undefined); }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    cloneNode() { const node = new Svg(this.tag); node.id = this.id; node.attributes = { ...this.attributes }; return node; }
    replaceWith() {}
}
(async () => {
    const { ContourRegionCache, framePainter } = await load('region_cache.js');
    const { buildContourStrings, buildContourPaths } = await load('contour.js');
    const { generatePerlin } = await load('perlin_gen.js');
    await test('contour bounds are independent of timeline length; nearby scroll reuses paths and LRU stays bounded', () => {
        const cache = new ContourRegionCache((field) => field.length * field[0].length);
        const view = { width: 900, height: 600, offsetX: 0, offsetY: 0 };
        const first = cache.get(view, args);
        assert.equal(cache.get({ ...view, offsetX: 100 }, args), first);
        for (const steps of [16, 1024, 16384, 65536]) {
            const region = cache.get({ ...view, offsetX: steps * 38, offsetY: 1100 }, args);
            assert.ok(region.width <= 1320 && region.height <= 1020);
            assert.ok(cache.regions.length <= 3);
            assert.ok(region.paths < 14000);
        }
    });
    await test('global Perlin cell sampling is identical across adjacent windows and the original field', () => {
        const field = Array.from({ length: 100 }, () => new Float64Array(50));
        generatePerlin(field, args.scale, args.dampening, 0, 1.5);
        const offset = Array.from({ length: 20 }, () => new Float64Array(20));
        offset.offsetXCells = 35; offset.offsetYCells = 12;
        generatePerlin(offset, args.scale, args.dampening, 0, 1.5);
        for (let x = 0; x < 20; x++) for (let y = 0; y < 20; y++) assert.equal(offset[x][y], field[x + 35][y + 12]);
    });
    await test('all curve modes generate finite bounded SVG geometry after rapid long-distance scrolling', () => {
        for (const curve of ['segments', 'linear', 'catmullRom', 'bspline', 'natural']) {
            const cache = new ContourRegionCache(buildContourStrings);
            for (const x of [0, 38 * 16384, 50000]) {
                const region = cache.get({ width: 200, height: 100, offsetX: x, offsetY: 300 }, { ...args, settings: { ...args.settings, curve } });
                assert.ok(region.paths.some((d) => d.length));
                assert.ok(region.paths.every((d) => !/NaN|Infinity/.test(d)));
            }
        }
    });
    await test('paint requests coalesce and use the latest state without creating a continuous timer', () => {
        const frames = []; let state = 0; const painted = [];
        global.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
        const paint = framePainter(() => painted.push(state));
        paint(); state = 1; paint(); state = 2; paint();
        assert.equal(frames.length, 1);
        frames.shift()(); assert.deepEqual(painted, [2]); assert.equal(frames.length, 0);
    });
    await test('Canvas viewport/DPR/masking and highlight updates share one paint without reading the composition size', async () => {
        const frames = []; const calls = [];
        global.window = { devicePixelRatio: 2 };
        global.document = { getElementById() { throw new Error('Composition size must never be read'); } };
        global.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
        global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} };
        const context = new Proxy({}, { get: (object, key) => object[key] ?? ((...values) => calls.push([key, ...values])) });
        const canvas = { getContext: () => context };
        const { createCanvasContour } = await load('canvas_overlay.js');
        const renderer = createCanvasContour(canvas);
        renderer.build('pianoSpacer', args);
        renderer.setView({ width: 900, height: 600, offsetX: 620000, offsetY: 400,
            clip: { x: 100, y: 32, width: 800, height: 568 } });
        renderer.setRects([{ x: 620100, y: 450, width: 30, height: 22 }]);
        assert.equal(frames.length, 1); frames.shift()();
        assert.equal(canvas.width, 1800); assert.equal(canvas.height, 1200);
        assert.ok(calls.some((call) => call[0] === 'rect' && call[1] === 100 && call[2] === 32));
        renderer.setRects([{ x: 620100, y: 450, width: 30, height: 22 }]);
        assert.equal(frames.length, 0);
    });
    await test('SVG uses a viewport viewBox and translated cached paths plus local note masks, including reverse scrolling', async () => {
        const frames = [];
        global.SVGSVGElement = Svg;
        global.document = { createElementNS: (ns, tag) => new Svg(tag) };
        global.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
        const { createSvgContour } = await load('svg_overlay.js');
        const svg = new Svg(); const renderer = createSvgContour(svg);
        renderer.build('pianoSpacer', args);
        renderer.setView({ width: 900, height: 600, offsetX: 380000, offsetY: 500 });
        renderer.setRects([{ x: 380100, y: 532, width: 40, height: 22 }]); frames.shift()();
        assert.equal(svg.attributes.viewBox, '0 0 900 600');
        assert.equal(svg.parts['.base'].children.length, args.levels);
        const paths = [...svg.parts['.base'].children];
        renderer.setView({ width: 900, height: 600, offsetX: 379990, offsetY: 490 }); frames.shift()();
        assert.equal(svg.parts['.base'].children[0], paths[0]);
        assert.match(paths[0].attributes.transform, /translate/);
    });
    await test('interval rendering matches brute-force intersection for long tails, overlaps, pitches and arbitrary PPQ', () => {
        const h = createEditorHarness(); const Index = vm.runInContext('NoteRenderIndex', h.scope);
        for (const ppq of [7, 101, 480]) {
            const sequence = new h.NoteSequence(16384, ppq);
            for (let i = 0; i < 1000; i++) sequence.addNote({ midi: i % 128, ticks: i * 2, durationTicks: i % 3 ? 5 : 3000 });
            const index = new Index(sequence);
            for (const start of [0, 500, 1500, 3000]) {
                const expected = sequence.notes.filter((note) => note.midi >= 40 && note.midi <= 80 && note.ticks <= start + 50 && note.ticks + note.durationTicks >= start);
                assert.deepEqual(Array.from(index.query(start, start + 50, 40, 80), (note) => note.id), Array.from(expected, (note) => note.id));
            }
        }
    });
    await test('render caches refresh after in-place edits, deletion, Undo/Redo and external refresh', () => {
        const h = createEditorHarness(); h.engine.setPatternLength(1024);
        const note = h.engine.sequence.addNote({ midi: 60, ticks: 10000, durationTicks: 120 });
        h.paint(); note.ticks = 0;
        h.readyEvents[0].detail.editor.refresh();
        const key = (value, extra = {}) => h.documentListeners.keydown({ key: value, preventDefault() {}, ...extra });
        key('a', { ctrlKey: true }); key('Delete'); assert.equal(h.engine.sequence.notes.length, 0);
        key('z', { ctrlKey: true }); assert.equal(h.engine.sequence.notes[0].ticks, 0);
        key('z', { ctrlKey: true, shiftKey: true }); assert.equal(h.engine.sequence.notes.length, 0);
    });
    await test('playhead-only frames do not emit unchanged note highlights and scroll bursts use one viewport draw', async () => {
        const h = createEditorHarness(); let events = 0;
        h.documentListeners['jukebox:notes'] = () => { events++; };
        h.engine.sequence.addNote({ midi: 60, ticks: 0, durationTicks: 120 });
        h.readyEvents[0].detail.editor.refresh();
        await h.elements.playButton.onclick();
        const initial = events;
        for (let i = 0; i < 5; i++) { h.engine.audioContext.currentTime += 0.01; h.animate(); }
        assert.equal(events, initial);
        h.engine.stop();
        h.canvasCalls.length = 0;
        for (let i = 0; i < 10; i++) h.elements.pianoViewport.listeners.scroll();
        assert.equal(h.canvasCalls.length, 0);
        h.animate(); assert.ok(h.canvasCalls.length > 0);
    });
    await test('large MIDI worker uses the unchanged parser and restores exact canonical data before any engine mutation', async () => {
        const fs = require('node:fs');
        const h = createEditorHarness();
        const sequence = new h.NoteSequence(32768);
        for (let i = 0; i < 17000; i++) sequence.addNote({ midi: i % 48 + 40, ticks: i * 120, durationTicks: 60 });
        const bytes = h.MidiIO.encode(sequence).bytes;
        assert.ok(bytes.length >= 128 * 1024);
        const workers = [];
        h.scope.Worker = class {
            constructor(url) {
                assert.equal(url, '/js/midi-import-worker.js');
                workers.push(this);
                this.context = vm.createContext({});
                this.context.self = this.context;
                this.context.importScripts = (...urls) => urls.forEach((file) =>
                    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), this.context));
                this.context.postMessage = (data) => this.onmessage({ data: structuredClone(data) });
                vm.runInContext(fs.readFileSync(path.join(root, 'js/midi-import-worker.js'), 'utf8'), this.context);
            }
            postMessage(buffer) { this.context.onmessage({ data: buffer }); }
            terminate() { this.terminated = true; }
        };
        const before = JSON.stringify(h.engine.sequence.toJSON());
        const result = await h.MidiIO.parseAsync(bytes);
        assert.equal(workers.length, 1); assert.equal(workers[0].terminated, true);
        assert.equal(result.sequence.notes.length, 17000);
        assert.equal(result.sequence.notes[16999].ticks, 16999 * 120);
        assert.equal(result.sequence.notes[16999].durationTicks, 60);
        assert.equal(result.sequence.ppq, 480);
        assert.equal(JSON.stringify(h.engine.sequence.toJSON()), before);
    });
    await test('obsolete MIDI workers terminate on abort and small/unsupported-worker imports retain sync validation', async () => {
        const h = createEditorHarness(); let terminated = false;
        h.scope.Worker = class { postMessage() {} terminate() { terminated = true; } };
        const controller = new AbortController();
        const pending = h.MidiIO.parseAsync(new Uint8Array(140000), { signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, { name: 'AbortError' });
        assert.equal(terminated, true);
        h.scope.Worker = class { constructor() { throw new Error('Workers blocked'); } };
        await assert.rejects(h.MidiIO.parseAsync(new Uint8Array(140000)), /MIDI|header|SMF/i);
        const bytes = h.MidiIO.encode(h.engine.sequence).bytes;
        const parsed = await h.MidiIO.parseAsync(bytes);
        assert.equal(parsed.sequence.notes.length, 0);
    });
    console.log(`${passed} render-performance tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
