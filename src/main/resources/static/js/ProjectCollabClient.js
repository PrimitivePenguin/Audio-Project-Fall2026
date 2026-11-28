class ProjectCollabClient {
    constructor({ getProject, getSnapshot, onRemoteEvent, onConflict, onStatus, canPublish = () => true }) {
        Object.assign(this, { getProject, getSnapshot, onRemoteEvent, onConflict, canPublish, onStatus: onStatus ?? (() => {}) });
        this.clientId = crypto.randomUUID();
        this.draftId = this.clientId;
        try {
            this.draftId = sessionStorage.getItem('jukebox:draft-tab') ?? this.clientId;
            sessionStorage.setItem('jukebox:draft-tab', this.draftId);
        } catch {}
        this.client = null;
        this.connected = false;
        this.activeProjectId = null;
        this.pending = null;
        this.inFlight = null;
        this.blocked = false;
        this.awaitingState = false;
    }

    get draftKey() { return `jukebox:collaboration-draft:${this.getProject()?.id}:${this.draftId}`; }

    readDraft() {
        try { return JSON.parse(localStorage.getItem(this.draftKey)); } catch { return null; }
    }

    keepDraft() {
        const project = this.getProject();
        const draft = this.pending ?? this.inFlight;
        if (!project || !draft) return;
        this.draft = { ...draft, baseRevision: project.version };
        try { localStorage.setItem(this.draftKey, JSON.stringify(this.draft)); }
        catch { this.onStatus('The local draft is in memory only. Download it before leaving this page.'); }
    }

    clearDraft() {
        try { localStorage.removeItem(this.draftKey); } catch {}
        this.draft = null;
    }

    connect(projectId) {
        this.disconnect();
        this.activeProjectId = projectId;
        this.draft = this.readDraft();
        if (this.draft) this.conflict('A local draft is available. Download it to recover your previous edits.');
        if (!projectId || !window.StompJs?.Client) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const client = new window.StompJs.Client({
            brokerURL: `${protocol}//${window.location.host}/ws`,
            reconnectDelay: 2000,
            heartbeatIncoming: 10000,
            heartbeatOutgoing: 10000,
            onConnect: () => {
                if (this.client !== client) return;
                this.connected = true;
                client.subscribe('/user/queue/sync', (frame) => this.handleFrame(client, frame));
                client.subscribe(`/topic/projects/${projectId}`, (frame) => this.handleFrame(client, frame));
                this.requestState();
                if (!this.blocked) this.onStatus('Live collaboration connected.');
            },
            onWebSocketClose: () => {
                if (this.client !== client) return;
                this.connected = this.awaitingState = false;
                this.keepDraft();
                if (!this.blocked) this.onStatus('Collaboration disconnected. Pending edits are retained.');
            },
            onStompError: () => {
                if (this.client === client) this.conflict('Collaboration rejected the connection. Check access before retrying.');
            }
        });
        this.client = client;
        client.activate();
    }

    disconnect() {
        this.keepDraft();
        const client = this.client;
        this.client = null;
        this.activeProjectId = null;
        this.connected = this.awaitingState = this.blocked = false;
        this.pending = this.inFlight = null;
        this.draft = null;
        client?.deactivate();
    }

    requestState() {
        if (!this.connected || this.blocked || this.awaitingState) return;
        this.awaitingState = true;
        this.send({ clientId: this.clientId, type: 'REQUEST_STATE' });
    }

    send(message) {
        try {
            this.client.publish({
                destination: `/app/projects/${this.activeProjectId}/sync`,
                body: JSON.stringify(message)
            });
        } catch {
            this.conflict('Collaboration could not send the update.');
        }
    }

    publish(type, targetId, payload) {
        const project = this.getProject();
        if (!project || project.role === 'VIEWER') return;
        const data = this.getSnapshot();
        this.pending = { type, targetId, payload, name: data.name, snapshot: JSON.stringify(data) };
        this.keepDraft();
        if (this.blocked) this.onConflict(this.conflictMessage, this.draft);
        this.flush();
    }

    flush() {
        if (!this.connected || this.awaitingState || this.blocked || this.inFlight || !this.pending || !this.canPublish()) return;
        this.inFlight = { ...this.pending, baseRevision: this.getProject().version };
        this.pending = null;
        this.send({ ...this.inFlight, clientId: this.clientId });
    }

    conflict(message) {
        this.blocked = true;
        this.conflictMessage = message;
        this.awaitingState = false;
        this.pending ??= this.inFlight;
        this.inFlight = null;
        this.keepDraft();
        this.onConflict(message, this.draft);
    }

    handleFrame(client, frame) {
        if (client !== this.client || this.blocked) return;
        let event;
        try { event = JSON.parse(frame.body); } catch { return; }
        const project = this.getProject();
        if (!event || !project || event.projectId !== project.id) return;
        const privateReply = ['STATE_SNAPSHOT', 'CONFLICT', 'ERROR'].includes(event.type);
        if (!privateReply && !['NOTES_SYNC', 'TRACKS_SYNC', 'AUDIO_SYNC', 'SETTINGS_SYNC',
            'INSTRUMENTS_SYNC', 'FULL_SYNC', 'REST_SYNC'].includes(event.type)) return;
        if (privateReply && event.clientId !== this.clientId) return;
        if (event.type === 'ERROR' || event.type === 'CONFLICT') {
            this.conflict(event.type === 'CONFLICT' ? 'The server has a newer project revision.' : 'The server rejected an edit.');
            return;
        }
        if (!Number.isSafeInteger(event.revision) || event.revision < project.version) return;
        if (event.type === 'REST_SYNC' && event.clientId === this.clientId) return;
        if (event.type === 'STATE_SNAPSHOT') {
            this.awaitingState = false;
            if (this.inFlight && event.snapshot === this.inFlight.snapshot && event.revision > project.version) {
                this.inFlight = null;
                project.version = event.revision;
                if (!this.pending) this.clearDraft();
            } else if ((this.inFlight || this.pending) && event.revision > project.version) {
                this.conflict('The project changed while local edits were pending.');
                return;
            } else if (this.inFlight) {
                this.pending ??= this.inFlight;
                this.inFlight = null;
            }
            if (!this.pending && event.revision > project.version && this.onRemoteEvent(event, true)) {
                project.version = event.revision;
            }
            this.flush();
            return;
        }
        if (event.clientId === this.clientId && this.inFlight && event.snapshot === this.inFlight.snapshot) {
            project.version = event.revision;
            this.inFlight = null;
            if (this.pending) this.keepDraft();
            else {
                this.clearDraft();
                this.onStatus(`Project saved at revision ${event.revision}.`);
            }
            this.flush();
        } else if (event.revision <= project.version) {
            return;
        } else if (this.pending || this.inFlight) {
            this.conflict('A collaborator saved while local edits were pending.');
        } else if (this.onRemoteEvent(event, false)) {
            project.version = event.revision;
        }
    }
}
