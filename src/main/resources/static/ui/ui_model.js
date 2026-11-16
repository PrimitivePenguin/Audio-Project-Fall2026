// ui-model.js — MODEL (no DOM; only loadSettings/saveSettings at the bottom touch fetch/localStorage)
// Holds the user's contour ui settings, validates them, and tells
// listeners what changed. The View and the contour renderer both read from here;
// only the Controller writes (through update / addStop / removeStop / reset).
//
// Shape of the settings object (one plain object, JSON-serializable):
// {
//   colorStops:  [{ pos: 0..1, rgb: [r,g,b] }, ...]   // pressed / main colours (>= 2 stops)
//   offColor:    { enabled: false, stops: [{ pos, rgb }, ...] }  // base colours when not pressed
//   res:         5          // grid cell size in px (smaller = more detail, slower)
//   numLevels:   15         // number of contour lines
//   noise:       0.25       // ONE slider -> canvasDampening and canvasScale (see derived())
//   curve: {
//     type:      "catmullRom",   // "segments" | "linear" | "catmullRom" | "bspline" | "natural"
//     tension:   1,              // only used when type === "catmullRom"
//     points:    "interpolate",  // "interpolate" | "midpoint"
//     lineWidth: 1
//   }
// }

export const CURVE_TYPES = ["segments", "linear", "catmullRom", "bspline", "natural"];
export const POINT_MODES = ["interpolate", "midpoint"];

// Limits used by validate(); the View can also use them for slider min/max.
export const LIMITS = {
    res:       { min: 2,   max: 20 },
    numLevels: { min: 2,   max: 40 },
    noise:     { min: 0.05, max: 1 },
    tension:   { min: 0,   max: 2 },
    lineWidth: { min: 0.5, max: 4 },
    stops:     { min: 2,   max: 12 },
};

// Changing these keys means the Perlin field must be rebuilt (expensive);
// any other key only needs a redraw (cheap).
export const REBUILD_KEYS = new Set(["res", "noise"]);

// INPUT:  none
// OUTPUT: a fresh settings object (deep copy, safe to mutate)
// ACTION: the defaults; match what index.html uses today (canvasColorList, canvasSettings, ...)
export function defaultSettings() {
    // TODO: return { colorStops: [...], offColor: {...}, res: 5, numLevels: 15, noise: 0.25, curve: {...} }
}

// INPUT:  hex: "#rrggbb"
// OUTPUT: [r, g, b] (0..255), or null if hex is not a valid colour
// ACTION: helper for the Controller (input type=color gives hex) and for validate()
export function hexToRgb(hex) {
    // TODO: regex /^#([0-9a-f]{6})$/i, then parseInt in pairs
}

// INPUT:  rgb: [r, g, b]
// OUTPUT: "#rrggbb"
// ACTION: helper for the View (sets input type=color value)
export function rgbToHex(rgb) {
    // TODO: each channel .toString(16).padStart(2, "0")
}

// INPUT:  stops: [{ pos, rgb }, ...]
// OUTPUT: [[r,g,b], ...] sorted by pos — the colorlist format contour.js expects
// ACTION: converts the model's stop list into contour's colour list
//         (note: levelColors spreads colours evenly, so pos currently only sets the ORDER;
//          to honour exact positions, levelColors would need to read pos too)
export function stopsToColorList(stops) {
    // TODO
}

// INPUT:  s: settings object (possibly from localStorage/server, so untrusted)
// OUTPUT: { settings, errors } — settings is a cleaned copy (clamped, sorted, defaults filled in),
//         errors is an array of human-readable messages (empty if everything was fine)
// ACTION: the single place where rules live:
//         - numbers clamped to LIMITS, numLevels rounded to an integer
//         - curve.type in CURVE_TYPES, curve.points in POINT_MODES (else default + error)
//         - colorStops: drop invalid rgb, clamp pos to 0..1, sort by pos, need >= LIMITS.stops.min
//         - offColor.stops validated the same way when offColor.enabled
//         - unknown keys dropped
export function validate(s) {
    // TODO
}

export class UiModel {
    // INPUT:  initial: optional settings object
    // OUTPUT: model instance
    // ACTION: stores validate(initial ?? defaultSettings()).settings; creates the listener Set
    constructor(initial) {
        // TODO: this.settings = ...; this.listeners = new Set();
    }

    // INPUT:  none
    // OUTPUT: { canvasDampening, canvasScale }
    // ACTION: derives both values from the one stored `noise` value (never store these).
    //         Start with both = noise; change the mapping here later if they need different ranges.
    derived() {
        // TODO
    }

    // INPUT:  patch: partial settings, e.g. { numLevels: 20 } or { curve: { tension: 1.5 } }
    // OUTPUT: { ok: boolean, errors: string[] }
    // ACTION: merges patch into a copy (nested merge for curve/offColor), runs validate(),
    //         stores the result, then calls emit(changedKeys).
    //         Return the errors so the Controller can show feedback.
    update(patch) {
        // TODO
    }

    // INPUT:  list: "colorStops" | "offColor"; stop: { pos, rgb } (optional, defaults to a midpoint grey)
    // OUTPUT: { ok, errors }  (fails when already at LIMITS.stops.max)
    // ACTION: adds a colour stop, then emit
    addStop(list, stop) {
        // TODO
    }

    // INPUT:  list: "colorStops" | "offColor"; index: number
    // OUTPUT: { ok, errors }  (fails when it would go below LIMITS.stops.min)
    // ACTION: removes a colour stop, then emit
    removeStop(list, index) {
        // TODO
    }

    // INPUT:  none
    // OUTPUT: none
    // ACTION: settings = defaultSettings(); emit every key
    reset() {
        // TODO
    }

    // INPUT:  fn(settings, changedKeys: Set<string>, needsRebuild: boolean)
    // OUTPUT: unsubscribe function
    // ACTION: same pattern as press_state.js onChange
    onChange(fn) {
        // TODO
    }

    // INPUT:  changedKeys: Set<string>
    // OUTPUT: none
    // ACTION: calls every listener; needsRebuild = any key in REBUILD_KEYS
    emit(changedKeys) {
        // TODO
    }

    // INPUT:  none
    // OUTPUT: JSON string of settings
    // ACTION: what gets saved (localStorage and/or PUT /api/ui)
    toJSON() {
        // TODO
    }

    // INPUT:  json: string
    // OUTPUT: { ok, errors }
    // ACTION: JSON.parse inside try/catch (bad data -> keep current settings, return error),
    //         then validate + store + emit
    fromJSON(json) {
        // TODO
    }
}

// ---------- persistence (kept separate so the model above stays testable in Node) ----------

const STORAGE_KEY = "jukebox.ui";

// INPUT:  model: UiModel
// OUTPUT: Promise<{ ok, source: "server" | "local" | "default", errors }>
// ACTION: logged in -> GET /api/ui; on failure or logged out -> localStorage;
//         nothing saved -> keep defaults. Wrap localStorage in try/catch.
export async function loadSettings(model) {
    // TODO
}

// INPUT:  model: UiModel
// OUTPUT: Promise<{ ok, errors }>
// ACTION: always writes localStorage; if logged in also PUT /api/ui with model.toJSON().
//         Non-2xx response -> ok: false with a message the View can show.
export async function saveSettings(model) {
    // TODO
}