const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../main/resources/static/js');
const scope = vm.createContext({ Blob, clearInterval, document: {
    addEventListener(_, listener) { this.ready = listener; }
}, window: {}, crypto: require('node:crypto').webcrypto });
function load(file) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), scope, { filename: file });
}
for (const file of ['AudioArrangement.js', 'NoteSequence.js', 'SequencerEngine.js', 'AudioExporter.js',
    'instruments/SynthInstrumentManager.js']) load(file);
const { AudioExporter, SequencerEngine, AudioArrangement } = vm.runInContext(
    '({ AudioExporter, SequencerEngine, AudioArrangement })', scope);

class OfflineGraph {
    constructor(channels, frames, sampleRate) {
        this.output = { channels, frames, sampleRate };
        this.destination = {};
        this.oscillators = [];
        this.buffers = [];
        this.gains = [];
        this.filters = [];
    }
    node() {
        return {
            connect(target) { this.target = target; return target; },
            start(...args) { this.startArgs = args; },
            stop(time) { this.stopTime = time; }
        };
    }
    createGain() {
        const node = this.node();
        const envelope = [];
        node.gain = {
            value: 0, envelope,
            setValueAtTime: (...args) => envelope.push(args),
            linearRampToValueAtTime: (...args) => envelope.push(args)
        };
        this.gains.push(node);
        return node;
    }
    createOscillator() {
        const node = { ...this.node(), frequency: {} };
        this.oscillators.push(node);
        return node;
    }
    createBiquadFilter() {
        const node = { ...this.node(), frequency: {} };
        this.filters.push(node);
        return node;
    }
    createBufferSource() {
        const node = this.node();
        this.buffers.push(node);
        return node;
    }
    async startRendering() { return this; }
}

