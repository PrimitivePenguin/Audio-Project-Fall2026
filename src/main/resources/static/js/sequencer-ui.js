(() => {
    const engine = new SequencerEngine();
    const get = id => document.getElementById(id);
    const status = get('status');
    const bpm = get('bpm');
    const start = get('loopStart');
    const end = get('loopEnd');
    const play = get('playButton');
    const grid = get('pianoGrid');
    const cells = [];
    const headers = [];
    let uploadId = 0;
    let lastStep = null;
    let pendingPlay = false;
    const label = document.createElement('div');
    label.className = 'step-label corner'; label.textContent = 'Pitch / Step'; grid.append(label);
    for (let step = 0; step < engine.totalSteps; step++) {
        const header = document.createElement('div');
        header.className = 'step-label' + (step % 4 === 0 ? ' beat' : '');
        header.textContent = step + 1;
        headers.push(header); grid.append(header);
    }
    NoteSequence.visiblePitches().forEach(midi => {
        const black = [1, 3, 6, 8, 10].includes(midi % 12);
        const key = document.createElement('div');
        key.className = 'key' + (black ? ' black' : '');
        key.textContent = NoteSequence.pitchName(midi); grid.append(key);
        for (let step = 0; step < engine.totalSteps; step++) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'cell' + (black ? ' black' : '') + (step % 4 === 0 ? ' beat' : '');
            cell.setAttribute('aria-label', `${NoteSequence.pitchName(midi)}, step ${step + 1}`);
            cell.setAttribute('aria-pressed', 'false');
            cell.addEventListener('click', () => {
                engine.sequence.toggleNote(midi, step);
                const active = engine.sequence.hasNote(midi, step);
                cell.classList.toggle('active', active);
                cell.setAttribute('aria-pressed', String(active));
            });
            cells.push({ cell, step }); grid.append(cell);
        }
    });
    const sampleButtons = [];
    for (let step = 0; step < engine.totalSteps; step++) {
        const button = document.createElement('button');
        button.textContent = step + 1; button.type = 'button'; button.disabled = true;
        button.setAttribute('aria-label', `Sample step ${step + 1}`);
        button.setAttribute('aria-pressed', 'false');
        button.onclick = () => {
            engine.setStep('uploaded', step, !engine.tracks.get('uploaded').steps[step]);
            renderSamples();
        };
        sampleButtons.push(button); get('stepGrid').append(button);
    }
    function renderSamples() {
        const track = engine.tracks.get('uploaded');
        sampleButtons.forEach((button, step) => {
            button.disabled = !track;
            button.classList.toggle('active', Boolean(track?.steps[step]));
            button.setAttribute('aria-pressed', String(Boolean(track?.steps[step])));
        });
    }
    function controls() {
        play.disabled = pendingPlay || engine.isPlaying;
        start.disabled = end.disabled = pendingPlay || engine.isPlaying;
    }
    function updateLoop() {
        try {
            if (!start.value || !end.value) throw new Error('Enter both loop endpoints.');
            engine.setLoopRange(Number(start.value) - 1, Number(end.value));
            status.textContent = `Loop: steps ${engine.loopStart + 1}–${engine.loopEnd}.`;
        } catch (error) { status.textContent = error.message; }
        start.value = engine.loopStart + 1; end.value = engine.loopEnd;
        cells.forEach(({ cell, step }) => cell.classList.toggle('outside', step < engine.loopStart || step >= engine.loopEnd));
        headers.forEach((header, step) => header.classList.toggle('outside', step < engine.loopStart || step >= engine.loopEnd));
    }
    start.onchange = end.onchange = updateLoop;
    bpm.onchange = () => {
        if (!bpm.value.trim() || !Number.isFinite(Number(bpm.value))) status.textContent = 'Enter a BPM from 40 to 240.';
        else { engine.setBpm(Number(bpm.value)); status.textContent = `Tempo: ${engine.bpm} BPM.`; }
        bpm.value = engine.bpm;
    };
    play.onclick = async () => {
        if (pendingPlay || engine.isPlaying) return;
        pendingPlay = true; controls();
        try {
            await engine.play();
            if (engine.isPlaying) status.textContent = 'Playing. Edits affect notes not already queued.';
        } catch (error) { status.textContent = `Playback failed: ${error.message}`; }
        finally { pendingPlay = false; controls(); }
    };
    function stop() {
        engine.stop(); pendingPlay = false; controls(); status.textContent = 'Stopped. Position reset to loop start.';
    }
    get('stopButton').onclick = stop;
    engine.onError = error => { stop(); status.textContent = `Playback failed: ${error.message}`; };
    get('audioFile').onchange = async event => {
        const file = event.target.files[0]; if (!file) return;
        const token = ++uploadId;
        try {
            engine.initContext();
            const buffer = await engine.audioContext.decodeAudioData(await file.arrayBuffer());
            if (token !== uploadId) return;
            const steps = engine.tracks.get('uploaded')?.steps.slice();
            engine.addTrack('uploaded', buffer);
            steps?.forEach((active, step) => engine.setStep('uploaded', step, active));
            renderSamples(); get('sampleStatus').textContent = `Loaded: ${file.name}`;
        } catch (error) {
            if (token === uploadId) get('sampleStatus').textContent = `Could not load audio: ${error.message}. Previous sample retained.`;
        }
    };
    function draw() {
        const step = engine.audioContext ? engine.getPlaybackStep() : null;
        if (step !== lastStep) {
            cells.forEach(({ cell, step: index }) => cell.classList.toggle('current', index === step));
            headers.forEach((header, index) => header.classList.toggle('current', index === step));
            sampleButtons.forEach((button, index) => button.classList.toggle('current', index === step));
            lastStep = step;
        }
        requestAnimationFrame(draw);
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    window.addEventListener('pagehide', () => engine.stop());
    // Center approximately two visible octaves on C4 (MIDI 60).
    get('pianoViewport').scrollTop = 24 + (83 - 60) * 24 - 288;
    controls(); draw();
})();
