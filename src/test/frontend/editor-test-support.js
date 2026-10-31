const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createEditorHarness(pixelRatio = 1, options = {}) {
    const canvasCalls = [];
    const elements = {};
    const intervals = new Map();
    const windowListeners = {};
    const documentListeners = {};
    const readyEvents = [];
    let engine;
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
                    strokeStyle: target.strokeStyle
                });
        }
    });

    class Element {
        constructor() {
            this.value = '';
            this.style = {};
            this.children = [];
            this.listeners = {};
            this.attributes = {};
            this.dataset = {};
            this.clientWidth = 900;
            this.clientHeight = 600;
            this.scrollLeft = 0;
            this.scrollTop = 0;
            this.capturedPointers = new Set();
            this.classList = { toggle() {} };
        }
        getContext() {
            return drawingContext;
        }
        getBoundingClientRect() {
            return { left: 20, top: 40 };
        }
        setAttribute(name, value) {
            this.attributes[name] = value;
        }
        append(child) {
            this.children.push(child);
        }
        replaceChildren() {
            this.children = [];
        }
        addEventListener(name, callback) {
            this.listeners[name] = callback;
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
        connect() {}
        disconnect() {}
        start(time) {
            this.startTime = time;
        }
        stop(time = 0) {
            this.stopTime = time;
        }
    }

    class AudioContext {
        constructor() {
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
        createGain() {
            return {
                gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} },
                connect() {},
                disconnect() {}
            };
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

    const scope = vm.createContext({
        document: {
            getElementById(id) {
                elements[id] ??= new Element();
                return elements[id];
            },
            createElement() {
                return new Element();
            },
            addEventListener(name, callback) {
                documentListeners[name] = callback;
            },
            dispatchEvent(event) {
                readyEvents.push(event);
                options.onReady?.(event.detail.engine);
                documentListeners[event.type]?.(event);
            }
        },
        window: {
            AudioContext,
            devicePixelRatio: pixelRatio,
            addEventListener(name, callback) {
                windowListeners[name] = callback;
            },
            confirm() {
                confirmCount++;
                return confirmResult;
            }
        },
        AbortController,
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
        setTimeout() {},
        requestAnimationFrame() {}
    });
    const directory = path.resolve(__dirname, '../../main/resources/static/js');
    for (const file of [
        'vendor/tonejs-midi-2.0.28.js',
        'NoteSequence.js',
        'SequencerEngine.js',
        'midi-io.js',
        'PianoRollEditor.js'
    ]) {
        vm.runInContext(fs.readFileSync(path.join(directory, file), 'utf8'), scope);
    }
    const api = vm.runInContext(
        '({ NoteSequence, SequencerEngine, MidiIO, PianoRollEditor })',
        scope
    );
    scope.CapturedEngine = class extends api.SequencerEngine {
        constructor() {
            super();
            engine = this;
        }
    };
    if (options.registrationScript) {
        vm.runInContext(options.registrationScript, scope);
    }
    const source = fs
        .readFileSync(path.join(directory, 'sequencer-ui.js'), 'utf8')
        .replace('new SequencerEngine()', 'new CapturedEngine()');
    vm.runInContext(source, scope);

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
        readyEvents,
        elements,
        canvasCalls,
        intervals,
        windowListeners,
        documentListeners,
        pointer,
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
