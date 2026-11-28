// Local workspace geometry. Dock preferences are independent of project data.
function createDockLayout(editorState, actions) {
    const { getElement, pianoViewport } = editorState;
    const workspace = getElement('dawWorkspace');
    const chrome = ['meshContainer1', 'editingToolbar', 'workspaceStatus'].map(getElement);
    const storageKey = 'jukebox.workspace.docks.v1';
    const minPiano = 112;
    const maxDock = 720;
    let preferences;
    try { preferences = JSON.parse(localStorage.getItem(storageKey)); } catch {}
    const docks = [
        { key: 'automation', details: 'automationPanel', summary: 'automationSummary', body: 'automationBody',
            handle: 'automationResize', minimum: 110, initial: 180 },
        { key: 'samples', details: 'sampleRack', summary: 'sampleRackSummary', body: 'sampleRackBody',
            handle: 'sampleRackResize', minimum: 72, initial: 172 }
    ].map(({ key, details, summary, body, handle, minimum, initial }) => {
        const saved = preferences?.[key];
        const height = Number.isFinite(saved?.height)
            ? Math.max(minimum, Math.min(maxDock, saved.height)) : initial;
        return {
            key, minimum, height, actual: 0,
            details: getElement(details), summary: getElement(summary),
            body: getElement(body), handle: getElement(handle),
            open: typeof saved?.open === 'boolean' ? saved.open : true
        };
    });
    let measurementKey = '';
    let gesture = null;
    const visible = (dock) => !dock.details.hidden;
    const expanded = (dock) => visible(dock) && dock.details.open;

    function persist() {
        try {
            localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(docks.map((dock) => [
                dock.key, { open: dock.details.open, height: dock.height }
            ]))));
        } catch { /* The layout still works if local storage is unavailable. */ }
    }

    function availableHeight() {
        const fixed = chrome.reduce((total, element) => total + (element.offsetHeight || 0), 0);
        const headers = docks.filter(visible).reduce((total, dock) => total + (dock.summary.offsetHeight || 0) + 1, 0);
        const height = workspace.clientHeight - fixed - headers;
        workspace.style.setProperty('--piano-min-height', `${Math.min(minPiano, Math.max(48, height))}px`);
        return Math.max(0, height - minPiano);
    }

    function layoutDocks(preferred = null, restoreActual = false) {
        const available = availableHeight();
        const open = docks.filter(expanded);
        const key = `${available}:${open.map((dock) => dock.key).join(',')}`;
        if (!preferred && key === measurementKey) return;
        measurementKey = key;
        const minimumTotal = open.reduce((sum, dock) => sum + dock.minimum, 0);
        const room = Math.max(available, minimumTotal);
        if (preferred) {
            if (open.includes(preferred)) {
                const other = open.find((dock) => dock !== preferred);
                if (other) other.actual = Math.min(other.actual, room - preferred.minimum);
                const remaining = room - (other?.actual ?? 0);
                const requested = restoreActual && preferred.actual ? preferred.actual : preferred.height;
                preferred.actual = Math.floor(Math.min(requested, remaining));
            }
        } else {
            const desired = open.reduce((sum, dock) => sum + dock.height - dock.minimum, 0);
            const scale = desired ? Math.min(1, (room - minimumTotal) / desired) : 1;
            for (const dock of open) dock.actual = Math.floor(dock.minimum + (dock.height - dock.minimum) * scale);
        }
        for (const dock of open) {
            const otherHeight = open.filter((item) => item !== dock).reduce((sum, item) => sum + item.actual, 0);
            dock.maximum = Math.max(dock.minimum, Math.min(maxDock, room - otherHeight));
            const height = `${dock.actual}px`;
            if (dock.body.style.height !== height) dock.body.style.height = height;
            for (const [name, value] of Object.entries({
                'aria-valuemin': dock.minimum, 'aria-valuemax': dock.maximum, 'aria-valuenow': dock.actual
            })) {
                if (dock.handle.getAttribute(name) !== String(value)) dock.handle.setAttribute(name, String(value));
            }
        }
        editorState.pendingViewportRender = true;
    }

    function setHeight(dock, height) {
        dock.height = Math.max(dock.minimum, Math.min(dock.maximum, height));
        layoutDocks(dock);
    }

    function finish(event, cancelled = false) {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        const { dock, pointerId, originalHeight } = gesture;
        gesture = null;
        if (cancelled) {
            dock.height = originalHeight;
            measurementKey = '';
            layoutDocks();
        } else {
            persist();
        }
        if (dock.handle.hasPointerCapture(pointerId)) dock.handle.releasePointerCapture(pointerId);
    }

    function bind() {
        for (const dock of docks) {
            dock.details.open = dock.open;
            dock.details.addEventListener('toggle', () => {
                if (!dock.details.open) {
                    if (dock.key === 'automation') actions.cancelAutomationGesture();
                    if (gesture?.dock === dock) finish({ pointerId: gesture.pointerId }, true);
                }
                persist();
                layoutDocks(dock, true);
            });
            dock.handle.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || gesture || !expanded(dock)) return;
                actions.cancelAutomationGesture();
                gesture = { dock, pointerId: event.pointerId, y: event.clientY,
                    height: dock.actual, originalHeight: dock.height };
                dock.handle.setPointerCapture(event.pointerId);
                dock.handle.focus({ preventScroll: true });
                event.preventDefault();
                event.stopPropagation();
            });
            dock.handle.addEventListener('pointermove', (event) => {
                if (gesture?.dock !== dock || gesture.pointerId !== event.pointerId) return;
                setHeight(dock, gesture.height + gesture.y - event.clientY);
            });
            dock.handle.addEventListener('pointerup', (event) => finish(event));
            dock.handle.addEventListener('pointercancel', (event) => finish(event, true));
            dock.handle.addEventListener('lostpointercapture', (event) => finish(event, true));
            dock.handle.addEventListener('keydown', (event) => {
                const heights = { ArrowUp: dock.actual + 12, ArrowDown: dock.actual - 12,
                    Home: dock.minimum, End: dock.maximum };
                if (!Object.hasOwn(heights, event.key) || !expanded(dock)) return;
                event.preventDefault();
                setHeight(dock, heights[event.key]);
                persist();
            });
        }
        layoutDocks();
        const onResize = () => {
            layoutDocks();
            editorState.pendingViewportRender = true;
        };
        window.addEventListener('resize', onResize);
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(onResize);
            for (const element of [workspace, pianoViewport, ...chrome, ...docks.map((dock) => dock.summary), getElement('automationPlot')]) {
                observer.observe(element);
            }
        }
    }

    return { bind, layoutDocks };
}
