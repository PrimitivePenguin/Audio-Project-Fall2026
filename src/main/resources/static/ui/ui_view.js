// ui-view.js — VIEW
// Builds and updates the "UI" form from the model's settings.
// Reads settings, never changes them: user input goes to ui-controller.js.
//
// Expected markup (see templates/settings.html):
//   #ui
//     #colorStops      list of rows  [data-list="colorStops"] > .stop[data-index]
//     #offColorToggle  checkbox
//     #offColorSection  (hidden unless offColor.enabled)
//       #offColorStops  [data-list="offColor"] > .stop[data-index]
//     #res, #numLevels, #noise, #curveType, #tension, #lineWidth  inputs
//     #tensionRow       (hidden unless curve.type === "catmullRom")
//     input[name=points]  radio pair: interpolate / midpoint
//     #uiStatus  feedback text (saved / errors)
//     #uiPreview svg used for the live contour preview

import { LIMITS, rgbToHex } from "./ui-model.js";

// INPUT:  root: the #ui element
// OUTPUT: view object { root, els: {...named inputs}, render, renderStops, showStatus }
// ACTION: looks up every element once; sets slider min/max from LIMITS
export function createUiView(root) {
    // TODO: const els = { res: root.querySelector("#res"), ... };
    //       for each slider: el.min = LIMITS.x.min; el.max = LIMITS.x.max;
    //       return { root, els, render: s => render(els, s), ... };
}

// INPUT:  els: element lookup; s: settings
// OUTPUT: none
// ACTION: puts every value from s into the form, and updates the value label next to each slider.
//         Conditional sections are just visibility toggles here:
//           els.offColorSection.hidden = !s.offColor.enabled
//           els.tensionRow.hidden      = s.curve.type !== "catmullRom"
//         Safe to call any time (after load, reset, every change).
export function render(els, s) {
    // TODO
}

// INPUT:  listEl: container for one stop list; stops: [{ pos, rgb }]; listName: "colorStops" | "offColor"
// OUTPUT: none
// ACTION: rebuilds the rows: each row = range (pos), input type=color (rgbToHex), delete button.
//         Each row gets data-index; the container gets data-list (used by Controller delegation).
//         Also sets the gradient preview bar: background = gradientCss(stops)
export function renderStops(listEl, stops, listName) {
    // TODO
}

// INPUT:  stops: [{ pos, rgb }]
// OUTPUT: CSS string "linear-gradient(to right, rgb(..) 0%, ...)"
// ACTION: preview of the colour list
export function gradientCss(stops) {
    // TODO
}

// INPUT:  statusEl; message: string; kind: "ok" | "error" | "info"
// OUTPUT: none
// ACTION: user feedback, e.g. "Saved", "Need at least 2 colours", "Could not reach server — saved on this device"
//         (use role="status" / aria-live="polite" on the element in the HTML)
export function showStatus(statusEl, message, kind = "info") {
    // TODO
}
