const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createEditorHarness(pixelRatio = 1, options = {}) {
    const canvasCalls = [];
    const nodes = [];
    const documentHandlers = {};
    const storage = new Map(Object.entries(options.storage ?? {}));
    const elements = {};
    const intervals = new Map();
    const windowListeners = {};
    const documentListeners = {};
    const readyEvents = [];
    const deferredActions = [];
    let engine;
    let arrangement;
    let activeElement = null;
    let animationCallback = null;
    let resizeCallback;
    let animationRequests = 0;
    let modalOpen = false;
    const resizeObservers = [];
    let nextTimer = 0;
    let confirmResult = true;
    let confirmCount = 0;
    const drawingState = {};
    const drawingContext = new Proxy(drawingState, {
        get(target, property) {
            if (property in target) {
                return target[property];
            }
            return (...args) =>
                canvasCalls.push({
                    method: property,
                    args,
                    fillStyle: target.fillStyle,
                    strokeStyle: target.strokeStyle,
                    globalAlpha: target.globalAlpha ?? 1
                });
        }
    });

    class Element {
        constructor(tagName) {
            if (tagName) this.tagName = tagName.toUpperCase();
            nodes.push(this);
            this.value = '';
            this.style = { setProperty(name, value) { this[name] = value; } };
            this.children = [];
            this.listeners = {};
            this.listenerCounts = {};
            this.attributes = {};
            this.dataset = {};
            this.clientWidth = 900;
            this.clientHeight = 600;
            this.scrollLeft = 0;
            this.scrollTop = 0;
            this.capturedPointers = new Set();
            this.classList = { toggle() {}, add: (...names) => { this.className = [this.className ?? '', ...names].join(' '); } };
        }
        focus(options) {
            this.focusOptions = options;
            this.focused = true;
            activeElement = this;
        }
        get valueAsNumber() { return Number(this.value); }
        getContext() {
            return drawingContext;
        }
        getBoundingClientRect() {
            return { left: 20, top: 40 };
        }
        setAttribute(name, value) {
            this.attributes[name] = value;
        }
        append(...children) {
            children.forEach((child) => { child.parentElement = this; });
            this.children.push(...children);
        }
        after(element) {
            const parent = this.parentElement;
            if (!parent) return;
            element.remove();
            parent.children.splice(parent.children.indexOf(this) + 1, 0, element);
            element.parentElement = parent;
        }
        get options() { return this.children; }
        remove() {
            if (this.parentElement) {
                this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
                this.parentElement = null;
            }
        }
        appendChild(child) { this.append(child); return child; }
        prepend(...children) {
            children.forEach((child) => { child.parentElement = this; });
            this.children.unshift(...children);
        }
        getAttribute(name) { return this.attributes[name] ?? null; }
        closest(selector) {
            const matches = (node, part) => {
                const tag = part.match(/^[a-z]+/i)?.[0];
                if (tag && node.tagName !== tag.toUpperCase()) return false;
                const cls = part.match(/^\.([\w-]+)/)?.[1];
                if (cls && !(node.className ?? '').split(' ').includes(cls)) return false;
                const attribute = part.match(/\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]/);
                if (attribute) {
                    const value = node.attributes[attribute[1]] ?? node[attribute[1]];
                    if (value === undefined || (attribute[2] !== undefined && String(value) !== attribute[2])) return false;
                }
                return Boolean(tag || cls || attribute);
            };
            for (let node = this; node; node = node.parentElement) {
                if (selector.split(',').some((part) => matches(node, part.trim()))) return node;
            }
            return null;
        }
        showModal() {
            this.open = true;
        }
        close() {
            this.open = false;
            this.listeners.close?.();
        }
        replaceChildren(...children) {
            this.children = [];
            this.append(...children);
        }
        addEventListener(name, callback) {
            this.listeners[name] = callback;
            this.listenerCounts[name] = (this.listenerCounts[name] ?? 0) + 1;
        }
        setPointerCapture(pointerId) {
            this.capturedPointers.add(pointerId);
        }
        hasPointerCapture(pointerId) {
            return this.capturedPointers.has(pointerId);
        }
        releasePointerCapture(pointerId) {
            this.capturedPointers.delete(pointerId);
        }
    }

    class AudioSource {
        constructor() {
            this.frequency = { value: 0 };
        }
        connect(destination) { this.destination = destination; return this; }
        disconnect() { this.disconnected = true; }
        start(time, offset, duration) {
            this.startTime = time;
            this.offset = offset;
            this.duration = duration;
        }
        stop(time = 0) {
            this.stopTime = time;
        }
    }

    class AudioContext {
        constructor() {
            this.sampleRate = 48000;
            this.state = 'suspended';
            this.currentTime = 0;
            this.sources = [];
        }
        async resume() {
            this.state = 'running';
        }
        async decodeAudioData(data) {
            return data;
        }
        createBuffer(channels, length, sampleRate) {
            const pcm = Array.from({ length: channels }, () => new Float32Array(length));
            return { length, sampleRate, duration: length / sampleRate, numberOfChannels: channels,
                copyToChannel(data, channel) { pcm[channel].set(data); }, getChannelData(channel) { return pcm[channel]; } };
        }
        createBiquadFilter() {
            return Object.assign(new AudioSource(), { frequency: this.param(), Q: this.param() });
        }
        createDelay() { return Object.assign(new AudioSource(), { delayTime: this.param() }); }
        createConvolver() { return new AudioSource(); }
        param() {
            return {
                value: 0,
                setValueAtTime(value) { this.value = value; },
                linearRampToValueAtTime(value) { this.value = value; },
                exponentialRampToValueAtTime(value) { this.value = value; },
                setTargetAtTime(value) { this.value = value; },
                cancelScheduledValues() {}
            };
        }
        createGain() {
            return Object.assign(new AudioSource(), { gain: this.param() });
        }
        createStereoPanner() {
            return Object.assign(new AudioSource(), { pan: this.param() });
        }
        createBufferSource() {
            const source = new AudioSource();
            this.sources.push(source);
            return source;
        }
        createOscillator() {
            return this.createBufferSource();
        }
    }

    const css = fs.readFileSync(path.resolve(__dirname, '../../main/resources/static/css/sequencer.css'), 'utf8');
    const cssValues = new Map([...css.matchAll(/(--roll-[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]));
    const scope = vm.createContext({
        getComputedStyle: () => ({ getPropertyValue: (key) => cssValues.get(key) ?? '' }),
        document: {
            get activeElement() {
                return activeElement;
            },
            querySelector() {
                return modalOpen || elements.deleteTrackDialog?.open ? {} : null;
            },
            head: new Element('head'),
            body: new Element('body'),
            getElementById(id) {
                elements[id] ??= nodes.find((node) => node.id === id) ?? new Element();
                return elements[id];
            },
            createElement(tagName) {
                return new Element(tagName);
            },
            addEventListener(name, callback, config) {
                (documentHandlers[name] ??= []).push({ callback, once: config?.once });
                documentListeners[name] = (event) => {
                    const handlers = [...documentHandlers[name]];
                    documentHandlers[name] = handlers.filter((entry) => !entry.once);
                    const legacyPress = name === 'keydown' && !event.type && event.key === ' ';
                    handlers.forEach((entry) => entry.callback(event));
                    if (legacyPress) documentListeners.keyup?.({ ...event, type: 'keyup' });
                };
            },
            dispatchEvent(event) {
                if (event.type === 'jukebox:ready') {
                    readyEvents.push(event);
                    options.onReady?.(event.detail.engine);
                }
                documentListeners[event.type]?.(event);
            }
        },
        localStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: (key) => storage.delete(key)
        },
        fetch: options.fetch,
        URL,
        clearTimeout,
        window: {
            location: { pathname: options.pathname ?? '/index.html', protocol: 'https:', host: 'jukebox.test' },
            AudioContext,
            StompJs: options.StompJs,
            devicePixelRatio: pixelRatio,
            addEventListener(name, callback) {
                const previous = windowListeners[name];
                const handler = (...args) => { previous?.(...args); callback(...args); };
                windowListeners[name] = handler;
                if (name === 'resize' && !previous) resizeCallback = () => {
                    windowListeners.resize();
                    animationCallback?.();
                };
            },
            confirm() {
                confirmCount++;
                return confirmResult;
            }
        },
        Option: class extends Element {
            constructor(text, value) { super('option'); this.textContent = text; this.value = value; }
        },
        AbortController,
        crypto: require('node:crypto').webcrypto,
        CustomEvent: class {
            constructor(type, options) {
                this.type = type;
                this.detail = options.detail;
            }
        },
        setInterval(callback) {
            const id = ++nextTimer;
            intervals.set(id, callback);
            return id;
        },
        clearInterval(id) {
            intervals.delete(id);
        },
        setTimeout(callback, delay) {
            if (delay === 0) deferredActions.push(callback);
            else return setTimeout(callback, delay);
        },
        requestAnimationFrame(callback) {
            animationRequests++;
            animationCallback = callback;
        },
        ResizeObserver: class {
            constructor(callback) {
                resizeObservers.push(callback);
            }
            observe() {}
        }
    });
    const directory = path.resolve(__dirname, '../../main/resources/static/js');
    for (const file of [
        'vendor/tonejs-midi-2.0.28.js',
        'NoteSequence.js',
        'AudioArrangement.js',
        'SampleAssetStore.js',
        'SequencerEngine.js',
        'midi-io.js',
        'PianoRollEditor.js',
        'TrackOverview.js',
        'ArrangementEditor.js',
        'ProjectCollabClient.js'
    ]) {
        vm.runInContext(fs.readFileSync(path.join(directory, file), 'utf8'), scope);
    }
    const api = vm.runInContext(
        '({ AudioArrangement, ArrangementEditor, SampleAssetStore, NoteSequence, SequencerEngine, MidiIO, PianoRollEditor, PianoRollFollow, TrackOverview })',
        scope
    );
    scope.CapturedEngine = class extends api.SequencerEngine {
        constructor() {
            super();
            engine = this;
        }
    };
    scope.CapturedArrangement = class extends api.ArrangementEditor {
        constructor(...args) {
            super(...args);
            arrangement = this;
        }
    };
    for (const script of options.scripts ?? []) {
        vm.runInContext(fs.readFileSync(path.join(directory, script), 'utf8'), scope);
    }
    if (options.registrationScript) {
        vm.runInContext(options.registrationScript, scope);
    }
    const page = fs.readFileSync(path.join(directory, '../index.html'), 'utf8');
    for (const [, script] of page.matchAll(/<script src="\/js\/(sequencer\/[^"]+\.js|sequencer-ui\.js)"><\/script>/g)) {
        vm.runInContext(fs.readFileSync(path.join(directory, script), 'utf8'), scope, { filename: script });
    }
    const initialization = vm.runInContext(`initializeSequencer({
        engine: new CapturedEngine(),
        createArrangement: (engine, hooks) => new CapturedArrangement(engine, hooks)
    })`, scope);

    const pointer = (x, y, options = {}) => ({
        clientX: x + 20,
        clientY: y + 40,
        pointerId: 1,
        button: 0,
        preventDefault() {},
        ...options
    });
    const harness = {
        ...api,
        engine,
        arrangement,
        ready: Promise.resolve(initialization),
        scope,
        nodes,
        readyEvents,
        elements,
        canvasCalls,
        rollColor: (name) => cssValues.get('--roll-' + name)?.trim(),
        intervals,
        windowListeners: new Proxy(windowListeners, {
            get(target, key) { return key === 'resize' ? resizeCallback : target[key]; }
        }),
        documentListeners,
        pointer,
        animate(timestamp) {
            animationCallback(timestamp);
        },
        get animationRequests() {
            return animationRequests;
        },
        get resizeObserverCount() {
            return resizeObservers.length;
        },
        resize() {
            resizeObservers.forEach((callback) => callback());
            animationCallback?.();
        },
        setModalOpen(value) {
            modalOpen = value;
        },
        get activeElement() {
            return activeElement;
        },
        setConfirmation(value) {
            confirmResult = value;
        },
        get confirmCount() {
            return confirmCount;
        },
        view() {
            return {
                highestPitch: Number(elements.pitchHigh.value || 83),
                scrollLeft: elements.pianoViewport.scrollLeft,
                scrollTop: elements.pianoViewport.scrollTop,
                width: elements.pianoViewport.clientWidth,
                height: elements.pianoViewport.clientHeight
            };
        },
        paint() {
            canvasCalls.length = 0;
            elements.pianoViewport.listeners.scroll();
            animationCallback();
        },
        flushDeferredActions() {
            deferredActions.splice(0).forEach((callback) => callback());
        },
        async activateControl(id, detail = 1) {
            const control = elements[id];
            control.tagName ??= 'BUTTON';
            control.type ??= 'button';
            control.setAttribute('data-daw-controls', '');
            control.closest ??= (selector) => {
                if (selector === 'button, summary' || selector === '[data-daw-controls]') {
                    return control;
                }
                return null;
            };
            control.focus();
            const event = { target: control, detail };
            documentListeners.click?.(event);
            const result = control.onclick?.(event);
            control.listeners.click?.(event);
            deferredActions.splice(0).forEach((callback) => callback());
            await Promise.resolve();
            return result;
        },
        clickAt(x, y) {
            const event = pointer(x, y);
            elements.pianoCanvas.onpointerdown(event);
            elements.pianoCanvas.onpointerup(event);
            elements.pianoCanvas.onclick(event);
        },
        noteBounds(note) {
            return api.PianoRollEditor.rectangle(note, harness.view());
        },
        clickNote(note) {
            const bounds = harness.noteBounds(note);
            harness.clickAt(bounds.x + bounds.hitWidth / 2, bounds.y + 12);
        },
        drag(note, edge, targetStep, cancel = false) {
            const bounds = harness.noteBounds(note);
            const startX = edge === 'left' ? bounds.x + 1 : bounds.x + bounds.hitWidth - 1;
            const start = pointer(startX, bounds.y + 12);
            elements.pianoCanvas.onpointerdown(start);
            const targetX = 100 + targetStep * 38 - elements.pianoViewport.scrollLeft;
            const finish = pointer(targetX, bounds.y + 12);
            elements.pianoCanvas.onpointermove(finish);
            if (cancel) {
                elements.pianoCanvas.onpointercancel(finish);
            } else {
                elements.pianoCanvas.onpointerup(finish);
                elements.pianoCanvas.onclick(finish);
            }
        },
        async importSequence(sequence) {
            const bytes = api.MidiIO.encode(sequence).bytes;
            await elements.midiFile.onchange({
                target: {
                    files: [
                        { name: 'test.mid', size: bytes.length, arrayBuffer: async () => bytes }
                    ],
                    value: 'test.mid'
                }
            });
        }
    };
    return harness;
}

module.exports = { createEditorHarness };
