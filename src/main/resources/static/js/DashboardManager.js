class DashboardManager {
    constructor() {
        this.STORAGE_KEY = 'jukebox_dashboard_projects_v1';
    }

    getProjects() {
        const data = localStorage.getItem(this.STORAGE_KEY);
        return data ? JSON.parse(data) : {};
    }

    saveProject(name, sequenceJson) {
        const projects = this.getProjects();
        const id = `proj_${Date.now()}`;
        projects[id] = {
            id,
            name: name || 'Untitled Project',
            updatedAt: new Date().toISOString(),
            data: sequenceJson
        };
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(projects));
        return id;
    }


    updateProject(id, sequenceJson) {
        const projects = this.getProjects();
        if (projects[id]) {
            projects[id].data = sequenceJson;
            projects[id].updatedAt = new Date().toISOString();
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(projects));
            return true;
        }
        return false;
    }

    renameProject(id, newName) {
        const projects = this.getProjects();
        if (projects[id]) {
            projects[id].name = newName;
            projects[id].updatedAt = new Date().toISOString();
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(projects));
        }
    }

    deleteProject(id) {
        const projects = this.getProjects();
        delete projects[id];
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(projects));
    }
}