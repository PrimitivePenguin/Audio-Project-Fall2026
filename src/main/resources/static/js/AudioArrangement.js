// Arrangement metadata is independent of MIDI notes and legacy step-trigger tracks.
class AudioArrangement {
    static tempoCache = new WeakMap();
    static limits = { assets: 64, tracks: 64, clips: 4096, bytes: 32 * 1024 * 1024, duration: 300 };

    constructor(data) {
        this.tracks = new Map();
        this.assets = new Map();
        this.clips = new Map();
        this.laneOrder = [];
        this.index = null;
        this.clipRevision = 0;
        if (data?.version !== 1) return;
        for (const item of Array.isArray(data.tracks) ? data.tracks : []) {
            if (this.tracks.size >= AudioArrangement.limits.tracks) break;
            if (typeof item?.id !== 'string' || !item.id.startsWith('audio-') ||
                typeof item.name !== 'string') continue;
            this.tracks.set(item.id, { id: item.id, name: item.name.slice(0, 128), audio: true });
        }
        for (const item of Array.isArray(data.assets) ? data.assets : []) {
            if (this.assets.size >= AudioArrangement.limits.assets) break;
            if (!item || !/^[a-f0-9]{64}$/.test(item.id) || typeof item.name !== 'string' ||
                !(item.duration > 0 && item.duration <= AudioArrangement.limits.duration)) continue;
            this.assets.set(item.id, { id: item.id, name: item.name.slice(0, 255), duration: item.duration });
        }
        for (const item of Array.isArray(data.clips) ? data.clips : []) {
            if (this.clips.size >= AudioArrangement.limits.clips) break;
            try { this.setClip(item); } catch { /* A bad clip must not prevent recovery of the project. */ }
        }
        if (Array.isArray(data.laneOrder)) this.laneOrder = [...new Set(data.laneOrder)].filter((id) => typeof id === 'string');
    }

    addTrack(name = `Audio ${this.tracks.size + 1}`) {
        if (this.tracks.size >= AudioArrangement.limits.tracks) throw new Error('The audio track limit is 64.');
        const track = { id: `audio-${crypto.randomUUID()}`, name, audio: true };
        this.tracks.set(track.id, track);
        return track;
    }

    orderedTracks(midiTracks) {
        const tracks = new Map([...midiTracks, ...this.tracks.values()].map((track) => [track.id, track]));
        const ordered = [];
        // MIDI-only operations keep their existing ordering authority. Preserve the slots occupied by audio lanes.
        const template = this.laneOrder.filter((id) => tracks.has(id));
        let midiIndex = 0;
        for (const id of template) {
            const track = this.tracks.get(id) ?? midiTracks[midiIndex++];
            if (track && tracks.delete(track.id)) ordered.push(track);
        }
        return [...ordered, ...tracks.values()];
    }

    setClip(data) {
        const { id, trackId, assetId, startTick, sourceOffsetSeconds, playDurationSeconds } = data;
        const asset = this.assets.get(assetId);
        if (typeof id !== 'string' || !this.tracks.has(trackId) || !asset ||
            !Number.isSafeInteger(startTick) || startTick < 0 ||
            !Number.isFinite(sourceOffsetSeconds) || sourceOffsetSeconds < 0 ||
            !Number.isFinite(playDurationSeconds) || playDurationSeconds <= 0 ||
            sourceOffsetSeconds + playDurationSeconds > asset.duration + 1e-8) {
            throw new Error('Invalid audio clip timing or source.');
        }
        if (!this.clips.has(id) && this.clips.size >= AudioArrangement.limits.clips) {
            throw new Error('The audio clip limit is 4096.');
        }
        const clip = { id, trackId, assetId, startTick, sourceOffsetSeconds, playDurationSeconds };
        this.clips.set(id, clip);
        this.clipRevision++;
        this.index = null;
        return clip;
    }

    deleteClip(id) {
        if (this.clips.delete(id)) this.clipRevision++;
        this.index = null;
    }

    createClip(assetId, trackId, startTick) {
        return this.setClip({
            id: crypto.randomUUID(), trackId, assetId, startTick, sourceOffsetSeconds: 0,
            playDurationSeconds: this.assets.get(assetId)?.duration
        });
    }

    static timeMap(sequence) {
        const cached = this.tempoCache.get(sequence);
        if (cached?.source === sequence.tempos) return cached;
        let previous = { ticks: 0, seconds: 0, bpm: 120 };
        const points = [previous];
        for (const { ticks, bpm } of sequence.tempos) {
            const seconds = previous.seconds + (ticks - previous.ticks) * 60 / (previous.bpm * sequence.ppq);
            previous = { ticks, seconds, bpm };
            points.push(previous);
        }
        const upperBound = (value, key) => {
            let low = 0;
            let high = points.length;
            while (low < high) {
                const middle = Math.floor((low + high) / 2);
                if (points[middle][key] <= value) low = middle + 1;
                else high = middle;
            }
            return low;
        };
        const map = {
            source: sequence.tempos, points, upperBound,
            tempoAt(ticks) { return points[Math.max(0, upperBound(ticks, 'ticks') - 1)].bpm; },
            secondsAt(ticks) {
                const p = points[Math.max(0, upperBound(ticks, 'ticks') - 1)];
                return p.seconds + (ticks - p.ticks) * 60 / (p.bpm * sequence.ppq);
            },
            tickAt(seconds) {
                const p = points[Math.max(0, upperBound(seconds, 'seconds') - 1)];
                return p.ticks + (seconds - p.seconds) * p.bpm * sequence.ppq / 60;
            }
        };
        this.tempoCache.set(sequence, map);
        return map;
    }

