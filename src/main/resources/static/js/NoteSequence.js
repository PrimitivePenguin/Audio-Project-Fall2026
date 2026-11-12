// Canonical timing uses integer ticks. Step getters retain the original grid API.
class NoteSequence {
    #noteIds = new Set();
    #indexedNotes = null;

    constructor(stepCount = 16, ppq = 480) {
        if (!Number.isInteger(stepCount) || stepCount < 1 || stepCount > 65536) {
            throw new RangeError('Pattern length must be 1–65536 steps.');
        }
        if (!Number.isInteger(ppq) || ppq < 1 || ppq > 32767) {
            throw new RangeError('Invalid PPQ.');
        }
        this.stepCount = stepCount;
        this.ppq = ppq;
        this.name = 'JukeBox';
        this.notes = [];
        this.tracks = [{ id: 'piano', name: 'Piano', channel: 0, program: 0 }];
        this.tempos = [{ ticks: 0, bpm: 120 }];
        this.timeSignatures = [{ ticks: 0, timeSignature: [4, 4] }];
        this.nextId = 1;
        this.nextTrackId = 1;
        this.importInfo = null;
    }
    // Pitch labels and grid conversions do not depend on the current viewport.
    static pitchName(midi) {
        const pitchNames = [
            'C',
            'C♯/D♭',
            'D',
            'D♯/E♭',
            'E',
            'F',
            'F♯/G♭',
            'G',
            'G♯/A♭',
            'A',
            'A♯/B♭',
            'B'
        ];
        const octave = Math.floor(midi / 12) - 1;
        return pitchNames[midi % 12] + octave;
    }

    static visiblePitches(low = 36, high = 83) {
        return Array.from({ length: high - low + 1 }, (_, row) => high - row);
    }

    stepToTick(step) {
        return (step * this.ppq) / 4;
    }

    tickToStep(tick) {
        return (tick * 4) / this.ppq;
    }
    // Note identity is independent of pitch and position, allowing overlapping notes.
    addNote(data) {
        const { midi, trackId = 'piano', velocity = 0.7 } = data;
        const ticks = data.ticks ?? Math.round(this.stepToTick(data.startStep));
        const durationTicks =
            data.durationTicks ?? Math.round(this.stepToTick(data.durationSteps ?? 1));
        const velocityMidi = data.velocityMidi ?? Math.max(1, Math.round(velocity * 127));
        const noteOffVelocity = data.noteOffVelocity ?? 0;
        if (
            !Number.isInteger(midi) ||
            midi < 0 ||
            midi > 127 ||
            !Number.isSafeInteger(ticks) ||
            ticks < 0 ||
            ticks >= this.stepToTick(this.stepCount) ||
            !Number.isSafeInteger(durationTicks) ||
            durationTicks <= 0 ||
            !Number.isFinite(velocity) ||
            velocity < 0 ||
            velocity > 1 ||
            !Number.isInteger(velocityMidi) ||
            velocityMidi < 1 ||
            velocityMidi > 127 ||
            !Number.isInteger(noteOffVelocity) ||
            noteOffVelocity < 0 ||
            noteOffVelocity > 127 ||
            !this.tracks.some((track) => track.id === trackId)
        ) {
            throw new RangeError('Invalid note or unknown musical track.');
        }
        // Bulk imports must not scan every earlier note for every new ID.
        if (this.#indexedNotes !== this.notes || this.#noteIds.size !== this.notes.length) {
            this.#noteIds = new Set(this.notes.map((note) => note.id));
            this.#indexedNotes = this.notes;
        }
        while (this.#noteIds.has(`note-${this.nextId}`)) {
            this.nextId++;
        }
        const id = data.id ?? `note-${this.nextId++}`;
        if (this.#noteIds.has(id)) {
            throw new Error('Duplicate note ID.');
        }
        const note = {
            id,
            midi,
            ticks,
            durationTicks,
            velocity: velocityMidi / 127,
            velocityMidi,
            noteOffVelocity,
            trackId,
            importId: data.importId ?? null
        };
        Object.defineProperties(note, {
            startStep: { enumerable: false, get: () => this.tickToStep(note.ticks) },
            durationSteps: { enumerable: false, get: () => this.tickToStep(note.durationTicks) }
        });
        this.notes.push(note);
        this.#noteIds.add(id);
        return note;
    }