async function main() {
    const engine = new SequencerEngine();
    scope.document.ready({ detail: { engine } });
    const synth = scope.window.jukeboxSynth;
    const sequence = engine.sequence;
    sequence.stepCount = 8;
    sequence.tempos = [{ ticks: 0, bpm: 120 }, { ticks: 480, bpm: 60 }];
    const triangle = sequence.addMusicalTrack({ name: 'Triangle', channel: 1 });
    const muted = sequence.addMusicalTrack({ name: 'Muted', channel: 2 });
    const drums = sequence.addMusicalTrack({ name: 'Percussion channel', channel: 9 });
    synth.setParam(triangle.id, 'waveform', 'triangle');
    synth.setParam(triangle.id, 'filterCutoff', 444);
    synth.setParam(triangle.id, 'attack', 0.25);
    synth.setParam(triangle.id, 'release', 2);
    for (const trackId of ['piano', triangle.id, muted.id, drums.id]) {
        sequence.addNote({ trackId, midi: 69, ticks: 240, durationTicks: 480, velocity: 0.8 });
    }
    engine.setLaneMuted(muted.id, true);
    engine.laneGains.set(triangle.id, { gain: { value: 0.6 } });
    engine.masterGain = { gain: { value: 0.4 } };

    const arrangement = engine.arrangement;
    const lane = arrangement.addTrack();
    const silentLane = arrangement.addTrack();
    const buffer = { duration: 5, sampleRate: 44100, length: 220500, numberOfChannels: 1 };
    arrangement.assets.set('drum', { name: 'Drum Pattern', duration: 5, buffer });
    arrangement.assets.set('unused', { name: 'Unused', duration: 5 });
    arrangement.assets.set('missing', { name: 'Missing Kick.wav', duration: 1 });
    const clip = arrangement.setClip({ id: 'clip', trackId: lane.id, assetId: 'drum', startTick: 240,
        sourceOffsetSeconds: 1, playDurationSeconds: 2 });
    const split = AudioArrangement.split(clip, 720, sequence);
    arrangement.deleteClip(clip.id);
    split.forEach((piece) => arrangement.setClip(piece));
    arrangement.setClip({ ...clip, id: 'overlap', startTick: 480 });
    arrangement.setClip({ id: 'muted', trackId: silentLane.id, assetId: 'missing', startTick: 0,
        sourceOffsetSeconds: 0, playDurationSeconds: 1 });
    engine.setLaneMuted(silentLane.id, true);
    engine.loopStart = 3;
    engine.loopEnd = 5;
    engine.pausedTick = 720;
    const before = JSON.stringify({ sequence, clips: [...arrangement.clips], paused: engine.pausedTick });

    const plan = AudioExporter.snapshot(engine);
    synth.setParam(triangle.id, 'waveform', 'square');
    const graph = await AudioExporter.render(plan, OfflineGraph);
    assert.deepEqual(graph.output, { channels: 2, frames: 132300, sampleRate: 44100 });
    assert.equal(graph.oscillators.length, 2);
    assert.equal(graph.oscillators[0].type, 'sawtooth');
    assert.equal(graph.oscillators[1].type, 'triangle');
    assert.equal(graph.oscillators[1].frequency.value, 440);
    assert.equal(graph.filters[1].frequency.value, 444);
    assert.deepEqual(graph.filters[1].target.gain.envelope[1], [0.05 * 102 / 127, 0.5]);
    assert.equal(graph.filters[1].target.target.gain.value, 0.6);
    assert.equal(graph.gains[0].gain.value, 0.4);
    assert.deepEqual(graph.buffers.map((source) => source.startArgs),
        [[0.25, 1, 0.75], [1, 1.75, 1.25], [0.5, 1, 2]]);
    assert(graph.buffers.every((source) => source.buffer === buffer));
    assert.equal(JSON.stringify({ sequence, clips: [...arrangement.clips], paused: engine.pausedTick }), before);
    assert.equal(engine.audioContext, null);
    console.log('PASS Offline graph preserves tempo, included lanes, trims, splits, overlaps, live synth settings and transport');

    engine.setLaneMuted(silentLane.id, false);
    assert.throws(() => AudioExporter.snapshot(engine), /Missing Kick\.wav.*relink/i);
    assert.throws(() => AudioExporter.checkBudget({ ...plan, frames: 100_000_000 }), /memory budget/);
    let allocated = false;
    await assert.rejects(AudioExporter.render({ ...plan, frames: 100_000_000 }, function () {
        allocated = true;
    }), /memory budget/);
    assert.equal(allocated, false);
    engine.registerInstrumentManager(null);
    assert.throws(() => AudioExporter.snapshot(engine), /does not support offline/);
    console.log('PASS Missing placed audio, unsupported instruments and oversized renders fail explicitly');

    const messages = [];
    scope.self = {};
    scope.postMessage = (message) => messages.push(message);
    scope.importScripts = (file) => load(file.replace('/js/', ''));
    load('audio-export-worker.js');
    const sampleRate = 44100;
    const left = Float32Array.from({ length: sampleRate }, (_, i) => 0.5 * Math.sin(i * 2 * Math.PI * 440 / sampleRate));
    const right = Float32Array.from(left, (value) => -value / 2);
    left[0] = 3;
    right[0] = -3;
    function encode(format) {
        scope.self.onmessage({ data: { left, right, format, sampleRate } });
        const result = messages.pop();
        assert(!result.error, result.error);
        return result.blob;
    }
    const wav = Buffer.from(await encode('wav').arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 2);
    assert.equal(wav.readUInt32LE(24), 44100);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 44100 * 4);
    assert.equal(wav.readInt16LE(44), 32767);
    assert.equal(wav.readInt16LE(46), -32768);
    const mp3 = Buffer.from(await encode('mp3').arrayBuffer());
    let offset = 0;
    let frames = 0;
    while (offset < mp3.length) {
        const header = mp3.readUInt32BE(offset);
        assert.equal(header >>> 17, 0x7ffd); // frame sync, MPEG-1, Layer III
        assert.equal((header >>> 12) & 15, 11); // 192 kbps
        assert.equal((header >>> 10) & 3, 0); // 44.1 kHz
        assert.notEqual((header >>> 6) & 3, 3); // stereo
        offset += Math.floor(144 * 192000 / sampleRate) + ((header >>> 9) & 1);
        frames++;
    }
    assert.equal(offset, mp3.length);
    assert(Math.abs(frames * 1152 / sampleRate - 1) < 0.06);
    if (process.argv[2]) {
        fs.writeFileSync(path.join(process.argv[2], 'export-encoder-check.wav'), wav);
        fs.writeFileSync(path.join(process.argv[2], 'export-encoder-check.mp3'), mp3);
    }
    console.log('PASS Worker generates valid stereo PCM WAV and genuine 192 kbps Layer III frames');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
