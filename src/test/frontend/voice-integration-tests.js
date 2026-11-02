const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEditorHarness } = require('./editor-test-support');

let passed = 0;
async function test(name, run) {
    await run();
    console.log('PASS', name);
    passed++;
}

function nextTurn() {
    return new Promise((resolve) => setImmediate(resolve));
}

function addChord(engine) {
    for (const midi of [60, 64, 67]) {
        engine.sequence.addNote({ midi, startStep: 0 });
    }
}

(async () => {
    await test('Stop isolates throwing voices and cancels remaining voices and sample sources before reporting', async () => {
        const h = createEditorHarness();
        const stopped = [];
        const errors = [];
        addChord(h.engine);
        h.engine.voiceFactory = (event) => ({
            stop() {
                stopped.push(event.midi);
                if (event.midi === 60) {
                    throw new Error('broken voice');
                }
            },
            finished: new Promise(() => {})
        });
        h.engine.addTrack('uploaded', {});
        h.engine.setStep('uploaded', 0, true);
        await h.engine.play();
        const sampleSource = h.engine.audioContext.sources[0];
        h.engine.onError = (error, details) => {
            errors.push([error.message, details.phase]);
            assert.equal(h.engine.pitchedVoices.size, 0);
            assert.equal(h.engine.tracks.get('uploaded').activeSources.size, 0);
            assert.equal(sampleSource.stopTime, 0);
            h.engine.stop(); // Reentrant legacy handlers must not recurse or interrupt cleanup.
        };
        h.engine.stop();
        assert.deepEqual(stopped, [60, 64, 67]);
        assert.deepEqual(errors, [['broken voice', 'voice-stop']]);
        assert.equal(h.engine.isPlaying, false);
        assert.equal(h.engine.stepEvents.length, 0);
        assert.equal(h.intervals.size, 0);
        h.engine.stop();
        assert.deepEqual(stopped, [60, 64, 67]);
    });

    await test('throwing sample cancellation and manager Stop do not interrupt other cleanup', async () => {
        const h = createEditorHarness();
        let managerStopped = false;
        h.engine.registerInstrumentManager({
            createVoice: (event, context, output) => h.engine.createPitchedVoice(event),
            stop() {
                managerStopped = true;
                throw new Error('effects flush failed');
            }
        });
        h.engine.addTrack('sample', {});
        let healthySampleStopped = false;
        h.engine.tracks.get('sample').activeSources.add({
            stop() {
                throw new Error('bad sample');
            }
        });
        h.engine.tracks.get('sample').activeSources.add({
            stop() {
                healthySampleStopped = true;
            }
        });
        h.engine.stop();
        assert.equal(healthySampleStopped, true);
        assert.equal(managerStopped, true);
        assert.equal(h.engine.tracks.get('sample').activeSources.size, 0);
        assert.equal(h.engine.audioErrors.length, 2);
    });

    await test('malformed voice handles never enter the registry and healthy notes/samples continue', async () => {
        for (const makeInvalid of [
            () => null,
            () => ({}),
            () => ({ stop() {} }),
            () => ({ stop: 'invalid', finished: Promise.resolve() }),
            () => ({ stop() {}, finished: 42 }),
            () => ({
                get then() {
                    throw new Error('bad handle getter');
                },
                stop() {}
            })
        ]) {
            const h = createEditorHarness();
            addChord(h.engine);
            let healthyCalls = 0;
            h.engine.voiceFactory = (event) => {
                if (event.midi === 60) {
                    return makeInvalid();
                }
                healthyCalls++;
                return { stop() {}, finished: new Promise(() => {}) };
            };
            h.engine.addTrack('sample', {});
            h.engine.setStep('sample', 0, true);
            await h.engine.play();
            assert.equal(healthyCalls, 2);
            assert.equal(h.engine.pitchedVoices.size, 2);
            assert.equal(h.engine.audioContext.sources.length, 1);
            assert.equal(h.engine.isPlaying, true);
            const failure = h.engine.audioErrors.find((entry) => entry.phase === 'voice-factory');
            assert.ok(failure);
            assert.equal(failure.noteId, h.engine.sequence.notes[0].id);
            h.engine.stop();
        }
    });

    await test('factory throws are contained per note and valid thenable completions are supported', async () => {
        const h = createEditorHarness();
        addChord(h.engine);
        let thenableCompleted = false;
        h.engine.voiceFactory = (event) => {
            if (event.midi === 60) {
                throw new Error('instrument unavailable');
            }
            return {
                stop() {},
                finished: {
                    then(resolve) {
                        thenableCompleted = true;
                        resolve();
                    }
                }
            };
        };
        await h.engine.play();
        await nextTurn();
        assert.equal(thenableCompleted, true);
        assert.equal(h.engine.pitchedVoices.size, 0);
        assert.equal(h.engine.isPlaying, true);
        h.engine.stop();
    });

    await test('async factories are rejected and their late handles are cancelled without unhandled rejection', async () => {
        const h = createEditorHarness();
        addChord(h.engine);
        let lateCancelled = 0;
        const unhandled = [];
        const listener = (error) => unhandled.push(error);
        process.on('unhandledRejection', listener);
        try {
            h.engine.voiceFactory = async (event) => {
                if (event.midi === 60) {
                    throw new Error('async load failed');
                }
                return {
                    stop() {
                        lateCancelled++;
                    },
                    finished: Promise.resolve()
                };
            };
            await h.engine.play();
            await nextTurn();
            assert.equal(h.engine.pitchedVoices.size, 0);
            assert.equal(lateCancelled, 2);
            assert.equal(unhandled.length, 0);
            assert.ok(
                h.engine.audioErrors.some((entry) => entry.error.message.includes('synchronous'))
            );
            assert.equal(h.engine.isPlaying, true);
            h.engine.stop();
        } finally {
            process.removeListener('unhandledRejection', listener);
        }
    });

    await test('rejected completion cancels only that voice and reports an error without unhandled rejection', async () => {
        const h = createEditorHarness();
        addChord(h.engine);
        const cancelled = [];
        const unhandled = [];
        const listener = (error) => unhandled.push(error);
        process.on('unhandledRejection', listener);
        try {
            h.engine.voiceFactory = (event) => ({
                stop() {
                    cancelled.push(event.midi);
                },
                finished:
                    event.midi === 60
                        ? Promise.reject(new Error('voice processor failed'))
                        : new Promise(() => {})
            });
            await h.engine.play();
            await nextTurn();
            assert.deepEqual(cancelled, [60]);
            assert.equal(h.engine.pitchedVoices.size, 2);
            assert.equal(h.engine.audioErrors[0].phase, 'voice-completion');
            assert.equal(unhandled.length, 0);
            assert.equal(h.engine.isPlaying, true);
            h.engine.stop();
            assert.deepEqual(cancelled, [60, 64, 67]);
        } finally {
            process.removeListener('unhandledRejection', listener);
        }
    });

    await test('malformed handle cleanup and async Stop rejection are observed safely', async () => {
        const h = createEditorHarness();
        h.engine.sequence.addNote({ midi: 60, startStep: 0 });
        let cancelled = 0;
        h.engine.voiceFactory = () => ({
            stop() {
                cancelled++;
            }
        });
        await h.engine.play();
        assert.equal(cancelled, 1);
        assert.equal(h.engine.pitchedVoices.size, 0);
        h.engine.stop();
        h.engine.voiceFactory = () => ({
            stop: async () => {
                throw new Error('async cancellation failed');
            },
            finished: new Promise(() => {})
        });
        await h.engine.play();
        h.engine.stop();
        await nextTurn();
        assert.equal(h.engine.pitchedVoices.size, 0);
        assert.ok(
            h.engine.audioErrors.some(
                (entry) => entry.error.message === 'async cancellation failed'
            )
        );
    });

    await test('ready entry point registers on the same engine and preserves all note metadata', async () => {
        let readyEngine;
        let preparedContext;
        let preparedOutput;
        const events = [];
        const h = createEditorHarness(1, {
            onReady(engine) {
                readyEngine = engine;
                engine.registerInstrumentManager({
                    async prepare(context, output) {
                        preparedContext = context;
                        preparedOutput = output;
                    },
                    createVoice(event, context, output) {
                        events.push({ event, context, output });
                        return { stop() {}, finished: new Promise(() => {}) };
                    }
                });
            }
        });
        h.engine.sequence.tracks[0].channel = 3;
        h.engine.sequence.tracks[0].program = 42;
        h.engine.sequence.addNote({ midi: 127, startStep: 0, durationSteps: 2, velocityMidi: 65 });
        await h.engine.play();
        assert.equal(readyEngine, h.engine);
        assert.equal(h.readyEvents[0].type, 'jukebox:ready');
        assert.equal(preparedContext, h.engine.audioContext);
        assert.equal(preparedOutput, h.engine.masterGain);
        assert.equal(events[0].context, preparedContext);
        assert.equal(events[0].output, preparedOutput);
        assert.deepEqual(
            [
                events[0].event.midi,
                events[0].event.velocityMidi,
                events[0].event.trackId,
                events[0].event.channel,
                events[0].event.program
            ],
            [127, 65, 'piano', 3, 42]
        );
        assert.equal(events[0].event.when, 0.05);
        assert.equal(events[0].event.duration, 0.25);
        h.engine.stop();
    });

    await test('preparation occurs before scheduling, caches readiness, and Stop cancels a pending start', async () => {
        const h = createEditorHarness();
        let prepareCount = 0;
        let resolvePreparation;
        let signal;
        h.engine.registerInstrumentManager({
            prepare(context, output, options) {
                prepareCount++;
                signal = options.signal;
                return new Promise((resolve) => {
                    resolvePreparation = resolve;
                });
            },
            createVoice: (event) => h.engine.createPitchedVoice(event)
        });
        h.engine.sequence.addNote({ midi: 60, startStep: 0 });
        const first = h.engine.play();
        const duplicate = h.engine.play();
        await nextTurn();
        assert.equal(h.intervals.size, 0);
        assert.equal(h.engine.pitchedVoices.size, 0);
        h.engine.stop();
        assert.equal(signal.aborted, true);
        resolvePreparation();
        await Promise.all([first, duplicate]);
        assert.equal(h.engine.isPlaying, false);
        const second = h.engine.play();
        await nextTurn();
        resolvePreparation();
        await second;
        h.engine.stop();
        await h.engine.play();
        assert.equal(prepareCount, 2);
        assert.equal(h.intervals.size, 1);
        h.engine.stop();
    });

    await test('manager lifecycle handles track replacement, disposal, fallback and preparation failures', async () => {
        const h = createEditorHarness();
        const trackSnapshots = [];
        let disposed = 0;
        h.engine.registerInstrumentManager({
            createVoice: (event) => h.engine.createPitchedVoice(event),
            syncTracks(tracks) {
                trackSnapshots.push(tracks);
            },
            dispose() {
                disposed++;
            }
        });
        const source = new h.NoteSequence(32);
        source.addNote({ midi: 60, startStep: 0 });
        h.MidiIO.importInto(h.engine, h.MidiIO.encode(source).bytes);
        h.engine.removeImportedMidi();
        assert.ok(trackSnapshots.length >= 3);
        assert.ok(trackSnapshots[1].some((track) => track.importId));
        assert.ok(trackSnapshots[2].every((track) => !track.importId));
        h.engine.registerInstrumentManager(null);
        assert.equal(disposed, 1);
        assert.equal(h.engine.voiceFactory, null);
        h.engine.sequence.addNote({ midi: 60, startStep: 0 });
        await h.engine.play();
        assert.ok(h.engine.audioContext.sources.length > 0);
        h.engine.stop();
        h.engine.registerInstrumentManager({
            createVoice() {},
            prepare() {
                return Promise.reject(new Error('assets not ready'));
            }
        });
        await assert.rejects(h.engine.play(), /assets not ready/);
        assert.equal(h.engine.isPlaying, false);
        assert.equal(h.intervals.size, 0);
        assert.throws(() => h.engine.registerInstrumentManager({}), /createVoice/);
    });

    await test('legacy error callbacks can Stop during scheduling without starting later voices or a stray timer', async () => {
        const h = createEditorHarness();
        addChord(h.engine);
        let factoryCalls = 0;
        h.engine.voiceFactory = () => {
            factoryCalls++;
            throw new Error('stop requested by consumer');
        };
        h.engine.onError = () => h.engine.stop();
        h.engine.addTrack('uploaded', {});
        h.engine.setStep('uploaded', 0, true);
        await h.engine.play();
        assert.equal(factoryCalls, 1);
        assert.equal(h.engine.isPlaying, false);
        assert.equal(h.engine.pitchedVoices.size, 0);
        assert.equal(h.engine.audioContext.sources.length, 0);
        assert.equal(h.intervals.size, 0);
    });

    await test('a reentrant Stop from a factory cancels its returned handle instead of reviving playback', async () => {
        const h = createEditorHarness();
        addChord(h.engine);
        let cancelled = 0;
        h.engine.voiceFactory = () => {
            h.engine.stop();
            return {
                stop() {
                    cancelled++;
                },
                finished: new Promise(() => {})
            };
        };
        await h.engine.play();
        assert.equal(cancelled, 1);
        assert.equal(h.engine.pitchedVoices.size, 0);
        assert.equal(h.intervals.size, 0);
        assert.equal(h.engine.currentStep, h.engine.loopStart);
    });

    await test('Stop releases pending preparation even if the manager never resolves its own Promise', async () => {
        const h = createEditorHarness();
        h.engine.registerInstrumentManager({
            prepare: () => new Promise(() => {}),
            createVoice: () => ({ stop() {}, finished: Promise.resolve() })
        });
        const pending = h.engine.play();
        await nextTurn();
        h.engine.stop();
        await pending;
        assert.equal(h.engine.startPromise, null);
        assert.equal(h.engine.isPlaying, false);
        assert.equal(h.intervals.size, 0);
    });

    await test('completion getters are read once and faulty reporting callbacks cannot interrupt Stop', async () => {
        const h = createEditorHarness();
        h.engine.sequence.addNote({ midi: 60, startStep: 0 });
        let reads = 0;
        h.engine.voiceFactory = () => ({
            stop() {},
            get finished() {
                reads++;
                return Promise.resolve();
            }
        });
        await h.engine.play();
        await nextTurn();
        assert.equal(reads, 1);
        h.engine.stop();
        h.engine.voiceFactory = () => ({
            stop() {
                throw new Error('cancel failed');
            },
            finished: new Promise(() => {})
        });
        h.engine.onError = () => {
            throw new Error('reporting failed');
        };
        await h.engine.play();
        h.engine.stop();
        assert.equal(h.engine.pitchedVoices.size, 0);
        assert.equal(h.engine.isStopping, false);
        assert.equal(h.intervals.size, 0);
    });

    await test('the documented registration example attaches and plays through the same engine', async () => {
        const documentation = fs.readFileSync(
            path.resolve(__dirname, '../../../docs/sequencer-api.md'),
            'utf8'
        );
        const exampleSection = documentation.split('### Runnable registration example')[1];
        const registrationScript = exampleSection.split('```javascript')[1].split('```')[0];
        const h = createEditorHarness(1, { registrationScript });
        assert.ok(h.engine.instrumentManager);
        h.engine.sequence.addNote({ midi: 69, startStep: 0 });
        await h.engine.play();
        assert.equal(h.engine.audioContext.sources[0].frequency.value, 440);
        assert.equal(h.engine.audioContext.sources[0].startTime, 0.05);
        h.engine.stop();
        assert.equal(h.engine.pitchedVoices.size, 0);
        assert.equal(h.intervals.size, 0);
    });

    console.log(`${passed} voice integration tests passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
