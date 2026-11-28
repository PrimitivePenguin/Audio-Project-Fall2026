// Keyboard shortcuts, shortcut help and focus policy.
function createKeyboard(editorState, actions) {
    const { getElement, undoStack, redoStack, pianoViewport, selectedIds } = editorState;

    const shortcutsDialog = getElement('shortcutsDialog');

    let helpReturnFocus = null;

    function clearSelectionOrCancel() {
        if (editorState.resizeGesture || editorState.editGesture || editorState.cursorGesture || editorState.trackGesture) {
            actions.cancelEditorGesture();
        } else if (editorState.workspaceMode === 'tracks') {
            editorState.arrangement.select(editorState.arrangement.trackId);
        } else {
            actions.selectNote(null);
        }
    }

    const editorShortcuts = [
        {
            key: 'a',
            modifier: true,
            label: 'Cmd/Ctrl+A',
            description: 'Select all musical notes',
            action: actions.selectAllNotes
        },
        {
            key: 'c',
            modifier: true,
            label: 'Cmd/Ctrl+C',
            description: 'Copy selected notes or audio clips',
            button: 'copyNotes',
            action: () => actions.clipboardEdit('copy')
        },
        {
            key: 'x',
            modifier: true,
            label: 'Cmd/Ctrl+X',
            description: 'Cut selected notes or audio clips',
            button: 'cutNotes',
            action: () => actions.clipboardEdit('cut')
        },
        {
            key: 'v',
            modifier: true,
            label: 'Cmd/Ctrl+V',
            description: 'Paste at editing cursor',
            button: 'pasteNotes',
            action: () => actions.clipboardEdit('paste')
        },
        {
            key: 'd',
            modifier: true,
            label: 'Cmd/Ctrl+D',
            description: 'Duplicate after the selected passage',
            button: 'duplicateNotes',
            action: () => actions.clipboardEdit('duplicate')
        },
        {
            key: 'z',
            modifier: true,
            label: 'Cmd/Ctrl+Z',
            description: 'Undo an editor action',
            button: 'undoNotes',
            action: () => actions.restoreHistory(undoStack, redoStack, 'before')
        },
        {
            key: 'z',
            modifier: true,
            shift: true,
            label: 'Cmd/Ctrl+Shift+Z',
            description: 'Redo an editor action',
            button: 'redoNotes',
            action: () => actions.restoreHistory(redoStack, undoStack, 'after')
        },
        {
            key: 'delete',
            aliases: ['backspace'],
            label: 'Delete / Backspace',
            description: 'Delete selected notes',
            button: 'deleteNote',
            action: actions.deleteSelectedNote
        },
        {
            key: 'escape',
            label: 'Escape',
            description: 'Cancel active gesture / clear selection',
            action: clearSelectionOrCancel
        },
        {
            key: 'arrowright',
            navigation: 'right',
            label: 'Arrow Right',
            description: 'Select the nearest musical note center right (one note selected)',
            action: () => actions.navigateSelection('right')
        },
        {
            key: 'arrowleft',
            navigation: 'left',
            label: 'Arrow Left',
            description: 'Select the nearest musical note center left (one note selected)',
            action: () => actions.navigateSelection('left')
        },
        {
            key: 'arrowup',
            navigation: 'up',
            label: 'Arrow Up',
            description: 'Select the nearest musical note center up (one note selected)',
            action: () => actions.navigateSelection('up')
        },
        {
            key: 'arrowdown',
            navigation: 'down',
            label: 'Arrow Down',
            description: 'Select the nearest musical note center down (one note selected)',
            action: () => actions.navigateSelection('down')
        },
        {
            key: 'arrowup',
            local: true,
            label: 'Arrow Up in Length',
            description: 'Lengthen each selected note by one step',
            action: () => actions.adjustLength(1)
        },
        {
            key: 'arrowdown',
            local: true,
            label: 'Arrow Down in Length',
            description: 'Shorten each selected note by one step',
            action: () => actions.adjustLength(-1)
        }
    ];

    const mouseControls = [
        ['Track order / deletion', 'Drag the left grip in Tracks to an insertion line; release to reorder. Escape or pointer cancellation cancels. Delete names the active track, confirms nonempty tracks, requires Stop and protects the last track. Track order and deletion support Undo/Redo.'],
        ['Tracks / Piano Roll', 'Switch perspectives without resetting playback or the cursor. Click a lane to select it; double-click a lane or choose Piano Roll / Edit Track to edit. The Active track selector also supports keyboard selection and All Notes.'],
        ['Ghost Notes', 'In a focused piano roll, show other tracks as faded, non-interactive references. New notes and Paste target the active track. All Notes paste preserves source track identities.'],
        ['Click empty grid space', 'Clear the selection without creating a note. With nothing selected, create a note on the active track (All Notes uses Piano, or the first surviving track) with the current length and velocity.'],
        ['Click a note', 'Select it. Repeated clicks cycle independent overlapping notes.'],
        ['Shift-click a note', 'Add or remove that note from selection.'],
        ['Cut Mode in Tracks', 'Drag down across an audio clip to split it at the snapped position. Escape cancels.'],
        ['Shift-click an audio clip', 'Add or remove the clip from the arrangement selection.'],
        ['Drag empty grid space', 'Marquee-select intersecting notes; Shift adds to the selection.'],
        ['Drag note body', 'Move in time and pitch. Dragging a selected note moves the selected group.'],
        ['Drag note edge', 'Resize the note. A selected group shares a duration change and keeps every start fixed.'],
        ['Cross the opposite edge', 'Single-note resizing previews deletion; release deletes. Group resizing never deletes.'],
        ['Playback follow', 'The orange playhead locks to the musical-grid midpoint only after crossing from the left. Horizontal navigation releases it; scrolling ahead rearms a later crossing. Pause, wraps and resizing reassess readiness without recentering.'],
        ['Synth / Drums', 'Open instrument menus from the top toolbar; Close or Escape dismisses them. Pointer-operated sliders release focus on completion and native selects after an option change, so Space controls transport. Enter activates focused controls.'],
        ['Toolbar focus', 'Mouse-activated DAW buttons and Workspace Options return focus to the visible workspace so Space controls transport. Enter activates focused controls. Space controls playback. Inputs and dialogs keep their focus.'],
        ['Play button / Space', 'Before or inside the loop, audition from the cursor to loop end; at or beyond loop end, audition to composition end. Then repeat the configured full loop. A cursor at composition end starts at loop start.'],
        ['Click or drag timeline ruler', 'Position the edit/paste cursor to the nearest MIDI tick without grid snapping. Escape or pointer cancellation restores its original position. While paused, moving it also seeks Resume; during playback it does not seek.'],
        ['Scroll / horizontal scroll', 'Explore pitches vertically and measures horizontally using scrollbars or your trackpad.'],
        ['Next overlapping note', 'Use Workspace options to cycle overlapping stable note IDs.'],
        ['Length / ±1 step', 'Enter an absolute length for all selected notes, or change each duration relatively.']
    ];

    function appendGuideEntry(container, label, description) {
        const term = document.createElement('dt');
        const definition = document.createElement('dd');
        term.textContent = label;
        definition.textContent = description;
        container.append(term, definition);
    }

    function closeShortcuts() {
        shortcutsDialog.close();
    }

    let focusPolicyRevision = 0;

    editorState.pointerInput = null;

    function deferWorkspaceFocus(control, previousFocus) {
        const revision = focusPolicyRevision;
        // Use a task so all native click/change handlers finish before the handoff.
        setTimeout(() => {
            if (revision !== focusPolicyRevision || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) {
                return;
            }
            const focused = document.activeElement;
            if (focused !== control && focused !== document.body && focused !== previousFocus) {
                return;
            }
            pianoViewport.focus({ preventScroll: true });
        }, 0);
    }

    function matchesShortcut(shortcut, event) {
        const key = event.key.toLowerCase();
        return (shortcut.key === key || shortcut.aliases?.includes(key)) &&
            Boolean(shortcut.modifier) === Boolean(event.metaKey || event.ctrlKey) &&
            Boolean(shortcut.shift) === Boolean(event.shiftKey) && !event.altKey;
    }

    let transportSpaceDown = false;

    const isSpace = (event) => event.key === ' ' || event.code === 'Space';

    function handleTransportSpace(event) {
        if (!isSpace(event)) return false;
        const target = event.target;
        const typing = target?.isContentEditable || target?.closest?.('textarea, [role="textbox"], [contenteditable="true"]') ||
            target?.tagName === 'TEXTAREA' ||
            (target?.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(target.type));
        if (!transportSpaceDown && (event.type === 'keyup' || event.altKey || event.ctrlKey || event.metaKey ||
            typing || editorState.deleteTrackDialog.open || shortcutsDialog.open ||
            document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]'))) return false;
        event.preventDefault();
        event.stopImmediatePropagation?.();
        if (event.type === 'keyup') transportSpaceDown = false;
        else if (!event.repeat && !transportSpaceDown) {
            transportSpaceDown = true;
            actions.togglePlayback();
        }
        return true;
    }

    function bind() {
        appendGuideEntry(getElement('keyboardGuide'), 'Space', 'Play, pause, or resume the transport.');
        for (const shortcut of editorShortcuts) {
            appendGuideEntry(getElement('keyboardGuide'), shortcut.label, shortcut.description);
            if (shortcut.button) {
                const button = getElement(shortcut.button);
                button.title = `${shortcut.description} (${shortcut.label})`;
                button.onclick = () => actions.runEditorAction(shortcut.action);
            }
        }
        for (const [label, description] of mouseControls) {
            appendGuideEntry(getElement('mouseGuide'), label, description);
        }
        getElement('shortcutsButton').onclick = (event) => {
            actions.cancelEditorGesture();
            helpReturnFocus = event?.detail > 0 ? pianoViewport : getElement('shortcutsButton');
            shortcutsDialog.showModal();
            getElement('closeShortcuts').focus();
        };
        getElement('closeShortcuts').onclick = closeShortcuts;
        shortcutsDialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            closeShortcuts();
        });
        shortcutsDialog.addEventListener('close', () => helpReturnFocus?.focus());
        document.addEventListener('pointerdown', (event) => {
            focusPolicyRevision++;
            editorState.pointerInput = null;
            const control = event.target?.closest?.('input[type="range"], select');
            if (event.button !== 0 || !control?.closest?.('[data-daw-pointer-inputs]') ||
                control.closest('dialog, [role="dialog"]')) return;
            editorState.pointerInput = { control, pointerId: event.pointerId, previousFocus: document.activeElement };
        }, true);
        document.addEventListener('pointerup', (event) => {
            if (!editorState.pointerInput || editorState.pointerInput.pointerId !== event.pointerId || editorState.pointerInput.control.tagName === 'SELECT') return;
            const interaction = editorState.pointerInput;
            editorState.pointerInput = null;
            deferWorkspaceFocus(interaction.control, interaction.previousFocus);
        }, true);
        document.addEventListener('pointercancel', () => { editorState.pointerInput = null; }, true);
        document.addEventListener('change', (event) => {
            if (!editorState.pointerInput || editorState.pointerInput.control !== event.target || event.target.tagName !== 'SELECT') return;
            const interaction = editorState.pointerInput;
            editorState.pointerInput = null;
            deferWorkspaceFocus(interaction.control, interaction.previousFocus);
        }, true);
        document.addEventListener('click', (event) => {
            // Range/select clicks are part of the ongoing pointer interaction, not buttons.
            const control = event.target?.closest?.('button, summary');
            if (!control) return;
            focusPolicyRevision++;
            if (!(event.detail > 0) || !control.closest?.('[data-daw-controls]') ||
                control.closest('dialog, [role="dialog"], a, .account-menu') ||
                (control.tagName === 'BUTTON' && control.type !== 'button')) return;
            deferWorkspaceFocus(control, document.activeElement);
        }, true);
        document.addEventListener('keyup', (event) => handleTransportSpace(event), true);
        window.addEventListener('blur', () => { transportSpaceDown = false; });
        document.addEventListener('keydown', (event) => {
            if (handleTransportSpace(event)) return;
            if (event.target?.closest?.('.dock-resize')) return;
            focusPolicyRevision++;
            editorState.pointerInput = null;
            if (editorState.deleteTrackDialog.open) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    actions.closeTrackDeletion();
                }
                return;
            }
            if (shortcutsDialog.open) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    closeShortcuts();
                }
                return;
            }
            if (document.querySelector?.('dialog[open], [role="dialog"][aria-modal="true"]')) {
                return;
            }
            if (event.key === 'Escape' && editorState.autoGesture) {
                event.preventDefault();
                actions.cancelAutomationGesture();
                return;
            }
            if (event.key === 'Escape' && (editorState.resizeGesture || editorState.editGesture || editorState.cursorGesture || editorState.trackGesture || editorState.arrangement.gesture)) {
                event.preventDefault();
                actions.cancelEditorGesture();
                return;
            }
            const target = event.target;
            const nativeSelect = target?.tagName === 'SELECT' || target?.closest?.('select, [role="combobox"], [role="listbox"]');
            if (event.key === 'Escape' && !nativeSelect && window.jukeboxInstrumentPanels?.closeActive()) {
                event.preventDefault();
                return;
            }
            if (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]') ||
                ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) {
                return;
            }
            if (editorState.workspaceMode === 'tracks' && editorState.arrangement.rackAssetId &&
                (event.key === 'Delete' || event.key === 'Backspace') &&
                !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                event.preventDefault();
                if (!event.repeat) return editorState.arrangement.deleteRackAsset();
                return;
            }
            if (editorState.workspaceMode === 'tracks' && !editorState.arrangement.gesture && !editorState.trackGesture && !editorState.cursorGesture &&
                !['BUTTON', 'A', 'SUMMARY'].includes(target?.tagName) &&
                !target?.closest?.('button, a, summary') && !event.altKey && !event.shiftKey) {
                const key = event.key.toLowerCase();
                const command = event.metaKey || event.ctrlKey;
                actions.checkHistory();
                const editable = editorState.arrangement.hooks.canEdit();
                let action;
                if (command && key === 'c' && editorState.arrangement.clipId) action = () => editorState.arrangement.copySelected();
                if (editable) {
                    if (command && key === 'v' && editorState.arrangement.clipboard.length) {
                        action = () => editorState.arrangement.pasteClips(editorState.arrangement.clipboard, editorState.editingCursorTick);
                    } else if (editorState.arrangement.clipId) {
                        if (command && key === 'd') action = () => editorState.arrangement.duplicateSelected();
                        if (command && key === 'x') action = () => editorState.arrangement.copySelected(true);
                        if (!command && (key === 'delete' || key === 'backspace')) action = () => editorState.arrangement.deleteSelected();
                    }
                }
                if (action) {
                    event.preventDefault();
                    actions.runEditorAction(action);
                    return;
                }
            }
            const shortcut = editorShortcuts.find((entry) => !entry.local && matchesShortcut(entry, event));
            if (!shortcut || editorState.resizeGesture || editorState.editGesture || editorState.cursorGesture || editorState.trackGesture) {
                return;
            }
            if (shortcut.navigation &&
                (target?.closest?.('button, a, summary, [role="button"], [role="menuitem"], [role="menu"], [role="tab"], [role="slider"], [role="separator"], [role="radio"], [role="listbox"], [role="tree"], [role="checkbox"], [role="switch"], [role="combobox"], [role="spinbutton"], [role="textbox"]') ||
                ['BUTTON', 'A', 'SUMMARY'].includes(target?.tagName))) {
                return;
            }
            if (editorState.databaseProject?.role === 'VIEWER' && !shortcut.navigation &&
                !['escape', 'a', 'c'].includes(shortcut.key)) return;
            if (editorState.workspaceMode === 'tracks' && !['z', 'escape'].includes(shortcut.key)) {
                return;
            }
            if (shortcut.navigation && !actions.directionalTarget(shortcut.navigation)) {
                return;
            }
            if (shortcut.key === 'delete' && !selectedIds.size) {
                return;
            }
            event.preventDefault();
            actions.runEditorAction(shortcut.action);
        }, true);
        getElement('noteLength').onkeydown = (event) => {
            const shortcut = editorShortcuts.find((entry) => entry.local && matchesShortcut(entry, event));
            if (shortcut) {
                event.preventDefault();
                actions.runEditorAction(shortcut.action);
            }
        };
    }

    return { bind };
}
