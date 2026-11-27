const REVERB_SECONDS = 2;

function makeReverbImpulse(context) {
    const length = Math.floor(context.sampleRate * REVERB_SECONDS);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    }
    return impulse;
}

JukeBoxEffects.register({
    id: 'reverb',
    label: 'Reverb',
    kind: 'send',
    order: 60,
    scopes: ['channel'],
    params: {
        reverbSend: { label: 'Send', min: 0, max: 1, def: 0, step: 0.01, format: 'percent', automatable: true }
    },
    isActive: (mix) => mix.reverbSend > 0,
    create({ context, shared }) {
        const input = context.createGain();
        const convolver = context.createConvolver();
        if (!shared.has('reverbImpulse')) shared.set('reverbImpulse', makeReverbImpulse(context)); // one impulse for every channel
        convolver.buffer = shared.get('reverbImpulse');
        input.connect(convolver);
        return {
            input, output: convolver, nodes: [input, convolver],
            targets: (key) => (key === 'reverbSend' ? [{ param: input.gain }] : [])
        };
    }
});