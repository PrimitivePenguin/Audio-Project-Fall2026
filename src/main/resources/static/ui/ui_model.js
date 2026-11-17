// ui_model.js — MODEL (no DOM; only loadSettings/saveSettings at the bottom touch fetch/localStorage)
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

// Slider step sizes (next to LIMITS so the View reads both from one place).
export const STEPS = { res: 1, numLevels: 1, noise: 0.01, tension: 0.05, lineWidth: 0.1 };

// Changing these keys means the Perlin field must be rebuilt (expensive);
// any other key only needs a redraw (cheap).
export const REBUILD_KEYS = new Set(["res", "noise"]);

// INPUT:  colors: [[r,g,b], ...]
// OUTPUT: [{ pos, rgb }, ...] with pos spread evenly from 0 to 1
// ACTION: turns a plain colour list (index.html style) into stops
function evenStops(colors) {
    const last = Math.max(colors.length - 1, 1);
    return colors.map((rgb, i) => ({ pos: i / last, rgb: [...rgb] }));
}

// INPUT:  none
// OUTPUT: a fresh settings object (deep copy, safe to mutate)
// ACTION: the defaults; match what index.html uses today (canvasColorList, canvasSettings, ...)
export function defaultSettings() {
    // pastel: white, red, orange, yellow, green, blue, violet, white (index.html canvasColorList)
    const pastel = [[255, 255, 255], [255, 179, 186], [255, 214, 165], [255, 250, 180],
                    [186, 255, 201], [174, 198, 255], [203, 170, 240], [255, 255, 255]];
    return {
        colorStops: evenStops(pastel),
        // index.html canvasOffColor: white -> black behind the notes
        offColor: { enabled: true, stops: evenStops([[255, 255, 255], [0, 0, 0]]) },
        res: 10, 
        numLevels: 10,
        noise: 0.35,
        curve: { type: "catmullRom", tension: 1, points: "interpolate", lineWidth: 1 },
    };
}

// INPUT:  hex: "#rrggbb"
// OUTPUT: [r, g, b] (0..255), or null if hex is not a valid colour
// ACTION: helper for the Controller (input type=color gives hex) and for validate()
export function hexToRgb(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
    if (!m) return null;
    return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
}

// INPUT:  rgb: [r, g, b]
// OUTPUT: "#rrggbb"
// ACTION: helper for the View (sets input type=color value)
export function rgbToHex(rgb) {
    return "#" + rgb.map(c => Math.round(c).toString(16).padStart(2, "0")).join("");
}

// INPUT:  stops: [{ pos, rgb }, ...]
// OUTPUT: [[r,g,b], ...] sorted by pos — the colorlist format contour.js expects
// ACTION: converts the model's stop list into contour's colour list
//         (note: levelColors spreads colours evenly, so pos currently only sets the ORDER;
//          to honour exact positions, levelColors would need to read pos too)
export function stopsToColorList(stops) {
    return [...stops].sort((a, b) => a.pos - b.pos).map(s => [...s.rgb]);
}

// ---------- validate helpers ----------

function isObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function copyStop(s) {
    return { pos: s.pos, rgb: [...s.rgb] };
}

