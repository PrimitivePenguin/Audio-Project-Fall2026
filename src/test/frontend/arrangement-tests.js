const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createEditorHarness } = require('./editor-test-support');

function audio(duration = 1) {
    return { duration, sampleRate: 48000, length: duration * 48000, numberOfChannels: 1 };
}

function file(name, value) {
    return { name, size: 1, arrayBuffer: async () => Uint8Array.of(value).buffer };
}

function note(h) {
    return h.engine.sequence.addNote({ midi: 64, ticks: 173, durationTicks: 153 });
}

function model(h, duration = 1) {
    const arrangement = h.engine.arrangement;
    const asset = { id: 'a'.repeat(64), name: 'clip.wav', duration, buffer: audio(duration) };
    arrangement.assets.set(asset.id, asset);
    return { arrangement, asset, lane: arrangement.addTrack('Audio') };
}

function snap(h, value) {
    h.elements.noteSnap.value = value;
    h.elements.noteSnap.onchange({ target: h.elements.noteSnap });
}

function drag(h, x, y, dx, dy) {
    const canvas = h.elements.pianoCanvas;
    canvas.onpointerdown(h.pointer(x, y));
    canvas.onpointermove(h.pointer(x + dx, y + dy));
    canvas.onpointerup(h.pointer(x + dx, y + dy));
}

function history(h, redo = false) {
    h.documentListeners.keydown({ key: 'z', ctrlKey: true, shiftKey: redo, preventDefault() {} });
}

function closeTo(value, expected) {
    assert.ok(Math.abs(value - expected) < 1e-8, `${value} should be near ${expected}`);
}

