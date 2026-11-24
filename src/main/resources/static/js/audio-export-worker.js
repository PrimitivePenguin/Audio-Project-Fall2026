function pcm16(value) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
    return Math.round(sample * (sample < 0 ? 32768 : 32767));
}

function wav(left, right, sampleRate) {
    const bytes = new ArrayBuffer(44 + left.length * 4);
    const view = new DataView(bytes);
    function tag(offset, text) {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    }
    tag(0, 'RIFF');
    view.setUint32(4, bytes.byteLength - 8, true);
    tag(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    tag(36, 'data');
    view.setUint32(40, left.length * 4, true);
    for (let i = 0; i < left.length; i++) {
        view.setInt16(44 + i * 4, pcm16(left[i]), true);
        view.setInt16(46 + i * 4, pcm16(right[i]), true);
    }
    return new Blob([bytes], { type: 'audio/wav' });
}

function mp3(left, right, sampleRate) {
    importScripts('/js/vendor/lamejs-1.2.7.js');
    const encoder = new lamejs.Mp3Encoder(2, sampleRate, 192);
    const size = 1152;
    const l = new Int16Array(size);
    const r = new Int16Array(size);
    const frames = [];
    for (let offset = 0; offset < left.length; offset += size) {
        const length = Math.min(size, left.length - offset);
        for (let i = 0; i < length; i++) {
            l[i] = pcm16(left[offset + i]);
            r[i] = pcm16(right[offset + i]);
        }
        const frame = encoder.encodeBuffer(l.subarray(0, length), r.subarray(0, length));
        if (frame.length) frames.push(frame);
        if (offset % (size * 100) === 0) postMessage({ progress: offset / left.length });
    }
    frames.push(encoder.flush());
    return new Blob(frames, { type: 'audio/mpeg' });
}

self.onmessage = ({ data: { left, right, format, sampleRate } }) => {
    try {
        postMessage({ blob: (format === 'mp3' ? mp3 : wav)(left, right, sampleRate) });
    } catch (error) {
        postMessage({ error: error.message || 'Audio encoding failed.' });
    }
};
