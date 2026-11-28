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
        this.delays = [];
        this.reverbs = [];
        this.sampleRate = sampleRate;
    }
    node() {
        return {
            connect(target) { this.target ??= target; (this.targets ??= []).push(target); return target; },
            start(...args) { this.startArgs = args; },
            stop(time) { this.stopTime = time; }
        };
    }
    param() {
        const envelope = [];
        return { value: 0, envelope,
            setValueAtTime: (...args) => envelope.push(args),
            linearRampToValueAtTime: (...args) => envelope.push(args),
            exponentialRampToValueAtTime: (...args) => envelope.push([...args, 'exponential'])
        };
    }
    createGain() {
        const node = { ...this.node(), gain: this.param() };
        this.gains.push(node);
        return node;
    }
    createStereoPanner() {
        return { ...this.node(), pan: this.param() };
    }
    createDelay() {
        const node = { ...this.node(), delayTime: this.param() };
        this.delays.push(node);
        return node;
    }
    createConvolver() {
        const node = this.node();
        this.reverbs.push(node);
        return node;
    }
    createBuffer(channels, frames, sampleRate) {
        const pcm = Array.from({ length: channels }, () => new Float32Array(frames));
        return { duration: frames / sampleRate, getChannelData: (channel) => pcm[channel] };
    }
    createOscillator() {
        const node = { ...this.node(), frequency: {} };
        this.oscillators.push(node);
        return node;
    }
    createBiquadFilter() {
        const node = { ...this.node(), frequency: this.param(), Q: this.param() };
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
    engine.setChannelVolume(triangle.id, 0.6);
    engine.setChannelPan(triangle.id, -0.3);
    engine.masterGain = { gain: { value: 0.4 } };

    const arrangement = engine.arrangement;
    const lane = arrangement.addTrack();
    engine.setChannelVolume(lane.id, 0.25);
    engine.setChannelPan(lane.id, 0.8);
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
    assert.equal(graph.oscillators[1].target.frequency.value, 444);
    assert.deepEqual(graph.oscillators[1].target.target.gain.envelope[1], [0.05 * 102 / 127, 0.5]);
    assert.equal(graph.oscillators[1].target.target.target.gain.value, 0.6);
    assert.equal(graph.oscillators[1].target.target.target.target.target.pan.value, -0.3);
    assert.equal(graph.gains[0].gain.value, 0.4);
    assert.deepEqual(graph.buffers.map((source) => source.startArgs),
        [[0.25, 1, 0.75], [1, 1.75, 1.25], [0.5, 1, 2]]);
    assert(graph.buffers.every((source) => source.buffer === buffer));
    const clipInput = graph.buffers[0].target;
    assert(graph.buffers.every((source) => source.target === clipInput));
    assert.equal(clipInput.gain.value, 0.25);
    assert.equal(clipInput.target.target.pan.value, 0.8);
    assert.equal(clipInput.target.target.target, graph.gains[0]);
    assert.equal(JSON.stringify({ sequence, clips: [...arrangement.clips], paused: engine.pausedTick }), before);
    assert.equal(engine.audioContext, null);
    console.log('PASS Offline graph preserves tempo, included lanes, trims, splits, overlaps, live synth settings and transport');

    engine.setChannelFilterType(lane.id, 'highpass');
    engine.setChannelParam(lane.id, 'cutoff', 700);
    engine.setChannelParam(lane.id, 'resonance', 8);
    engine.setChannelParam(lane.id, 'delaySend', 0.5);
    engine.setChannelParam(lane.id, 'delayBeats', 0.5);
    engine.setChannelParam(lane.id, 'delayFeedback', 0.4);
    engine.setChannelParam(lane.id, 'reverbSend', 0.4);
    engine.setAutomation(lane.id, 'volume', [{ tick: 10, value: 0 }, { tick: 960, value: 1 }]);
    engine.setAutomation(lane.id, 'pan', [{ tick: 0, value: -1 }, { tick: 960, value: 1 }]);
    engine.setAutomation(lane.id, 'cutoff', [{ tick: 0, value: 200 }, { tick: 960, value: 1800 }]);
    const processed = await AudioExporter.render(AudioExporter.snapshot(engine), OfflineGraph);
    const laneGain = processed.buffers[0].target;
    const laneFilter = laneGain.target;
    const lanePan = laneFilter.target;
    assert.equal(laneFilter.type, 'highpass');
    assert.equal(laneFilter.Q.value, 8);
    assert.equal(laneFilter.frequency.value, 700);
    assert.equal(processed.delays[0].delayTime.value, 0.25);
    assert.deepEqual(processed.delays[0].delayTime.envelope.slice(0, 2), [[0.25, 0], [0.5, 0.5]]);
    assert.equal(processed.delays[0].target.targets[0].gain.value, 0.4);
    assert.equal(processed.delays[0].target.targets[0].target, processed.delays[0]);
    assert.equal(lanePan.targets[1].gain.value, 0.5);
    assert.equal(lanePan.targets[2].gain.value, 0.4);
    assert.equal(processed.reverbs[0].buffer.duration, 2);
    assert(processed.reverbs[0].buffer.getChannelData(0).some((value) => value !== 0));
    assert(processed.output.frames > graph.output.frames);
    assert.deepEqual(laneGain.gain.envelope[0], [0, 0]);
    assert(laneGain.gain.envelope.some(([v, time]) => v === 0 && time > 0 && time < 0.1));
    assert.deepEqual(lanePan.pan.envelope[1], [0, 0.5]);
    assert.deepEqual(lanePan.pan.envelope[2], [1, 1.5]);
    assert.deepEqual(laneFilter.frequency.envelope[1], [600, 0.5, 'exponential']);
    assert.equal(processed.oscillators[0].target.target.target.target.type, 'lowpass');
    assert.equal(engine.audioContext, null);
    console.log('PASS Offline strips share effects, exact tempo/off-grid automation, independent routing and tail budgeting');

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

    const encoderInputs = [];
    scope.Worker = class {
        terminate() {}
        postMessage(data) {
            encoderInputs.push(data);
            this.onmessage({ data: { blob: new Blob([]) } });
        }
    };
    const testPCM = [new Float32Array([.25, -.125]), new Float32Array([-.5, .75])];
    const renderedPCM = { sampleRate: 44100, getChannelData: (channel) => testPCM[channel] };
    await AudioExporter.encode(renderedPCM, 'wav');
    await AudioExporter.encode(renderedPCM, 'mp3');
    for (const { left, right, sampleRate } of encoderInputs) {
        assert.deepEqual(left, testPCM[0]);
        assert.deepEqual(right, testPCM[1]);
        assert.equal(sampleRate, 44100);
    }
    assert.deepEqual(encoderInputs.map((input) => input.format), ['wav', 'mp3']);

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
