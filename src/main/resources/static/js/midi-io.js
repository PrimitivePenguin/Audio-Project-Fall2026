/* Note-focused SMF adapter. @tonejs/midi 2.0.28 is bundled locally. */
class MidiIO {
    // Structural validation before handing data to the library. Also collect unsupported-event warnings.
    static inspect(bytes) {
        if (!(bytes instanceof Uint8Array)) {
            bytes = new Uint8Array(bytes);
        }
        if (bytes.length > 10 * 1024 * 1024) {
            throw new Error('MIDI limit: 10 MB.');
        }
        let byteOffset = 0;
        const requireBytes = (byteCount) => {
            if (byteOffset + byteCount > bytes.length) {
                throw new Error('Truncated MIDI file.');
            }
        };
        const readByte = () => {
            requireBytes(1);
            return bytes[byteOffset++];
        };
        const readUnsignedInteger = (byteCount) => {
            let value = 0;
            while (byteCount--) {
                value = value * 256 + readByte();
            }
            return value;
        };
        const readText = (byteCount) => {
            let value = '';
            while (byteCount--) {
                value += String.fromCharCode(readByte());
            }
            return value;
        };
        // SMF delta times use at most four seven-bit groups, most significant first.
        const readVariableLengthValue = () => {
            let value = 0;
            for (let i = 0; i < 4; i++) {
                const currentByte = readByte();
                value = value * 128 + (currentByte & 127);
                if (!(currentByte & 128)) {
                    return value;
                }
            }
            throw new Error('Invalid MIDI variable-length value.');
        };
        if (readText(4) !== 'MThd') {
            throw new Error('Not a Standard MIDI File (missing MThd).');
        }
        const headerLength = readUnsignedInteger(4);
        if (headerLength !== 6) {
            throw new Error('Unsupported MIDI header length.');
        }
        const format = readUnsignedInteger(2);
        const count = readUnsignedInteger(2);
        const ppq = readUnsignedInteger(2);
        if (format !== 0 && format !== 1) {
            throw new Error('Only MIDI formats 0 and 1 are supported; format 2 is not supported.');
        }
        if (ppq & 0x8000) {
            throw new Error('SMPTE timing is not supported. Use PPQ MIDI.');
        }
        if (!ppq || !count || count > 256 || (format === 0 && count !== 1)) {
            throw new Error('Invalid MIDI timing or track count (maximum 256 tracks).');
        }
        const warnings = new Set();
        const endings = [];
        let noteCount = 0;
        let maxTick = 0;
        for (let track = 0; track < count; track++) {
            maxTick = Math.max(maxTick, inspectTrack());
        }
        if (byteOffset !== bytes.length) {
            throw new Error('Unexpected trailing MIDI data.');
        }
        return { bytes, ppq, warnings: [...warnings], maxTick, noteCount, endings };

        function inspectTrack() {
            if (readText(4) !== 'MTrk') {
                throw new Error('Missing MIDI track chunk.');
            }
            const length = readUnsignedInteger(4);
            requireBytes(length);
            const end = byteOffset + length;
            let runningStatus = 0;
            let ticks = 0;
            let hasEndOfTrack = false;
            const activeNotes = new Map();

            function inspectMetadataEvent(deltaStart, previousTick) {
                const type = readByte();
                const size = readVariableLengthValue();
                requireBytes(size);
                const requiredLength = { 0x2f: 0, 0x51: 3, 0x58: 4, 0x59: 2 }[type];
                if (requiredLength !== undefined && size !== requiredLength) {
                    throw new Error('Invalid MIDI metadata length.');
                }
                if (type === 0x51 && !bytes.slice(byteOffset, byteOffset + size).some(Boolean)) {
                    throw new Error('MIDI tempo cannot be zero.');
                }
                if (type === 0x58 && (!bytes[byteOffset] || bytes[byteOffset + 1] > 7)) {
                    throw new Error('Unsupported time signature.');
                }
                if (![0x2f, 0x51, 0x58, 0x03].includes(type)) {
                    warnings.add(
                        'Additional text, key signatures and other metadata are not retained.'
                    );
                }
                byteOffset += size;
                if (type === 0x2f) {
                    endings.push({ deltaStart, previousTick, end });
                    hasEndOfTrack = true;
                    if (byteOffset !== end) {
                        throw new Error('Unexpected events after end-of-track.');
                    }
                }
            }

            function inspectChannelEvent(status) {
                runningStatus = status;
                const eventKind = status >> 4;
                const channel = status & 15;
                const firstDataByte = readByte();
                const secondDataByte = eventKind === 0xc || eventKind === 0xd ? 0 : readByte();
                if (firstDataByte > 127 || secondDataByte > 127) {
                    throw new Error('Invalid MIDI channel data.');
                }
                const key = `${channel}:${firstDataByte}`;
                if (eventKind === 9 && secondDataByte > 0) {
                    if (activeNotes.get(key)) {
                        warnings.add(
                            'Same-pitch overlapping notes are paired FIFO; MIDI has no per-note identities.'
                        );
                    }
                    activeNotes.set(key, (activeNotes.get(key) ?? 0) + 1);
                    noteCount++;
                } else if (eventKind === 8 || (eventKind === 9 && secondDataByte === 0)) {
                    if (!activeNotes.get(key)) {
                        throw new Error(
                            'Unmatched MIDI note-off; file cannot be imported reliably.'
                        );
                    }
                    activeNotes.set(key, activeNotes.get(key) - 1);
                } else if (eventKind === 0xc) {
                    if (ticks > 0) {
                        warnings.add(
                            'Program changes are represented as separate channel/program tracks; their original event positions are not retained.'
                        );
                    }
                    if (
                        [...activeNotes.entries()].some(
                            ([key, count]) => key.startsWith(`${channel}:`) && count
                        )
                    ) {
                        throw new Error(
                            'Program change during an active note is not supported reliably.'
                        );
                    }
                } else {
                    warnings.add(
                        'Controllers (including sustain), pitch bend and aftertouch are not retained or rendered.'
                    );
                }
            }

            while (byteOffset < end) {
                const deltaStart = byteOffset;
                const previousTick = ticks;
                ticks += readVariableLengthValue();
                if (!Number.isSafeInteger(ticks)) {
                    throw new Error('MIDI tick overflow.');
                }
                let status = readByte();
                // A data byte reuses the last channel status; do not consume it twice.
                if (status < 128) {
                    if (!runningStatus) {
                        throw new Error('Invalid MIDI running status.');
                    }
                    byteOffset--;
                    status = runningStatus;
                }
                if (status === 0xff) {
                    inspectMetadataEvent(deltaStart, previousTick);
                } else if (status === 0xf0 || status === 0xf7) {
                    const size = readVariableLengthValue();
                    requireBytes(size);
                    byteOffset += size;
                    runningStatus = 0;
                    warnings.add('System-exclusive events are not retained.');
                } else if (status >= 0x80 && status <= 0xef) {
                    inspectChannelEvent(status);
                } else {
                    throw new Error('Unsupported MIDI status byte.');
                }
                if (byteOffset > end) {
                    throw new Error('MIDI event exceeds its track chunk.');
                }
                if (noteCount > 100000) {
                    throw new Error('MIDI limit: 100,000 notes.');
                }
            }
            if (!hasEndOfTrack || [...activeNotes.values()].some(Boolean)) {
                throw new Error('Missing end-of-track or unmatched MIDI note-on.');
            }
            return ticks;
        }
    }