// INPUT:  value: anything; lim: { min, max }; fallback; name (for messages); errors; integer: round?
// OUTPUT: a number inside lim (fallback when value is missing or not a number)
function num(value, lim, fallback, name, errors, integer) {
    if (value === undefined) return fallback;
    let n = typeof value === "number" ? value
          : (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
    if (!Number.isFinite(n)) {
        errors.push(`${name} must be a number`);
        return fallback;
    }
    if (integer) n = Math.round(n);
    if (n < lim.min || n > lim.max) {
        errors.push(`${name} must be between ${lim.min} and ${lim.max}`);
        n = Math.min(lim.max, Math.max(lim.min, n));
    }
    return n;
}

// INPUT:  value; allowed: string[]; fallback; name; errors
// OUTPUT: value if allowed, else fallback (+ error)
function choice(value, allowed, fallback, name, errors) {
    if (value === undefined) return fallback;
    if (allowed.includes(value)) return value;
    errors.push(`${name} must be one of: ${allowed.join(", ")}`);
    return fallback;
}

// INPUT:  rgb: anything
// OUTPUT: [r, g, b] rounded and clamped to 0..255, or null if not a colour
function cleanRgb(rgb) {
    if (!Array.isArray(rgb) || rgb.length !== 3) return null;
    const out = [];
    for (const c of rgb) {
        if (typeof c !== "number" || !Number.isFinite(c)) return null;
        out.push(Math.min(255, Math.max(0, Math.round(c))));
    }
    return out;
}

// INPUT:  value: anything; fallback: default stops; name; errors (null = clean quietly, no messages)
// OUTPUT: cleaned stop list: invalid stops dropped, pos clamped 0..1, sorted by pos,
//         at most LIMITS.stops.max; fallback when fewer than LIMITS.stops.min remain
function cleanStops(value, fallback, name, errors) {
    const report = msg => { if (errors) errors.push(msg); };
    if (value === undefined) return fallback.map(copyStop);
    if (!Array.isArray(value)) {
        report(`${name} must be a list of colours`);
        return fallback.map(copyStop);
    }
    const stops = [];
    for (const st of value) {
        const rgb = cleanRgb(st && st.rgb);
        const pos = st && typeof st.pos === "number" && Number.isFinite(st.pos)
            ? Math.min(1, Math.max(0, st.pos)) : null;
        if (!rgb || pos === null) {
            report(`${name}: dropped an invalid colour`);
            continue;
        }
        stops.push({ pos, rgb });
    }
    stops.sort((a, b) => a.pos - b.pos);   // stable: equal pos keeps its order
    if (stops.length > LIMITS.stops.max) {
        report(`${name}: at most ${LIMITS.stops.max} colours (extra ones dropped)`);
        stops.length = LIMITS.stops.max;
    }
    if (stops.length < LIMITS.stops.min) {
        report(`${name}: need at least ${LIMITS.stops.min} colours`);
        return fallback.map(copyStop);
    }
    return stops;
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
    const d = defaultSettings();
    const errors = [];
    if (s === undefined || s === null) {
        s = d;
    } else if (!isObject(s)) {
        errors.push("Settings must be an object");
        s = d;
    }

    // Only known keys are copied over, so anything else in s is dropped here.
    const out = {
        res:       num(s.res,       LIMITS.res,       d.res,       "Grid size",        errors, false),
        numLevels: num(s.numLevels, LIMITS.numLevels, d.numLevels, "Number of levels", errors, true),
        noise:     num(s.noise,     LIMITS.noise,     d.noise,     "Noise",            errors, false),
    };

    const curve = isObject(s.curve) ? s.curve : {};
    out.curve = {
        type:      choice(curve.type,   CURVE_TYPES, d.curve.type,   "Curve type", errors),
        tension:   num(curve.tension,   LIMITS.tension,   d.curve.tension,   "Tension",    errors, false),
        points:    choice(curve.points, POINT_MODES, d.curve.points, "Point mode", errors),
        lineWidth: num(curve.lineWidth, LIMITS.lineWidth, d.curve.lineWidth, "Line width", errors, false),
    };

    out.colorStops = cleanStops(s.colorStops, d.colorStops, "Colours", errors);

    const off = isObject(s.offColor) ? s.offColor : {};
    const enabled = off.enabled === undefined ? d.offColor.enabled : Boolean(off.enabled);
    out.offColor = {
        enabled,
        // disabled lists are still cleaned (they are kept for when the user turns them on) but never complain
        stops: cleanStops(off.stops, d.offColor.stops, "Off colours", enabled ? errors : null),
    };

    return { settings: out, errors };
}

// INPUT:  base: full settings; patch: partial settings
// OUTPUT: new object: base with patch on top (one level deeper for curve / offColor)
function merge(base, patch) {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if ((key === "curve" || key === "offColor") && isObject(value) && isObject(base[key])) {
            out[key] = { ...base[key], ...value };
        } else {
            out[key] = value;
        }
    }
    return out;
}

