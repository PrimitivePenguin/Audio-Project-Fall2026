// ui_controller.js — CONTROLLER
// The user changes things in the View; this file listens to those events,
// turns DOM values into model values, and calls the Model.
// It never edits the DOM itself: Model emits -> View re-renders.

import { hexToRgb, saveSettings, REBUILD_KEYS } from "./ui_model.js";

// INPUT:  model: UiModel; view: from createUiView
// OUTPUT: detach function (removes every listener)
// ACTION: wires all inputs:
//   "input"  on sliders (#res, #numLevels, #noise, #tension, #lineWidth) -> handle(model.update({...}))
//   "change" on #curveType, radio[name=points], #offColorToggle          -> handle(model.update({...}))
//   stop lists: one delegated listener per list (rows are added/removed) -> onStopEvent
//   #addStop / #addOffStop click                                         -> model.addStop(list)
//   #saveUi click  -> onSave;  #resetUi click -> model.reset()
//   model.onChange(...)    -> view.render(settings)
export function attachUiController(model, view) {
    const { els } = view;
    const cleanups = [];
    const on = (el, type, fn) => {
        if (!el) return;
        el.addEventListener(type, fn);
        cleanups.push(() => el.removeEventListener(type, fn));
    };

    const apply = patch => handle(model.update(patch), view);
    const applyThrottled = throttle(apply, 100);   // res / noise rebuild the field: not on every pixel

    // sliders
    for (const key of ["res", "numLevels", "noise"]) {
        const fn = REBUILD_KEYS.has(key) ? applyThrottled : apply;
        on(els[key], "input", e => fn({ [key]: +e.target.value }));
    }
    for (const key of ["tension", "lineWidth"]) {
        on(els[key], "input", e => apply({ curve: { [key]: +e.target.value } }));
    }

    // selects / radios / checkbox
    on(els.curveType, "change", e => apply({ curve: { type: e.target.value } }));
    for (const r of els.points) {
        on(r, "change", e => { if (e.target.checked) apply({ curve: { points: e.target.value } }); });
    }
    for (const r of els.renderer) {
        on(r, "change", e => { if (e.target.checked) apply({ renderer: e.target.value }); });
    }
    on(els.offColorToggle, "change", e => apply({ offColor: { enabled: e.target.checked } }));

    // stop lists: delegated, so rows can come and go
    for (const listEl of [els.colorStops, els.offColorStops]) {
        on(listEl, "input", e => onStopEvent(e, model, view));
        on(listEl, "click", e => onStopEvent(e, model, view));
    }
    on(els.addStop, "click", () => handle(model.addStop("colorStops"), view));
    on(els.addOffStop, "click", () => handle(model.addStop("offColor"), view));

    // save / reset
    on(els.save, "click", () => onSave(model, view));
    on(els.reset, "click", () => { model.reset(); view.showStatus("Reset to defaults", "info"); });

    // model -> view
    cleanups.push(model.onChange(settings => view.render(settings)));
    view.render(model.settings);

    return () => {
        cleanups.forEach(f => f());
        cleanups.length = 0;
    };
}

// INPUT:  e: input/click event inside a [data-list] container; model
// OUTPUT: none
// ACTION: row = e.target.closest("[data-index]"), list = row.closest("[data-list]").dataset.list
//         range  -> update that stop's pos (+e.target.value)
//         color  -> update that stop's rgb (hexToRgb(e.target.value))
//         delete -> model.removeStop(list, index)
export function onStopEvent(e, model, view) {
    const row = e.target.closest("[data-index]");
    const listEl = row && row.closest("[data-list]");
    if (!listEl) return;
    const list = listEl.dataset.list;
    const index = +row.dataset.index;

    if (e.type === "click") {
        if (!e.target.closest("[data-action=delete]")) return;
        handle(model.removeStop(list, index), view);
        return;
    }
    if (e.type !== "input") return;

    const stops = model.stopsOf(list);
    if (!stops || !stops[index]) return;
    const copy = stops.map(s => ({ pos: s.pos, rgb: [...s.rgb] }));

    if (e.target.type === "range") {
        // pos decides the order, so a stop can't be dragged past its neighbours
        const lo = index > 0 ? copy[index - 1].pos : 0;
        const hi = index < copy.length - 1 ? copy[index + 1].pos : 1;
        copy[index].pos = Math.min(hi, Math.max(lo, +e.target.value));
    } else if (e.target.type === "color") {
        const rgb = hexToRgb(e.target.value);
        if (!rgb) { view.showStatus("Not a valid colour", "error"); return; }
        copy[index].rgb = rgb;
    } else {
        return;
    }
    handle(model.update(model.stopsPatch(list, copy)), view);
}

// INPUT:  result: { ok, errors } from any model call; view
// OUTPUT: none
// ACTION: error checking + feedback: if !ok show the first error (kind "error"), else clear it
export function handle(result, view) {
    if (!result || result.ok) {
        view.showStatus("", "info");
    } else {
        view.showStatus((result.errors && result.errors[0]) || "Something went wrong", "error");
    }
}

// INPUT:  model; view
// OUTPUT: Promise<void>
// ACTION: disables the Save button, awaits saveSettings(model), shows "Saved" or the error, re-enables
export async function onSave(model, view) {
    const btn = view.els.save;
    if (btn) btn.disabled = true;
    view.showStatus("Saving…", "info");
    try {
        const r = await saveSettings(model);
        if (r.ok) {
            view.showStatus(r.source === "server" ? "Saved to your account" : "Saved on this device", "ok");
        } else {
            view.showStatus((r.errors && r.errors[0]) || "Could not save", "error");
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

// INPUT:  fn; ms
// OUTPUT: throttled fn
// ACTION: for sliders that rebuild the field (res, noise) so dragging doesn't rebuild every pixel.
//         Runs at most once per ms; the last call during a wait always runs (trailing), so the
//         final slider position is never lost.
export function throttle(fn, ms = 100) {
    let last = 0;
    let timer = null;
    let pending = null;
    return (...args) => {
        const now = Date.now();
        if (timer === null && now - last >= ms) {
            last = now;
            fn(...args);
            return;
        }
        pending = args;
        if (timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            last = Date.now();
            const a = pending;
            pending = null;
            if (a) fn(...a);
        }, ms - (now - last));
    };
}
