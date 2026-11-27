const DELAY_MAX_SECONDS = 4;
const DELAY_DAMP_HZ = 4000;

JukeBoxEffects.register({
    id: 'delay',
    label: 'Delay',
    kind: 'send',
    order: 50,
    scopes: ['channel'],
    params: {
        delaySend: { label: 'Send', min: 0, max: 1, def: 0, step: 0.01, format: 'percent', automatable: true },
        delayBeats: { label: 'Time', min: 0.125, max: 2, def: 0.75, step: 0.125, format: 'beats' }, // follows BPM
        delayFeedback: { label: 'Fdbk', min: 0, max: 0.9, def: 0.4, step: 0.01, format: 'percent', automatable: true }
    },
    isActive: (mix) => mix.delaySend > 0,
    create(env) {
        const { context } = env;
        const input = context.createGain(); // the send
        const delay = context.createDelay(DELAY_MAX_SECONDS);
        const damp = context.createBiquadFilter();
        const feedback = context.createGain();
        damp.type = 'lowpass';
        damp.frequency.value = DELAY_DAMP_HZ;
        input.connect(delay);
        delay.connect(damp);
        damp.connect(feedback);
        feedback.connect(delay); // legal feedback loop: it contains a DelayNode
        const seconds = (beats) => Math.min(DELAY_MAX_SECONDS, (beats * 60) / env.bpm());
        return {
            input, output: damp, nodes: [input, delay, damp, feedback],
            targets(key) {
                switch (key) {
                    case 'delaySend': return [{ param: input.gain }];
                    case 'delayBeats': return [{ param: delay.delayTime, map: seconds }];
                    case 'delayFeedback': return [{ param: feedback.gain }];
                    default: return [];
                }
            },
            onTempoChange(mix, environment) {
                environment.smooth(delay.delayTime, seconds(mix.delayBeats));
            }
        };
    }
});