// Node geometry/CPU benchmark, not browser frame timing. Run with node --expose-gc.
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../../main/resources/static');
global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} closePath() {} };
(async () => {
    const { setup, generatePerlin } = await import(pathToFileURL(path.join(root, 'contour/perlin_gen.js')));
    const { buildContourPaths, buildContourStrings } = await import(pathToFileURL(path.join(root, 'contour/contour.js')));
    const args = { res: 10, scale: 0.21, dampening: 0.35, levels: 10,
        settings: { curve: 'catmullRom', tension: 1, height: 1.5, points: 'interpolate' } };
    for (const steps of [16, 1024, 16384]) {
        const width = 100 + steps * 38, height = 1184;
        const cells = (Math.ceil(width / args.res) + 1) * (Math.ceil(height / args.res) + 1);
        if (steps === 16384) { console.log(JSON.stringify({ before: 'whole song', steps, cells, skipped: 'avoid excessive allocation; cell count only' })); continue; }
        global.document = { getElementById: () => ({ clientWidth: width, clientHeight: height }) };
        global.gc?.();
        const start = performance.now();
        const field = generatePerlin(setup(args.res, 'mesh'), args.scale, args.dampening, 0, 1.5);
        buildContourPaths(field, args.levels, args.settings);
        console.log(JSON.stringify({ before: 'whole song', steps, cells, milliseconds: +(performance.now() - start).toFixed(2) }));
    }
    const { ContourRegionCache } = await import(pathToFileURL(path.join(root, 'contour/region_cache.js')));
    for (const [mode, build] of [['canvas', buildContourPaths], ['svg', buildContourStrings]]) {
        const cache = new ContourRegionCache(build);
        const view = { width: 900, height: 600, offsetX: 38 * 8192, offsetY: 400 };
        const start = performance.now();
        const region = cache.get(view, args);
        const coldMs = performance.now() - start;
        const hitStart = performance.now();
        for (let i = 0; i < 100; i++) cache.get({ ...view, offsetX: view.offsetX + i }, args);
        console.log(JSON.stringify({ after: 'bounded ' + mode, cells: (region.width / 10 + 1) * (region.height / 10 + 1),
            coldMs: +coldMs.toFixed(2), hitMs: +((performance.now() - hitStart) / 100).toFixed(4), builds: cache.buildCount }));
    }
    const scope = vm.createContext({});
    for (const name of ['NoteSequence', 'PianoRollEditor', 'TrackOverview']) vm.runInContext(fs.readFileSync(path.join(root, 'js', name + '.js'), 'utf8'), scope);
    for (const count of [100, 1000, 10000, 50000]) {
        const result = vm.runInContext(`(() => {
            const s = new NoteSequence(16384);
            for (let i = 0; i < ${count}; i++) s.addNote({ midi: 40 + i % 48, ticks: i % 16384 * 120, durationTicks: 240 });
            return s;
        })()`, scope);
        const Piano = vm.runInContext('PianoRollEditor', scope), Overview = vm.runInContext('TrackOverview', scope);
        const t = performance.now();
        for (let i = 0; i < 100; i++) { Piano.eligibleNotes(result); Overview.lanes(result); }
        console.log(JSON.stringify({ before: 'filter + lanes', notes: count, perRedrawMs: +((performance.now() - t) / 100).toFixed(3) }));
        const Index = vm.runInContext('NoteRenderIndex', scope);
        const indexStart = performance.now();
        const index = new Index(result);
        const indexMs = performance.now() - indexStart;
        const queryStart = performance.now();
        for (let i = 0; i < 100; i++) index.query(8192 * 120 + i, 8213 * 120 + i, 48, 72);
        console.log(JSON.stringify({ after: 'indexed viewport + reused lanes', notes: count,
            indexMs: +indexMs.toFixed(2), perRedrawMs: +((performance.now() - queryStart) / 100).toFixed(3) }));
    }
    const { createEditorHarness } = require('../frontend/editor-test-support');
    for (const [notes, steps] of [[100, 16], [1000, 1024], [10000, 16384], [50000, 16384]]) {
        global.gc?.();
        const h = createEditorHarness();
        const sequence = new h.NoteSequence(steps);
        for (let i = 0; i < notes; i++) sequence.addNote({ midi: 40 + i % 48, ticks: i % steps * 120, durationTicks: 120 });
        const bytes = h.MidiIO.encode(sequence).bytes;
        const importStart = performance.now();
        const parsed = h.MidiIO.parse(bytes).sequence;
        const parseMs = performance.now() - importStart;
        h.engine.replaceSequence(parsed);
        h.readyEvents[0].detail.editor.refresh();
        const firstRenderMs = performance.now() - importStart;
        let start = performance.now();
        for (let i = 0; i < 30; i++) h.paint();
        const pianoMs = (performance.now() - start) / 30;
        h.elements.tracksView.onclick();
        start = performance.now();
        for (let i = 0; i < 30; i++) h.paint();
        console.log(JSON.stringify({ afterOnly: 'binary MIDI parse + first fake-DOM render', notes, steps,
            parseMs: +parseMs.toFixed(2), firstRenderMs: +firstRenderMs.toFixed(2), pianoMs: +pianoMs.toFixed(3), overviewMs: +((performance.now() - start) / 30).toFixed(3) }));
    }
})();