    static parse(input) {
        const info = this.inspect(input);
        let midi;
        try {
            midi = new Midi(info.bytes);
        } catch (error) {
            throw new Error(`Could not parse MIDI: ${error.message ?? error}`);
        }
        if (midi.tracks.length > 255) {
            throw new Error('Limit: 255 musical channel/program tracks.');
        }
        const endTick = Math.max(
            info.maxTick,
            ...midi.tracks.flatMap((track) =>
                track.notes.map((note) => note.ticks + note.durationTicks)
            )
        );
        const greatestCommonDivisor = (a, b) => (b ? greatestCommonDivisor(b, a % b) : a);
        const stepsPerTickBoundary = 4 / greatestCommonDivisor(info.ppq, 4);
        // Pad only the pattern boundary to an integer tick; preserve every note tick.
        const patternSteps = Math.max(
            16,
            Math.ceil((endTick * 4) / info.ppq / stepsPerTickBoundary) * stepsPerTickBoundary
        );
        const sequence = new NoteSequence(patternSteps, info.ppq);
        sequence.name = midi.name || 'Imported composition';
        sequence.tracks = midi.tracks.map((track, trackIndex) => ({
            id: `midi-${trackIndex}`,
            name: track.name || `Track ${trackIndex + 1}`,
            channel: track.channel,
            program: track.instrument.number
        }));
        if (!sequence.tracks.length) {
            sequence.tracks.push({ id: 'piano', name: 'Piano', channel: 0, program: 0 });
        }
        // Defaults apply only before the first explicit event; imported maps remain intact.
        sequence.tempos = midi.header.tempos.map((event) => ({
            ticks: event.ticks,
            bpm: event.bpm
        }));
        if (!sequence.tempos.some((event) => event.ticks === 0)) {
            sequence.tempos.unshift({ ticks: 0, bpm: 120 });
        }
        sequence.timeSignatures = midi.header.timeSignatures.map((event) => ({
            ticks: event.ticks,
            timeSignature: [...event.timeSignature]
        }));
        if (!sequence.timeSignatures.some((event) => event.ticks === 0)) {
            sequence.timeSignatures.unshift({ ticks: 0, timeSignature: [4, 4] });
        }
        sequence.tempos.sort((a, b) => a.ticks - b.ticks);
        sequence.timeSignatures.sort((a, b) => a.ticks - b.ticks);
        for (const tempo of sequence.tempos) {
            if (
                !Number.isSafeInteger(tempo.ticks) ||
                !Number.isFinite(tempo.bpm) ||
                tempo.bpm < 1 ||
                tempo.bpm > 1000
            ) {
                throw new Error('Supported MIDI tempo range is 1–1000 BPM.');
            }
        }
        midi.tracks.forEach((track, trackIndex) =>
            track.notes.forEach((note) =>
                sequence.addNote({
                    midi: note.midi,
                    ticks: note.ticks,
                    durationTicks: note.durationTicks,
                    velocityMidi: Math.round(note.velocity * 127),
                    noteOffVelocity: Math.round(note.noteOffVelocity * 127),
                    trackId: sequence.tracks[trackIndex].id
                })
            )
        );
        if (sequence.notes.length !== info.noteCount) {
            throw new Error('Some MIDI notes could not be paired. Import cancelled.');
        }
        return { sequence, warnings: info.warnings };
    }