export class UiModel {
    // INPUT:  initial: optional settings object
    // OUTPUT: model instance
    // ACTION: stores validate(initial ?? defaultSettings()).settings; creates the listener Set
    constructor(initial) {
        this.settings = validate(initial ?? defaultSettings()).settings;
        this.listeners = new Set();
    }

    // INPUT:  none
    // OUTPUT: { canvasDampening, canvasScale }
    // ACTION: derives both values from the one stored `noise` value (never store these).
    //         Dampening = noise. Scale = 0.6 * noise so the default noise (0.25) gives the
    //         dampening 0.25 / scale 0.15 pair index.html used; change the mapping here if
    //         they need different ranges.
    derived() {
        const noise = this.settings.noise;
        return {
            canvasDampening: noise,
            canvasScale: Math.round(noise * 0.6 * 1000) / 1000,
        };
    }

    // INPUT:  patch: partial settings, e.g. { numLevels: 20 } or { curve: { tension: 1.5 } }
    // OUTPUT: { ok: boolean, errors: string[] }
    // ACTION: merges patch into a copy (nested merge for curve/offColor), runs validate(),
    //         stores the result, then calls emit(changedKeys).
    //         Return the errors so the Controller can show feedback.
    update(patch) {
        if (!isObject(patch)) return { ok: false, errors: ["Nothing to update"] };
        const { settings, errors } = validate(merge(this.settings, patch));
        this.settings = settings;
        this.emit(new Set(Object.keys(patch)));
        return { ok: errors.length === 0, errors };
    }

    // INPUT:  list: "colorStops" | "offColor"
    // OUTPUT: that stop list (the stored array: read only), or null for an unknown list
    stopsOf(list) {
        if (list === "colorStops") return this.settings.colorStops;
        if (list === "offColor") return this.settings.offColor.stops;
        return null;
    }

    // INPUT:  list: "colorStops" | "offColor"; stops: new stop list
    // OUTPUT: the patch that replaces that list, for update()
    stopsPatch(list, stops) {
        return list === "colorStops" ? { colorStops: stops } : { offColor: { stops } };
    }

    // INPUT:  list: "colorStops" | "offColor"; stop: { pos, rgb } (optional, defaults to a midpoint grey)
    // OUTPUT: { ok, errors }  (fails when already at LIMITS.stops.max)
    // ACTION: adds a colour stop, then emit
    addStop(list, stop = { pos: 0.5, rgb: [128, 128, 128] }) {
        const stops = this.stopsOf(list);
        if (!stops) return { ok: false, errors: [`Unknown colour list "${list}"`] };
        if (stops.length >= LIMITS.stops.max) {
            return { ok: false, errors: [`At most ${LIMITS.stops.max} colours`] };
        }
        return this.update(this.stopsPatch(list, [...stops.map(copyStop), copyStop(stop)]));
    }

    // INPUT:  list: "colorStops" | "offColor"; index: number
    // OUTPUT: { ok, errors }  (fails when it would go below LIMITS.stops.min)
    // ACTION: removes a colour stop, then emit
    removeStop(list, index) {
        const stops = this.stopsOf(list);
        if (!stops) return { ok: false, errors: [`Unknown colour list "${list}"`] };
        if (!Number.isInteger(index) || index < 0 || index >= stops.length) {
            return { ok: false, errors: ["No such colour"] };
        }
        if (stops.length - 1 < LIMITS.stops.min) {
            return { ok: false, errors: [`Need at least ${LIMITS.stops.min} colours`] };
        }
        return this.update(this.stopsPatch(list, stops.filter((_, i) => i !== index).map(copyStop)));
    }

