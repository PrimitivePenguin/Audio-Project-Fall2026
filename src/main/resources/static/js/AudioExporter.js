// A one-pass, render-ready snapshot. No live nodes or transport settings are changed.
class AudioExporter {
    static sampleRate = 44100;

    static snapshot(engine) {
        const { sequence, arrangement, mutedLanes } = engine;
        const timeMap = AudioArrangement.timeMap(sequence);
        const { secondsAt } = timeMap;
        const bpm = timeMap.tempoAt(0);
        const slowestBpm = timeMap.points.reduce((slowest, event) => Math.min(slowest, event.bpm), bpm);
        const lanes = new Map();
        const addLane = (id, startTime, endTime) => {
            if (!lanes.has(id)) lanes.set(id, { mix: engine.getChannelMix(id), curves: new Map(), startTime, endTime });
            const lane = lanes.get(id);
            lane.startTime = Math.min(lane.startTime, startTime);
            lane.endTime = Math.max(lane.endTime, endTime);
        };
        const tracks = new Map(sequence.tracks.map((track) => [track.id, track]));
        const notes = [];
        const clips = [];
        const missing = new Set();
        let end = secondsAt(sequence.stepToTick(sequence.stepCount));
        let renderer;

        for (const note of sequence.notes) {
            const track = tracks.get(note.trackId);
            if (mutedLanes.has(note.trackId) || !track) continue;
            renderer ??= engine.instrumentManager?.createOfflineRenderer?.();
            if (!renderer) throw new Error(`The instrument on "${track.name}" does not support offline audio export.`);
            const when = secondsAt(note.ticks);
            const noteEnd = secondsAt(note.ticks + note.durationTicks);
            const event = { ...note, channel: track.channel, program: track.program, when, duration: noteEnd - when };
            const tail = renderer.endTime(event);
            end = Math.max(end, noteEnd, tail ?? 0);
            if (tail !== null) {
                notes.push({ event });
                addLane(note.trackId, when, tail ?? noteEnd);
            }
        }

        for (const clip of arrangement.clips.values()) {
            if (mutedLanes.has(clip.trackId)) continue;
            const asset = arrangement.assets.get(clip.assetId);
            if (!asset?.buffer) {
                missing.add(asset?.name ?? clip.assetId);
                continue;
            }
            const when = secondsAt(clip.startTick);
            const duration = Math.min(clip.playDurationSeconds, asset.buffer.duration - clip.sourceOffsetSeconds);
            if (duration <= 0 || duration + 1 / asset.buffer.sampleRate < clip.playDurationSeconds) {
                throw new Error(`The source audio for "${asset.name}" is shorter than its clip. Relink the original sample.`);
            }
            clips.push({ ...clip, when, duration, buffer: asset.buffer });
            addLane(clip.trackId, when, when + duration);
            end = Math.max(end, when + duration);
        }
        if (missing.size) {
            throw new Error(`Required audio is unavailable: ${[...missing].join(', ')}. Wait for loading to finish or relink these samples in the Sample Rack, then try again.`);
        }
        for (const { channelId, key, points } of engine.snapshotAutomation().lanes) {
            lanes.get(channelId)?.curves.set(key, points);
        }
        for (const { mix, curves, startTime, endTime } of lanes.values()) {
            const firstTick = timeMap.tickAt(startTime);
            const lastTick = timeMap.tickAt(endTime);
            const peak = (key, throughTail = false) => {
                const points = curves.get(key);
                if (!points) return mix[key];
                const first = SequencerEngine.interpolateAutomation(points, firstTick, false);
                const last = throughTail ? points.at(-1).tick : lastTick;
                return points.reduce((max, point) => point.tick >= firstTick && point.tick <= last
                    ? Math.max(max, point.value) : max,
                Math.max(first, SequencerEngine.interpolateAutomation(points, last, false)));
            };
            let tail = peak('reverbSend') > 0 ? REVERB_SECONDS : 0;
            if (peak('delaySend') > 0) {
                const feedback = peak('delayFeedback', true);
                const repeats = feedback > 0 ? 1 + Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1;
                tail = Math.max(tail, Math.min(20, repeats * SequencerEngine.delaySeconds(mix.delayBeats, slowestBpm)));
            }
            end = Math.max(end, endTime + tail);
        }
        const frames = Math.max(1, Math.ceil(end * this.sampleRate));
        return { frames, notes, clips, renderer, lanes, timeMap, bpm, masterGain: engine.masterGain?.gain.value ?? MASTER_GAIN };
    }

    static checkBudget(plan) {
        // Stereo render, channel copies for the worker, PCM/download allocations and Web Audio nodes.
        const sources = new Set(plan.clips.map(({ buffer }) => buffer));
        let bytes = plan.frames * 24 + plan.notes.length * 8192 + plan.clips.length * 4096;
        for (const source of sources) bytes += source.length * source.numberOfChannels * 4;
        if (!Number.isSafeInteger(bytes) || bytes > 512 * 1024 ** 2) {
            throw new Error('This arrangement exceeds the browser export memory budget. Shorten the composition or export from a smaller project.');
        }
    }

    static async render(plan, Context = window.OfflineAudioContext || window.webkitOfflineAudioContext) {
        if (!Context) throw new Error('This browser does not support offline audio rendering.');
        this.checkBudget(plan);
        const context = new Context(2, plan.frames, this.sampleRate);
        const master = context.createGain();
        master.gain.value = plan.masterGain;
        master.connect(context.destination);
        const outputs = new Map();
        const endTick = plan.timeMap.tickAt(plan.frames / this.sampleRate);
        for (const [id, { mix, curves }] of plan.lanes) {
            const strip = SequencerEngine.buildStrip(context, mix, master, plan.bpm);
            outputs.set(id, strip.gain);
            for (const [key, points] of curves) {
                SequencerEngine.scheduleAutomationCurve(strip, mix, key, points, 0, endTick, plan.timeMap);
            }
            SequencerEngine.scheduleDelayTempo(strip, mix.delayBeats, 0, endTick, plan.timeMap);
        }
        for (const { event } of plan.notes) {
            plan.renderer.schedule(event, context, outputs.get(event.trackId));
        }
        for (const clip of plan.clips) {
            const source = context.createBufferSource();
            source.buffer = clip.buffer;
            source.connect(outputs.get(clip.trackId));
            source.start(clip.when, clip.sourceOffsetSeconds, clip.duration);
        }
        return context.startRendering();
    }

    static encode(buffer, format, progress) {
        return new Promise((resolve, reject) => {
            const left = buffer.getChannelData(0).slice();
            const right = buffer.getChannelData(1).slice();
            const worker = new Worker('/js/audio-export-worker.js');
            const fail = (message) => {
                worker.terminate();
                reject(new Error(message));
            };
            worker.onerror = (event) => fail(event.message || 'Could not start the audio encoder.');
            worker.onmessageerror = () => fail('Could not receive the encoded audio.');
            worker.onmessage = ({ data }) => {
                if (data.error) fail(data.error);
                else if (data.blob) {
                    worker.terminate();
                    resolve(data.blob);
                } else progress?.(data.progress);
            };
            try {
                worker.postMessage({ left, right, format, sampleRate: buffer.sampleRate }, [left.buffer, right.buffer]);
            } catch (error) {
                fail(error.message);
            }
        });
    }
}