    static validateTrackName(name) {
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 128) {
            throw new RangeError('Use a MIDI track name with 1–128 characters.');
        }
        return name.trim();
    }

    addMusicalTrack({ name = 'MIDI Track', channel = 0, program = 0 } = {}) {
        const validName = NoteSequence.validateTrackName(name);
        if (!Number.isInteger(channel) || channel < 0 || channel > 15 ||
            !Number.isInteger(program) || program < 0 || program > 127 || this.tracks.length >= 255) {
            throw new RangeError('Use a valid MIDI channel/program and at most 255 musical tracks.');
        }
        const ids = new Set(this.tracks.map((track) => track.id));
        while (ids.has(`track-${this.nextTrackId}`)) {
            this.nextTrackId++;
        }
        const track = { id: `track-${this.nextTrackId++}`, name: validName, channel, program };
        this.tracks.push(track);
        return track;
    }

    renameMusicalTrack(id, name) {
        const validName = NoteSequence.validateTrackName(name);
        const track = this.tracks.find((candidate) => candidate.id === id);
        if (!track) {
            throw new RangeError('Choose an existing musical track.');
        }
        track.name = validName;
        return track;
    }

    moveMusicalTrack(id, toIndex) {
        const fromIndex = this.tracks.findIndex((track) => track.id === id);
        if (fromIndex < 0 || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= this.tracks.length) {
            throw new RangeError('Choose an existing MIDI track and valid destination.');
        }
        if (fromIndex === toIndex) {
            return false;
        }
        const [track] = this.tracks.splice(fromIndex, 1);
        this.tracks.splice(toIndex, 0, track);
        return true;
    }

    setMusicalTrackOrder(ids) {
        const byId = new Map(this.tracks.map((track) => [track.id, track]));
        if (!Array.isArray(ids) || ids.length !== this.tracks.length ||
            new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
            throw new RangeError('Track order must contain every current MIDI track ID exactly once.');
        }
        this.tracks.splice(0, this.tracks.length, ...ids.map((id) => byId.get(id)));
    }

    deleteMusicalTrack(id) {
        const index = this.tracks.findIndex((track) => track.id === id);
        if (index < 0 || this.tracks.length <= 1) {
            throw new RangeError('Choose an existing MIDI track; the last MIDI track cannot be deleted.');
        }
        const record = {
            track: { ...this.tracks[index] },
            index,
            notes: []
        };
        this.notes.forEach((note, noteIndex) => {
            if (note.trackId === id) {
                record.notes.push({ note: { ...note }, index: noteIndex });
            }
        });
        this.tracks.splice(index, 1);
        this.notes = this.notes.filter((note) => note.trackId !== id);
        return record;
    }

    restoreMusicalTrack(record) {
        if (!record?.track || typeof record.track.id !== 'string' || !record.track.id ||
            typeof record.track.name !== 'string' || !Number.isInteger(record.track.channel) ||
            record.track.channel < 0 || record.track.channel > 15 || !Number.isInteger(record.track.program) ||
            record.track.program < 0 || record.track.program > 127 || !Number.isInteger(record.index) || record.index < 0 ||
            record.index > this.tracks.length || this.tracks.some((track) => track.id === record.track.id) ||
            !Array.isArray(record.notes)) {
            throw new RangeError('Cannot restore this MIDI track in the current composition.');
        }
        const ids = new Set(this.notes.map((note) => note.id));
        const indices = new Set();
        // Validate every restored record off-model before making any structural change.
        const staged = new NoteSequence(this.stepCount, this.ppq);
        staged.tracks = [record.track];
        for (const entry of record.notes) {
            if (!entry.note?.id || ids.has(entry.note.id) || entry.note.trackId !== record.track.id ||
                !Number.isInteger(entry.index) || entry.index < 0 || indices.has(entry.index)) {
                throw new RangeError('Restored MIDI notes must have unique original IDs and positions.');
            }
            indices.add(entry.index);
            staged.addNote(entry.note);
        }
        const pianoHasNotes = this.notes.some((note) => note.trackId === 'piano') ||
            record.notes.some((entry) => entry.note.trackId === 'piano');
        const exportedCount = [...this.tracks, record.track].filter((track) =>
            !this.importInfo || track.id !== 'piano' || pianoHasNotes).length;
        if (exportedCount > 255) {
            throw new RangeError('Restoring this track would exceed the MIDI track limit.');
        }
        const survivors = [...this.notes];
        this.tracks.splice(record.index, 0, { ...record.track });
        const restored = record.notes.map((entry) => ({ index: entry.index, note: this.addNote(entry.note) }))
            .sort((a, b) => a.index - b.index);
        const merged = [];
        let survivingIndex = 0;
        let restoredIndex = 0;
        while (survivingIndex < survivors.length || restoredIndex < restored.length) {
            if (restoredIndex < restored.length &&
                (merged.length >= restored[restoredIndex].index || survivingIndex >= survivors.length)) {
                merged.push(restored[restoredIndex++].note);
            } else {
                merged.push(survivors[survivingIndex++]);
            }
        }
        this.notes = merged;
        return this.tracks[record.index];
    }

    ensurePianoTrack() {
        if (this.tracks.some((track) => track.id === 'piano')) {
            return 'piano';
        }
        // Deleting Piano is intentional. Use a survivor instead of resurrecting it on creation/import.
        if (this.tracks.length) {
            return this.tracks[0].id;
        }
        this.tracks.push({ id: 'piano', name: 'Piano', channel: 0, program: 0 });
        return 'piano';
    }

    updateNoteTiming(id, ticks, durationTicks) {
        const note = this.notes.find((candidate) => candidate.id === id);
        const patternEnd = Math.floor(this.stepToTick(this.stepCount));
        if (
            !note ||
            !Number.isSafeInteger(ticks) ||
            !Number.isSafeInteger(durationTicks) ||
            ticks < 0 ||
            durationTicks < 1 ||
            ticks + durationTicks > patternEnd
        ) {
            throw new RangeError(
                'Keep the note inside the pattern with a duration of at least one tick.'
            );
        }
        note.ticks = ticks;
        note.durationTicks = durationTicks;
        return note;
    }

    copyAtPpq(ppq) {
        const copy = new NoteSequence(this.stepCount, ppq);
        const scaleTick = (tick) => {
            // Multiply integers first; a fractional ratio can introduce false rounding error.
            const numerator = tick * ppq;
            const converted = numerator / this.ppq;
            if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(converted)) {
                throw new Error(
                    'These PPQ resolutions cannot be combined without changing note timing.'
                );
            }
            return converted;
        };
        copy.name = this.name;
        copy.tracks = this.tracks.map((track) => ({ ...track }));
        copy.tempos = this.tempos.map((tempo) => ({ ...tempo, ticks: scaleTick(tempo.ticks) }));
        copy.timeSignatures = this.timeSignatures.map((event) => ({
            ticks: scaleTick(event.ticks),
            timeSignature: [...event.timeSignature]
        }));
        this.notes.forEach((note) =>
            copy.addNote({
                ...note,
                ticks: scaleTick(note.ticks),
                durationTicks: scaleTick(note.durationTicks)
            })
        );
        return copy;
    }

    withoutMidiImport() {
        if (!this.importInfo) {
            return this.copyAtPpq(this.ppq);
        }
        const info = this.importInfo;
        const remaining = new NoteSequence(this.stepCount, this.ppq);
        remaining.name = info.previousName;
        remaining.tracks = this.tracks
            .filter((track) => track.importId !== info.id)
            .map((track) => ({ ...track }));
        const fallbackTrackId = remaining.ensurePianoTrack();
        remaining.tempos = info.previousTempos.map((tempo) => ({ ...tempo }));
        remaining.timeSignatures = info.previousTimeSignatures.map((event) => ({
            ticks: event.ticks,
            timeSignature: [...event.timeSignature]
        }));
        this.notes
            .filter((note) => note.importId !== info.id)
            .forEach((note) => {
                const trackExists = remaining.tracks.some((track) => track.id === note.trackId);
                remaining.addNote({ ...note, trackId: trackExists ? note.trackId : fallbackTrackId });
            });
        const lastNoteEnd = remaining.notes.reduce(
            (end, note) => Math.max(end, note.ticks + note.durationTicks),
            0
        );
        remaining.stepCount = Math.max(
            16,
            info.previousStepCount,
            Math.ceil(remaining.tickToStep(lastNoteEnd))
        );
        return remaining;
    }

    withMidiImport(imported, importId) {
        // Replacing an import removes only its provenance group, never manual notes.
        const manual = this.withoutMidiImport();
        const gcd = (a, b) => (b ? gcd(b, a % b) : a);
        const ppq = manual.notes.length
            ? (manual.ppq / gcd(manual.ppq, imported.ppq)) * imported.ppq
            : imported.ppq;
        if (ppq > 32767) {
            throw new Error(
                'Cannot combine these PPQ resolutions exactly. Export your work and use New Sequence first.'
            );
        }
        // With no notes, retain the original grid positions of the baseline maps too.
        const copy = manual.copyAtPpq(ppq);
        const source = imported.copyAtPpq(ppq);
        copy.ensurePianoTrack();
        copy.importInfo = {
            id: importId,
            noteCount: source.notes.length,
            previousName: copy.name,
            previousStepCount: copy.stepCount,
            previousTempos: copy.tempos,
            previousTimeSignatures: copy.timeSignatures
        };
        copy.name = source.name;
        const manualEnd = copy.notes.reduce(
            (end, note) => Math.max(end, note.ticks + note.durationTicks),
            0
        );
        copy.stepCount = Math.max(
            copy.stepCount,
            source.stepCount,
            Math.ceil(copy.tickToStep(manualEnd))
        );
        if (copy.stepCount > 65536) {
            throw new Error('The combined composition exceeds 65536 steps.');
        }
        copy.tempos = source.tempos;
        copy.timeSignatures = source.timeSignatures;
        const trackIds = new Map();
        source.tracks.forEach((track, index) => {
            const id = `${importId}-track-${index}`;
            trackIds.set(track.id, id);
            copy.tracks.push({ ...track, id, importId, sourceTrackId: track.id });
        });
        source.notes.forEach((note) =>
            copy.addNote({
                ...note,
                id: `${importId}-${note.id}`,
                trackId: trackIds.get(note.trackId),
                importId
            })
        );
        const exportedTrackCount = copy.tracks.filter(
            (track) => track.id !== 'piano' || copy.notes.some((note) => note.trackId === 'piano')
        ).length;
        if (exportedTrackCount > 255) {
            throw new Error('The combined composition exceeds 255 musical MIDI tracks.');
        }
        return copy;
    }

    removeById(id) {
        this.notes = this.notes.filter((note) => note.id !== id);
    }

    removeNote(midi, startStep, trackId = 'piano') {
        this.notes = this.notes.filter(
            (note) =>
                !(note.midi === midi && note.startStep === startStep && note.trackId === trackId)
        );
    }

    hasNote(midi, startStep, trackId = 'piano') {
        return this.notes.some(
            (note) => note.midi === midi && note.startStep === startStep && note.trackId === trackId
        );
    }

    toggleNote(midi, startStep, trackId = 'piano') {
        if (this.hasNote(midi, startStep, trackId)) {
            this.removeNote(midi, startStep, trackId);
        } else {
            this.addNote({ midi, startStep, trackId });
        }
    }

    notesAt(step) {
        return this.notes.filter(
            (note) => note.ticks >= this.stepToTick(step) && note.ticks < this.stepToTick(step + 1)
        );
    }
    // Integrate each tempo segment before converting the remaining ticks.
    ticksToSeconds(ticks) {
        let elapsedSeconds = 0;
        let lastTempoTick = 0;
        let currentBpm = 120;
        for (const tempo of this.tempos) {
            if (tempo.ticks > ticks) {
                break;
            }
            elapsedSeconds += ((tempo.ticks - lastTempoTick) * 60) / (currentBpm * this.ppq);
            lastTempoTick = tempo.ticks;
            currentBpm = tempo.bpm;
        }
        return elapsedSeconds + ((ticks - lastTempoTick) * 60) / (currentBpm * this.ppq);
    }
    // Invert the same segments without rounding the resulting musical position.
    secondsToTicks(seconds) {
        let elapsedSeconds = 0;
        let lastTempoTick = 0;
        let currentBpm = 120;
        for (const tempo of this.tempos) {
            const nextTempoSeconds =
                elapsedSeconds + ((tempo.ticks - lastTempoTick) * 60) / (currentBpm * this.ppq);
            if (nextTempoSeconds > seconds) {
                break;
            }
            elapsedSeconds = nextTempoSeconds;
            lastTempoTick = tempo.ticks;
            currentBpm = tempo.bpm;
        }
        return lastTempoTick + ((seconds - elapsedSeconds) * currentBpm * this.ppq) / 60;
    }
    // Meter affects labels, not the duration of a quarter note. A meter change starts a new measure.
    positionAtTick(tick) {
        let meterStartTick = 0;
        let measure = 1;
        let meter = [4, 4];
        for (const event of this.timeSignatures) {
            if (event.ticks > tick) {
                break;
            }
            const measureTicks = (this.ppq * 4 * meter[0]) / meter[1];
            measure += Math.ceil((event.ticks - meterStartTick) / measureTicks);
            meterStartTick = event.ticks;
            meter = event.timeSignature;
        }
        const beatTicks = (this.ppq * 4) / meter[1];
        const ticksIntoMeter = tick - meterStartTick;
        return {
            measure: measure + Math.floor(ticksIntoMeter / (beatTicks * meter[0])),
            beat: (Math.floor(ticksIntoMeter / beatTicks) % meter[0]) + 1,
            onBeat:
                Math.abs(ticksIntoMeter / beatTicks - Math.round(ticksIntoMeter / beatTicks)) <
                1e-8,
            meter
        };
    }
    // Runtime getters are omitted; persistence uses canonical integer ticks.
    toJSON() {
        return {
            version: 2,
            name: this.name,
            ppq: this.ppq,
            stepCount: this.stepCount,
            importInfo: this.importInfo,
            tracks: this.tracks.map((track) => ({ ...track })),
            tempos: this.tempos.map((tempo) => ({ ...tempo })),
            timeSignatures: this.timeSignatures.map((event) => ({
                ticks: event.ticks,
                timeSignature: [...event.timeSignature]
            })),
            notes: this.notes.map((note) => ({ ...note }))
        };
    }
}