    // INPUT:  none
    // OUTPUT: none
    // ACTION: settings = defaultSettings(); emit every key
    reset() {
        this.settings = validate(defaultSettings()).settings;
        this.emit(new Set(Object.keys(this.settings)));
    }

    // INPUT:  fn(settings, changedKeys: Set<string>, needsRebuild: boolean)
    // OUTPUT: unsubscribe function
    // ACTION: same pattern as press_state.js onChange
    onChange(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    // INPUT:  changedKeys: Set<string>
    // OUTPUT: none
    // ACTION: calls every listener; needsRebuild = any key in REBUILD_KEYS
    emit(changedKeys) {
        const needsRebuild = [...changedKeys].some(k => REBUILD_KEYS.has(k));
        this.listeners.forEach(f => f(this.settings, changedKeys, needsRebuild));
    }

    // INPUT:  none
    // OUTPUT: JSON string of settings
    // ACTION: what gets saved (localStorage and/or PUT /api/ui)
    toJSON() {
        return JSON.stringify(this.settings);
    }

    // INPUT:  json: string
    // OUTPUT: { ok, errors }
    // ACTION: JSON.parse inside try/catch (bad data -> keep current settings, return error),
    //         then validate + store + emit
    fromJSON(json) {
        let parsed;
        try {
            parsed = JSON.parse(json);
        } catch {
            return { ok: false, errors: ["Saved settings could not be read"] };
        }
        const { settings, errors } = validate(parsed);
        this.settings = settings;
        this.emit(new Set(Object.keys(settings)));
        return { ok: errors.length === 0, errors };
    }
}

// ---------- persistence (kept separate so the model above stays testable in Node) ----------

const STORAGE_KEY = "jukebox.ui";

// localStorage can throw (private mode, blocked storage): treat that as "nothing there"
function readLocal() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function writeLocal(json) {
    try { localStorage.setItem(STORAGE_KEY, json); return true; } catch { return false; }
}

// INPUT:  model: UiModel
// OUTPUT: Promise<{ ok, source: "server" | "local" | "default", errors }>
// ACTION: logged in -> GET /api/ui; on failure or logged out -> localStorage;
//         nothing saved -> keep defaults. Wrap localStorage in try/catch.
export async function loadSettings(model) {
    // The server answers 200 only when logged in AND something was saved
    // (401 logged out, 204 nothing saved yet): everything else falls back to this device.
    try {
        const r = await fetch("/api/ui", { headers: { Accept: "application/json" } });
        if (r.status === 200) {
            const res = model.fromJSON(await r.text());
            return { ok: res.ok, source: "server", errors: res.errors };
        }
    } catch {
        // offline / server down: use the local copy
    }

    const local = readLocal();
    if (local !== null) {
        const res = model.fromJSON(local);
        return { ok: res.ok, source: "local", errors: res.errors };
    }
    return { ok: true, source: "default", errors: [] };
}

// INPUT:  model: UiModel
// OUTPUT: Promise<{ ok, source: "server" | "local", errors }>
// ACTION: always writes localStorage; if logged in also PUT /api/ui with model.toJSON().
//         Non-2xx response -> ok: false with a message the View can show.
export async function saveSettings(model) {
    const json = model.toJSON();
    const errors = [];
    const localOk = writeLocal(json);
    if (!localOk) errors.push("Could not save on this device");

    let r;
    try {
        r = await fetch("/api/ui", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: json,
        });
    } catch {
        errors.push(localOk ? "Could not reach server — saved on this device" : "Could not reach server");
        return { ok: false, source: "local", errors };
    }

    if (r.status === 401) {
        // logged out: this device only, and that's fine
        return { ok: errors.length === 0, source: "local", errors };
    }
    if (!r.ok) {
        const text = (await r.text().catch(() => "")).trim();
        errors.push(text || `Server rejected the settings (${r.status})`);
        return { ok: false, source: "local", errors };
    }
    return { ok: errors.length === 0, source: "server", errors };
}
