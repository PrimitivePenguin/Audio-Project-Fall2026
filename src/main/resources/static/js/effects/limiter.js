// A fast, hard-ratio compressor. Master-only by default; add 'channel' to scopes to allow it per track.
JukeBoxEffects.register({
    id: 'limiter',
    label: 'Limiter',
    kind: 'insert',
    order: 100, // always last
    scopes: ['channel', 'master'],
    params: {
        limThreshold: { label: 'Ceiling', min: -24, max: 0, def: 0, step: 0.1, format: 'db', automatable: true }, // 0 = off
        limRelease: { label: 'Release', min: 0.01, max: 1, def: 0.1, format: 'seconds', log: true }
    },
    isActive: (mix) => mix.limThreshold < 0,
    create({ context }) {
        const limiter = context.createDynamicsCompressor();
        limiter.ratio.value = 20;
        limiter.knee.value = 0;
        limiter.attack.value = 0.001;
        return {
            input: limiter, output: limiter, nodes: [limiter],
            targets(key) {
                switch (key) {
                    case 'limThreshold': return [{ param: limiter.threshold }];
                    case 'limRelease': return [{ param: limiter.release }];
                    default: return [];
                }
            }
        };
    }
});