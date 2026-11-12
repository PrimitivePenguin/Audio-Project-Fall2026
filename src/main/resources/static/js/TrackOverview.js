// Overview geometry references canonical notes; it owns no composition or transport state.
class TrackOverview {
    static laneHeight = 84;

    static color(trackId) {
        const palette = ['#3474c9', '#47896c', '#9068b6', '#b86a4b', '#378b99', '#b27b23'];
        let hash = 0;
        for (const character of trackId) {
            hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
        }
        return palette[hash % palette.length];
    }

    static lanes(sequence) {
        const lanes = sequence.tracks.map((track, index) => ({
            track,
            index,
            notes: [],
            lowestPitch: 127,
            highestPitch: 0
        }));
        const byId = new Map(lanes.map((lane) => [lane.track.id, lane]));
        for (const note of sequence.notes) {
            const lane = byId.get(note.trackId);
            if (lane) {
                lane.notes.push(note);
                lane.lowestPitch = Math.min(lane.lowestPitch, note.midi);
                lane.highestPitch = Math.max(lane.highestPitch, note.midi);
            }
        }
        return lanes;
    }

    static laneAt(point, scrollTop, trackCount) {
        if (point.y < PianoRollEditor.geometry.rulerHeight) {
            return -1;
        }
        const index = Math.floor((point.y + scrollTop - PianoRollEditor.geometry.rulerHeight) / this.laneHeight);
        return index >= 0 && index < trackCount ? index : -1;
    }

    static dropPosition(pointY, scrollTop, count, fromIndex) {
        const boundary = Math.max(0, Math.min(count,
            Math.round((pointY + scrollTop - PianoRollEditor.geometry.rulerHeight) / this.laneHeight)));
        return { boundary, index: boundary > fromIndex ? boundary - 1 : boundary };
    }

    static rectangle(note, lane, sequence, view) {
        const { keyboardWidth, rulerHeight, stepWidth } = PianoRollEditor.geometry;
        const padding = 12;
        const pitchHeight = this.laneHeight - padding * 2 - 5;
        const pitchRange = lane.highestPitch - lane.lowestPitch;
        const pitchOffset = pitchRange > 0
            ? (lane.highestPitch - note.midi) / pitchRange * pitchHeight : pitchHeight / 2;
        return {
            x: keyboardWidth + sequence.tickToStep(note.ticks) * stepWidth - view.scrollLeft,
            y: rulerHeight + lane.index * this.laneHeight + padding + pitchOffset - view.scrollTop,
            width: sequence.tickToStep(note.durationTicks) * stepWidth,
            height: 5
        };
    }
}
