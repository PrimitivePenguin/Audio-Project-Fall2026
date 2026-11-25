class ArrangementEditor {
    constructor(engine, hooks) {
        this.engine = engine;
        this.hooks = hooks;
        this.store = new SampleAssetStore();
        this.trackId = null;
        this.clipId = null;
        this.rackAssetId = null;
        this.rackButtons = new Map();
        this.deletingAsset = false;
        this.selected = new Set();
        this.clipboard = [];
        this.razor = false;
        this.dragAsset = null;
        this.dropPreview = null;
        this.gesture = null;
        this.relinkId = null;
        this.assetJobs = Promise.resolve();
        const el = (id) => document.getElementById(id);
        this.el = el;
        const mode = el('clipVisualization');
        try { this.visualization = localStorage.getItem('jukebox-clip-view') === 'spectrogram' ? 'spectrogram' : 'waveform'; }
        catch { this.visualization = 'waveform'; }
        mode.value = this.visualization;
        mode.onchange = () => {
            this.visualization = mode.value;
            try { localStorage.setItem('jukebox-clip-view', this.visualization); } catch { /* Session preference. */ }
            this.hooks.redraw();
        };
        el('clipRazor').onclick = () => {
            this.cancelGesture();
            this.razor = !this.razor;
            el('clipRazor').setAttribute('aria-pressed', String(this.razor));
        };
        el('addAudioTrack').onclick = () => this.action(() => {
            const track = this.model.addTrack();
            this.hooks.clearMidiTrack();
            this.select(track.id);
            this.hooks.tracksChanged(track.id);
        });
        el('audioTrackSelect').onchange = () => {
            this.hooks.clearMidiTrack();
            this.select(el('audioTrackSelect').value || null);
        };
        el('renameAudioTrack').onclick = () => this.action(() => {
            const name = el('audioTrackName').value.trim();
            if (!name || name.length > 128) throw new Error('Enter an audio track name up to 128 characters.');
            this.model.tracks.get(this.trackId).name = name;
            this.hooks.tracksChanged();
        });
        el('audioClipSelect').onchange = () => {
            this.selectRackAsset(null);
            this.select(this.trackId, el('audioClipSelect').value);
        };
        el('deleteAudioClip').onclick = () => this.action(() => this.deleteSelected());
        el('duplicateAudioClip').onclick = () => this.action(() => this.duplicateSelected());
        el('sampleRack').addEventListener('click', (event) => {
            if (!event.target?.closest?.('.sample-asset')) this.selectRackAsset(null);
        });
        el('rackFiles').onchange = (event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (this.hooks.canEdit()) return this.importFiles(files);
        };
        el('relinkAudioFile').onchange = (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file && this.relinkId) return this.importFiles([file], this.relinkId);
        };
        hooks.canvas.addEventListener('dragover', (event) => this.dragOver(event));
        hooks.canvas.addEventListener('drop', (event) => this.drop(event));
        hooks.canvas.addEventListener('dragleave', () => this.cancelDrop());
    }

    get model() { return this.engine.arrangement; }

    select(trackId, clipId = null, additive = false) {
        const clip = this.model.clips.get(clipId);
        const next = additive ? new Set(this.selected) : new Set();
        if (clip) {
            if (additive && next.has(clipId)) next.delete(clipId);
            else next.add(clipId);
        }
        this.setSelection(next, trackId);
    }

    setSelection(ids, trackId = null) {
        this.selected = new Set([...ids].filter((id) => this.model.clips.has(id)));
        this.clipId = [...this.selected].at(-1) ?? null;
        this.trackId = this.model.clips.get(this.clipId)?.trackId ?? (this.model.tracks.has(trackId) ? trackId : null);
        this.refreshInspector();
        this.hooks.selectionChanged();
        this.hooks.redraw();
    }

    reset() {
        this.dragAsset = null;
        this.dropPreview = null;
        this.relinkId = null;
        this.clipboard = [];
        this.selectRackAsset(null);
        this.select(null);
        this.refreshRack();
    }

    action(callback) {
        if (this.hooks.canEdit()) this.hooks.run(callback);
    }

    refreshInspector() {
        const el = this.el;
        const track = this.model.tracks.get(this.trackId);
        const clip = this.model.clips.get(this.clipId);
        const asset = this.model.assets.get(clip?.assetId);
        const editable = this.hooks.canEdit();
        const laneKey = JSON.stringify([...this.model.tracks.values()].map(({ id, name }) => [id, name]));
        if (laneKey !== this.laneKey) {
            this.laneKey = laneKey;
            this.options('audioTrackSelect', 'Select audio lane', this.model.tracks.values(), (item) => item.name);
        }
        el('audioTrackSelect').value = track?.id ?? '';
        if (this.nameTrack !== track || (track && this.savedName !== track.name)) {
            this.nameTrack = track;
            this.savedName = track?.name;
            el('audioTrackName').value = track?.name ?? '';
        }
        if (this.optionsModel !== this.model || this.optionsTrack !== track || this.optionsRevision !== this.model.clipRevision) {
            this.optionsModel = this.model;
            this.optionsTrack = track;
            this.optionsRevision = this.model.clipRevision;
            const clips = track ? [...this.model.clips.values()].filter((item) => item.trackId === track.id) : [];
            this.options('audioClipSelect', 'Select clip', clips, (item) =>
                `${this.model.assets.get(item.assetId)?.name} · tick ${item.startTick}`);
        }
        el('audioClipSelect').value = clip?.id ?? '';
        el('addAudioTrack').disabled = !editable;
        el('clipRazor').disabled = !editable;
        el('rackFiles').disabled = !editable;
        el('audioTrackName').disabled = el('renameAudioTrack').disabled = !editable || !track;
        el('deleteAudioClip').disabled = el('duplicateAudioClip').disabled = !editable || !clip;
        el('audioClipInfo').textContent = this.selected.size > 1 ? `${this.selected.size} clips selected` : clip
            ? `${asset.name} · start tick ${clip.startTick} · source offset ${clip.sourceOffsetSeconds.toFixed(3)} s · length ${clip.playDurationSeconds.toFixed(3)} s${asset.buffer ? '' : ' · missing audio'}`
            : '';
    }

    options(id, placeholder, items, label) {
        const option = (value, text) => {
            const node = document.createElement('option');
            node.value = value;
            node.textContent = text;
            return node;
        };
        this.el(id).replaceChildren(option('', placeholder), ...Array.from(items, (item) => option(item.id, label(item))));
    }

    selectRackAsset(id) {
        this.rackAssetId = this.model.assets.has(id) ? id : null;
        for (const [assetId, { row, label }] of this.rackButtons) {
            const selected = assetId === this.rackAssetId;
            row.classList.toggle('is-selected', selected);
            label.setAttribute('aria-pressed', String(selected));
        }
    }

    deleteRackAsset() {
        const model = this.model;
        const id = this.rackAssetId;
        const asset = model.assets.get(id);
        if (!asset || !this.hooks.canEdit()) return;
        const clips = [...model.clips.values()].filter((clip) => clip.assetId === id);
        const count = clips.length;
        if (count && !window.confirm(`Delete "${asset.name}" and its ${count} referencing ${count === 1 ? 'clip' : 'clips'}?`)) return;

        this.deletingAsset = true;
        this.cancelDrop();
        this.dragAsset = null;
        const status = this.el('rackStatus');
        status.textContent = `Deleting ${asset.name}…`;
        this.assetJobs = this.assetJobs.then(async () => {
            try {
                await this.store.delete(id);
                if (this.model !== model) return;
                for (const clip of clips) model.deleteClip(clip.id);
                model.assets.delete(id);
                this.clipboard = this.clipboard.filter((clip) => clip.assetId !== id);
                this.hooks.discardAssetHistory(id);
                if (this.rackAssetId === id) this.selectRackAsset(null);
                this.setSelection(this.selected, this.trackId);
                status.textContent = `Deleted ${asset.name}.`;
            } catch (error) {
                status.textContent = `Could not delete ${asset.name}: ${error.message}`;
            } finally {
                this.deletingAsset = false;
                this.refreshRack();
            }
        });
        return this.assetJobs;
    }

    refreshRack() {
        const list = this.el('rackAssets');
        const focusedId = [...this.rackButtons].find(([, { label }]) => label === document.activeElement)?.[0];
        this.rackButtons.clear();
        list.replaceChildren();
        for (const asset of this.model.assets.values()) {
            const row = document.createElement('li');
            const label = document.createElement('button');
            label.type = 'button';
            label.className = 'sample-asset-label';
            row.onclick = () => this.selectRackAsset(asset.id);
            this.rackButtons.set(asset.id, { row, label });
            // 1. Inside refreshRack(), replace the `const status = ...` line with:
            const status = asset.loading ? 'Loading' : asset.buffer
                ? (asset.url && asset.local ? 'Ready · cloud & browser'
                    : asset.url ? 'Ready · cloud'
                    : asset.local ? 'Ready · stored in this browser'
                    : 'Ready · session only')
                : 'Missing audio · relink original file';
            label.textContent = `${asset.name} · ${asset.duration.toFixed(2)} s · ${status}`;
            const color = TrackOverview.color(asset.id);
            row.style.backgroundColor = color;
            row.style.color = ArrangementEditor.assetInk(color);
            row.className = 'sample-asset';
            row.append(label);
            if (asset.buffer) {
                row.draggable = label.draggable = true;
                const startDrag = (event) => {
                    if (!this.hooks.canEdit()) { event.preventDefault(); return; }
                    this.selectRackAsset(asset.id);
                    this.dragAsset = asset.id;
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData('application/x-jukebox-asset', asset.id);
                };
                label.addEventListener('dragstart', startDrag);
                row.addEventListener('dragstart', (event) => { if (event.target === row) startDrag(event); });
                row.addEventListener('dragend', () => { this.dragAsset = null; this.cancelDrop(); });
            } else if (!asset.loading) {
                row.append(this.button('Relink', () => {
                    this.relinkId = asset.id;
                    this.el('relinkAudioFile').click();
                }));
            }
            list.append(row);
        }
        this.selectRackAsset(this.rackAssetId);
        if (focusedId) (this.rackButtons.get(focusedId)?.label ?? this.el('rackFiles')).focus({ preventScroll: true });
        this.refreshInspector();
    }

    button(label, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.onclick = action;
        return button;
    }

    // 2. Replace importFiles(files, relinkId = null) and add the three upload helpers below it:
    importFiles(files, relinkId = null) {
        const model = this.model;
        this.assetJobs = this.assetJobs.then(async () => {
            const failures = [];
            const added = [];
            for (const file of files) {
                if (this.model !== model) return;
                try {
                    if (!(file.size > 0 && file.size <= AudioArrangement.limits.bytes)) {
                        throw new Error('Choose an audio file up to 32 MiB.');
                    }
                    const bytes = await file.arrayBuffer();
                    const id = await SampleAssetStore.identify(bytes);
                    if (relinkId && relinkId !== id) throw new Error('Choose the exact original audio file.');
                    const existing = model.assets.get(id);
                    if (existing?.buffer && existing?.url) continue;
                    if (!existing && model.assets.size >= AudioArrangement.limits.assets) throw new Error('The rack is full (64 samples).');
                    this.el('rackStatus').textContent = `Decoding ${file.name}…`;
                    const buffer = existing?.buffer ?? await this.decode(bytes, model);
                    if (this.model !== model) return;
                    const asset = existing ?? { id, name: file.name.slice(0, 255), duration: buffer.duration };
                    asset.buffer = buffer;
                    asset.fetchFailed = false;
                    model.assets.set(id, asset);
                    added.push(asset);
                    try { await this.store.write(id, bytes); asset.local = true; } catch { asset.local = false; }
                    try {
                        this.el('rackStatus').textContent = `Uploading ${file.name} to cloud…`;
                        await this.uploadAssetToCloud(asset, bytes, this.inferContentType(file));
                    } catch (uploadError) {
                        failures.push(`${file.name} (cloud sync): ${uploadError.message}`);
                    }
                    if (this.model !== model) return;
                    this.preview(asset, model);
                    this.refreshRack();
                } catch (error) {
                    failures.push(`${file.name}: ${error.message}`);
                }
            }
            if (this.model !== model) return;
            this.el('rackStatus').textContent = failures.length ? failures.join(' · ') : 'Samples are ready. Drag one onto an audio lane.';
            return added;
        });
        return this.assetJobs;
    }

    inferContentType(file) {
        if (file?.type && file.type.startsWith('audio/')) return file.type;
        const ext = file?.name?.split('.').pop()?.toLowerCase();
        const map = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4' };
        return map[ext] || 'audio/wav';
    }

    async uploadAssetToCloud(asset, bytes, contentType = 'audio/wav') {
        const projectId = this.hooks.projectId?.();
        if (!projectId || asset.url) return;
        const presignRes = await fetch(`/api/projects/${projectId}/samples/presign`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sha256: asset.id,
                fileName: asset.name,
                contentType
            })
        });
        const presign = await presignRes.json().catch(() => null);
        if (!presignRes.ok) {
            throw new Error(presign?.error || `Presign failed (${presignRes.status})`);
        }
        const uploadRes = await fetch(presign.uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=31536000, immutable'
            },
            body: bytes
        });
        if (!uploadRes.ok) {
            throw new Error(`Cloud upload failed (${uploadRes.status})`);
        }
        asset.url = presign.publicUrl;
        this.hooks.onAssetUploaded?.(asset);
    }

    async ensureAssetsUploaded() {
        const projectId = this.hooks.projectId?.();
        if (!projectId) return;
        for (const asset of this.model.assets.values()) {
            if (asset.url) continue;
            const bytes = await this.store.read(asset.id).catch(() => null);
            if (!bytes) continue;
            await this.uploadAssetToCloud(asset, bytes, this.inferContentType(asset));
        }
    }

    async decode(bytes, model) {
        this.engine.initContext();
        const buffer = await this.engine.audioContext.decodeAudioData(bytes.slice(0));
        if (!(buffer.duration > 0 && buffer.duration <= AudioArrangement.limits.duration) ||
            buffer.numberOfChannels > 2) throw new Error('Use mono or stereo audio of up to 5 minutes.');
        const bytesInMemory = [...model.assets.values()].reduce((sum, { buffer: cached }) =>
            sum + (cached ? cached.length * cached.numberOfChannels * 4 : 0), 0);
        if (bytesInMemory + buffer.length * buffer.numberOfChannels * 4 > 256 * 1024 * 1024) {
            throw new Error('The project reached its decoded-audio memory limit.');
        }
        return buffer;
    }

    preview(asset, model) {
        this.store.preview(asset, () => this.hooks.redraw(),
            () => this.model === model && model.assets.get(asset.id) === asset);
    }

    // 3. Replace restoreAssets() with:
    restoreAssets() {
        const model = this.model;
        const assets = [...model.assets.values()].filter(
            (asset) => !asset.buffer && !asset.loading && !asset.fetchFailed
        );
        if (!assets.length) return this.assetJobs;
        for (const asset of assets) asset.loading = true;
        this.refreshRack();
        this.assetJobs = this.assetJobs.then(async () => {
            for (const asset of assets) {
                if (this.model !== model) return;
                try {
                    let bytes = await this.store.read(asset.id);
                    if (!bytes && asset.url) {
                        const response = await fetch(asset.url);
                        if (!response.ok) throw new Error(`Download failed (${response.status})`);
                        const downloaded = await response.arrayBuffer();
                        if (await SampleAssetStore.identify(downloaded) !== asset.id) {
                            throw new Error('Downloaded sample hash did not match project metadata.');
                        }
                        bytes = downloaded;
                        try { await this.store.write(asset.id, bytes); asset.local = true; } catch { asset.local = false; }
                    } else if (bytes) {
                        asset.local = true;
                    }
                    if (bytes) {
                        const buffer = await this.decode(bytes, model);
                        if (this.model !== model) return;
                        asset.buffer = buffer;
                        this.preview(asset, model);
                    }
                } catch {
                    asset.fetchFailed = true;
                }
                asset.loading = false;
                if (this.model === model) { this.refreshRack(); this.hooks.redraw(); }
            }
        });
        return this.assetJobs;
    }

    place(assetId, trackId, tick) {
        const asset = this.model.assets.get(assetId);
        if (!asset?.buffer || !this.model.tracks.has(trackId)) throw new Error('Choose a loaded sample and an audio lane.');
        if (tick < 0 || tick >= this.engine.sequence.stepToTick(65536)) throw new Error('Drop inside the arrangement.');
        const start = AudioArrangement.bounds({ startTick: tick, playDurationSeconds: asset.duration },
            this.engine.sequence);
        this.hooks.extendPattern(start.endTick);
        const clip = { id: crypto.randomUUID(), assetId, trackId, startTick: tick,
            sourceOffsetSeconds: 0, playDurationSeconds: asset.duration };
        this.commit(null, clip);
    }

    commit(before, after) {
        this.applyEdit(before ? [before] : [], after ? [after] : []);
    }

    applyEdit(before, after) {
        if (this.model.clips.size - before.length + after.length > AudioArrangement.limits.clips) {
            throw new Error('The audio clip limit is 4096.');
        }
        this.restoreEdit(before, after);
        this.hooks.record(before, after);
    }

    restoreEdit(previous, next) {
        const retained = new Set(next.map((clip) => clip.id));
        for (const clip of previous) {
            if (!retained.has(clip.id)) this.model.deleteClip(clip.id);
        }
        for (const clip of next) this.model.setClip(clip);
        this.setSelection(retained, (next[0] ?? previous[0])?.trackId);
    }

    selectedClips() {
        return [...this.selected].map((id) => this.model.clips.get(id)).filter(Boolean);
    }

    deleteSelected() {
        const clips = this.selectedClips();
        if (clips.length) this.applyEdit(clips, []);
    }

    copySelected(cut = false) {
        const clips = this.selectedClips();
        if (!clips.length) return;
        this.clipboard = clips.map((clip) => ({ ...clip }));
        if (cut) this.applyEdit(clips, []);
    }

    pasteClips(clips, startTick) {
        if (!clips.length) return;
        if (clips.length + this.model.clips.size > AudioArrangement.limits.clips) throw new Error('The audio clip limit is 4096.');
        const first = Math.min(...clips.map((clip) => clip.startTick));
        const copies = clips.map((clip) => ({ ...clip, id: crypto.randomUUID(), startTick: startTick + clip.startTick - first }));
        const sequence = this.engine.sequence;
        this.hooks.extendPattern(Math.max(...copies.map((clip) => AudioArrangement.bounds(clip, sequence).endTick)));
        this.applyEdit([], copies);
    }

    duplicateSelected() {
        const clips = this.selectedClips();
        if (!clips.length) return;
        const end = Math.max(...clips.map((clip) => AudioArrangement.bounds(clip, this.engine.sequence).endTick));
        this.pasteClips(clips, Math.ceil(end - 1e-8));
    }

    dropTarget(event) {
        const point = this.hooks.point(event);
        const lane = this.hooks.laneAt(point);
        const step = this.hooks.stepAt(point);
        if (!this.hooks.inGrid(point) || step >= 65536 || step < 0) return null;
        const startTick = PianoRollEditor.snappedTicks(this.engine.sequence, step, this.hooks.snap(), true);
        return startTick < this.engine.sequence.stepToTick(65536) ? { trackId: lane?.audio ? lane.id : null, below: lane?.audio ? null : lane?.id, startTick } : null;
    }

    dragOver(event) {
        if (!this.dragAsset) return;
        event.preventDefault();
        const candidate = this.hooks.canEdit() && this.dropTarget(event);
        const target = candidate && (candidate.trackId || this.model.tracks.size < AudioArrangement.limits.tracks) && candidate;
        event.dataTransfer.dropEffect = target ? 'copy' : 'none';
        const asset = this.model.assets.get(this.dragAsset);
        this.dropPreview = target && asset?.buffer
            ? { ...target, assetId: asset.id, sourceOffsetSeconds: 0, playDurationSeconds: asset.duration } : null;
        this.el('rackStatus').textContent = target ? (target.trackId ? 'Release to place on this audio lane.' : 'Release to create an audio lane here.') : 'Drop inside the arrangement grid.';
        this.hooks.redraw();
    }

    drop(event) {
        if (!this.dragAsset) return;
        event.preventDefault();
        const assetId = this.dragAsset;
        this.dragAsset = null;
        const target = this.dropTarget(event);
        this.cancelDrop();
        this.action(() => {
            if (!target) throw new Error('Drop inside the arrangement grid.');
            if (this.model.clips.size >= AudioArrangement.limits.clips) throw new Error('The audio clip limit is 4096.');
            let trackId = target.trackId;
            if (!trackId) {
                const asset = this.model.assets.get(assetId);
                if (!asset?.buffer) return;
                if (this.model.tracks.size >= AudioArrangement.limits.tracks) throw new Error('The audio track limit is 64.');
                this.hooks.extendPattern(AudioArrangement.bounds({ startTick: target.startTick,
                    playDurationSeconds: asset.duration }, this.engine.sequence).endTick);
                trackId = this.hooks.createLane(target.below);
            }
            this.place(assetId, trackId, target.startTick);
            this.el('rackStatus').textContent = 'Sample placed.';
        });
    }

    cancelDrop() {
        if (!this.dropPreview) return;
        this.dropPreview = null;
        this.el('rackStatus').textContent = 'Drag a loaded sample onto an audio lane.';
        this.hooks.redraw();
    }

    clipAt(point, track) {
        const row = (point.y + this.hooks.scrollTop() - PianoRollEditor.geometry.rulerHeight) % TrackOverview.laneHeight;
        if (!this.hooks.inGrid(point) || row < 7 || row >= TrackOverview.laneHeight - 7) return null;
        const sequence = this.engine.sequence;
        const step = this.hooks.stepAt(point);
        // Include the minimum visible width when hitting very short clips.
        const ticksPerPixel = sequence.stepToTick(1 / PianoRollEditor.geometry.stepWidth);
        const tick = sequence.stepToTick(step);
        const hits = this.model.query(sequence, tick - 8 * ticksPerPixel, tick + 1e-8, true)
            .filter(({ clip, endTick }) => clip.trackId === track.id && clip.startTick <= tick &&
                Math.max(endTick, clip.startTick + 8 * ticksPerPixel) >= tick);
        return hits.find(({ clip }) => clip.id === this.clipId) ?? hits.at(-1);
    }

    begin(event, point, track) {
        this.hooks.clearMidiTrack();
        const hit = this.clipAt(point, track);
        this.select(track.id, hit?.clip.id, event.shiftKey && Boolean(hit));
        if (!hit || event.shiftKey || !this.hooks.canEdit()) return;
        if (this.razor) {
            this.gesture = { hit, razor: true, startY: event.clientY, pointerId: event.pointerId };
            this.hooks.canvas.setPointerCapture(event.pointerId);
            this.move(event);
            event.preventDefault();
            return;
        }
        const step = this.hooks.stepAt(point);
        const pixels = PianoRollEditor.geometry.stepWidth;
        const leftDistance = Math.abs(step - this.engine.sequence.tickToStep(hit.clip.startTick)) * pixels;
        const rightStep = Math.max(this.engine.sequence.tickToStep(hit.endTick),
            this.engine.sequence.tickToStep(hit.clip.startTick) + 8 / pixels);
        const rightDistance = Math.abs(step - rightStep) * pixels;
        const clipWidth = (rightStep - this.engine.sequence.tickToStep(hit.clip.startTick)) * pixels;
        const edge = Math.min(leftDistance, rightDistance) <= Math.min(4, clipWidth / 3)
            ? (leftDistance <= rightDistance ? 'left' : 'right') : null;
        this.gesture = { hit, edge, step, pointerId: event.pointerId,
            clientX: event.clientX, clientY: event.clientY, preview: null };
        this.hooks.canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    move(event) {
        const g = this.gesture;
        if (!g || g.pointerId !== event.pointerId) return;
        g.clientX = event.clientX;
        g.clientY = event.clientY;
        const point = this.hooks.point(event);
        const lane = this.hooks.laneAt(point);
        const clip = g.hit.clip;
        const sequence = this.engine.sequence;
        if (g.razor) {
            g.cutTick = PianoRollEditor.snappedTicks(sequence, this.hooks.stepAt(point), this.hooks.snap());
            this.hooks.redraw();
            return;
        }
        const delta = PianoRollEditor.snappedTicks(sequence, this.hooks.stepAt(point) - g.step, this.hooks.snap());
        const lastTick = Math.ceil(sequence.stepToTick(this.engine.totalSteps)) - 1;
        if (g.edge) {
            const anchor = g.edge === 'left' ? clip.startTick : g.hit.endTick;
            g.preview = delta ? AudioArrangement.trim(clip, g.edge, Math.min(lastTick + 1, anchor + delta),
                sequence, this.model.assets.get(clip.assetId)) : null;
        } else {
            g.preview = lane?.audio && this.hooks.inGrid(point) && (delta || lane.id !== clip.trackId)
                ? { ...clip, trackId: lane.id, startTick: Math.max(0, Math.min(lastTick, clip.startTick + delta)) } : null;
        }
        this.hooks.redraw();
    }

    finish(event) {
        if (this.gesture?.pointerId !== event.pointerId) return;
        this.move(event);
        const { hit, preview, razor, cutTick, startY } = this.gesture;
        this.cancelGesture();
        if (razor && event.clientY - startY >= 8) {
            this.action(() => {
                const parts = AudioArrangement.split(hit.clip, cutTick, this.engine.sequence);
                if (parts) this.applyEdit([hit.clip], parts);
            });
        } else if (preview) this.action(() => {
            this.hooks.extendPattern(AudioArrangement.bounds(preview, this.engine.sequence).endTick);
            this.commit(hit.clip, preview);
        });
    }

    cancelGesture() {
        if (!this.gesture) return;
        const { pointerId } = this.gesture;
        this.gesture = null;
        this.hooks.release(pointerId);
        this.hooks.redraw();
    }

    draw(context, lane, view) {
        const sequence = this.engine.sequence;
        const { keyboardWidth, rulerHeight, stepWidth } = PianoRollEditor.geometry;
        const start = sequence.stepToTick((view.scrollLeft - 8) / stepWidth);
        const end = sequence.stepToTick((view.scrollLeft + view.width - keyboardWidth) / stepWidth);
        const assets = this.model.assets;
        const entries = view.clipsByLane.get(lane.track.id) ?? [];
        const preview = this.gesture?.preview ?? this.dropPreview;
        const selected = this.selected;
        const mode = this.visualization;
        for (const entry of entries) if (entry.clip.id !== preview?.id && !selected.has(entry.clip.id)) paint(entry);
        for (const entry of entries) if (entry.clip.id !== preview?.id && selected.has(entry.clip.id)) paint(entry, true);
        if (preview?.trackId === lane.track.id) paint(AudioArrangement.bounds(preview, sequence), true);

        const cut = this.gesture;
        if (cut?.razor && cut.hit.clip.trackId === lane.track.id &&
            cut.cutTick > cut.hit.clip.startTick && cut.cutTick < cut.hit.endTick) {
            const x = keyboardWidth + sequence.tickToStep(cut.cutTick) * stepWidth - view.scrollLeft;
            const y = rulerHeight + lane.index * TrackOverview.laneHeight - view.scrollTop + 7;
            context.fillStyle = '#fff2af';
            context.fillRect(x - 1, y, 2, TrackOverview.laneHeight - 14);
        }

        function paint(entry, highlight = false) {
            const { clip, endTick } = entry;
            const asset = assets.get(clip.assetId);
            const x = keyboardWidth + sequence.tickToStep(clip.startTick) * stepWidth - view.scrollLeft;
            const y = rulerHeight + lane.index * TrackOverview.laneHeight - view.scrollTop + 7;
            const width = Math.max(8, sequence.tickToStep(endTick - clip.startTick) * stepWidth);
            const height = TrackOverview.laneHeight - 14;
            const left = Math.max(keyboardWidth, x);
            const right = Math.min(view.width, x + width);
            if (right <= left) return;
            const top = Math.max(rulerHeight, y);
            const bottom = Math.min(view.height, y + height);
            if (bottom <= top) return;
            view.clipMasks.push({ x: left + view.scrollLeft, y: top + view.scrollTop,
                width: right - left, height: bottom - top, opaque: true });
            const color = TrackOverview.color(asset.id);
            const ink = ArrangementEditor.assetInk(color);
            context.fillStyle = color;
            context.fillRect(left, y, right - left, height);
            if (mode === 'spectrogram' && asset.spectrogram) {
                const bounds = { y: y + 18, height: height - 18, scrollLeft: view.scrollLeft };
                ArrangementEditor.paintSpectrum(context, entry, asset, sequence, bounds, start, end);
            }
            if (mode === 'waveform' && asset.waveform) {
                const signalEnd = x + Math.max(1, sequence.tickToStep(endTick - clip.startTick) * stepWidth);
                ArrangementEditor.paintWaveform(context, entry, asset, sequence, { left,
                    right: Math.min(right, signalEnd), y: y + 18, height: height - 18, scrollLeft: view.scrollLeft }, ink);
            }
            context.save();
            context.beginPath();
            context.rect(left, y, right - left, height);
            context.clip();
            context.fillStyle = ink;
            context.font = '11px system-ui';
            context.textAlign = 'left';
            context.fillText(asset.name + (!asset.buffer ? ' · missing' : ''), left + 4, y + 13);
            if (mode === 'spectrogram' && asset.buffer && !asset.spectrogram && right - left > 100) {
                context.fillText(asset.previewStatus === 'pending' ? 'Preparing spectrogram…' : 'Spectrogram unavailable',
                    left + 4, y + 32);
            }
            context.strokeStyle = highlight ? '#ffd68b' : asset.buffer ? '#3d4954' : ink;
            if (!asset.buffer && !highlight) context.setLineDash([3, 2]);
            context.lineWidth = highlight ? 2 : 1;
            context.strokeRect(x, y, width, height);
            context.restore();
        }
    }

    static assetInk(color) {
        const [r, g, b] = color.slice(1).match(/../g).map((hex) => {
            const channel = parseInt(hex, 16) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#000000' : '#ffffff';
    }

    static paintWaveform(context, entry, asset, sequence, bounds, ink) {
        const { low, high } = asset.waveform;
        const { keyboardWidth, stepWidth } = PianoRollEditor.geometry;
        const map = AudioArrangement.timeMap(sequence);
        const sourceBin = (x) => {
            const tick = sequence.stepToTick((x + bounds.scrollLeft - keyboardWidth) / stepWidth);
            const seconds = Math.min(entry.endSeconds, Math.max(entry.startSeconds, map.secondsAt(tick)));
            return (entry.clip.sourceOffsetSeconds + seconds - entry.startSeconds) / asset.duration * low.length;
        };
        const center = bounds.y + bounds.height / 2;
        const amplitude = (bounds.height - 4) / 2;
        context.strokeStyle = ink;
        context.lineWidth = 1;
        context.beginPath();
        let from = sourceBin(bounds.left);
        for (let x = bounds.left; x < bounds.right; x++) {
            const to = sourceBin(Math.min(x + 1, bounds.right));
            const first = Math.max(0, Math.min(low.length - 1, Math.floor(from)));
            const last = Math.min(low.length, Math.max(first + 1, Math.ceil(to)));
            let min = 1, max = -1;
            for (let i = first; i < last; i++) {
                min = Math.min(min, low[i]);
                max = Math.max(max, high[i]);
            }
            context.moveTo(x + 0.5, center - Math.min(1, max) * amplitude);
            context.lineTo(x + 0.5, center - Math.max(-1, min) * amplitude + 0.5);
            from = to;
        }
        context.stroke();
    }

    static paintSpectrum(context, entry, asset, sequence, bounds, start, end) {
        const image = asset.spectrogram;
        const left = Math.max(entry.clip.startTick, start + sequence.stepToTick(8 / PianoRollEditor.geometry.stepWidth));
        const right = Math.min(entry.endTick, end);
        if (right <= left) return;
        const { keyboardWidth, stepWidth } = PianoRollEditor.geometry;
        const map = AudioArrangement.timeMap(sequence);
        const firstTempo = map.upperBound(left, 'ticks');
        const lastTempo = map.upperBound(right, 'ticks');
        const visiblePixels = Math.max(1, Math.ceil(sequence.tickToStep(right - left) * stepWidth));
        // Exact affine slices at ordinary tempo boundaries. When there are more
        // tempo events than screen pixels, sample the map at pixel resolution.
        const inner = lastTempo - firstTempo > visiblePixels
            ? Array.from({ length: visiblePixels - 1 }, (_, i) => left + (right - left) * (i + 1) / visiblePixels)
            : map.points.slice(firstTempo, lastTempo).map(({ ticks }) => ticks);
        const boundaries = [left, ...inner, right];
        const sourceX = (tick) => Math.max(0, Math.min(image.width, (entry.clip.sourceOffsetSeconds +
            map.secondsAt(tick) - entry.startSeconds) * image.width / asset.duration));
        for (let i = 1; i < boundaries.length; i++) {
            const a = boundaries[i - 1], b = boundaries[i];
            const first = sourceX(a), width = sourceX(b) - first;
            if (width <= 0) continue;
            context.drawImage(image, first, 0, width, image.height,
                keyboardWidth + sequence.tickToStep(a) * stepWidth - bounds.scrollLeft,
                bounds.y, sequence.tickToStep(b - a) * stepWidth, bounds.height);
        }
    }
}
