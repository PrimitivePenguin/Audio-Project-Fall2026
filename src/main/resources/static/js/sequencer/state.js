// One editor state object. Musical data stays in SequencerEngine and AudioArrangement.
function createSequencerState(engine) {
    const getElement = (id) => document.getElementById(id);
    const ROLL = (() => {
        const css = getComputedStyle(document.documentElement);
        const v = (name) => {
            const value = css.getPropertyValue(`--roll-${name}`).trim();
            // An empty value is ignored by the canvas, which would silently reuse the previous colour.
            if (!value) console.warn(`sequencer-ui: CSS variable --roll-${name} is not set in css/sequencer.css`);
            return value;
        };
        return {
            bg: v('bg'), rowSharp: v('row-sharp'), rowLine: v('row-line'), beatLine: v('beat-line'),
            loopShade: v('loop-shade'), keyWhite: v('key-white'), keyBlack: v('key-black'),
            keyLabel: v('key-label'), keyLabelOnBlack: v('key-label-on-black'), rulerBg: v('ruler-bg'),
            text: v('text'), noteOutline: v('note-outline'), noteSelected: v('note-selected'),
            noteDelete: v('note-delete'), grip: v('grip'), cursor: v('cursor'), playback: v('playback'),
            marquee: v('marquee'), marqueeFill: v('marquee-fill'), laneActive: v('lane-active'),
            laneAlt: v('lane-alt'), laneHeader: v('lane-header'), laneHeaderActive: v('lane-header-active')
        };
    })();
    const statusElement = getElement('status');
    const bpmInput = getElement('bpm');
    const loopStartInput = getElement('loopStart');
    const loopEndInput = getElement('loopEnd');
    const playButton = getElement('playButton');
    const pianoViewport = getElement('pianoViewport');
    const pianoCanvas = getElement('pianoCanvas');
    const pianoSpacer = getElement('pianoSpacer');
    const mixerPanel = getElement('trackMixer');
    const drawingContext = pianoCanvas.getContext('2d');
    const { keyboardWidth: KEYBOARD_WIDTH, rulerHeight: RULER_HEIGHT } = PianoRollEditor.geometry;
    const baseGeometry = { ...PianoRollEditor.geometry };
    let { rowHeight: ROW_HEIGHT, stepWidth: STEP_WIDTH } = baseGeometry;
    let workspaceMode = 'piano';
    let snapMode = 'sixteenth';
    const supportedMeters = ['4/4', '3/4', '6/8', '5/4', '7/8'];
    let activeTrackId = null;
    let ghostNotesEnabled = false;
    let workspaceSequence = null;
    let pianoScrollTop = 0;
    let selectedNoteId = null;
    const selectedIds = new Set();
    let editGesture = null;
    let cursorGesture = null;
    let trackGesture = null;
    let clipboard = null;
    let editingCursorTick = 0;
    const undoStack = [];
    const redoStack = [];
    const playbackFollow = new PianoRollFollow();
    let pendingViewportRender = false;
    let midiImportController = null;
    let isStartingPlayback = false;
    let lowestPitch = 36;
    let highestPitch = 83;
    let displayedStep = null;
    let newNoteLengthSteps = 1;
    let newNoteVelocity = 89;
    let resizeGesture = null;
    let suppressResizeClick = false;
    let overlapIds = [];
    let databaseProject = null;
    let loadedInstrumentState = null;

    return {
        engine, getElement, ROLL, statusElement, bpmInput,
        loopStartInput, loopEndInput, playButton, pianoViewport, pianoCanvas,
        pianoSpacer, mixerPanel, drawingContext,
        KEYBOARD_WIDTH, RULER_HEIGHT, baseGeometry, ROW_HEIGHT, STEP_WIDTH,
        workspaceMode, snapMode, supportedMeters, activeTrackId, ghostNotesEnabled,
        workspaceSequence, pianoScrollTop, selectedNoteId,
        selectedIds, editGesture, cursorGesture, trackGesture,
        clipboard, editingCursorTick,
        undoStack, redoStack, playbackFollow,
        pendingViewportRender, midiImportController, isStartingPlayback, lowestPitch,
        highestPitch, displayedStep, newNoteLengthSteps, newNoteVelocity,
        resizeGesture, suppressResizeClick, overlapIds,
        databaseProject, loadedInstrumentState,
    };
}
