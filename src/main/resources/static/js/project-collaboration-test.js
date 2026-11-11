document.addEventListener('DOMContentLoaded', () => {
    const list = document.getElementById('databaseProjectList');
    const status = document.getElementById('databaseProjectStatus');
    const refreshButton = document.getElementById('refreshDatabaseProjectsBtn');
    const createButton = document.getElementById('createDatabaseProjectBtn');
    const nameInput = document.getElementById('databaseProjectName');

    async function request(url, options = {}) {
        const response = await fetch(url, {
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
            ...options
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(body && body.error ? body.error : `Request failed (${response.status})`);
        }
        return body;
    }

    function showError(error) {
        status.textContent = `Error: ${error.message}`;
    }

    function addButton(parent, label, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.margin = '4px';
        button.onclick = async () => {
            button.disabled = true;
            try {
                await action();
                await loadProjects();
            } catch (error) {
                showError(error);
            } finally {
                button.disabled = false;
            }
        };
        parent.appendChild(button);
    }

    function renderProject(project) {
        const item = document.createElement('li');
        item.style.cssText = 'margin: 10px 0; padding: 12px; background: #fff; border: 1px solid #86efac; border-radius: 6px;';

        const title = document.createElement('strong');
        title.textContent = `${project.name} (${project.role})`;
        item.appendChild(title);

        const controls = document.createElement('div');
        addButton(controls, 'Load in editor', async () => {
            window.location.href = `/project/${project.id}`;
        });
        addButton(controls, 'Read', async () => {
            const result = await request(`/api/projects/${project.id}`);
            status.textContent = `Read succeeded: ${result.name}, updated ${new Date(result.updatedAt).toLocaleString()}.`;
        });
        if (project.role === 'OWNER' || project.role === 'EDITOR') {
            addButton(controls, 'Edit name', async () => {
                const name = prompt('New project name:', project.name);
                if (name && name.trim()) {
                    await request(`/api/projects/${project.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ name: name.trim() })
                    });
                }
            });
        }
        if (project.role === 'OWNER') {
            addButton(controls, 'Share', async () => {
                const usernameOrEmail = prompt('Username or email to add:');
                const role = prompt('Role: EDITOR or VIEWER', 'VIEWER');
                if (!usernameOrEmail || !['EDITOR', 'VIEWER'].includes(role)) {
                    throw new Error('Enter a username/email and role EDITOR or VIEWER');
                }
                await request(`/api/projects/${project.id}/collaborators`, {
                    method: 'POST',
                    body: JSON.stringify({ usernameOrEmail, role })
                });
            });
            addButton(controls, 'Collaborators', async () => {
                const collaborators = await request(`/api/projects/${project.id}/collaborators`);
                status.textContent = `Collaborators: ${collaborators.map(c => `${c.userId} (${c.role})`).join(', ')}`;
            });
            addButton(controls, 'Transfer ownership', async () => {
                const usernameOrEmail = prompt('Transfer ownership to username or email:');
                if (usernameOrEmail) {
                    await request(`/api/projects/${project.id}/transfer-ownership`, {
                        method: 'POST',
                        body: JSON.stringify({ usernameOrEmail })
                    });
                }
            });
            addButton(controls, 'Delete', async () => {
                if (confirm(`Delete database project "${project.name}"?`)) {
                    await request(`/api/projects/${project.id}`, { method: 'DELETE' });
                }
            });
        } else {
            addButton(controls, 'Leave project', async () => {
                if (confirm(`Leave "${project.name}"?`)) {
                    await request(`/api/projects/${project.id}/leave`, { method: 'POST' });
                }
            });
        }
        item.appendChild(controls);
        list.appendChild(item);
    }

    async function loadProjects() {
        status.textContent = 'Loading database projects...';
        try {
            const projects = await request('/api/projects');
            list.replaceChildren();
            projects.forEach(renderProject);
            status.textContent = `${projects.length} database project(s) loaded.`;
        } catch (error) {
            list.replaceChildren();
            showError(error);
        }
    }

    refreshButton.onclick = loadProjects;
    createButton.onclick = async () => {
        const name = nameInput.value.trim() || 'Untitled Project';
        createButton.disabled = true;
        try {
            await request('/api/projects', {
                method: 'POST',
                body: JSON.stringify({ name, projectData: '{}' })
            });
            nameInput.value = '';
            await loadProjects();
        } catch (error) {
            showError(error);
        } finally {
            createButton.disabled = false;
        }
    };
    loadProjects();
});