    static importInto(engine, input) {
        const result = this.parse(input); // Complete validation before mutation.
        result.sequence = engine.importMidiSequence(result.sequence);
        return result;
    }

    static encode(sequence) {
        const midi = new Midi();
        midi.header.fromJSON({
            name: sequence.name,
            ppq: sequence.ppq,
            // SMF tempo is integer microseconds/quarter; guard the library's floor operation.
            tempos: sequence.tempos.map((tempo) => ({
                ticks: tempo.ticks,
                bpm: 60000000 / (Math.round(60000000 / tempo.bpm) + 0.001)
            })),
            timeSignatures: sequence.timeSignatures,
            keySignatures: [],
            meta: []
        });
        // Do not add an unused manual Piano track to an otherwise unchanged MIDI export.
        const exportTracks = sequence.tracks.filter(
            (track) =>
                !sequence.importInfo ||
                track.id !== 'piano' ||
                sequence.notes.some((note) => note.trackId === track.id)
        );
        exportTracks.forEach((track) => {
            const midiTrack = midi.addTrack();
            midiTrack.name = track.name;
            midiTrack.channel = track.channel;
            midiTrack.instrument.number = track.program;
            sequence.notes
                .filter((note) => note.trackId === track.id)
                .forEach((note) =>
                    midiTrack.addNote({
                        midi: note.midi,
                        ticks: note.ticks,
                        durationTicks: note.durationTicks,
                        // Library floors normalized velocities; a sub-integer guard avoids floating-point truncation.
                        velocity: Math.min(1, (note.velocityMidi + 0.01) / 127),
                        noteOffVelocity: Math.min(1, (note.noteOffVelocity + 0.01) / 127)
                    })
                );
        });
        const raw = midi.toArray();
        const info = this.inspect(raw);
        const bytes = padTrackEndings(raw, info, sequence);
        return {
            bytes,
            warnings: [
                'Note-focused export: sample audio, controllers, pitch bend, aftertouch, SysEx, extra metadata and JukeBox loop markers are not exported.'
            ]
        };

        // The library emits EOT after the last event. Move it to retain trailing silence.
        function padTrackEndings(raw, info, sequence) {
            const targetTick = Math.max(
                Math.ceil(sequence.stepToTick(sequence.stepCount)),
                info.maxTick
            );
            const parts = [raw.slice(0, 14)];
            let chunkStart = 14;

            for (const ending of info.endings) {
                const body = [
                    ...raw.slice(chunkStart + 8, ending.deltaStart),
                    ...encodeDeltaTicks(targetTick - ending.previousTick),
                    255,
                    47,
                    0
                ];
                const length = body.length;
                // MTrk followed by its four-byte big-endian payload length.
                parts.push(
                    Uint8Array.from([
                        77,
                        84,
                        114,
                        107,
                        (length >>> 24) & 255,
                        (length >>> 16) & 255,
                        (length >>> 8) & 255,
                        length & 255
                    ]),
                    Uint8Array.from(body)
                );
                chunkStart = ending.end;
            }

            const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
            let offset = 0;
            for (const part of parts) {
                bytes.set(part, offset);
                offset += part.length;
            }
            return bytes;

            function encodeDeltaTicks(value) {
                if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff) {
                    throw new Error('MIDI delta exceeds the supported SMF range.');
                }
                // Each MIDI VLQ byte carries seven bits; the high bit means another byte follows.
                const parts = [value & 127];
                while ((value = Math.floor(value / 128))) {
                    parts.unshift((value & 127) | 128);
                }
                return parts;
            }
        }
    }
}
