// Pure editor calculations use CSS pixels and canonical ticks, never audio time.
class PianoRollEditor {
    static geometry = {
        rowHeight: 24,
        stepWidth: 38,
        keyboardWidth: 100,
        rulerHeight: 32
    };

    static cursorTick(sequence, pointX, scrollLeft) {
        const step = (pointX + scrollLeft - this.geometry.keyboardWidth) / this.geometry.stepWidth;
        const boundedStep = Math.max(0, Math.min(sequence.stepCount, step));
        return Math.min(Math.floor(sequence.stepToTick(sequence.stepCount)),
            Math.round(sequence.stepToTick(boundedStep)));
    }

    static cursorLabel(sequence, ticks) {
        const position = sequence.positionAtTick(ticks);
        const meterEvent = sequence.timeSignatures.filter((event) => event.ticks <= ticks).at(-1);
        const meterStart = meterEvent?.ticks ?? 0;
        const beatTicks = sequence.ppq * 4 / position.meter[1];
        const withinBeat = (ticks - meterStart) % beatTicks;
        const subdivision = Math.floor(withinBeat / sequence.stepToTick(1) + 1e-8) + 1;
        return `Measure ${position.measure} · Beat ${position.beat} · Step ${subdivision}` +
            ` (absolute ${Math.floor(sequence.tickToStep(ticks)) + 1} · tick ${ticks})`;
    }

    static rectangle(note, view) {
        const { rowHeight, stepWidth, keyboardWidth, rulerHeight } = this.geometry;
        return {
            x: keyboardWidth + note.startStep * stepWidth - view.scrollLeft,
            y: rulerHeight + (view.highestPitch - note.midi) * rowHeight - view.scrollTop,
            width: note.durationSteps * stepWidth,
            hitWidth: Math.max(8, note.durationSteps * stepWidth),
            height: rowHeight
        };
    }

    static notesAtPoint(notes, point, view) {
        const { keyboardWidth, rulerHeight } = this.geometry;
        if (point.x < keyboardWidth || point.y < rulerHeight) {
            return [];
        }
        return notes
            .filter((note) => {
                const bounds = this.rectangle(note, view);
                return (
                    point.x >= bounds.x &&
                    point.x <= bounds.x + bounds.hitWidth &&
                    point.y >= bounds.y &&
                    point.y < bounds.y + bounds.height
                );
            })
            .reverse();
    }

    static edgeAtPoint(note, point, view) {
        const bounds = this.rectangle(note, view);
        const leftDistance = Math.abs(point.x - bounds.x);
        const rightDistance = Math.abs(point.x - bounds.x - bounds.hitWidth);
        const tolerance = Math.min(6, Math.max(2, bounds.hitWidth / 3));
        if (Math.min(leftDistance, rightDistance) > tolerance) {
            return null;
        }
        return leftDistance <= rightDistance ? 'left' : 'right';
    }

    static resizedTiming(sequence, original, edge, pointerStep, deletionPointerStep = pointerStep) {
        if (!Number.isFinite(pointerStep)) {
            throw new RangeError('Invalid resize position.');
        }
        const patternEnd = Math.floor(sequence.stepToTick(sequence.stepCount));
        const originalEnd = original.ticks + original.durationTicks;
        const deleteMargin = 6 / this.geometry.stepWidth;
        const startStep = sequence.tickToStep(original.ticks);
        const endStep = sequence.tickToStep(originalEnd);
        const visualEndStep = Math.max(endStep, startStep + 8 / this.geometry.stepWidth);
        const crossedBoundary =
            edge === 'right'
                ? deletionPointerStep < startStep - deleteMargin
                : deletionPointerStep > visualEndStep + deleteMargin;
        if (crossedBoundary) {
            return { ...original, deleteNote: true };
        }
        // Snap duration relative to the fixed endpoint. Imported fractional starts/ends
        // remain exact, but a deliberate resize never manufactures a one-tick sliver.
        const available = edge === 'right' ? patternEnd - original.ticks : originalEnd;
        let maximumSteps = Math.floor(sequence.tickToStep(available));
        if (Math.round(sequence.stepToTick(maximumSteps + 1)) <= available) {
            maximumSteps++;
        }
        if (maximumSteps < 1) {
            return { ...original, limited: true };
        }
        const requestedSteps = edge === 'right' ? pointerStep - startStep : endStep - pointerStep;
        const durationSteps = Math.max(1, Math.min(maximumSteps, Math.round(requestedSteps)));
        const durationTicks = Math.round(sequence.stepToTick(durationSteps));
        if (edge === 'right') {
            return { ticks: original.ticks, durationTicks };
        }
        if (originalEnd > patternEnd) {
            throw new Error('Extend the pattern before moving this note’s left edge.');
        }
        return { ticks: originalEnd - durationTicks, durationTicks };
    }

