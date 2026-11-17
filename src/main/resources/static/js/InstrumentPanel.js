// Shared presentation only: both instruments still use the existing engine and APIs.
class InstrumentPanel {
    static active = null;

    static closeActive() {
        if (!this.active) {
            return false;
        }
        this.active.close(true);
        return true;
    }

    static attach(rootId, toggleId, panel, title, onOpen, onClose) {
        const root = document.getElementById(rootId);
        const toggle = document.getElementById(toggleId);
        const heading = document.createElement('div');
        heading.className = 'instrument-heading';
        const label = document.createElement('strong');
        label.textContent = title;
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Close';
        close.setAttribute('aria-label', `Close ${title}`);
        heading.append(label, close);
        panel.prepend(heading);
        panel.classList.add('instrument-panel');
        panel.id = toggle.getAttribute('aria-controls');
        root.appendChild(panel);
        function positionPanel() {
            const toolbar = root.closest('.primary-toolbar');
            const viewportHeight = window.innerHeight ?? 800;
            const top = Math.max(8, Math.min((toolbar?.getBoundingClientRect().bottom ?? 68) + 8, viewportHeight - 120));
            panel.style.top = `${top}px`;
            panel.style.maxHeight = `calc(100dvh - ${top + 12}px)`;
        }
        window.addEventListener('resize', () => {
            if (!panel.hidden) positionPanel();
        });
        const menu = {
            close(restoreFocus = false) {
                panel.hidden = true;
                toggle.setAttribute('aria-expanded', 'false');
                onClose();
                if (InstrumentPanel.active === menu) {
                    InstrumentPanel.active = null;
                }
                if (restoreFocus) {
                    toggle.focus({ preventScroll: true });
                }
            },
            open() {
                InstrumentPanel.active?.close();
                panel.hidden = false;
                toggle.setAttribute('aria-expanded', 'true');
                InstrumentPanel.active = menu;
                positionPanel();
                onOpen();
            }
        };
        toggle.addEventListener('click', () => panel.hidden ? menu.open() : menu.close());
        close.addEventListener('click', (event) => menu.close(event.detail === 0));
        window.addEventListener('pagehide', () => menu.close());
        return menu;
    }
}
window.jukeboxInstrumentPanels = InstrumentPanel;
