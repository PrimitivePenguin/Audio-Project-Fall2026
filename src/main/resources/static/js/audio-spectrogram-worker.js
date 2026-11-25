// One Hann-windowed FFT per sampled time column and channel. Rows aggregate
// bins on a logarithmic frequency axis, with the highest frequencies at the top.
function spectrogram({ channels, width, fftSize, sampleRate, height }) {
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);
    const energy = new Float64Array(fftSize / 2);
    const reverse = new Uint16Array(fftSize);
    const window = new Float64Array(fftSize);
    const bytes = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < fftSize; i++) {
        reverse[i] = (reverse[i >> 1] >> 1) | ((i & 1) * (fftSize >> 1));
        window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1));
    }
    const lowerBin = Math.max(1, 40 * fftSize / sampleRate);
    for (let column = 0; column < width; column++) {
        energy.fill(0);
        for (const channel of channels) {
            imag.fill(0);
            for (let i = 0; i < fftSize; i++) real[reverse[i]] = channel[column * fftSize + i] * window[i];
            for (let span = 2; span <= fftSize; span *= 2) {
                const half = span / 2;
                for (let bin = 0; bin < half; bin++) {
                    const angle = -2 * Math.PI * bin / span;
                    const cos = Math.cos(angle), sin = Math.sin(angle);
                    for (let i = bin; i < fftSize; i += span) {
                        const j = i + half;
                        const r = real[j] * cos - imag[j] * sin;
                        const im = real[j] * sin + imag[j] * cos;
                        real[j] = real[i] - r;
                        imag[j] = imag[i] - im;
                        real[i] += r;
                        imag[i] += im;
                    }
                }
            }
            for (let k = 0; k < energy.length; k++) energy[k] += real[k] ** 2 + imag[k] ** 2;
        }
        for (let row = 0; row < height; row++) {
            const low = Math.max(1, Math.floor(lowerBin * (energy.length / lowerBin) ** (row / height)));
            const high = Math.min(energy.length, Math.max(low + 1,
                Math.ceil(lowerBin * (energy.length / lowerBin) ** ((row + 1) / height))));
            let peak = 0;
            for (let bin = low; bin < high; bin++) peak = Math.max(peak, energy[bin]);
            const db = 10 * Math.log10(peak / (fftSize / 4) ** 2 / channels.length + 1e-12);
            const value = Math.max(0, Math.min(1, (db + 78) / 78));
            const pixel = ((height - row - 1) * width + column) * 4;
            bytes[pixel] = 22 + 219 * value ** 2;
            bytes[pixel + 1] = 34 + 180 * value;
            bytes[pixel + 2] = 47 + 147 * Math.sqrt(value);
            // Let low-energy bins reveal the asset color beneath the spectral detail.
            bytes[pixel + 3] = 255 * value;
        }
    }
    return bytes;
}

if (typeof self !== 'undefined') {
    self.onmessage = ({ data }) => {
        const pixels = spectrogram(data);
        self.postMessage(pixels, [pixels.buffer]);
    };
}