    static intersects(note, start, end, view) {
        const bounds = this.rectangle(note, view);
        return bounds.x < Math.max(start.x, end.x) &&
            bounds.x + bounds.width > Math.min(start.x, end.x) &&
            bounds.y < Math.max(start.y, end.y) &&
            bounds.y + bounds.height > Math.min(start.y, end.y);
    }

    static movedNotes(sequence, notes, horizontalPixels, verticalPixels) {
        const patternEnd = Math.floor(sequence.stepToTick(sequence.stepCount));
        let minimumTickDelta = -Infinity;
        let maximumTickDelta = Infinity;
        let minimumPitchDelta = -127;
        let maximumPitchDelta = 127;
        for (const note of notes) {
            minimumTickDelta = Math.max(minimumTickDelta, -note.ticks);
            maximumTickDelta = Math.min(maximumTickDelta, patternEnd - note.ticks - note.durationTicks);
            minimumPitchDelta = Math.max(minimumPitchDelta, -note.midi);
            maximumPitchDelta = Math.min(maximumPitchDelta, 127 - note.midi);
        }
        if (minimumTickDelta > maximumTickDelta) {
            return null;
        }
        // Snap the displacement, preserving imported fractional grid positions.
        const requestedTicks = Math.round(sequence.stepToTick(Math.round(horizontalPixels / this.geometry.stepWidth)));
        const ticks = Math.max(minimumTickDelta, Math.min(maximumTickDelta, requestedTicks));
        const requestedPitch = -Math.round(verticalPixels / this.geometry.rowHeight);
        const pitch = Math.max(minimumPitchDelta, Math.min(maximumPitchDelta, requestedPitch));
        return new Map(notes.map((note) => [note.id, {
            ...note,
            ticks: note.ticks + ticks,
            midi: note.midi + pitch
        }]));
    }

    static resizedGroup(sequence, notes, requestedSteps) {
        const patternEnd = Math.floor(sequence.stepToTick(sequence.stepCount));
        const wholeStepTicks = Math.max(1, Math.round(sequence.stepToTick(1)));
        let minimumDelta = -Infinity;
        let maximumDelta = Infinity;
        for (const note of notes) {
            // Existing sub-step notes may stay short, but cannot shrink further by mouse.
            minimumDelta = Math.max(minimumDelta, Math.min(note.durationTicks, wholeStepTicks) - note.durationTicks);
            maximumDelta = Math.min(maximumDelta, patternEnd - note.ticks - note.durationTicks);
        }
        if (minimumDelta > maximumDelta) {
            return new Map(notes.map((note) => [note.id, { ...note, limited: true }]));
        }
        const requestedTicks = Math.round(sequence.stepToTick(Math.round(requestedSteps)));
        const delta = Math.max(minimumDelta, Math.min(maximumDelta, requestedTicks));
        return new Map(notes.map((note) => [note.id, {
            ticks: note.ticks,
            durationTicks: note.durationTicks + delta
        }]));
    }

    static durationTicks(sequence, steps) {
        if (!Number.isFinite(steps) || steps <= 0 || steps > 65536) {
            throw new RangeError('Use a positive note length up to 65536 steps.');
        }
        const ticks = Math.round(sequence.stepToTick(steps));
        if (ticks < 1) {
            throw new RangeError('The minimum duration is one MIDI tick.');
        }
        return ticks;
    }

