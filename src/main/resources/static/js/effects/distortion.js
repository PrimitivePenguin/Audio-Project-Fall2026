JukeBoxEffects.register({
    id: 'distortion',
    label: 'Distortion',
    kind: 'insert',
    order: 10,
    scopes: ['channel', 'master'],
    params: {
        distDrive: { label: 'Drive', min: 0, max: 1, def: 0.4, step: 0.01, format: 'percent', automatable: true },
        distTone: { label: 'Tone', min: 500, max: 20000, def: 20000, format: 'hz', log: true, automatable: true },
        distMix: { label: 'Mix', min: 0, max: 1, def: 0, step: 0.01, format: 'percent', automatable: true }
    },
    isActive: (mix) => mix.distMix > 0,
    create({ context }) {
        const curve = (() => {
            const size = 2048;
            const data = new Float32Array(size);
            const k = 2.5;
            for (let i = 0; i < size; i++) data[i] = Math.tanh(k * ((i / (size - 1)) * 2 - 1)) / Math.tanh(k);
            return data;
        })();
        const input = context.createGain();
        const output = context.createGain();
        const dry = context.createGain();
        const wet = context.createGain();
        const preGain = context.createGain();
        const shaper = context.createWaveShaper();
        const tone = context.createBiquadFilter();
        const postGain = context.createGain();
        shaper.curve = curve;
        shaper.oversample = '4x';
        tone.type = 'lowpass';
        input.connect(dry).connect(output);
        input.connect(preGain).connect(shaper).connect(tone).connect(postGain).connect(wet).connect(output);

        const driveGain = (drive) => 1 + drive * 29;
        const levelComp = (drive) => 1 / driveGain(drive) ** 0.35; // keeps loudness roughly level

        return {
            input, output,
            nodes: [input, output, dry, wet, preGain, shaper, tone, postGain],
            targets(key) {
                switch (key) {
                    case 'distDrive': return [{ param: preGain.gain, map: driveGain }, { param: postGain.gain, map: levelComp }];
                    case 'distTone': return [{ param: tone.frequency }];
                    case 'distMix': return [{ param: wet.gain }, { param: dry.gain, map: (mix) => 1 - mix }];
                    default: return [];
                }
            }
        };
    }
});