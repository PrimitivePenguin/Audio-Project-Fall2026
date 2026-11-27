// Registers effect modules. See distortion.js for a minimal example.
(() => {
    const KINDS = ['insert', 'send'];
    const SCOPES = ['channel', 'master'];
    const FORMATS = ['percent', 'pan', 'hz', 'db', 'seconds', 'ratio', 'beats', 'bpm', 'number'];
    const RESERVED = ['volume', 'pan', 'cutoff', 'resonance', 'filterType', 'tempo'];
    const modules = new Map();
    const owners = new Map(); // param key -> module id

    const fail = (message) => { throw new TypeError(`JukeBoxEffects: ${message}`); };
    const isNode = (node) => typeof node?.connect === 'function';

    function validateParams(id, params) {
        if (!params || typeof params !== 'object' || !Object.keys(params).length) fail(`'${id}' needs params.`);
        for (const [key, spec] of Object.entries(params)) {
            if (!/^[a-z][A-Za-z0-9]*$/.test(key) || RESERVED.includes(key)) fail(`'${id}': bad param key '${key}'.`);
            if (owners.has(key)) fail(`param key '${key}' is already used by '${owners.get(key)}'.`);
            const { min, max, def } = spec ?? {};
            if (![min, max, def].every(Number.isFinite) || !(min < max) || def < min || def > max) {
                fail(`'${id}.${key}' needs numeric min < max and a default inside the range.`);
            }
            if (spec.log && min <= 0) fail(`'${id}.${key}' is log-scaled, so min must be above 0.`);
            if (!FORMATS.includes(spec.format ?? 'number')) fail(`'${id}.${key}' has an unknown format.`);
        }
    }

    function register(definition) {
        const { id, label, kind, params, isActive, create } = definition ?? {};
        if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) fail('an effect needs a lowercase id.');
        if (modules.has(id)) fail(`'${id}' is already registered.`);
        if (typeof label !== 'string' || !KINDS.includes(kind)) fail(`'${id}' needs a label and kind 'insert' or 'send'.`);
        if (typeof isActive !== 'function' || typeof create !== 'function') fail(`'${id}' needs isActive() and create().`);
        const scopes = definition.scopes ?? ['channel'];
        if (!Array.isArray(scopes) || !scopes.length || !scopes.every((scope) => SCOPES.includes(scope))) {
            fail(`'${id}' scopes must be 'channel' and/or 'master'.`);
        }
        validateParams(id, params);
        const keys = Object.keys(params);

        const module = Object.freeze({
            id, label, kind, params, isActive,
            scopes: [...scopes],
            order: Number.isFinite(definition.order) ? definition.order : 50,
            create(env, mix) {
                const instance = create(env, mix);
                if (!isNode(instance?.input) || !isNode(instance?.output) ||
                    !Array.isArray(instance.nodes) || typeof instance.targets !== 'function') {
                    fail(`'${id}'.create() must return { input, output, nodes, targets }.`);
                }
                // Default apply(): push every stored value through targets(). Override for extras.
                instance.apply ??= (values, environment, immediate = false) => {
                    const put = immediate ? environment.set : environment.smooth;
                    for (const key of keys) {
                        for (const { param, map } of instance.targets(key)) {
                            put(param, map ? map(values[key]) : values[key]);
                        }
                    }
                };
                return instance;
            }
        });
        keys.forEach((key) => owners.set(key, id));
        modules.set(id, module);
        return module;
    }

    window.JukeBoxEffects = {
        register,
        get: (id) => modules.get(id),
        all: () => [...modules.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    };
})();