    static adjustedLength(sequence, durationTicks, direction) {
        const steps = sequence.tickToStep(durationTicks) + direction;
        if (steps > 65536) {
            throw new RangeError('Use a positive note length up to 65536 steps.');
        }
        return Math.max(1, Math.round(sequence.stepToTick(steps)));
    }

    static eligibleNotes(sequence, view = {}) {
        const { trackId = null, hiddenTrackIds = new Set(), lowestPitch = 0, highestPitch = 127 } = view;
        const trackIds = new Set(sequence.tracks
            .filter((track) => !track.hidden && track.visible !== false && !hiddenTrackIds.has(track.id))
            .filter((track) => trackId === null || track.id === trackId)
            .map((track) => track.id));
        return sequence.notes.filter((note) => trackIds.has(note.trackId) &&
            note.midi >= lowestPitch && note.midi <= highestPitch);
    }

    static directionalNote(notes, selected, direction, ppq) {
        const horizontal = direction === 'left' || direction === 'right';
        // Ordinary pattern-bounded values use Numbers. The legacy model also permits
        // safe-integer tails beyond the pattern, requiring exact arithmetic for large centers.
        const maximumNumericCenter = Math.floor(Number.MAX_SAFE_INTEGER / 8);
        const needsExactArithmetic = (note) => 2 * note.ticks + note.durationTicks > maximumNumericCenter;
        const exact = needsExactArithmetic(selected) || notes.some(needsExactArithmetic);
        const center = exact
            ? (note) => 2n * BigInt(note.ticks) + BigInt(note.durationTicks)
            : (note) => 2 * note.ticks + note.durationTicks;
        const selectedCenter = center(selected);
        const four = exact ? 4n : 4;
        const pitchWeight = exact ? 2n * BigInt(ppq) : 2 * ppq;
        const absolute = (value) => value < 0 ? -value : value;
        const isCandidate = (note, noteCenter) => {
            if (note.id === selected.id) {
                return false;
            }
            switch (direction) {
                case 'right':
                    return noteCenter > selectedCenter;
                case 'left':
                    return noteCenter < selectedCenter;
                case 'up':
                    return note.midi > selected.midi;
                case 'down':
                    return note.midi < selected.midi;
                default:
                    return false;
            }
        };
        const compareTies = (candidate, candidateCenter, current, currentCenter) => {
            const pitchDifference = current.midi - candidate.midi;
            if (horizontal && pitchDifference !== 0) {
                return pitchDifference;
            }
            if (candidateCenter !== currentCenter) {
                return candidateCenter < currentCenter ? -1 : 1;
            }
            if (!horizontal && pitchDifference !== 0) {
                return pitchDifference;
            }
            // Code-unit ordering is stable across locales and independent of insertion order.
            return String(candidate.id) < String(current.id) ? -1 : 1;
        };
        let target = null;
        let targetCenter = null;
        let nearestDistance = null;
        for (const note of notes) {
            const noteCenter = center(note);
            if (!isCandidate(note, noteCenter)) {
                continue;
            }
            const pitchDifference = Math.abs(note.midi - selected.midi);
            const rise = exact ? BigInt(pitchDifference) : pitchDifference;
            // Doubled musical centers preserve half-tick positions without pixels or grid rounding.
            const distance = four * absolute(noteCenter - selectedCenter) + pitchWeight * rise;
            if (target === null || distance < nearestDistance ||
                (distance === nearestDistance && compareTies(note, noteCenter, target, targetCenter) < 0)) {
                target = note;
                targetCenter = noteCenter;
                nearestDistance = distance;
            }
        }
        return target;
    }

