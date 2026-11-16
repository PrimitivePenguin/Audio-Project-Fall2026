// ui_view.js — VIEW
// Builds and updates the "UI" form from the model's settings.
// Reads settings, never changes them: user input goes to ui_controller.js.
//
// Expected markup (see templates/settings.html):
//   #ui
//     #colorStops      list of rows  [data-list="colorStops"] > .stop[data-index]
//       (a sibling [data-gradient="colorStops"] bar shows the gradient preview)
//     #addStop         button
//     #offColorToggle  checkbox
//     #offColorSection  (hidden unless offColor.enabled)
//       #offColorStops  [data-list="offColor"] > .stop[data-index]  (+ [data-gradient="offColor"])
//       #addOffStop     button
//     #res, #numLevels, #noise, #curveType, #tension, #lineWidth  inputs
//       each slider may have an <output for="id"> next to it showing its value
//     #tensionRow       (hidden unless curve.type === "catmullRom")
//     input[name=points]  radio pair: interpolate / midpoint
//     #saveUi, #resetUi  buttons
//     #uiStatus  feedback text (saved / errors)
//     #uiPreview svg used for the live contour preview

import { LIMITS, STEPS, rgbToHex } from "./ui_model.js";

const SLIDERS = ["res", "numLevels", "noise", "tension", "lineWidth"];

// INPUT:  root: the #ui element
// OUTPUT: view object { root, els: {...named inputs}, render, renderStops, showStatus }
// ACTION: looks up every element once; sets slider min/max from LIMITS
export function createUiView(root) {
    const $ = sel => root.querySelector(sel);
    const els = {
        colorStops:      $("#colorStops"),
        addStop:         $("#addStop"),
        offColorToggle:  $("#offColorToggle"),
        offColorSection: $("#offColorSection"),
        offColorStops:   $("#offColorStops"),
        addOffStop:      $("#addOffStop"),
        res:             $("#res"),
        numLevels:       $("#numLevels"),
        noise:           $("#noise"),
        curveType:       $("#curveType"),
        tension:         $("#tension"),
        tensionRow:      $("#tensionRow"),
        lineWidth:       $("#lineWidth"),
        points:          [...root.querySelectorAll("input[name=points]")],
        save:            $("#saveUi"),
        reset:           $("#resetUi"),
        status:          $("#uiStatus"),
        preview:         $("#uiPreview"),
        labels:          {},   // slider key -> <output> showing its value (may be missing)
    };

    for (const key of SLIDERS) {
        const el = els[key];
        if (!el) continue;
        el.min = LIMITS[key].min;
        el.max = LIMITS[key].max;
        el.step = STEPS[key];
        els.labels[key] = root.querySelector(`output[for="${key}"]`);
    }

    return {
        root,
        els,
        render: s => render(els, s),
        renderStops: (listName, stops) =>
            renderStops(listName === "offColor" ? els.offColorStops : els.colorStops, stops, listName),
        showStatus: (message, kind) => showStatus(els.status, message, kind),
    };
}

// Sets el.value only when it differs, so an input being dragged is left alone
function setValue(el, value) {
    if (el && String(el.value) !== String(value)) el.value = value;
}

// Text shown next to a slider
function formatValue(key, value) {
    if (key === "res") return `${value} px`;
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// INPUT:  els: element lookup; s: settings
// OUTPUT: none
// ACTION: puts every value from s into the form, and updates the value label next to each slider.
//         Conditional sections are just visibility toggles here:
//           els.offColorSection.hidden = !s.offColor.enabled
//           els.tensionRow.hidden      = s.curve.type !== "catmullRom"
//         Safe to call any time (after load, reset, every change).
export function render(els, s) {
    setValue(els.res, s.res);
    setValue(els.numLevels, s.numLevels);
    setValue(els.noise, s.noise);
    setValue(els.tension, s.curve.tension);
    setValue(els.lineWidth, s.curve.lineWidth);
    setValue(els.curveType, s.curve.type);
    for (const r of els.points) r.checked = r.value === s.curve.points;
    if (els.offColorToggle) els.offColorToggle.checked = s.offColor.enabled;

    if (els.offColorSection) els.offColorSection.hidden = !s.offColor.enabled;
    if (els.tensionRow) els.tensionRow.hidden = s.curve.type !== "catmullRom";

    const values = { res: s.res, numLevels: s.numLevels, noise: s.noise,
                     tension: s.curve.tension, lineWidth: s.curve.lineWidth };
    for (const [key, out] of Object.entries(els.labels)) {
        if (out) out.value = formatValue(key, values[key]);
    }

    renderStops(els.colorStops, s.colorStops, "colorStops");
    renderStops(els.offColorStops, s.offColor.stops, "offColor");
}

// One row of a stop list
function stopRow(stop, index) {
    const row = document.createElement("div");
    row.className = "stop";
    row.innerHTML =
        '<input type="range" min="0" max="1" step="0.01" aria-label="Position">' +
        '<input type="color" aria-label="Colour">' +
        '<button type="button" data-action="delete" aria-label="Remove colour" title="Remove colour">&times;</button>';
    fillRow(row, stop, index);
    return row;
}

function fillRow(row, stop, index) {
    row.dataset.index = index;
    const range = row.querySelector('input[type="range"]');
    const color = row.querySelector('input[type="color"]');
    setValue(range, stop.pos);
    setValue(color, rgbToHex(stop.rgb));
    range.title = `${Math.round(stop.pos * 100)}%`;
}

// INPUT:  listEl: container for one stop list; stops: [{ pos, rgb }]; listName: "colorStops" | "offColor"
// OUTPUT: none
// ACTION: rebuilds the rows: each row = range (pos), input type=color (rgbToHex), delete button.
//         Each row gets data-index; the container gets data-list (used by Controller delegation).
//         Also sets the gradient preview bar: background = gradientCss(stops)
export function renderStops(listEl, stops, listName) {
    if (!listEl) return;
    listEl.dataset.list = listName;

    const rows = listEl.querySelectorAll(":scope > .stop");
    if (rows.length !== stops.length) {
        listEl.replaceChildren(...stops.map((st, i) => stopRow(st, i)));
    } else {
        // same number of rows: update in place so a slider being dragged keeps focus
        rows.forEach((row, i) => fillRow(row, stops[i], i));
    }

    const bar = listEl.parentElement && listEl.parentElement.querySelector(`[data-gradient="${listName}"]`);
    if (bar) bar.style.background = gradientCss(stops);
}

// INPUT:  stops: [{ pos, rgb }]
// OUTPUT: CSS string "linear-gradient(to right, rgb(..) 0%, ...)"
// ACTION: preview of the colour list
export function gradientCss(stops) {
    if (!stops || stops.length === 0) return "none";
    const sorted = [...stops].sort((a, b) => a.pos - b.pos);
    if (sorted.length === 1) sorted.push(sorted[0]);   // a gradient needs two stops
    const parts = sorted.map(s => `rgb(${s.rgb.join(",")}) ${Math.round(s.pos * 100)}%`);
    return `linear-gradient(to right, ${parts.join(", ")})`;
}

// INPUT:  statusEl; message: string; kind: "ok" | "error" | "info"
// OUTPUT: none
// ACTION: user feedback, e.g. "Saved", "Need at least 2 colours", "Could not reach server — saved on this device"
//         (use role="status" / aria-live="polite" on the element in the HTML)
export function showStatus(statusEl, message, kind = "info") {
    if (!statusEl) return;
    statusEl.textContent = message ?? "";
    statusEl.dataset.kind = kind;
    statusEl.hidden = !message;
}