    static bounds(clip, sequence) {
        const map = this.timeMap(sequence);
        const startSeconds = map.secondsAt(clip.startTick);
        const endSeconds = startSeconds + clip.playDurationSeconds;
        return { clip, startSeconds, endSeconds, endTick: map.tickAt(endSeconds) };
    }

    static trim(clip, edge, tick, sequence, asset) {
        const { startSeconds, endSeconds } = this.bounds(clip, sequence);
        const map = this.timeMap(sequence);
        const minimum = Math.min(clip.playDurationSeconds, 0.001);
        if (edge === 'right') {
            const available = asset.duration - clip.sourceOffsetSeconds;
            return { ...clip, playDurationSeconds: Math.min(available,
                Math.max(minimum, map.secondsAt(tick) - startSeconds)) };
        }
        const earliest = Math.max(0, Math.ceil(map.tickAt(startSeconds - clip.sourceOffsetSeconds) - 1e-8));
        const latest = Math.max(clip.startTick, Math.floor(map.tickAt(endSeconds - minimum) + 1e-8));
        const startTick = Math.max(earliest, Math.min(latest, tick));
        const seconds = map.secondsAt(startTick);
        return { ...clip, startTick, sourceOffsetSeconds: Math.max(0, clip.sourceOffsetSeconds + seconds - startSeconds),
            playDurationSeconds: endSeconds - seconds };
    }

    static split(clip, tick, sequence) {
        if (!Number.isSafeInteger(tick) || tick <= clip.startTick) return null;
        const map = this.timeMap(sequence);
        const leftDuration = map.secondsAt(tick) - map.secondsAt(clip.startTick);
        const rightDuration = clip.playDurationSeconds - leftDuration;
        if (leftDuration < 0.001 || rightDuration < 0.001) return null;
        return [
            { ...clip, playDurationSeconds: leftDuration },
            { ...clip, id: crypto.randomUUID(), startTick: tick,
                sourceOffsetSeconds: clip.sourceOffsetSeconds + leftDuration, playDurationSeconds: rightDuration }
        ];
    }

    getIndex(sequence) {
        if (this.index?.sequence === sequence && this.index.tempos === sequence.tempos) return this.index;
        const entries = [...this.clips.values()].map((clip) => AudioArrangement.bounds(clip, sequence))
            .sort((a, b) => a.clip.startTick - b.clip.startTick);
        const counts = new Map();
        const build = (from, to) => {
            if (from >= to) return null;
            const middle = Math.floor((from + to) / 2);
            const entry = entries[middle];
            const left = build(from, middle);
            const right = build(middle + 1, to);
            counts.set(entry.clip.trackId, (counts.get(entry.clip.trackId) ?? 0) + 1);
            return { entry, left, right, maxEnd: Math.max(entry.endTick, left?.maxEnd ?? 0, right?.maxEnd ?? 0) };
        };
        return this.index = { sequence, tempos: sequence.tempos, root: build(0, entries.length), counts };
    }

    query(sequence, start, end, includeHeld) {
        if (!this.clips.size) return [];
        const result = [];
        const visit = (node) => {
            if (!node || (includeHeld && node.maxEnd <= start)) return;
            const { entry, left, right } = node;
            // Onset-only queries can skip the entire left subtree before the start.
            if (includeHeld || entry.clip.startTick >= start) visit(left);
            if (entry.clip.startTick >= end) return;
            if (entry.clip.startTick >= start || (includeHeld && entry.endTick > start)) result.push(entry);
            visit(right);
        };
        visit(this.getIndex(sequence).root);
        return result;
    }

    retime(fromPpq, toPpq) {
        if (fromPpq === toPpq) return;
        const clips = [...this.clips.values()].map((clip) => ({
            ...clip, startTick: clip.startTick * toPpq / fromPpq
        }));
        if (clips.some((clip) => !Number.isSafeInteger(clip.startTick))) {
            throw new Error('These MIDI resolutions cannot be combined without changing audio clip positions.');
        }
        for (const clip of clips) this.setClip(clip);
    }

    toJSON() {
        return {
            version: 1, laneOrder: [...this.laneOrder],
            tracks: [...this.tracks.values()].map(({ id, name }) => ({ id, name })),
            assets: [...this.assets.values()].map(({ id, name, duration }) => ({ id, name, duration })),
            clips: [...this.clips.values()].map((clip) => ({ ...clip }))
        };
    }
}
