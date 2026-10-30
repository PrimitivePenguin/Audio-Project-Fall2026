// Musical positions are independent of the viewport and audio clock.
class NoteSequence {
    constructor(stepCount = 16) {
        if (!Number.isInteger(stepCount) || stepCount < 1) throw new RangeError('Invalid pattern length');
        this.stepCount = stepCount;
        this.notes = [];
    }
    static pitchName(midi) {
        return ['C', 'C♯/D♭', 'D', 'D♯/E♭', 'E', 'F', 'F♯/G♭', 'G', 'G♯/A♭', 'A', 'A♯/B♭', 'B'][midi % 12] + (Math.floor(midi / 12) - 1);
    }
    static visiblePitches(low = 36, high = 83) {
        return Array.from({ length: high - low + 1 }, (_, row) => high - row);
    }
    addNote({ midi, startStep, durationSteps = 1, velocity = 0.7, trackId = 'piano' }) {
        if (!Number.isInteger(midi) || midi < 0 || midi > 127 ||
            !Number.isFinite(startStep) || startStep < 0 || startStep >= this.stepCount ||
            !Number.isFinite(durationSteps) || durationSteps <= 0 ||
            !Number.isFinite(velocity) || velocity < 0 || velocity > 1 || typeof trackId !== 'string') {
            throw new RangeError('Invalid note');
        }
        this.removeNote(midi, startStep, trackId);
        this.notes.push({ midi, startStep, durationSteps, velocity, trackId });
    }
    removeNote(midi, startStep, trackId = 'piano') {
        this.notes = this.notes.filter(n => !(n.midi === midi && n.startStep === startStep && n.trackId === trackId));
    }
    hasNote(midi, startStep) { return this.notes.some(n => n.midi === midi && n.startStep === startStep); }
    toggleNote(midi, startStep) {
        if (this.hasNote(midi, startStep)) this.removeNote(midi, startStep);
        else this.addNote({ midi, startStep });
    }
    notesAt(step) { return this.notes.filter(n => n.startStep >= step && n.startStep < step + 1); }
    toJSON() { return { stepCount: this.stepCount, notes: this.notes.map(n => ({ ...n })) }; }
}
