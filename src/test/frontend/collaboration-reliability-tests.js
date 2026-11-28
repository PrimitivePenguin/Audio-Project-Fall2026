const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createEditorHarness } = require('./editor-test-support');

const source = fs.readFileSync(require('node:path').join(__dirname,
    '../../main/resources/static/js/ProjectCollabClient.js'), 'utf8');
const projectId = '11111111-1111-1111-1111-111111111111';
function storage() {
    const data = new Map();
    return { getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
}

function transport() {
    const sockets = [];
    class Client {
        constructor(options) {
            this.options = options;
            this.sent = [];
            this.subscriptions = new Map();
            sockets.push(this);
        }
        activate() {}
        deactivate() {}
        subscribe(topic, fn) { this.subscriptions.set(topic, fn); }
        publish(message) { this.sent.push(JSON.parse(message.body)); }
        event(event, privateReply = false) {
            const topic = privateReply ? '/user/queue/sync' : `/topic/projects/${projectId}`;
            this.subscriptions.get(topic)({ body: JSON.stringify({ projectId, ...event }) });
        }
    }
    return { Client, sockets };
}

test('reconnect reconciles an accepted in-flight snapshot and preserves a newer local draft on conflict', () => {
    const StompJs = transport();
    const localStorage = storage();
    const sessionStorage = storage();
    const scope = vm.createContext({ crypto, localStorage, sessionStorage,
        window: { StompJs, location: { protocol: 'https:', host: 'jukebox.test' } } });
    const Collab = vm.runInContext(source + '\nProjectCollabClient', scope);
    const project = { id: projectId, version: 1, role: 'EDITOR' };
    let snapshot = { notes: ['one'] };
    const applied = [];
    const conflicts = [];
    const options = { getProject: () => project, getSnapshot: () => snapshot,
        onRemoteEvent: (event) => applied.push(event), onConflict: (message) => conflicts.push(message) };
    const client = new Collab(options);
    client.connect(projectId);
    const ws = StompJs.sockets.at(-1);
    ws.options.onConnect();
    ws.event({ type: 'STATE_SNAPSHOT', clientId: client.clientId, revision: 1 }, true);
    client.publish('NOTES_SYNC');
    const first = ws.sent.at(-1);
    assert.equal(first.baseRevision, 1);
    ws.options.onWebSocketClose();
    snapshot = { notes: ['one', 'offline'] };
    client.publish('NOTES_SYNC');
    ws.options.onConnect();
    assert.equal(ws.sent.at(-1).type, 'REQUEST_STATE');
    ws.event({ type: 'STATE_SNAPSHOT', clientId: client.clientId, revision: 2, snapshot: first.snapshot }, true);
    const next = ws.sent.at(-1);
    assert.equal(next.baseRevision, 2);
    assert.match(next.snapshot, /offline/);
    ws.event({ type: 'CONFLICT', clientId: 'other-tab', revision: 3 }, true);
    assert.equal(client.blocked, false);
    ws.event({ type: 'CONFLICT', clientId: client.clientId, revision: 3, snapshot: '{"notes":[]}' }, true);
    assert.equal(client.blocked, true);
    assert.equal(applied.length, 0);
    assert.match(client.readDraft().snapshot, /offline/);
    client.disconnect();
    const reopened = new Collab(options);
    reopened.connect(projectId);
    assert.equal(reopened.blocked, true);
    assert.match(reopened.draft.snapshot, /offline/);
    assert.equal(conflicts.length, 2);
});

test('remote snapshots are validated before the editor changes, then apply note-off velocity and mute', async () => {
    const StompJs = transport();
    const snapshot = {
        name: 'Original', ppq: 480, stepCount: 16, tracks: [{ id: 'piano', name: 'Piano', channel: 0, program: 0 }],
        notes: [], tempos: [{ ticks: 0, bpm: 120 }], timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }],
        loopStart: 0, loopEnd: 16
    };
    const h = createEditorHarness(1, {
        StompJs, scripts: ['instruments/DrumMachine.js'], pathname: `/project/${projectId}`,
        fetch: async () => ({ ok: true, json: async () => ({
            id: projectId, name: snapshot.name, role: 'EDITOR', version: 1, projectData: snapshot
        }) })
    });
    await h.ready;
    const ws = StompJs.sockets[0];
    ws.options.onConnect();
    const invalid = { ...snapshot, notes: [{ id: 'invalid', midi: 200, ticks: 0, durationTicks: 120 }] };
    ws.event({ type: 'NOTES_SYNC', revision: 2, name: 'Invalid', snapshot: JSON.stringify(invalid) });
    assert.equal(h.engine.sequence.name, 'Original');
    assert.equal(h.engine.sequence.notes.length, 0);
    const output = h.engine.laneOutput('piano');
    const valid = { ...snapshot, stepCount: 24, loopEnd: 24, mutedLanes: ['piano'],
        instruments: { version: 1, drums: { tracks: [{ id: 'drum-kick', volume: 0.4, pan: -0.5, steps: [true] }] } },
        notes: [{ id: 'note', midi: 60, ticks: 0, durationTicks: 120, noteOffVelocity: 77 }] };
    ws.event({ type: 'REST_SYNC', revision: 3, name: 'Changed', snapshot: JSON.stringify(valid) });
    assert.equal(h.engine.sequence.name, 'Changed');
    assert.equal(h.engine.totalSteps, 24);
    assert.equal(h.engine.sequence.notes[0].noteOffVelocity, 77);
    assert.equal(h.scope.window.jukeboxDrums.getVolume('drum-kick'), 0.4);
    assert.equal(h.scope.window.jukeboxDrums.getPan('drum-kick'), -0.5);
    assert.equal(h.engine.laneGains.get('piano').gain.value, 0);
    assert.ok(output);
    ws.event({ type: 'REST_SYNC', revision: 2, name: 'Stale', snapshot: JSON.stringify(snapshot) });
    assert.equal(h.engine.sequence.name, 'Changed');
});

