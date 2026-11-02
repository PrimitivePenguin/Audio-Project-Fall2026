// Pure editor calculations use CSS pixels and canonical ticks, never audio time.
class PianoRollEditor {
    static geometry = {
        rowHeight: 24,
        stepWidth: 38,
        keyboardWidth: 100,
        rulerHeight: 32
    };

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