    static revealNote(note, sequence, view) {
        const { keyboardWidth, rulerHeight, stepWidth, rowHeight } = this.geometry;
        const gridWidth = Math.max(0, view.width - keyboardWidth);
        const gridHeight = Math.max(0, view.height - rulerHeight);
        if (!gridWidth || !gridHeight) {
            return { scrollLeft: view.scrollLeft, scrollTop: view.scrollTop };
        }
        const head = sequence.tickToStep(note.ticks) * stepWidth;
        const noteWidth = Math.max(8, sequence.tickToStep(note.durationTicks) * stepWidth);
        // Reveal the full block when it fits. For an oversized note, reveal its head, not its end.
        const revealWidth = noteWidth > gridWidth ? Math.min(8, gridWidth) : noteWidth;
        const top = (view.highestPitch - note.midi) * rowHeight;
        let scrollLeft = view.scrollLeft;
        let scrollTop = view.scrollTop;
        if (head < scrollLeft) {
            scrollLeft = head;
        } else if (head + revealWidth > scrollLeft + gridWidth) {
            scrollLeft = head + revealWidth - gridWidth;
        }
        if (top < scrollTop) {
            scrollTop = top;
        } else if (top + rowHeight > scrollTop + gridHeight) {
            scrollTop = top + rowHeight - gridHeight;
        }
        const maxLeft = Math.max(0, sequence.stepCount * stepWidth - gridWidth);
        const maxTop = Math.max(0, (view.highestPitch - (view.lowestPitch ?? 0) + 1) * rowHeight - gridHeight);
        return {
            scrollLeft: Math.max(0, Math.min(maxLeft, scrollLeft)),
            scrollTop: Math.max(0, Math.min(maxTop, scrollTop))
        };
    }

    static navigation(notes, sequence, view) {
        if (!notes.length) {
            return null;
        }
        const { rowHeight, stepWidth, keyboardWidth, rulerHeight } = this.geometry;
        const firstTick = notes.reduce((first, note) => Math.min(first, note.ticks), Infinity);
        const visibleTicks = sequence.stepToTick(
            Math.max(1, (view.width - keyboardWidth) / stepWidth)
        );
        const pitches = notes
            .filter((note) => note.ticks < firstTick + visibleTicks)
            .map((note) => note.midi)
            .sort((a, b) => a - b);
        const centralPitch = pitches[Math.floor(pitches.length / 2)];
        return {
            scrollLeft: Math.max(0, sequence.tickToStep(firstTick) * stepWidth - 2 * stepWidth),
            scrollTop: Math.max(
                0,
                (view.highestPitch - centralPitch) * rowHeight -
                    (view.height - rulerHeight - rowHeight) / 2
            )
        };
    }
}

// View-only tracking. The audio clock supplies position; this class never advances musical time.
class PianoRollFollow {
    constructor() {
        this.reset();
    }

    reset() {
        this.state = 'DISARMED';
        this.previous = null;
    }

    interrupt() {
        this.reset();
    }

    update(sample) {
        if (!sample.playing) {
            this.reset();
            return null;
        }
        const gridWidth = Math.max(0, sample.width - PianoRollEditor.geometry.keyboardWidth);
        if (!gridWidth) {
            this.reset();
            return null;
        }
        const difference = sample.contentX - sample.scrollLeft - gridWidth / 2;
        const previous = this.previous;
        const discontinuity = !previous || sample.runId !== previous.runId ||
            sample.pass !== previous.pass || sample.ticks < previous.ticks - 1e-7 || sample.width !== previous.width;
        this.previous = { ...sample, difference };
        if (discontinuity) {
            this.state = difference < -0.5 ? 'ARMED' : 'DISARMED';
            return null;
        }
        if (this.state === 'DISARMED') {
            if (difference < -0.5) {
                this.state = 'ARMED';
            }
            return null;
        }
        if (this.state === 'ARMED' && previous.difference < 0 && difference >= 0 && sample.ticks > previous.ticks) {
            this.state = 'FOLLOWING';
        }
        if (this.state === 'FOLLOWING') {
            return Math.max(0, Math.min(sample.maxScroll, sample.contentX - gridWidth / 2));
        }
        return null;
    }
}
