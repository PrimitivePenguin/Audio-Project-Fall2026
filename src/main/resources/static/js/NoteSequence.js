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

    ensurePianoTrack() {
        if (!this.tracks.some((track) => track.id === 'piano')) {
            this.tracks.unshift({ id: 'piano', name: 'Piano', channel: 0, program: 0 });
        }
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
        remaining.ensurePianoTrack();
        remaining.tempos = info.previousTempos.map((tempo) => ({ ...tempo }));
        remaining.timeSignatures = info.previousTimeSignatures.map((event) => ({
            ticks: event.ticks,
            timeSignature: [...event.timeSignature]
        }));
        this.notes
            .filter((note) => note.importId !== info.id)
            .forEach((note) => {
                const trackExists = remaining.tracks.some((track) => track.id === note.trackId);
                remaining.addNote({ ...note, trackId: trackExists ? note.trackId : 'piano' });
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