const tests = [
    ['rack import deduplicates decoding and a Free rack drop at step 9 floors to the preceding sixteenth', async () => {
        const h = createEditorHarness();
        const midi = note(h);
        const before = JSON.stringify(midi);
        h.engine.initContext();
        let decodes = 0;
        h.engine.audioContext.decodeAudioData = async () => { decodes++; return audio(); };
        await h.elements.rackFiles.onchange({ target: { files: [
            file('beat.wav', 1), file('bass.mp3', 2), file('same beat.wav', 1)
        ] } });
        assert.equal(decodes, 2);
        assert.equal(h.engine.arrangement.assets.size, 2);
        assert.equal(JSON.stringify(midi), before);
        h.elements.tracksView.onclick();
        h.elements.addAudioTrack.onclick();
        const row = h.elements.rackAssets.children[0];
        const label = row.children[0];
        const transfer = { setData() {}, dropEffect: '' };
        label.listeners.dragstart({ dataTransfer: transfer });
        const canvas = h.elements.pianoCanvas;
        let prevented = false;
        canvas.listeners.dragover({ ...h.pointer(100 + 8.6 * 38, 15),
            dataTransfer: transfer, preventDefault: () => { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(transfer.dropEffect, 'none');
        const drop = { ...h.pointer(100 + 8.6 * 38, 145), dataTransfer: transfer };
        snap(h, 'free');
        canvas.listeners.dragover(drop);
        h.animate();
        assert.equal(transfer.dropEffect, 'copy');
        assert.ok(h.canvasCalls.some(({ method, args }) => method === 'fillText' && args[0] === 'beat.wav'));
        canvas.listeners.drop(drop);
        const clip = [...h.engine.arrangement.clips.values()][0];
        assert.equal(clip.startTick, 960);
        assert.equal(clip.playDurationSeconds, 1);
        h.elements.duplicateAudioClip.onclick();
        assert.equal(decodes, 2);
        assert.equal(h.engine.arrangement.clips.size, 2);
        assert.ok([...h.engine.arrangement.clips.values()].every((value) => value.assetId === clip.assetId));
        assert.equal(row.draggable, true);
        assert.deepEqual(row.children, [label]);
        assert.equal(row.style.backgroundColor, h.TrackOverview.color(clip.assetId));
        assert.equal(h.engine.arrangement.assets.size, 2);
    }],
    ['rack selection switches and clears, survives a drop, and routes Delete by context', async () => {
        const h = createEditorHarness();
        h.engine.initContext();
        h.engine.audioContext.decodeAudioData = async () => audio();
        h.SampleAssetStore.prototype.write = async () => {};
        const deleted = [];
        h.SampleAssetStore.prototype.delete = async (id) => deleted.push(id);
        const midi = note(h);
        h.elements.tracksView.onclick();
        h.elements.addAudioTrack.onclick();
        await h.elements.rackFiles.onchange({ target: { files: [file('A.wav', 42), file('B.wav', 43)] } });
        const [first, second] = h.elements.rackAssets.children;
        const [asset, unused] = [...h.engine.arrangement.assets.values()];
        const pressed = (row) => row.children[0].getAttribute('aria-pressed');
        const key = (key, target) => {
            let prevented = false;
            h.documentListeners.keydown({ key, target, preventDefault() { prevented = true; } });
            return prevented;
        };
        first.onclick();
        assert.deepEqual([pressed(first), pressed(second)], ['true', 'false']);
        assert.equal(h.engine.arrangement.clips.size, 0);
        second.onclick();
        assert.deepEqual([pressed(first), pressed(second)], ['false', 'true']);
        h.elements.sampleRack.listeners.click({ target: h.elements.rackAssets });
        assert.deepEqual([pressed(first), pressed(second)], ['false', 'false']);

        const dataTransfer = { setData() {} };
        first.children[0].listeners.dragstart({ dataTransfer });
        h.elements.pianoCanvas.listeners.drop({ ...h.pointer(160, 145), dataTransfer });
        assert.equal(pressed(first), 'true');
        assert.equal(h.engine.arrangement.clips.size, 1);
        second.onclick();
        assert.equal(key('Backspace', { tagName: 'INPUT' }), false);
        assert.equal(key('Delete', second.children[0]), true);
        await new Promise(setImmediate);
        assert.deepEqual(deleted, [unused.id]);
        assert.equal(h.confirmCount, 0);
        assert.equal(h.engine.arrangement.clips.size, 1);
        assert.equal(h.elements.rackAssets.children[0].children[0].getAttribute('aria-pressed'), 'false');

        h.clickAt(155, 145);
        assert.equal(key('Delete'), true);
        assert.equal(h.engine.arrangement.clips.size, 0);
        assert.ok(h.engine.arrangement.assets.has(asset.id));
        h.elements.rackAssets.children[0].onclick();
        h.elements.pianoRollView.onclick();
        h.clickNote(midi);
        assert.equal(key('Backspace'), true);
        assert.equal(h.engine.sequence.notes.length, 0);
        assert.deepEqual(deleted, [unused.id]);
    }],
    ['referenced rack deletion confirms, rolls back on storage failure, and removes every reference on success', async () => {
        const h = createEditorHarness();
        h.engine.initContext();
        h.engine.audioContext.decodeAudioData = async () => audio();
        h.SampleAssetStore.prototype.write = async () => {};
        let fail = true;
        let attempts = 0;
        h.SampleAssetStore.prototype.delete = async () => {
            attempts++;
            if (fail) throw new Error('IndexedDB refused the transaction');
        };
        h.elements.tracksView.onclick();
        h.elements.addAudioTrack.onclick();
        await h.elements.rackFiles.onchange({ target: { files: [file('Referenced.wav', 12)] } });
        const model = h.engine.arrangement;
        const [id] = model.assets.keys();
        const [lane] = model.tracks.keys();
        const card = h.elements.rackAssets.children[0];
        const dataTransfer = { setData() {} };
        card.children[0].listeners.dragstart({ dataTransfer });
        h.elements.pianoCanvas.listeners.drop({ ...h.pointer(160, 145), dataTransfer });
        model.createClip(id, lane, 240);
        card.onclick();
        const originalConfirm = h.scope.window.confirm;
        let confirmation;
        h.scope.window.confirm = (message) => {
            confirmation = message;
            return originalConfirm(message);
        };
        const key = () => h.documentListeners.keydown({ key: 'Backspace', preventDefault() {} });
        h.setConfirmation(false);
        key();
        assert.equal(h.confirmCount, 1);
        assert.match(confirmation, /2 referencing clips/);
        assert.equal(attempts, 0);
        assert.equal(model.clips.size, 2);

        h.setConfirmation(true);
        key();
        await new Promise(setImmediate);
        assert.equal(attempts, 1);
        assert.equal(model.assets.has(id), true);
        assert.equal(model.clips.size, 2);
        assert.match(h.elements.rackStatus.textContent, /IndexedDB refused/);

        fail = false;
        key();
        await new Promise(setImmediate);
        assert.equal(h.confirmCount, 3);
        assert.equal(model.assets.size, 0);
        assert.equal(model.clips.size, 0);
        const json = model.toJSON();
        assert.equal(json.assets.length + json.clips.length, 0);
        history(h);
        history(h, true);
        assert.equal(model.clips.size, 0);
    }],
    ['IndexedDB deletion resolves only after commit and rejects when aborted', async () => {
        const h = createEditorHarness();
        const store = new h.SampleAssetStore();
        let transaction, key;
        store.databaseHandle = async () => ({
            transaction(name, mode) {
                assert.deepEqual([name, mode], ['audio', 'readwrite']);
                return transaction = { objectStore: () => ({ delete(id) { key = id; } }) };
            }
        });
        let completed = false;
        const pending = store.delete('asset-key').then(() => { completed = true; });
        await new Promise(setImmediate);
        assert.equal(key, 'asset-key');
        assert.equal(completed, false);
        transaction.oncomplete();
        await pending;
        const refused = store.delete('asset-key');
        await new Promise(setImmediate);
        transaction.error = new Error('abort');
        transaction.onabort();
        await assert.rejects(refused, /abort/);
    }],
    ['rack is docked and MIDI and blank drops add audio lanes without consuming assets', async () => {
        const html = fs.readFileSync(path.join(__dirname, '../../main/resources/static/index.html'), 'utf8');
        assert.match(html, /<details id="sampleRack" class="sample-dock" open hidden>/);
        assert.ok(html.indexOf('id="sampleRack"') > html.indexOf('id="pianoViewport"'));
        const h = createEditorHarness();
        note(h);
        h.engine.initContext();
        h.engine.audioContext.decodeAudioData = async () => audio();
        h.elements.tracksView.onclick();
        await h.elements.rackFiles.onchange({ target: { files: [file('A.wav', 20), file('B.wav', 21)] } });
        assert.equal(h.elements.rackAssets.children.length, 2);
        const canvas = h.elements.pianoCanvas;
        for (const [i, y] of [65, 400].entries()) {
            const dataTransfer = { setData() {} };
            h.elements.rackAssets.children[i].children[0].listeners.dragstart({ dataTransfer });
            canvas.listeners.dragover({ ...h.pointer(200, y), dataTransfer });
            assert.equal(dataTransfer.dropEffect, 'copy');
            assert.match(h.elements.rackStatus.textContent, /create an audio lane/);
            canvas.listeners.drop({ ...h.pointer(200, y), dataTransfer });
        }
        const a = h.engine.arrangement;
        assert.equal(h.elements.rackAssets.children.length, 2);
        assert.equal(a.clips.size, 2);
        assert.equal(a.tracks.size, 2);
        assert.equal(h.engine.sequence.notes.length, 1);
        assert.equal(a.orderedTracks(h.engine.sequence.tracks)[0].id, 'piano');
    }],
    ['waveform extraction preserves stereo transients and visualization is local-only', async () => {
        const h = createEditorHarness();
        const { arrangement, asset, lane } = model(h);
        const clip = arrangement.createClip(asset.id, lane.id, 120);
        const first = new Float32Array(4096), second = new Float32Array(4096);
        first[900] = 0.75;
        second[1401] = -0.875;
        asset.waveform = await new h.SampleAssetStore().makeWaveform({
            length: first.length, numberOfChannels: 2,
            getChannelData: (i) => i ? second : first
        });
        assert.equal(asset.waveform.high[450], 0.75);
        assert.equal(asset.waveform.low[700], -0.875);
        asset.spectrogram = { width: 32, height: 24 };
        h.elements.tracksView.onclick();
        h.paint();
        assert.equal(h.elements.clipVisualization.value, 'waveform');
        const color = h.TrackOverview.color(asset.id);
        const ink = h.ArrangementEditor.assetInk(color);
        const hasClipBackground = () => h.canvasCalls.some(({ method, fillStyle, args }) =>
            method === 'fillRect' && fillStyle === color && args[3] === h.TrackOverview.laneHeight - 14);
        assert.ok(hasClipBackground());
        assert.ok(h.canvasCalls.some(({ method, strokeStyle }) => method === 'stroke' && strokeStyle === ink));
        assert.ok(h.canvasCalls.some(({ method, fillStyle, args }) =>
            method === 'fillText' && fillStyle === ink && args[0] === asset.name));
        assert.ok(!h.canvasCalls.some(({ method }) => method === 'drawImage'));
        const snapshot = JSON.stringify(arrangement.toJSON());
        h.elements.clipVisualization.value = 'spectrogram';
        h.elements.clipVisualization.onchange();
        h.paint();
        assert.ok(h.canvasCalls.some(({ method }) => method === 'drawImage'));
        assert.ok(hasClipBackground());
        assert.equal(JSON.stringify(arrangement.toJSON()), snapshot);
        assert.equal(arrangement.clips.get(clip.id), clip);
        const restored = createEditorHarness(1, { storage: { 'jukebox-clip-view': 'spectrogram' } });
        assert.equal(restored.elements.clipVisualization.value, 'spectrogram');
    }],
    ['audio multi-selection and keyboard editing preserve group timing, tracks, and assets', () => {
        const h = createEditorHarness();
        const { arrangement, asset, lane } = model(h, 0.25);
        const other = arrangement.addTrack('Other');
        const a = arrangement.createClip(asset.id, lane.id, 120);
        const b = arrangement.createClip(asset.id, other.id, 360);
        h.elements.tracksView.onclick();
        h.clickAt(155, 145);
        const canvas = h.elements.pianoCanvas;
        const shift = h.pointer(230, 229, { shiftKey: true });
        canvas.onpointerdown(shift);
        canvas.onpointerup(shift);
        canvas.onclick(shift);
        assert.match(h.elements.audioClipInfo.textContent, /2 clips/);
        const key = (key, ctrlKey = true, target) => h.documentListeners.keydown({
            key, ctrlKey, target, preventDefault() {}
        });
        key('c');
        h.clickAt(100 + 8 * 38, 15);
        key('v');
        const copies = [...arrangement.clips.values()].filter(({ id }) => id !== a.id && id !== b.id);
        assert.deepEqual(copies.map(({ startTick, trackId, assetId }) => [startTick, trackId, assetId]),
            [[960, lane.id, asset.id], [1200, other.id, asset.id]]);
        key('x');
        assert.equal(arrangement.clips.size, 2);
        history(h);
        assert.equal(arrangement.clips.size, 4);
        history(h, true);
        assert.equal(arrangement.clips.size, 2);
        key('v');
        key('d');
        assert.equal(arrangement.clips.size, 6);
        key('Delete', false, { tagName: 'INPUT' });
        assert.equal(arrangement.clips.size, 6);
        key('Delete', false);
        assert.equal(arrangement.clips.size, 4);
        history(h);
        assert.equal(arrangement.clips.size, 6);
        h.clickAt(550, 408);
        assert.equal(h.elements.audioClipInfo.textContent, '');
    }],
    ['razor requires a downward stroke and splits the exact source range across a tempo change', () => {
        const h = createEditorHarness();
        const { arrangement, asset, lane } = model(h, 2);
        const sequence = h.engine.sequence;
        sequence.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 480, bpm: 60 }];
        h.engine.setPatternLength(32);
        const original = arrangement.createClip(asset.id, lane.id, 120);
        arrangement.setClip({ ...original, sourceOffsetSeconds: 0.25, playDurationSeconds: 1.5 });
        h.elements.tracksView.onclick();
        h.elements.clipRazor.onclick();
        const x = 100 + 660 / 120 * 38;
        h.clickAt(x, 145);
        assert.equal(arrangement.clips.size, 1);
        snap(h, 'thirty-second');
        drag(h, x - 4, 145, 4, 20);
        const [left, right] = [...arrangement.clips.values()];
        assert.equal(right.startTick, 660);
        assert.equal(left.id, original.id);
        assert.notEqual(right.id, original.id);
        closeTo(left.sourceOffsetSeconds, 0.25);
        closeTo(left.playDurationSeconds, 0.75);
        closeTo(left.sourceOffsetSeconds + left.playDurationSeconds, right.sourceOffsetSeconds);
        closeTo(right.sourceOffsetSeconds + right.playDurationSeconds, 1.75);
        closeTo(h.AudioArrangement.bounds(left, sequence).endTick, right.startTick);
        const restored = new h.AudioArrangement(JSON.parse(JSON.stringify(arrangement.toJSON())));
        assert.equal(restored.clips.get(right.id).sourceOffsetSeconds, right.sourceOffsetSeconds);
        history(h);
        assert.equal(arrangement.clips.size, 1);
        history(h, true);
        assert.equal(arrangement.clips.size, 2);
        h.elements.clipRazor.onclick();
        snap(h, 'free');
        drag(h, x + 20, 145, 17 * 38 / 120, 0);
        assert.equal(arrangement.clips.get(right.id).startTick, 677);
        const movedX = x + 17 * 38 / 120;
        drag(h, movedX + 1, 145, 20 * 38 / 120, 0);
        assert.equal(arrangement.clips.get(right.id).startTick, 697);
        h.elements.duplicateAudioClip.onclick();
        assert.equal(arrangement.clips.size, 3);
        assert.equal(arrangement.clips.get(left.id).playDurationSeconds, left.playDurationSeconds);
    }],
    ['Free razor uses the nearest tick and schedules both split sources contiguously', async () => {
        const h = createEditorHarness();
        const { arrangement, asset, lane } = model(h, 0.5);
        const clip = arrangement.createClip(asset.id, lane.id, 0);
        h.elements.tracksView.onclick();
        h.elements.clipRazor.onclick();
        snap(h, 'free');
        const cut = 37;
        const x = 100 + cut * 38 / 120;
        const canvas = h.elements.pianoCanvas;
        canvas.onpointerdown(h.pointer(x, 145));
        canvas.onpointermove(h.pointer(x, 160));
        canvas.onpointercancel(h.pointer(x, 160));
        assert.equal(arrangement.clips.size, 1);
        drag(h, x, 145, 0, 15);
        const [left, right] = [...arrangement.clips.values()];
        assert.equal(left.id, clip.id);
        assert.equal(right.startTick, cut);
        await h.engine.play(0);
        const sources = h.engine.audioContext.sources.filter((source) => source.buffer === asset.buffer);
        assert.equal(sources.length, 2);
        closeTo(sources[0].startTime + sources[0].duration, sources[1].startTime);
        closeTo(sources[0].offset + sources[0].duration, sources[1].offset);
        closeTo(sources[0].duration + sources[1].duration, clip.playDurationSeconds);
        h.engine.stop();
    }],
    ['clip move, cross-lane assignment, trim, deletion and history preserve stable identities', () => {
        const h = createEditorHarness();
        const { arrangement, asset, lane } = model(h);
        const second = arrangement.addTrack('Second');
        const clip = arrangement.createClip(asset.id, lane.id, 137);
        h.elements.tracksView.onclick();
        const x = () => 100 + arrangement.clips.get(clip.id).startTick * 38 / 120;
        drag(h, x() + 20, 145, 38, 0);
        assert.equal(arrangement.clips.get(clip.id).startTick, 257);
        snap(h, 'thirty-second');
        drag(h, x() + 20, 145, 19, 84);
        assert.equal(arrangement.clips.get(clip.id).startTick, 317);
        assert.equal(arrangement.clips.get(clip.id).trackId, second.id);
        snap(h, 'free');
        drag(h, x() + 20, 229, 37 * 38 / 120, 0);
        assert.equal(arrangement.clips.get(clip.id).startTick, 354);
        drag(h, x() + 1, 229, 120 * 38 / 120, 0);
        const trimmed = arrangement.clips.get(clip.id);
        assert.equal(trimmed.startTick, 474);
        closeTo(trimmed.sourceOffsetSeconds, 0.125);
        closeTo(trimmed.playDurationSeconds, 0.875);
        assert.equal(asset.buffer.duration, 1);
        h.elements.deleteAudioClip.onclick();
        assert.equal(arrangement.clips.size, 0);
        history(h);
        assert.equal(arrangement.clips.get(clip.id).startTick, 474);
        history(h);
        assert.equal(arrangement.clips.get(clip.id).startTick, 354);
        history(h);
        history(h);
        assert.equal(arrangement.clips.get(clip.id).trackId, lane.id);
        history(h, true);
        assert.equal(arrangement.clips.get(clip.id).trackId, second.id);
    }],
    ['mixed lane reorder keeps MIDI channel, program and note routing intact', () => {
        const h = createEditorHarness();
        const { arrangement, lane } = model(h);
        const bass = h.engine.sequence.addMusicalTrack({ name: 'Bass', channel: 4, program: 35 });
        h.engine.sequence.addNote({ midi: 43, trackId: bass.id, startStep: 1 });
        h.elements.tracksView.onclick();
        drag(h, 12, 242, 0, -200);
        assert.deepEqual(Array.from(arrangement.orderedTracks(h.engine.sequence.tracks), ({ id }) => id), [lane.id, 'piano', bass.id]);
        drag(h, 12, 239, 0, -120);
        assert.equal(h.engine.sequence.tracks[0].id, bass.id);
        assert.deepEqual([bass.channel, bass.program, h.engine.sequence.notes[0].trackId], [4, 35, bass.id]);
        history(h);
        assert.equal(h.engine.sequence.tracks[1].id, bass.id);
    }],
    ['precise onset, inside-clip playback, pause and resume share the engine clock', async () => {
        const h = createEditorHarness();
        const { arrangement, asset, lane } = model(h, 2);
        const clip = arrangement.createClip(asset.id, lane.id, 37);
        arrangement.setClip({ ...clip, sourceOffsetSeconds: 0.25, playDurationSeconds: 1 });
        await h.engine.play(0);
        const ctx = h.engine.audioContext;
        assert.equal(h.intervals.size, 1);
        let source = ctx.sources.find((item) => item.buffer === asset.buffer);
        closeTo(source.startTime, h.engine.playbackAnchorTime + 37 / 960);
        closeTo(source.offset, 0.25);
        closeTo(source.duration, 1);
        ctx.currentTime = h.engine.playbackAnchorTime + 0.5;
        h.engine.pause();
        assert.equal(source.stopTime, 0);
        assert.equal(h.engine.clipSources.size, 0);
        await h.engine.play();
        source = ctx.sources.at(-1);
        closeTo(source.offset, 0.25 + 0.5 - 37 / 960);
        closeTo(source.startTime, h.engine.playbackAnchorTime);
        h.engine.stop();
        await h.engine.play(240);
        closeTo(ctx.sources.at(-1).offset, 0.25 + (240 - 37) / 960);
        h.engine.stop();
        assert.equal(h.intervals.size, 0);
    }],
    ['overlapping clips are cut at wraps and chased once per pass at the loop start', async () => {
        const h = createEditorHarness();
        const { arrangement, asset, lane } = model(h, 2);
        arrangement.createClip(asset.id, lane.id, 0);
        arrangement.createClip(asset.id, lane.id, 150);
        h.engine.setLoopRange(1, 3);
        await h.engine.play();
        const ctx = h.engine.audioContext;
        const anchor = h.engine.playbackAnchorTime;
        for (const seconds of [0.05, 0.15, 0.23, 0.31]) {
            ctx.currentTime = anchor + seconds;
            h.engine.scheduler();
        }
        const starts = ctx.sources.filter((item) => item.buffer === asset.buffer);
        assert.equal(starts.length, 4);
        closeTo(starts[0].offset, 0.125);
        closeTo(starts[0].duration, 0.25);
        closeTo(starts[1].startTime, anchor + (150 - 120) / 960);
        closeTo(starts[1].duration, (360 - 150) / 960);
        closeTo(starts[2].startTime, anchor + 0.25);
        closeTo(starts[2].offset, 0.125);
        h.engine.stop();
        assert.ok(starts.every((source) => source.stopTime === 0));
        assert.equal(h.engine.clipSources.size, 0);
    }],
    ['MIDI import rescales exact clip start ticks and MIDI export carries no audio assets', () => {
        const h = createEditorHarness();
        const { arrangement, asset, lane } = model(h);
        const clip = arrangement.createClip(asset.id, lane.id, 137);
        const imported = new h.NoteSequence(32, 100);
        imported.addNote({ midi: 64, ticks: 40, durationTicks: 15 });
        h.engine.importMidiSequence(imported);
        assert.equal(h.engine.sequence.ppq, 2400);
        assert.equal(arrangement.clips.get(clip.id).startTick, 685);
        const decoded = h.MidiIO.parse(h.MidiIO.encode(h.engine.sequence).bytes).sequence;
        assert.equal(decoded.notes.length, 1);
        assert.equal(decoded.notes[0].midi, 64);
        assert.equal(decoded.tracks.length, 1);
        h.engine.removeImportedMidi();
        assert.equal(arrangement.clips.get(clip.id).startTick, 685);
    }],
    ['database save/load carries only metadata and restores cached or explicitly relinked audio', async () => {
        const bytes = Uint8Array.of(17);
        const id = await createEditorHarness().SampleAssetStore.identify(bytes);
        const trackId = 'audio-test';
        const saved = {
            stepCount: 32, ppq: 480, loopStart: 1, loopEnd: 28,
            arrangement: {
                version: 1, laneOrder: [trackId, 'piano'],
                tracks: [{ id: trackId, name: 'Dialogue' }],
                assets: [{ id, name: 'voice.wav', duration: 1 }],
                clips: [{ id: 'clip-1', trackId, assetId: id, startTick: 137,
                    sourceOffsetSeconds: 0.2, playDurationSeconds: 0.7 }]
            }
        };
        async function project(data, role, cached) {
            const calls = [];
            const h = createEditorHarness(1, {
                pathname: '/project/11111111-1111-1111-1111-111111111111',
                registrationScript: `
                    SampleAssetStore.prototype.read = async () => ${cached ? 'Uint8Array.of(17).buffer' : 'null'};
                    SampleAssetStore.prototype.write = async () => {};
                    window.AudioContext.prototype.decodeAudioData = async () =>
                        ({ duration: 1, sampleRate: 48000, length: 48000, numberOfChannels: 1 });
                `,
                fetch: async (url, request = {}) => {
                    calls.push(request);
                    return { ok: true, json: async () => ({
                        id: '11111111-1111-1111-1111-111111111111', name: 'Test project', role, version: 2,
                        projectData: JSON.stringify(data)
                    }) };
                }
            });
            await h.ready;
            await new Promise(setImmediate);
            return { h, calls };
        }
        const { h, calls } = await project(saved, 'EDITOR', false);
        const asset = h.engine.arrangement.assets.get(id);
        assert.match(h.elements.rackAssets.children[0].children[0].textContent, /Missing audio/);
        assert.equal(asset.buffer, undefined);
        await h.elements.saveProject.onclick();
        const payload = JSON.parse(JSON.parse(calls.at(-1).body).projectData);
        assert.deepEqual(payload.arrangement, saved.arrangement);
        assert.equal(payload.loopStart, saved.loopStart);
        const restored = await project(payload, 'VIEWER', true);
        const viewer = restored.h;
        assert.ok(viewer.engine.arrangement.assets.get(id).buffer);
        assert.match(viewer.elements.rackAssets.children[0].children[0].textContent, /stored in this browser/);
        viewer.elements.tracksView.onclick();
        viewer.elements.addAudioTrack.onclick();
        assert.equal(viewer.engine.arrangement.tracks.size, 1);
        viewer.clickAt(165, 60);
        assert.match(viewer.elements.audioClipInfo.textContent, /voice.wav/);
        assert.equal(viewer.elements.duplicateAudioClip.disabled, true);
        assert.ok(viewer.elements.laneMuteControls.children.every((button) => button.disabled));
        assert.equal(viewer.elements.rackFiles.disabled, true);
        h.elements.relinkAudioFile.click = () => {};
        h.elements.rackAssets.children[0].children.find(({ textContent }) => textContent === 'Relink').onclick();
        await h.elements.relinkAudioFile.onchange({ target: { files: [file('voice.wav', 18)] } });
        assert.match(h.elements.rackStatus.textContent, /exact original/);
        await h.elements.relinkAudioFile.onchange({ target: { files: [file('voice.wav', 17)] } });
        assert.ok(asset.buffer);
        assert.equal(h.engine.arrangement.clips.get('clip-1').startTick, 137);
    }],
    ['long MIDI overview paints visible indexed audio clips without scanning all notes', () => {
        const h = createEditorHarness(2);
        const { arrangement, asset, lane } = model(h);
        h.engine.setPatternLength(16384);
        const sequence = h.engine.sequence;
        for (let step = 0; step < 16384; step++) sequence.addNote({ midi: 67, startStep: step });
        for (let i = 0; i < 3; i++) arrangement.createClip(asset.id, lane.id, (12000 + i * 3) * 120);
        h.elements.tracksView.onclick();
        const viewport = h.elements.pianoViewport;
        viewport.scrollLeft = 12000 * 38;
        h.paint();
        assert.equal(h.canvasCalls.filter(({ method, args }) => method === 'fillText' && args[0] === 'clip.wav').length, 3);
        sequence.notes = new Proxy(sequence.notes, {
            get(target, key, receiver) {
                if (key === 'forEach' && locked) throw new Error('Unexpected render index rebuild');
                return Reflect.get(target, key, receiver);
            }
        });
        let locked = false;
        h.paint();
        locked = true;
        h.elements.zoom.value = '200';
        h.elements.zoom.oninput();
        h.animate();
        assert.equal(h.elements.pianoCanvas.width, viewport.clientWidth * 2);
        assert.equal(h.elements.pianoCanvas.height, viewport.clientHeight * 2);
        assert.ok(h.canvasCalls.filter(({ method }) => method === 'fillRect').length < 200);
    }],
    ['mute buttons route active and future MIDI and audio independently and preserve clip color', async () => {
        const h = createEditorHarness();
        const { arrangement, asset, lane } = model(h, 1);
        h.engine.sequence.addNote({ midi: 60, startStep: 0, durationSteps: 4 });
        arrangement.createClip(asset.id, lane.id, 0);
        h.elements.tracksView.onclick();
        const mute = (label) => h.elements.laneMuteControls.children.find((button) => button.getAttribute('aria-label') === label);
        assert.equal(mute('Mute Piano').getAttribute('aria-pressed'), 'false');
        h.paint();
        const pianoCount = h.canvasCalls.find(({ method, args }) => method === 'fillText' && args[0] === '1 note');
        const audioCount = h.canvasCalls.find(({ method, args }) => method === 'fillText' && args[0] === '1 clip');
        assert.ok(parseFloat(mute('Mute Piano').style.top) >= pianoCount.args[2] + 8);
        assert.ok(parseFloat(mute('Mute Audio').style.top) >= audioCount.args[2] + 8);
        const midiOutputs = [];
        h.engine.voiceFactory = (event, context, output) => {
            midiOutputs.push(output);
            return { stop() {}, finished: new Promise(() => {}) };
        };
        await h.engine.play(0);
        const source = h.engine.audioContext.sources.find((item) => item.buffer === asset.buffer);
        const midi = midiOutputs[0];
        assert.equal(source.destination, h.engine.laneGains.get(lane.id));
        assert.notEqual(midi, source.destination);
        mute('Mute Audio').onclick();
        assert.equal(mute('Mute Audio').getAttribute('aria-pressed'), 'true');
        assert.equal(source.destination.gain.value, 0);
        assert.equal(midi.gain.value, 1);
        assert.equal(source.stopTime, undefined);
        mute('Mute Piano').onclick();
        assert.equal(midi.gain.value, 0);
        mute('Mute Audio').onclick();
        assert.equal(source.destination.gain.value, 1);
        h.engine.pause();
        await h.engine.play();
        assert.equal(h.engine.audioContext.sources.at(-1).destination, source.destination);
        assert.equal(midiOutputs.at(-1).gain.value, 0);
        h.engine.stop();
        h.paint();
        const color = h.TrackOverview.color(asset.id);
        assert.ok(h.canvasCalls.some((call) => call.method === 'fillRect' && call.fillStyle === color));
        assert.equal(h.TrackOverview.color(asset.id), color);
    }],
    ['FFT previews represent actual frequency, time and both stereo channels', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../main/resources/static/js/audio-spectrogram-worker.js'), 'utf8');
        const spectrum = vm.runInNewContext(`${source}\nspectrogram`);
        const fftSize = 1024, width = 3, height = 56, sampleRate = 48000;
        const first = new Float32Array(width * fftSize);
        const second = new Float32Array(width * fftSize);
        for (let i = 0; i < fftSize; i++) {
            first[i] = 0.75 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
            second[fftSize + i] = 0.75 * Math.sin(2 * Math.PI * 4000 * i / sampleRate);
        }
        const result = spectrum({ channels: [first, second], width, height, fftSize, sampleRate });
        const peaks = [0, 1, 2].map((col) => Array.from({ length: height }, (_, row) => ({
            row, brightness: result[(row * width + col) * 4 + 1]
        })).reduce((max, item) => item.brightness > max.brightness ? item : max));
        assert.ok(peaks[0].row > peaks[1].row && peaks[0].brightness > 100 && peaks[1].brightness > 100);
        assert.equal(peaks[2].brightness, 34);
        for (let row = 0; row < height; row++) assert.equal(result[(row * width + 2) * 4 + 3], 0);
        assert.ok(result[(peaks[0].row * width) * 4 + 3] > 100);
    }],
    ['trimmed spectrograms crop source time and warp across tempo boundaries at the active zoom', () => {
        const h = createEditorHarness();
        const { arrangement, asset, lane } = model(h, 4);
        const clip = arrangement.createClip(asset.id, lane.id, 0);
        const trimmed = arrangement.setClip({ ...clip, sourceOffsetSeconds: 1, playDurationSeconds: 1.5 });
        const sequence = h.engine.sequence;
        sequence.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 480, bpm: 60 }];
        asset.spectrogram = { width: 200, height: 32 };
        const draws = [];
        h.PianoRollEditor.geometry.stepWidth = 76;
        h.ArrangementEditor.paintSpectrum({ drawImage: (...args) => draws.push(args) },
            h.AudioArrangement.bounds(trimmed, sequence), asset, sequence,
            { y: 40, height: 56, scrollLeft: 0 }, -sequence.stepToTick(8 / 76), 960);
        assert.equal(draws.length, 2);
        closeTo(draws[0][1], 50);
        closeTo(draws[0][3], 25);
        closeTo(draws[0][7], 304);
        closeTo(draws[1][1], 75);
        closeTo(draws[1][3], 50);
        closeTo(draws[1][7], 304);
    }]
];

(async () => {
    for (const [name, test] of tests) {
        await test();
        console.log('PASS', name);
    }
    console.log(`${tests.length} arrangement tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
