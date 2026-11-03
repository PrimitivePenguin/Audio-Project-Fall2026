document.addEventListener('DOMContentLoaded', () => {
    const manager = new DashboardManager();
    const projectList = document.getElementById('projectList');
    const importFileInput = document.getElementById('importFile');
    const newProjectNameInput = document.getElementById('newProjectName');
    const createBtn = document.getElementById('createBtn');
    const statusEl = document.getElementById('status');

    function showStatus(msg) {
        statusEl.textContent = msg;
    }

    function renderList() {
        projectList.replaceChildren();
        const projects = manager.getProjects();
        const items = Object.values(projects);

        if (items.length === 0) {
            const li = document.createElement('li');
            li.textContent = 'No saved projects found. Import a MIDI file or create a new project above.';
            projectList.appendChild(li);
            return;
        }

        items.forEach(proj => {
            const li = document.createElement('li');
            li.style.cssText = 'margin: 10px 0; padding: 12px; background: #fff; border: 1px solid #cbd5e1; border-radius: 6px; display: flex; align-items: center; justify-content: space-between;';

            const info = document.createElement('span');
            info.textContent = `${proj.name} (Updated: ${new Date(proj.updatedAt).toLocaleString()})`;

            const buttonGroup = document.createElement('div');

            //Open button
            const openBtn = document.createElement('button');
            openBtn.textContent = 'Open';
            openBtn.type = 'button';
            openBtn.style.marginRight = '8px';
            openBtn.onclick = () => {
                localStorage.setItem('activeProjectId', proj.id);
                window.location.href = '/index.html';
            };

            //Download button
            const exportBtn = document.createElement('button');
            exportBtn.textContent = 'Download MIDI';
            exportBtn.type = 'button';
            exportBtn.onclick = () => {
                try {
                    const seq = new NoteSequence(proj.data.stepCount, proj.data.ppq);
                    seq.name = proj.name;
                    seq.tracks = proj.data.tracks;
                    seq.tempos = proj.data.tempos;
                    seq.timeSignatures = proj.data.timeSignatures;
                    seq.importInfo = proj.data.importInfo;
                    proj.data.notes.forEach(n => seq.addNote(n));

                    const { bytes } = MidiIO.encode(seq);
                    const blob = new Blob([bytes], { type: 'audio/midi' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${proj.name}.mid`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    showStatus(`Downloaded "${proj.name}.mid".`);
                } catch (err) {
                    showStatus(`Export error: ${err.message}`);
                }
            };

            //Rename button
            const renameBtn = document.createElement('button');
            renameBtn.textContent = 'Rename';
            renameBtn.type = 'button';
            renameBtn.style.marginLeft = '8px';
            renameBtn.onclick = () => {
                const newName = prompt('Enter new project name:', proj.name);
                if (newName) {
                    manager.renameProject(proj.id, newName);
                    renderList();
                    showStatus('Project renamed successfully.');
                }
            };

            //Delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.type = 'button';
            deleteBtn.style.marginLeft = '8px';
            deleteBtn.onclick = () => {
                if (confirm(`Delete project "${proj.name}"?`)) {
                    manager.deleteProject(proj.id);
                    renderList();
                    showStatus('Project deleted.');
                }
            };

            buttonGroup.append(openBtn, exportBtn, renameBtn, deleteBtn);
            li.append(info, buttonGroup);
            projectList.appendChild(li);
        });
    }

    createBtn.onclick = () => {
        const name = newProjectNameInput.value.trim() || 'Untitled Project';
        const defaultSeq = new NoteSequence(16, 480);
        defaultSeq.name = name;
        manager.saveProject(name, defaultSeq.toJSON());
        newProjectNameInput.value = '';
        renderList();
        showStatus(`Created blank project "${name}".`);
    };

    importFileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const buffer = await file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            const { sequence } = MidiIO.parse(bytes);
            manager.saveProject(file.name.replace(/\.[^/.]+$/, ''), sequence.toJSON());
            importFileInput.value = '';
            renderList();
            showStatus(`Successfully imported and saved "${file.name}" to dashboard library.`);
        } catch (err) {
            showStatus(`Import failed: ${err.message}`);
        }
    };

    renderList();
});