class DashboardManager {
    async getProjects() {
        try {
            const response = await fetch('/api/projects', {
                credentials: 'same-origin'
            });
            if (!response.ok) throw new Error('Failed to fetch projects');
            return await response.json();
        } catch (error) {
            console.error('Error fetching projects:', error);
            return [];
        }
    }

    async getProject(id) {
        try {
            const response = await fetch(`/api/projects/${id}`, {
                credentials: 'same-origin'
            });
            if (!response.ok) throw new Error('Failed to fetch project');
            return await response.json();
        } catch (error) {
            console.error('Error fetching project:', error);
            throw error;
        }
    }

    async createProject(name, sequenceJson) {
        try {
            const response = await fetch('/api/projects', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name || 'Untitled Project',
                    projectData: typeof sequenceJson === 'string' ? sequenceJson : JSON.stringify(sequenceJson)
                })
            });
            if (!response.ok) throw new Error('Failed to create project');
            const project = await response.json();
            return project.id;
        } catch (error) {
            console.error('Error creating project:', error);
            throw error;
        }
    }

    async renameProject(id, newName, currentVersion) {
        try {
            const response = await fetch(`/api/projects/${id}`, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newName,
                    version: currentVersion
                })
            });
            if (!response.ok) throw new Error('Failed to rename project');
            return await response.json();
        } catch (error) {
            console.error('Error renaming project:', error);
            throw error;
        }
    }

    async shareProject(id, usernameOrEmail, role) {
        try {
            const response = await fetch(`/api/projects/${id}/collaborators`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ usernameOrEmail, role })
            });
            if (!response.ok) throw new Error('Failed to share project');
            return await response.json();
        } catch (error) {
            console.error('Error sharing project:', error);
            throw error;
        }
    }

    async deleteProject(id) {
        try {
            const response = await fetch(`/api/projects/${id}`, {
                method: 'DELETE',
                credentials: 'same-origin'
            });
            if (!response.ok) throw new Error('Failed to delete project');
            return true;
        } catch (error) {
            console.error('Error deleting project:', error);
            return false;
        }
    }
}