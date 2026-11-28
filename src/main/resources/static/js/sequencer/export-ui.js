// MIDI and audio export dialogs.
function createExportUI(editorState, actions) {
    const { getElement, engine } = editorState;

    const exportButton = getElement('exportAudio');

    function bind() {
        if (exportButton) {
            const dialog = getElement('audioExportDialog');
            const form = getElement('audioExportForm');
            const filename = getElement('audioExportName');
            const format = getElement('audioExportFormat');
            const close = getElement('closeAudioExport');
            const submit = getElement('renderAudio');
            const status = getElement('audioExportStatus');
            let exporting = false;
            exportButton.onclick = () => {
                if (exporting) return;
                filename.value = editorState.databaseProject?.name || engine.sequence.name || 'JukeBox Song';
                format.value = 'wav';
                status.textContent = '';
                dialog.showModal();
            };
            close.onclick = () => dialog.close();
            dialog.addEventListener('cancel', (event) => {
                if (exporting) event.preventDefault();
            });
            form.onsubmit = async (event) => {
                event.preventDefault();
                if (exporting) return;
                const type = format.value;
                const base = filename.value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
                    .trim().replace(/\.(wav|mp3)$/i, '').replace(/[. ]+$/, '') || 'JukeBox Song';
                exporting = true;
                for (const control of [filename, format, close, submit]) control.disabled = true;
                status.textContent = 'Preparing arrangement…';
                try {
                    const plan = AudioExporter.snapshot(engine);
                    AudioExporter.checkBudget(plan);
                    const seconds = (plan.frames / AudioExporter.sampleRate).toFixed(1);
                    status.textContent = `Rendering ${seconds} seconds of audio…`;
                    // Give the dialog a chance to paint before allocating the offline graph.
                    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
                    const rendered = await AudioExporter.render(plan);
                    status.textContent = `Encoding ${type.toUpperCase()}…`;
                    const blob = await AudioExporter.encode(rendered, type, (progress) => {
                        status.textContent = `Encoding MP3… ${Math.floor(progress * 100)}%`;
                    });
                    const url = URL.createObjectURL(blob);
                    try {
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = `${base}.${type}`;
                        link.click();
                        status.textContent = `Download started for ${link.download}.`;
                    } finally {
                        setTimeout(() => URL.revokeObjectURL(url), 30000);
                    }
                } catch (error) {
                    status.textContent = `Audio export failed: ${error.message}`;
                } finally {
                    exporting = false;
                    for (const control of [filename, format, close, submit]) control.disabled = false;
                    close.focus();
                }
            };
        }
    }

    return { bind };
}
