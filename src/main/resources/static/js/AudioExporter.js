// A one-pass, render-ready snapshot. No live nodes or transport settings are changed.
class AudioExporter {
    static sampleRate = 44100;

    static snapshot(engine) {
        const { sequence, arrangement, mutedLanes } = engine;
        const { secondsAt } = AudioArrangement.timeMap(sequence);
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
            if (tail !== null) notes.push({ event, mix: engine.getChannelMix(note.trackId) });
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
            clips.push({ ...clip, when, duration, buffer: asset.buffer, mix: engine.getChannelMix(clip.trackId) });
            end = Math.max(end, when + duration);
        }
        if (missing.size) {
            throw new Error(`Required audio is unavailable: ${[...missing].join(', ')}. Wait for loading to finish or relink these samples in the Sample Rack, then try again.`);
        }
        const frames = Math.max(1, Math.ceil(end * this.sampleRate));
        return { frames, notes, clips, renderer, masterGain: engine.masterGain?.gain.value ?? MASTER_GAIN };
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
        const lanes = new Map();
        function output(id, { volume, pan }) {
            if (!lanes.has(id)) {
                const node = context.createGain();
                const panner = context.createStereoPanner();
                node.gain.value = volume;
                panner.pan.value = pan;
                node.connect(panner);
                panner.connect(master);
                lanes.set(id, node);
            }
            return lanes.get(id);
        }
        for (const { event, mix } of plan.notes) {
            plan.renderer.schedule(event, context, output(event.trackId, mix));
        }
        for (const clip of plan.clips) {
            const source = context.createBufferSource();
            source.buffer = clip.buffer;
            source.connect(output(clip.trackId, clip.mix));
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
