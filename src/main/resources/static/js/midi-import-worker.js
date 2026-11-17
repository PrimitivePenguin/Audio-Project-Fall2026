// The same bundled parser and canonical validation, without a DOM or audio engine.
importScripts('/js/vendor/tonejs-midi-2.0.28.js', '/js/NoteSequence.js', '/js/midi-io.js');
self.onmessage = ({ data }) => {
    try {
        const result = MidiIO.parse(data);
        self.postMessage({ sequence: result.sequence.toJSON(), warnings: result.warnings });
    } catch (error) {
        self.postMessage({ error: error.message });
    }
};
