// Run with node src/test/frontend/sequencer-tests.js (no npm dependencies).

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createEditorHarness } = require('./editor-test-support');
let timers = new Map();
let nextTimer = 0;
class Source {
    constructor() {
        this.frequency = { value: 0 };
    }
    connect(destination) { this.destination = destination; }
    disconnect() {
        this.disconnected = true;
    }
    start(time) {
        this.started = time;
    }
    stop(time) {
        this.stopped = time ?? 0;
    }
}
class Context {
    constructor() {
        this.currentTime = 0;
        this.state = 'suspended';
        this.sources = [];
    }
    resume() {
        this.state = 'running';
        return Promise.resolve();
    }
    param() {
        return { value: 0, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime(value) { this.value = value; },
            setTargetAtTime(value) { this.value = value; }, cancelScheduledValues() {} };
    }
    createGain() {
        return {
            gain: this.param(),
            connect(destination) { this.destination = destination; },
            disconnect() {
                this.disconnected = true;
            }
        };
    }
    createStereoPanner() {
        return {
            pan: this.param(),
            connect(destination) { this.destination = destination; },
            disconnect() {
                this.disconnected = true;
            }
        };
    }
    createBiquadFilter() {
        return Object.assign(new Source(), { frequency: this.param(), Q: this.param() });
    }
    createBufferSource() {
        const s = new Source();
        this.sources.push(s);
        return s;
    }
    createOscillator() {
        return this.createBufferSource();
    }
}
const sandbox = {
    window: { AudioContext: Context },
    setInterval: (fn) => {
        timers.set(++nextTimer, fn);
        return nextTimer;
    },
    clearInterval: (id) => timers.delete(id),
    setTimeout: () => 0
};
vm.createContext(sandbox);
for (const file of [
    'vendor/tonejs-midi-2.0.28.js',
    'NoteSequence.js',
    'AudioArrangement.js',
        'SampleAssetStore.js',
        'SequencerEngine.js',
    'midi-io.js',
    'PianoRollEditor.js',
    'TrackOverview.js',
        'ArrangementEditor.js'
]) {
    vm.runInContext(
        fs.readFileSync(path.resolve(__dirname, '../../main/resources/static/js', file), 'utf8'),
        sandbox
    );
}
const { NoteSequence, SequencerEngine, MidiIO, Midi } = vm.runInContext(
    '({NoteSequence, SequencerEngine, MidiIO, Midi})',
    sandbox
);
let passed = 0;
async function test(name, fn) {
    await fn();
    console.log('PASS', name);
    passed++;
}
(async () => {
    await test('chromatic row mapping C2–B5 and C4', () => {
        const pitches = NoteSequence.visiblePitches();
        assert.equal(pitches.length, 48);
        assert.equal(pitches[0], 83);
        assert.equal(pitches[47], 36);
        assert.equal(pitches[23], 60);
        assert.equal(NoteSequence.pitchName(61), 'C♯/D♭4');
    });
    await test('notes, chords, removal, full MIDI range and invalid positions', () => {
        const s = new NoteSequence();
        s.toggleNote(60, 0);
        s.toggleNote(64, 0);
        assert.equal(s.notesAt(0).length, 2);
        s.toggleNote(60, 0);
        assert.equal(s.notesAt(0).length, 1);
        for (const midi of [0, 127]) {
            s.addNote({ midi, startStep: 2.5, durationSteps: 2, velocity: 0.4 });
        }
        for (const note of [
            { midi: 128, startStep: 0 },
            { midi: 60, startStep: -1 },
            { midi: 60, startStep: 16 },
            { midi: 60, startStep: 0, durationSteps: 0 }
        ]) {
            assert.throws(() => s.addNote(note));
        }
    });
    await test('BPM clamp and finite validation', () => {
        const e = new SequencerEngine();
        e.setBpm(500);
        assert.equal(e.bpm, 240);
        e.setBpm(NaN);
        assert.equal(e.bpm, 240);
        e.setBpm(1);
        assert.equal(e.bpm, 40);
    });
    await test('audio initialization, repeated Play, spacing and Stop', async () => {
        const e = new SequencerEngine();
        await Promise.all([e.play(), e.play()]);
        assert.equal(timers.size, 1);
        assert.equal(e.nextNoteTime, 0.175);
        e.stop();
        assert.equal(timers.size, 0);
        assert.equal(e.currentStep, 0);
        assert.equal(e.getPlaybackStep(), null);
    });
    await test('rapid Stop during asynchronous resume cancels start', async () => {
        const e = new SequencerEngine();
        e.initContext();
        let resolve;
        e.audioContext.resume = () => new Promise((r) => (resolve = r));
        const p = e.play();
        e.stop();
        resolve();
        await p;
        assert.equal(e.isPlaying, false);
        assert.equal(timers.size, 0);
    });
    await test('loop validation, wrap and one-step loop', async () => {
        const e = new SequencerEngine();
        assert.throws(() => e.setLoopRange(3, 3));
        assert.throws(() => e.setLoopRange(0.5, 4));
        e.setLoopRange(3, 4);
        await e.play();
        assert.equal(e.currentStep, 3);
        assert.throws(() => e.setLoopRange(0, 16));
        e.audioContext.currentTime = 0.18;
        e.scheduler();
        assert.equal(e.currentStep, 3);
        e.stop();
        assert.equal(e.currentStep, 3);
    });
    await test('delayed callbacks skip overdue steps without burst; tempo change', async () => {
        const e = new SequencerEngine();
        await e.play();
        e.audioContext.currentTime = 10;
        e.scheduler();
        assert.ok(e.stepEvents.filter((x) => x.time >= 10).length <= 1);
        assert.ok(e.nextNoteTime >= 10);
        e.stop();
        e.setBpm(240);
        await e.play();
        assert.ok(Math.abs(e.nextNoteTime - (10 + 0.05 + 0.0625)) < 1e-9);
        e.stop();
    });
    await test('simultaneous pitched voices, frequency, duration, cancellation', async () => {
        const e = new SequencerEngine();
        e.sequence.addNote({ midi: 69, startStep: 0 });
        e.sequence.addNote({ midi: 81, startStep: 0 });
        await e.play();
        const voices = e.audioContext.sources;
        assert.equal(voices.length, 2);
        assert.equal(voices[0].frequency.value, 440);
        assert.equal(voices[1].frequency.value, 880);
        assert.equal(voices[0].started, 0.05);
        assert.equal(voices[0].stopped, 0.175);
        e.stop();
        assert.equal(voices[0].stopped, 0);
    });
    await test('sample addTrack/setStep compatibility and safe replacement', async () => {
        const e = new SequencerEngine();
        const buffer = {};
        e.addTrack('kick', buffer);
        e.setStep('kick', 0, true);
        e.setStep('kick', 0.5, true);
        assert.equal(e.tracks.get('kick').steps['0.5'], undefined);
        await e.play();
        const source = e.audioContext.sources[0];
        assert.equal(source.buffer, buffer);
        const old = e.tracks.get('kick');
        e.addTrack('kick', {});
        assert.equal(source.stopped, 0);
        assert.equal(old.gainNode.disconnected, true);
        e.stop();
    });
    await test('audio clock drives visual position', async () => {
        const e = new SequencerEngine();
        await e.play();
        assert.equal(e.getPlaybackStep(), null);
        e.audioContext.currentTime = 0.05;
        assert.equal(e.getPlaybackStep(), 0);
        e.stop();
    });
    await test('resume rejection leaves transport stopped', async () => {
        const e = new SequencerEngine();
        e.initContext();
        e.audioContext.resume = () => Promise.reject(new Error('blocked'));
        await assert.rejects(e.play());
        assert.equal(e.isPlaying, false);
        assert.equal(timers.size, 0);
    });
    await test('UI MIDI upload lifecycle and piano-roll click editing', async () => {
        const h = createEditorHarness();
        await h.ready;
        const { engine, elements } = h;
        assert.equal(h.readyEvents.length, 1);
        elements.noteLength.value = '1';
        elements.velocity.value = '89';
        h.clickAt(119, 300);
        assert.equal(engine.sequence.notes.length, 1);
        h.clickAt(119, 300); // select
        elements.noteLength.value = '2';
        elements.noteLength.onchange();
        assert.equal(engine.sequence.notes[0].durationSteps, 2);
        elements.deleteNote.onclick();
        assert.equal(engine.sequence.notes.length, 0);
        const seq = new NoteSequence(32);
        seq.addNote({ midi: 127, ticks: 17, durationTicks: 240, velocityMidi: 12 });
        const bytes = MidiIO.encode(seq).bytes;
        await elements.midiFile.onchange({
            target: { files: [{ size: bytes.length, arrayBuffer: async () => bytes }] }
        });
        assert.equal(engine.sequence.notes[0].ticks, 17);
        assert.equal(engine.totalSteps, 32);
        assert.equal(Number(elements.pitchHigh.value), 127);
        const imported = engine.sequence;
        await elements.midiFile.onchange({
            target: { files: [{ size: 0, arrayBuffer: async () => new Uint8Array() }] }
        });
        assert.equal(engine.sequence, imported);
        assert.equal(engine.tracks.has('uploaded'), false);
    });
    function composition() {
        const s = new NoteSequence(64, 960);
        s.tracks = [
            { id: 'a', name: 'Keys', channel: 0, program: 4 },
            { id: 'b', name: 'Bass', channel: 2, program: 32 }
        ];
        s.tempos = [
            { ticks: 0, bpm: 120 },
            { ticks: 1920, bpm: 60 }
        ];
        s.timeSignatures = [
            { ticks: 0, timeSignature: [4, 4] },
            { ticks: 3840, timeSignature: [3, 4] }
        ];
        for (const note of [
            { midi: 0, ticks: 1, durationTicks: 123, velocityMidi: 1, trackId: 'a' },
            { midi: 127, ticks: 1, durationTicks: 456, velocityMidi: 127, trackId: 'a' },
            {
                midi: 60,
                ticks: 1440,
                durationTicks: 960,
                velocityMidi: 65,
                noteOffVelocity: 44,
                trackId: 'a'
            },
            { midi: 60, ticks: 1440, durationTicks: 960, velocityMidi: 80, trackId: 'a' },
            { midi: 60, ticks: 3840, durationTicks: 1920, velocityMidi: 100, trackId: 'b' }
        ]) {
            s.addNote(note);
        }
        return s;
    }
    const semantic = (s) =>
        JSON.parse(
            JSON.stringify({
                ppq: s.ppq,
                stepCount: s.stepCount,
                tracks: s.tracks.map((t) => ({
                    name: t.name,
                    channel: t.channel,
                    program: t.program
                })),
                tempos: s.tempos,
                timeSignatures: s.timeSignatures,
                notes: s.notes
                    .map((n) => ({
                        midi: n.midi,
                        ticks: n.ticks,
                        durationTicks: n.durationTicks,
                        velocityMidi: n.velocityMidi,
                        noteOffVelocity: n.noteOffVelocity,
                        track: s.tracks.findIndex((t) => t.id === n.trackId)
                    }))
                    .sort(
                        (a, b) =>
                            a.ticks - b.ticks || a.midi - b.midi || a.velocityMidi - b.velocityMidi
                    )
            })
        );
    await test('stable IDs, duplicate notes, and track-aware edits', () => {
        const s = composition();
        const a = s.notes[2];
        const b = s.notes[3];
        assert.notEqual(a.id, b.id);
        s.removeById(a.id);
        assert.ok(s.notes.includes(b));
        s.toggleNote(60, 16, 'a');
        assert.equal(s.hasNote(60, 16, 'a'), true);
        assert.equal(s.hasNote(60, 16, 'b'), true);
        s.toggleNote(60, 16, 'a');
        assert.equal(s.hasNote(60, 16, 'b'), true);
    });
    await test('multi-bar resizing keeps samples/loops aligned and prevents data deletion', () => {
        const e = new SequencerEngine();
        e.addTrack('sample', {});
        e.setPatternLength(64);
        e.setStep('sample', 63, true);
        assert.throws(() => e.setPatternLength(16));
        assert.equal(e.totalSteps, 64);
        assert.equal(e.loopEnd, 64);
        e.setStep('sample', 63, false);
        e.setPatternLength(32);
        assert.equal(e.tracks.get('sample').steps.length, 32);
        e.sequence.addNote({ midi: 60, startStep: 30, durationSteps: 2 });
        assert.throws(() => e.setPatternLength(31));
    });
    await test('tempo map conversion, inverse, and meter labels', () => {
        const s = composition();
        assert.equal(s.ticksToSeconds(1440), 0.75);
        assert.equal(s.ticksToSeconds(2400), 1.5);
        assert.equal(s.secondsToTicks(1.5), 2400);
        assert.equal(s.positionAtTick(3840).measure, 2);
        assert.equal(s.positionAtTick(6720).measure, 3);
    });
    await test('real MIDI encode/parse preserves supported multi-track subset and trailing silence', () => {
        const s = composition();
        const { bytes } = MidiIO.encode(s);
        const result = MidiIO.parse(bytes);
        assert.equal(MidiIO.inspect(bytes).ppq, 960);
        assert.deepEqual(semantic(result.sequence), semantic(s));
        assert.equal(result.sequence.notes.length, 5);
        assert.notEqual(result.sequence.notes[2].id, result.sequence.notes[3].id);
    });
    await test('all 127 note-on velocities and note-off velocities survive round trip', () => {
        const s = new NoteSequence(128);
        for (let i = 1; i <= 127; i++) {
            s.addNote({
                midi: i,
                ticks: i * 120,
                durationTicks: 60,
                velocityMidi: i,
                noteOffVelocity: i
            });
        }
        const round = MidiIO.parse(MidiIO.encode(s).bytes).sequence;
        round.notes.forEach((n) => {
            assert.equal(n.velocityMidi, n.midi);
            assert.equal(n.noteOffVelocity, n.midi);
        });
    });
    await test('fractional starts and durations remain tick-exact without quantization', () => {
        const s = new NoteSequence(16, 101);
        s.addNote({ midi: 61, ticks: 17, durationTicks: 89, velocityMidi: 23 });
        const round = MidiIO.parse(MidiIO.encode(s).bytes).sequence;
        assert.equal(round.ppq, 101);
        assert.equal(round.notes[0].ticks, 17);
        assert.equal(round.notes[0].durationTicks, 89);
    });
    await test('format 0 parser supports PPQ notes', () => {
        // Independent literal SMF fixture: one note, running-status note-off at tick 96.
        const bytes = Uint8Array.from([
            77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 77, 84, 114, 107, 0, 0, 0, 11, 0, 144,
            60, 100, 96, 60, 0, 0, 255, 47, 0
        ]);
        const s = MidiIO.parse(bytes).sequence;
        assert.equal(s.ppq, 96);
        assert.equal(s.notes[0].durationTicks, 96);
    });
    await test('invalid, truncated, format 2 and SMPTE files reject without import mutation', () => {
        const valid = MidiIO.encode(composition()).bytes;
        const invalid = [new Uint8Array(), valid.slice(0, 20)];
        const format = Uint8Array.from(valid);
        format[9] = 2;
        invalid.push(format);
        const smpte = Uint8Array.from(valid);
        smpte[12] = 0xe7;
        invalid.push(smpte);
        const e = new SequencerEngine();
        const before = e.sequence;
        e.sequence.addNote({ midi: 60, startStep: 0 });
        for (const bytes of invalid) {
            assert.throws(() => MidiIO.importInto(e, bytes));
            assert.equal(e.sequence, before);
            assert.equal(e.sequence.notes.length, 1);
        }
    });
    await test('import retains sample patterns and rejects replacement during playback', async () => {
        const e = new SequencerEngine();
        e.addTrack('sample', {});
        e.setPatternLength(96);
        e.setStep('sample', 95, true);
        MidiIO.importInto(e, MidiIO.encode(composition()).bytes);
        assert.equal(e.totalSteps, 96);
        assert.equal(e.tracks.get('sample').steps[95], true);
        await e.play();
        const before = e.sequence;
        assert.throws(() => MidiIO.importInto(e, MidiIO.encode(composition()).bytes));
        assert.equal(e.sequence, before);
        e.stop();
    });
    await test('tempo-spanning note schedules correct duration through existing voice interface', async () => {
        const e = new SequencerEngine();
        e.replaceSequence(composition());
        e.setLoopRange(6, 7);
        const events = [];
        e.voiceFactory = (event) => {
            events.push(event);
            return { stop() {}, finished: new Promise(() => {}) };
        };
        await e.play();
        assert.equal(events.length, 2);
        assert.ok(Math.abs(events[0].when - 0.05) < 1e-9);
        assert.equal(events[0].duration, 0.75);
        e.stop();
    });
    await test('multi-bar loops and delayed tempo-map callbacks maintain phase', async () => {
        const e = new SequencerEngine();
        e.replaceSequence(composition());
        e.setLoopRange(12, 32);
        await e.play();
        const loop = e.stepSeconds(32) - e.stepSeconds(12);
        const original = e.nextNoteTime;
        e.audioContext.currentTime = loop * 100 + 0.05;
        e.scheduler();
        assert.ok(e.nextNoteTime > e.audioContext.currentTime);
        assert.ok(e.currentStep >= 12 && e.currentStep < 32);
        assert.ok(e.stepEvents.filter((x) => x.time >= e.audioContext.currentTime).length <= 2);
        assert.ok(original > 0.05);
        e.stop();
    });
    await test('import tempo outside UI range is preserved; tempo maps cannot be flattened accidentally', () => {
        const s = new NoteSequence();
        s.tempos = [
            { ticks: 0, bpm: 300 },
            { ticks: 480, bpm: 60000000 / 345679 }
        ];
        const round = MidiIO.parse(MidiIO.encode(s).bytes).sequence;
        assert.equal(round.tempos[0].bpm, 300);
        assert.ok(Math.abs(round.tempos[1].bpm - s.tempos[1].bpm) < 1e-10);
        const e = new SequencerEngine();
        e.replaceSequence(round);
        assert.equal(e.bpm, 300);
        assert.throws(() => e.setBpm(120));
    });
    await test('unsupported controllers warn; unmatched and zero-duration source notes reject', () => {
        const raw = (body) =>
            Uint8Array.from([
                77,
                84,
                104,
                100,
                0,
                0,
                0,
                6,
                0,
                0,
                0,
                1,
                0,
                96,
                77,
                84,
                114,
                107,
                0,
                0,
                0,
                body.length,
                ...body
            ]);
        const cc = raw([0, 176, 64, 127, 0, 255, 47, 0]);
        assert.ok(MidiIO.parse(cc).warnings.some((w) => w.includes('sustain')));
        assert.throws(() => MidiIO.parse(raw([0, 144, 60, 100, 0, 255, 47, 0])));
        assert.throws(() => MidiIO.parse(raw([0, 144, 60, 100, 0, 128, 60, 0, 0, 255, 47, 0])));
    });

    // Objects built inside the vm sandbox have another realm's prototypes; compare plain copies.
    const plain = (value) => JSON.parse(JSON.stringify(value));
    await test('legacy sample tracks retain a gain and pan strip through buffer replacement', () => {
        const e = new SequencerEngine();
        e.addTrack('kick', {});
        const original = e.tracks.get('kick');
        assert.equal(original.gainNode.gain.value, 0.8);
        assert.equal(original.gainNode.destination.destination, original.strip.pan);
        assert.equal(original.strip.pan.destination, e.masterGain);
        assert.equal(original.strip.out, e.masterGain);
        assert.equal(e.setChannelVolume('kick', 9), true);
        assert.equal(original.gainNode.gain.value, 1.5);
        assert.equal(e.setChannelVolume('kick', -1), true);
        assert.equal(original.gainNode.gain.value, 0);
        assert.equal(e.setChannelPan('kick', -5), true);
        assert.equal(original.strip.pan.pan.value, -1);
        assert.equal(e.setChannelVolume('kick', NaN), false);
        assert.equal(e.setChannelPan('kick', Infinity), false);
        assert.equal(e.setChannelVolume('missing', 0.5), false);
        e.addTrack('kick', {});
        assert.equal(original.gainNode.disconnected, true);
        assert.equal(original.strip.pan.disconnected, true);
        assert.deepEqual(plain(e.getChannelMix('kick')), { filterType: "lowpass", volume: 0, pan: -1, cutoff: 20000, resonance: 0, delaySend: 0, delayBeats: 0.75, delayFeedback: 0.4, reverbSend: 0 });
    });

    await test('MIDI voices use the same gain, pan, and mute chain as audio lanes', async () => {
        const e = new SequencerEngine();
        const midiId = e.sequence.tracks[0].id;
        e.sequence.addNote({ midi: 60, startStep: 0, durationSteps: 1 });
        assert.equal(e.setChannelPan(midiId, 0.25), true);
        assert.equal(e.audioContext, null);
        let output;
        e.voiceFactory = (event, context, out) => {
            output = out;
            return { stop() {}, finished: new Promise(() => {}) };
        };
        e.setLaneMuted(midiId, true);
        await e.play();
        const mute = e.laneGains.get(midiId);
        assert.equal(output.destination.destination.destination, mute);
        assert.equal(mute.destination, e.masterGain);
        assert.equal(mute.gain.value, 0);
        assert.equal(output.destination.destination.pan.value, 0.25);
        e.setChannelVolume(midiId, 0.6);
        assert.equal(output.gain.value, 0.6);
        assert.equal(mute.gain.value, 0);
        e.setLaneMuted(midiId, false);
        assert.equal(mute.gain.value, 1);
        assert.deepEqual(plain(e.getChannelMix(midiId)), { filterType: "lowpass", volume: 0.6, pan: 0.25, cutoff: 20000, resonance: 0, delaySend: 0, delayBeats: 0.75, delayFeedback: 0.4, reverbSend: 0 });
        e.stop();
        e.newSequence();
        assert.equal(e.laneGains.size, 0);
        assert.equal(output.disconnected, true);
        assert.deepEqual(plain(e.getChannelMix(midiId)), { filterType: "lowpass", volume: 1, pan: 0, cutoff: 20000, resonance: 0, delaySend: 0, delayBeats: 0.75, delayFeedback: 0.4, reverbSend: 0 });
    });

    console.log(`${passed} tests passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
