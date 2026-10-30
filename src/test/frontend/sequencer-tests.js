// Run with node src/test/frontend/sequencer-tests.js (no npm dependencies).
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
let timers = new Map(), nextTimer = 0;
class Source {
    constructor() { this.frequency = { value: 0 }; }
    connect() {} disconnect() { this.disconnected = true; }
    start(time) { this.started = time; }
    stop(time) { this.stopped = time ?? 0; }
}
class Context {
    constructor() { this.currentTime = 0; this.state = 'suspended'; this.sources = []; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() { this.disconnected = true; } }; }
    createBufferSource() { const s = new Source(); this.sources.push(s); return s; }
    createOscillator() { return this.createBufferSource(); }
}
const sandbox = { window: { AudioContext: Context }, setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearInterval: id => timers.delete(id), setTimeout: () => 0 };
vm.createContext(sandbox);
for (const file of ['NoteSequence.js', 'SequencerEngine.js']) vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../main/resources/static/js', file), 'utf8'), sandbox);
const { NoteSequence, SequencerEngine } = vm.runInContext('({NoteSequence, SequencerEngine})', sandbox);
let passed = 0;
async function test(name, fn) { await fn(); console.log('PASS', name); passed++; }
(async () => {
    await test('chromatic row mapping C2–B5 and C4', () => {
        const pitches = NoteSequence.visiblePitches(); assert.equal(pitches.length, 48); assert.equal(pitches[0], 83); assert.equal(pitches[47], 36); assert.equal(pitches[23], 60); assert.equal(NoteSequence.pitchName(61), 'C♯/D♭4');
    });
    await test('notes, chords, removal, full MIDI range and invalid positions', () => {
        const s = new NoteSequence(); s.toggleNote(60, 0); s.toggleNote(64, 0); assert.equal(s.notesAt(0).length, 2); s.toggleNote(60, 0); assert.equal(s.notesAt(0).length, 1);
        for (const midi of [0,127]) s.addNote({midi, startStep: 2.5, durationSteps: 2, velocity: .4});
        for (const note of [{midi:128,startStep:0},{midi:60,startStep:-1},{midi:60,startStep:16},{midi:60,startStep:0,durationSteps:0}]) assert.throws(() => s.addNote(note));
    });
    await test('BPM clamp and finite validation', () => { const e = new SequencerEngine(); e.setBpm(500); assert.equal(e.bpm,240); e.setBpm(NaN); assert.equal(e.bpm,240); e.setBpm(1); assert.equal(e.bpm,40); });
    await test('audio initialization, repeated Play, spacing and Stop', async () => {
        const e = new SequencerEngine(); await Promise.all([e.play(), e.play()]); assert.equal(timers.size,1); assert.equal(e.nextNoteTime,.175); e.stop(); assert.equal(timers.size,0); assert.equal(e.currentStep,0); assert.equal(e.getPlaybackStep(),null);
    });
    await test('rapid Stop during asynchronous resume cancels start', async () => {
        const e = new SequencerEngine(); e.initContext(); let resolve; e.audioContext.resume = () => new Promise(r => resolve=r); const p=e.play(); e.stop(); resolve(); await p; assert.equal(e.isPlaying,false); assert.equal(timers.size,0);
    });
    await test('loop validation, wrap and one-step loop', async () => {
        const e=new SequencerEngine(); assert.throws(()=>e.setLoopRange(3,3)); assert.throws(()=>e.setLoopRange(.5,4)); e.setLoopRange(3,4); await e.play(); assert.equal(e.currentStep,3); assert.throws(()=>e.setLoopRange(0,16)); e.audioContext.currentTime=.18; e.scheduler(); assert.equal(e.currentStep,3); e.stop(); assert.equal(e.currentStep,3);
    });
    await test('delayed callbacks skip overdue steps without burst; tempo change', async () => {
        const e=new SequencerEngine(); await e.play(); e.audioContext.currentTime=10; e.scheduler(); assert.ok(e.stepEvents.filter(x=>x.time>=10).length<=1); assert.ok(e.nextNoteTime>=10); e.stop(); e.setBpm(240); await e.play(); assert.ok(Math.abs(e.nextNoteTime-(10+.05+ .0625))<1e-9); e.stop();
    });
    await test('simultaneous pitched voices, frequency, duration, cancellation', async () => {
        const e=new SequencerEngine(); e.sequence.addNote({midi:69,startStep:0}); e.sequence.addNote({midi:81,startStep:0}); await e.play(); const voices=e.audioContext.sources; assert.equal(voices.length,2); assert.equal(voices[0].frequency.value,440); assert.equal(voices[1].frequency.value,880); assert.equal(voices[0].started,.05); assert.equal(voices[0].stopped,.175); e.stop(); assert.equal(voices[0].stopped,0);
    });
    await test('sample addTrack/setStep compatibility and safe replacement', async () => {
        const e=new SequencerEngine(); const buffer={}; e.addTrack('kick',buffer); e.setStep('kick',0,true); e.setStep('kick',.5,true); assert.equal(e.tracks.get('kick').steps['0.5'],undefined); await e.play(); const source=e.audioContext.sources[0]; assert.equal(source.buffer,buffer); const old=e.tracks.get('kick'); e.addTrack('kick',{}); assert.equal(source.stopped,0); assert.equal(old.gainNode.disconnected,true); e.stop();
    });
    await test('audio clock drives visual position', async () => { const e=new SequencerEngine(); await e.play(); assert.equal(e.getPlaybackStep(),null); e.audioContext.currentTime=.05; assert.equal(e.getPlaybackStep(),0); e.stop(); });
    await test('resume rejection leaves transport stopped', async () => { const e=new SequencerEngine(); e.initContext(); e.audioContext.resume=()=>Promise.reject(new Error('blocked')); await assert.rejects(e.play()); assert.equal(e.isPlaying,false); assert.equal(timers.size,0); });
    await test('UI upload reuses engine, preserves triggers, rejects stale and failed uploads', async () => {
        class Element {
            constructor() { this.value = ''; this.disabled = false; this.children = []; this.listeners = {}; this.classList = { toggle() {} }; }
            append(child) { this.children.push(child); }
            setAttribute() {} addEventListener(name, fn) { this.listeners[name] = fn; }
        }
        const elements = {};
        const document = { getElementById: id => elements[id] ||= new Element(), createElement: () => new Element(), addEventListener() {} };
        const engines = [];
        sandbox.document = document; sandbox.requestAnimationFrame = () => {};
        sandbox.window.addEventListener = () => {};
        sandbox.TestEngine = class extends SequencerEngine { constructor() { super(); engines.push(this); } };
        const ui = fs.readFileSync(path.resolve(__dirname, '../../main/resources/static/js/sequencer-ui.js'), 'utf8').replace('new SequencerEngine()', 'new TestEngine()');
        vm.runInContext(ui, sandbox);
        const engine = engines[0]; engine.initContext();
        engine.audioContext.decodeAudioData = async data => { if (data === 'bad') throw new Error('invalid'); return { data }; };
        const upload = data => elements.audioFile.onchange({ target: { files: [{ name: String(data), arrayBuffer: async () => data }] } });
        await upload('first'); engine.setStep('uploaded', 2, true);
        await upload('second'); assert.equal(engine.tracks.get('uploaded').steps[2], true);
        await upload('bad'); assert.equal(engine.tracks.get('uploaded').buffer.data, 'second');
        let release; const old = elements.audioFile.onchange({ target: { files: [{ name: 'old', arrayBuffer: () => new Promise(r => release = r) }] } });
        await upload('latest'); release('old'); await old;
        assert.equal(engine.tracks.get('uploaded').buffer.data, 'latest'); assert.equal(engines.length, 1);
    });
    console.log(`${passed} tests passed`);
})().catch(error => { console.error(error); process.exitCode=1; });
