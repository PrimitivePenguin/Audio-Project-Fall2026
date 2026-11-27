JukeBoxEffects.register({
    id: 'compressor',
    label: 'Compressor',
    kind: 'insert',
    order: 20,
    scopes: ['channel', 'master'],
    params: {
        compThreshold: { label: 'Thresh', min: -60, max: 0, def: -18, step: 0.5, format: 'db', automatable: true },
        compRatio: { label: 'Ratio', min: 1, max: 20, def: 1, step: 0.1, format: 'ratio', automatable: true }, // 1 = off
        compAttack: { label: 'Attack', min: 0.001, max: 0.5, def: 0.01, format: 'seconds', log: true },
        compRelease: { label: 'Release', min: 0.02, max: 1, def: 0.25, format: 'seconds', log: true },
        compMakeup: { label: 'Makeup', min: 0, max: 24, def: 0, step: 0.1, format: 'db', automatable: true }
    },
    isActive: (mix) => mix.compRatio > 1,
    create({ context }) {
        const compressor = context.createDynamicsCompressor();
        const makeup = context.createGain();
        compressor.knee.value = 6;
        compressor.connect(makeup);
        return {
            input: compressor, output: makeup, nodes: [compressor, makeup],
            targets(key) {
                switch (key) {
                    case 'compThreshold': return [{ param: compressor.threshold }];
                    case 'compRatio': return [{ param: compressor.ratio }];
                    case 'compAttack': return [{ param: compressor.attack }];
                    case 'compRelease': return [{ param: compressor.release }];
                    case 'compMakeup': return [{ param: makeup.gain, map: (db) => 10 ** (db / 20) }];
                    default: return [];
                }
            }
        };
    }
});