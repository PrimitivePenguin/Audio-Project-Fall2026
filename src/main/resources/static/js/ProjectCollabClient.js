class ProjectCollabClient {
    constructor({ getProject, getSnapshot, onRemoteEvent, onConflict, onStatus }) {
        this.getProject = getProject;
        this.getSnapshot = getSnapshot;
        this.onRemoteEvent = onRemoteEvent;
        this.onConflict = onConflict;
        this.onStatus = onStatus ?? (() => {});
        this.clientId = crypto.randomUUID();
        this.client = null;
        this.connected = false;
        this.activeProjectId = null;
        this.outbox = [];
        this.inFlight = null;
    }

    connect(projectId) {
        this.disconnect();
        if (!projectId || !window.StompJs?.Client) return;

        this.activeProjectId = projectId;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const brokerURL = `${protocol}//${window.location.host}/ws`;

        this.client = new window.StompJs.Client({
            brokerURL,
            reconnectDelay: 2000,
            heartbeatIncoming: 10000,
            heartbeatOutgoing: 10000,
            onConnect: () => {
                this.connected = true;
                this.client.subscribe('/user/queue/sync', (frame) => this.#handleFrame(frame));
                this.client.subscribe(`/topic/projects/${projectId}`, (frame) => this.#handleFrame(frame));
                this.requestState();
                this.onStatus('Live collaboration connected.');
            },
            onWebSocketClose: () => {
                this.connected = false;
                this.inFlight = null;
                if (this.activeProjectId) {
                    this.onStatus('Collaboration disconnected — reconnecting…');
                }
            },
            onStompError: (frame) => {
                this.onStatus(`Collaboration error: ${frame.headers?.message || 'Connection rejected'}`);
            }
        });

        this.client.activate();
    }

    disconnect() {
        this.activeProjectId = null;
        this.connected = false;
        this.inFlight = null;
        this.outbox = [];
        if (this.client) {
            const existing = this.client;
            this.client = null;
            existing.deactivate();
        }
    }

    requestState() {
        const project = this.getProject();
        if (!this.connected || !project) return;
        this.client.publish({
            destination: `/app/projects/${project.id}/sync`,
            body: JSON.stringify({
                clientId: this.clientId,
                type: 'REQUEST_STATE',
                targetId: project.id
            })
        });
    }

    publish(type, targetId = null, payload = null) {
        const project = this.getProject();
        if (!project || project.role === 'VIEWER') return;
        if (!window.StompJs?.Client) return;

        if (type === 'SETTINGS_SYNC' && this.outbox.at(-1)?.type === 'SETTINGS_SYNC') {
            this.outbox.at(-1).payload = payload;
        } else {
            this.outbox.push({ type, targetId, payload });
        }
        this.#flushOutbox();
    }

    #flushOutbox() {
        const project = this.getProject();
        if (!this.connected || !project || this.inFlight || !this.outbox.length) return;

        const next = this.outbox.shift();
        this.inFlight = next;
        const snapshotObj = this.getSnapshot();

        this.client.publish({
            destination: `/app/projects/${project.id}/sync`,
            body: JSON.stringify({
                clientId: this.clientId,
                type: next.type,
                targetId: next.targetId,
                baseRevision: project.version,
                name: snapshotObj.name,
                payload: next.payload,
                snapshot: JSON.stringify(snapshotObj)
            })
        });
    }

    #handleFrame(frame) {
        let event;
        try {
            event = JSON.parse(frame.body);
        } catch {
            return;
        }
        const project = this.getProject();
        if (!project || (event.projectId && event.projectId !== project.id)) return;

        if (event.type === 'ERROR') {
            this.inFlight = null;
            this.outbox = [];
            this.onStatus(`Sync rejected: ${event.error}`);
            return;
        }

        if (event.type === 'CONFLICT') {
            this.inFlight = null;
            this.outbox = [];
            if (typeof event.revision === 'number') {
                project.version = event.revision;
            }
            this.onConflict(event);
            return;
        }

        if (event.type === 'STATE_SNAPSHOT') {
            if (this.inFlight || this.outbox.length > 0) {
                if (!this.inFlight) {
                    this.#flushOutbox();
                }
                return;
            }
            if (
                typeof event.revision === 'number' &&
                typeof project.version === 'number' &&
                event.revision < project.version
            ) {
                return;
            }
            if (this.onRemoteEvent(event, true) && typeof event.revision === 'number') {
                project.version = event.revision;
            }
            return;
        }
        
        if (event.clientId === this.clientId) {
            if (typeof event.revision === 'number') {
                project.version = event.revision;
            }
            this.inFlight = null;
            this.#flushOutbox();
            return;
        }

        const applied = this.onRemoteEvent(event, false);
        if (applied !== false && typeof event.revision === 'number') {
            project.version = event.revision;
        }
    }
}