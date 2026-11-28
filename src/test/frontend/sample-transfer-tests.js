const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEditorHarness } = require('./editor-test-support');

const projectId = '11111111-1111-1111-1111-111111111111';
const otherProject = '22222222-2222-2222-2222-222222222222';
const bytes = new Uint8Array([1, 2, 3]).buffer;
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const file = { size: bytes.byteLength, name: 'fixture.wav', arrayBuffer: async () => bytes };
const urlFor = (project, id) => `https://samples.example/projects/${project}/${id}.wav`;

function cache(h, initial = new Map()) {
    h.arrangement.store.read = async (id) => initial.get(id);
    h.arrangement.store.write = async (id, data) => initial.set(id, data);
    h.engine.initContext();
    h.engine.audioContext.decodeAudioData = async () => h.engine.audioContext.createBuffer(1, 480, 48000);
    return initial;
}

test('metadata save proceeds while upload hangs, timeout aborts, and a retry can sync', async () => {
    let stalledSignal;
    let fail = true;
    let offline = false;
    let saves = 0;
    const h = createEditorHarness(1, {
        pathname: `/project/${projectId}`,
        fetch: async (url, options = {}) => {
            if (options.method === 'POST') {
                const id = JSON.parse(options.body).sha256;
                return response({ publicUrl: urlFor(projectId, id), uploadUrl: 'https://upload.example' });
            }
            if (url === 'https://upload.example') {
                if (!fail) return response(null);
                stalledSignal = options.signal;
                return new Promise(() => {});
            }
            if (options.method === 'PUT') {
                if (offline) throw new Error('Offline');
                saves++;
                return response({ version: 1 + saves });
            }
            return response({ id: projectId, role: 'EDITOR', version: 1, projectData: { stepCount: 16 } });
        }
    });
    await h.ready;
    cache(h);
    h.ArrangementEditor.transferTimeout = 35;
    const [asset] = await h.arrangement.importFiles([file]);
    const pending = h.arrangement.ensureAssetsUploaded();
    assert.ok(pending);
    await h.elements.saveProject.onclick();
    assert.equal(saves, 1);
    assert.match(h.elements.status.textContent, /1 browser only/);
    await pending;
    assert.equal(stalledSignal.aborted, true);
    assert.equal(asset.url, undefined);
    fail = false;
    await h.arrangement.ensureAssetsUploaded();
    assert.equal(asset.url, urlFor(projectId, asset.id));
    offline = true;
    await h.elements.saveProject.onclick();
    assert.equal(saves, 1);
    assert.match(h.elements.status.textContent, /Save failed: Offline/);
});

test('a storage read error falls back to cloud and an invalid hash can be retried', async () => {
    let corrupt = true;
    const h = createEditorHarness(1, { fetch: async () => ({
        ok: true, arrayBuffer: async () => corrupt ? new Uint8Array([9]).buffer : bytes
    }) });
    await h.ready;
    cache(h);
    const id = await h.SampleAssetStore.identify(bytes);
    h.arrangement.store.read = async () => { throw new Error('IndexedDB unavailable'); };
    h.arrangement.store.write = async () => { throw new Error('IndexedDB unavailable'); };
    const asset = { id, name: 'Fixture', duration: 0.01, url: urlFor(projectId, id) };
    h.engine.arrangement.assets.set(id, asset);
    await h.arrangement.restoreAssets();
    assert.equal(asset.buffer, undefined);
    assert.equal(asset.fetchFailed, true);
    corrupt = false;
    await h.arrangement.restoreAssets(true);
    assert.ok(asset.buffer);
    assert.equal(asset.fetchFailed, false);
    assert.equal(asset.local, false);
});

test('a late upload cannot attach to a different project, and each project gets its own URL', async () => {
    let currentId = projectId;
    let release;
    let started;
    const uploadStarted = new Promise((resolve) => { started = resolve; });
    const presigns = [];
    const h = createEditorHarness(1, { fetch: async (url, options) => {
        if (options.method === 'POST') {
            const project = url.split('/')[3];
            presigns.push(project);
            const id = JSON.parse(options.body).sha256;
            return response({ publicUrl: urlFor(project, id), uploadUrl: `https://upload.example/${project}` });
        }
        if (url.endsWith(projectId)) return new Promise((resolve) => { release = resolve; started(); });
        return response(null);
    } });
    await h.ready;
    h.arrangement.hooks.projectId = () => currentId;
    cache(h);
    const [first] = await h.arrangement.importFiles([file]);
    const outgoing = h.arrangement.ensureAssetsUploaded();
    await uploadStarted;
    h.engine.arrangement = new h.AudioArrangement();
    currentId = otherProject;
    const second = { id: first.id, name: first.name, duration: first.duration, url: urlFor(projectId, first.id) };
    h.engine.arrangement.assets.set(second.id, second);
    await h.arrangement.ensureAssetsUploaded();
    release(response(null));
    await outgoing;
    assert.equal(first.url, undefined);
    assert.equal(second.url, urlFor(otherProject, first.id));
    assert.deepEqual(presigns, [projectId, otherProject]);
    await h.arrangement.ensureAssetsUploaded();
    assert.equal(presigns.length, 2);
});

test('a generated drum asset takes the same project upload path after an ordinary cloud rejection', async () => {
    let presigns = 0;
    let uploaded;
    const h = createEditorHarness(1, {
        pathname: `/project/${projectId}`,
        fetch: async (url, options = {}) => {
            if (options.method === 'POST') {
                const { sha256, contentType } = JSON.parse(options.body);
                assert.equal(contentType, 'audio/wav');
                if (++presigns === 1) return response(null, 503);
                return response({ publicUrl: urlFor(projectId, sha256), uploadUrl: 'https://upload.example' });
            }
            if (url === 'https://upload.example') {
                uploaded = options.body;
                return response(null);
            }
            return response({ id: projectId, role: 'EDITOR', version: 1, projectData: { stepCount: 16 } });
        }
    });
    await h.ready;
    cache(h);
    await h.readyEvents[0].detail.editor.addDrumSample(bytes, 120);
    await h.arrangement.transfer?.job;
    const asset = [...h.engine.arrangement.assets.values()][0];
    assert.equal(asset.name, 'Drum Pattern');
    assert.equal(asset.local, true);
    assert.equal(asset.url, undefined);
    await h.arrangement.ensureAssetsUploaded();
    assert.equal(asset.url, urlFor(projectId, asset.id));
    assert.equal(uploaded, bytes);
});
