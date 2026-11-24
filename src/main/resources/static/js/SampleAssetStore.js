// Project JSON refers to SHA-256 keys. IndexedDB stores the original encoded
// bytes once per browser origin. A relink must match the original bytes.
class SampleAssetStore {
    constructor() {
        this.database = null;
        this.previewQueue = Promise.resolve();
    }

    async databaseHandle() {
        if (!this.database) {
            this.database = new Promise((resolve, reject) => {
                if (!globalThis.indexedDB) {
                    reject(new Error('Local audio storage is unavailable.'));
                    return;
                }
                const request = indexedDB.open('jukebox-audio-assets', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('audio');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
                request.onblocked = () => reject(new Error('Local audio storage is blocked.'));
            }).catch((error) => {
                this.database = null;
                throw error;
            });
        }
        return this.database;
    }

    async read(id) {
        const db = await this.databaseHandle();
        return new Promise((resolve, reject) => {
            const request = db.transaction('audio').objectStore('audio').get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async write(id, bytes) {
        const db = await this.databaseHandle();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction('audio', 'readwrite');
            transaction.objectStore('audio').put(bytes, id);
            transaction.oncomplete = () => resolve();
            transaction.onabort = transaction.onerror = () => reject(transaction.error);
        });
    }

    static async identify(bytes) {
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    preview(asset, updated, current) {
        if (typeof asset.buffer.getChannelData === 'function') {
            this.makeWaveform(asset.buffer, current).then((waveform) => {
                if (waveform && current()) { asset.waveform = waveform; updated(); }
            }).catch(() => {});
        }
        asset.previewStatus = 'pending';
        this.previewQueue = this.previewQueue.then(async () => {
            if (!current()) return;
            try {
                asset.spectrogram = await this.makePreview(asset.buffer);
                asset.previewStatus = 'ready';
            } catch {
                asset.previewStatus = 'unavailable';
            }
            if (current()) updated();
        });
    }

    async makeWaveform(audio, current = () => true) {
        const count = Math.min(2048, audio.length);
        const channels = Array.from({ length: Math.min(audio.numberOfChannels, 2) },
            (_, channel) => audio.getChannelData(channel));
        const low = new Float32Array(count);
        const high = new Float32Array(count);
        let processed = 0;
        for (let i = 0; i < count; i++) {
            const start = Math.floor(i * audio.length / count);
            const end = Math.floor((i + 1) * audio.length / count);
            let min = 1, max = -1;
            for (const pcm of channels) {
                for (let j = start; j < end; j++) {
                    min = Math.min(min, pcm[j]);
                    max = Math.max(max, pcm[j]);
                }
            }
            low[i] = min;
            high[i] = max;
            processed += (end - start) * channels.length;
            if (processed >= 262144) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (!current()) return null;
                processed = 0;
            }
        }
        return { low, high };
    }

    async makePreview(audio) {
        const fftSize = 1024;
        const width = Math.max(1, Math.min(384, Math.ceil(audio.duration * 40)));
        const height = 56;
        const channels = [];
        for (let i = 0; i < Math.min(audio.numberOfChannels, 2); i++) {
            const pcm = audio.getChannelData(i);
            const samples = new Float32Array(width * fftSize);
            for (let x = 0; x < width; x++) {
                const center = Math.floor((x + 0.5) * pcm.length / width);
                const first = Math.max(0, center - fftSize / 2);
                const end = Math.min(pcm.length, center + fftSize / 2);
                samples.set(pcm.subarray(first, end), x * fftSize + first - center + fftSize / 2);
            }
            channels.push(samples);
        }
        const pixels = await new Promise((resolve, reject) => {
            const worker = new Worker('/js/audio-spectrogram-worker.js');
            const timer = setTimeout(() => {
                worker.terminate();
                reject(new Error('Spectrogram generation timed out.'));
            }, 10000);
            const finish = (callback, value) => {
                clearTimeout(timer);
                worker.terminate();
                callback(value);
            };
            worker.onmessage = ({ data }) => finish(resolve, data);
            worker.onerror = (error) => finish(reject, error);
            try {
                worker.postMessage({ channels, width, height, fftSize, sampleRate: audio.sampleRate },
                    channels.map((channel) => channel.buffer));
            } catch (error) {
                finish(reject, error);
            }
        });
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        const data = context.createImageData(width, height);
        data.data.set(pixels);
        context.putImageData(data, 0, 0);
        return canvas;
    }
}
