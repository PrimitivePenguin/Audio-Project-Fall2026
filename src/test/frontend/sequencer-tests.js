// Run with node src/test/frontend/sequencer-tests.js (no npm dependencies).
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
let timers = new Map();
let nextTimer = 0;
class Source {
    constructor() {
        this.frequency = { value: 0 };
    }
    connect() {}
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
    createGain() {
        return {
            gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} },
            connect() {},
            disconnect() {
                this.disconnected = true;
            }
        };
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
    'SequencerEngine.js',
    'midi-io.js',
    'PianoRollEditor.js'
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
    await test('UI sample/MIDI upload lifecycle, rollback and piano-roll click editing', async () => {
        class Element {
            constructor() {
                this.value = '';
                this.style = {};
                this.dataset = {};
                this.clientWidth = 900;
                this.clientHeight = 600;
                this.scrollLeft = 0;
                this.scrollTop = 0;
                this.disabled = false;
                this.children = [];
                this.listeners = {};
                this.classList = { toggle() {} };
            }
            getBoundingClientRect() {
                return { left: 0, top: 0 };
            }
            getContext() {
                return new Proxy({}, { get: () => () => {} });
            }
            replaceChildren() {
                this.children = [];
            }
            append(child) {
                this.children.push(child);
            }
            setAttribute() {}
            addEventListener(name, fn) {
                this.listeners[name] = fn;
            }
        }
        const elements = {};
        const document = {
            getElementById: (id) => (elements[id] ||= new Element()),
            createElement: () => new Element(),
            addEventListener() {},
            dispatchEvent() {}
        };
        const engines = [];
        sandbox.document = document;
        sandbox.CustomEvent = class {
            constructor(type, options) {
                this.type = type;
                this.detail = options.detail;
            }
        };
        sandbox.requestAnimationFrame = () => {};
        sandbox.window.addEventListener = () => {};
        sandbox.TestEngine = class extends SequencerEngine {
            constructor() {
                super();
                engines.push(this);
            }
        };
        const ui = fs
            .readFileSync(
                path.resolve(__dirname, '../../main/resources/static/js/sequencer-ui.js'),
                'utf8'
            )
            .replace('new SequencerEngine()', 'new TestEngine()');
        vm.runInContext(ui, sandbox);
        const engine = engines[0];
        engine.initContext();
        engine.audioContext.decodeAudioData = async (data) => {
            if (data === 'bad') {
                throw new Error('invalid');
            }
            return { data };
        };
        const upload = (data) =>
            elements.audioFile.onchange({
                target: { files: [{ name: String(data), arrayBuffer: async () => data }] }
            });
        await upload('first');
        engine.setStep('uploaded', 2, true);
        await upload('second');
        assert.equal(engine.tracks.get('uploaded').steps[2], true);
        await upload('bad');
        assert.equal(engine.tracks.get('uploaded').buffer.data, 'second');
        let release;
        const old = elements.audioFile.onchange({
            target: {
                files: [{ name: 'old', arrayBuffer: () => new Promise((r) => (release = r)) }]
            }
        });
        await upload('latest');
        release('old');
        await old;
        assert.equal(engine.tracks.get('uploaded').buffer.data, 'latest');
        assert.equal(engines.length, 1);
        elements.noteLength.value = '1';
        elements.velocity.value = '89';
        elements.pianoCanvas.onclick({ clientX: 119, clientY: 300 });
        assert.equal(engine.sequence.notes.length, 1);
        elements.pianoCanvas.onclick({ clientX: 119, clientY: 300 }); // select
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
        assert.equal(elements.pitchHigh.value, 127);
        const imported = engine.sequence;
        await elements.midiFile.onchange({
            target: { files: [{ size: 0, arrayBuffer: async () => new Uint8Array() }] }
        });
        assert.equal(engine.sequence, imported);
        assert.equal(engine.tracks.get('uploaded').steps[2], true);
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
    console.log(`${passed} tests passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