test('a conflicting REST save keeps a reviewable draft and requires confirmation to submit it', async () => {
    const attempts = [];
    let stale = true;
    const h = createEditorHarness(1, {
        pathname: `/project/${projectId}`,
        fetch: async (_url, options = {}) => {
            if (options.method === 'PUT') {
                attempts.push(JSON.parse(options.body));
                return stale
                    ? { ok: false, status: 409, json: async () => ({ error: 'Stale project revision' }) }
                    : { ok: true, status: 200, json: async () => ({ version: 2 }) };
            }
            return { ok: true, json: async () => ({ id: projectId, role: 'EDITOR', version: 1,
                projectData: { stepCount: 16 } }) };
        }
    });
    await h.ready;
    h.engine.sequence.addNote({ midi: 61, ticks: 10, durationTicks: 120, noteOffVelocity: 34 });
    await h.elements.saveProject.onclick();
    assert.equal(h.elements.reviewCollabDraft.hidden, false);
    assert.match(h.elements.status.textContent, /Stale project revision/);
    await h.elements.saveProject.onclick();
    assert.equal(attempts.length, 1);

    h.elements.reviewCollabDraft.onclick();
    assert.equal(h.engine.sequence.notes[0].noteOffVelocity, 34);
    stale = false;
    h.setConfirmation(false);
    await h.elements.saveProject.onclick();
    assert.equal(attempts.length, 1);
    h.setConfirmation(true);
    await h.elements.saveProject.onclick();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].version, 1);
    assert.deepEqual(JSON.parse(attempts[1].projectData).notes, JSON.parse(attempts[0].projectData).notes);
    assert.equal(h.elements.reviewCollabDraft.hidden, true);
    assert.match(h.elements.status.textContent, /Saved/);
});
