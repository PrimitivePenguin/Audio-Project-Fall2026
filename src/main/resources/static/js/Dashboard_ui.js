document.addEventListener('DOMContentLoaded', async () => {
    const manager = new DashboardManager();
    const projectList = document.getElementById('projectList');
    const importFileInput = document.getElementById('importFile');
    const newProjectNameInput = document.getElementById('newProjectName');
    const createBtn = document.getElementById('createBtn');
    const statusEl = document.getElementById('status');

    function showStatus(msg) {
        statusEl.textContent = msg;
    }

    async function renderList() {
        projectList.replaceChildren();
        showStatus('Loading projects from database...');
        
        const projects = await manager.getProjects();
        const items = Array.isArray(projects) ? projects : Object.values(projects);

        if (items.length === 0) {
            const li = document.createElement('li');
            li.textContent = 'No saved projects found. Import a MIDI file or create a new project above.';
            projectList.appendChild(li);
            showStatus('Ready.');
            return;
        }

        items.forEach(proj => {
            const li = document.createElement('li');
            li.style.cssText = 'margin: 10px 0; padding: 12px; background: #fff; border: 1px solid #cbd5e1; border-radius: 6px; display: flex; align-items: center; justify-content: space-between;';

            const info = document.createElement('span');
            const updatedAt = proj.updatedAt || proj.updated_at || new Date().toISOString();
            info.textContent = `${proj.name} (Updated: ${new Date(updatedAt).toLocaleString()})`;

            const buttonGroup = document.createElement('div');

            // Open button -> routes to the backend project view
            const openBtn = document.createElement('button');
            openBtn.textContent = 'Open';
            openBtn.type = 'button';
            openBtn.style.marginRight = '8px';
            openBtn.onclick = () => {
                window.location.href = `/project/${proj.id}`;
            };

            // Download MIDI button (client-side export helper)
            const exportBtn = document.createElement('button');
            exportBtn.textContent = 'Download MIDI';
            exportBtn.type = 'button';
            exportBtn.style.marginRight = '8px';
            exportBtn.onclick = () => {
                try {
                    const rawData = typeof proj.projectData === 'string' ? JSON.parse(proj.projectData) : proj.projectData;
                    const seq = new NoteSequence(rawData.stepCount || 16, rawData.ppq || 480);
                    seq.name = proj.name;
                    seq.tracks = rawData.tracks;
                    seq.tempos = rawData.tempos;
                    seq.timeSignatures = rawData.timeSignatures;
                    seq.importInfo = rawData.importInfo;
                    (rawData.notes || []).forEach(n => seq.addNote(n));

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

            // Rename button
            const renameBtn = document.createElement('button');
            renameBtn.textContent = 'Rename';
            renameBtn.type = 'button';
            renameBtn.style.marginRight = '8px';
            renameBtn.onclick = async () => {
                const newName = prompt('Enter new project name:', proj.name);
                if (newName && newName.trim()) {
                    try {
                        await manager.renameProject(proj.id, newName.trim(), proj.version);
                        await renderList();
                        showStatus('Project renamed successfully.');
                    } catch (err) {
                        showStatus(`Rename failed: ${err.message}`);
                    }
                }
            };

            // Delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.type = 'button';
            deleteBtn.onclick = async () => {
                if (confirm(`Delete project "${proj.name}"?`)) {
                    const success = await manager.deleteProject(proj.id);
                    if (success) {
                        await renderList();
                        showStatus('Project deleted.');
                    } else {
                        showStatus('Failed to delete project.');
                    }
                }
            };

            buttonGroup.append(openBtn, exportBtn, renameBtn, deleteBtn);
            li.append(info, buttonGroup);
            projectList.appendChild(li);
        });
        showStatus('Ready.');
    }

    createBtn.onclick = async () => {
        const name = newProjectNameInput.value.trim() || 'Untitled Project';
        const defaultSeq = new NoteSequence(16, 480);
        defaultSeq.name = name;
        
        try {
            const newId = await manager.createProject(name, defaultSeq.toJSON());
            newProjectNameInput.value = '';
            window.location.href = `/project/${newId}`;
        } catch (err) {
            showStatus(`Creation failed: ${err.message}`);
        }
    };

    importFileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const buffer = await file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            const { sequence } = MidiIO.parse(bytes);
            const projectName = file.name.replace(/\.[^/.]+$/, '');
            
            const newId = await manager.createProject(projectName, sequence.toJSON());
            importFileInput.value = '';
            window.location.href = `/project/${newId}`;
        } catch (err) {
            showStatus(`Import failed: ${err.message}`);
        }
    };

    await renderList();
});