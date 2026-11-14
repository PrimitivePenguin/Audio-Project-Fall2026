// from https://github.com/PrimitivePenguin/contour
import { gridRes } from "./perlin_gen.js";

// 2025/11/12 - Rebuilt around edge IDs + stitching so curves (Catmull-Rom, B-spline, natural) can be swapped in
// 2025/11/11 - Separated contour.js to make refactoring to include catmull-rom spline easier
// 2025/09/01 - Each level of the Marching Square algorithm is now added by string
// Marching Square Algorithm from The Coding Train

// Default drawing settings. Override any of these by passing settings to draw().
// curve: "segments" | "linear" | "catmullRom" | "bspline" | "natural"
// points: "interpolate" (smooth placement) | "midpoint" (classic blocky marching squares)
// res is left out on purpose: gridRes is only set once setup() runs, so it is read at draw time.
export const DEFAULT_SETTINGS = { curve: "catmullRom", tension: 1, points: "interpolate" };


// ===================== 1. FIELD =====================
// Done with perlin_gen.js


// ===================== 2. LEVELS =====================

// INPUT:  num_color: number of levels, colorStops: array of [r, g, b]
// OUTPUT: { levels: number[], colors: string[], step: number, minVal: number }
// ACTION: spaces levels evenly from minVal to maxVal and blends a colour for each
function levelColors(num_color, colorStops = [[0, 0, 0], [255, 255, 255]]) {
    const minVal = 0;
    const maxVal = 255;
    const levelStep = (maxVal - minVal) / num_color;
    const levels = [];
    const colors = [];

    for (let i = 0; i < num_color; i++) {
        levels.push(minVal + i * levelStep);

        // Find which colorStops we are between
        const t = num_color > 1 ? i / (num_color - 1) : 0; // normalized 0..1
        const scaled = t * (colorStops.length - 1);
        const idx = Math.floor(scaled);
        const frac = scaled - idx;

        const c1 = colorStops[idx];
        const c2 = colorStops[Math.min(idx + 1, colorStops.length - 1)];

        const r = Math.round(lerp(c1[0], c2[0], frac));
        const g = Math.round(lerp(c1[1], c2[1], frac));
        const b = Math.round(lerp(c1[2], c2[2], frac));

        colors.push(`rgb(${r},${g},${b})`);
    }

    return { levels, colors, step: levelStep, minVal };
}

// INPUT:  a, b: numbers, t: number (0..1)
// OUTPUT: number
// ACTION: linear interpolation from a to b
function lerp(a, b, t) {
    return a + (b - a) * t;
}


// ===================== 3. SEGMENTS =====================

// INPUT:  a, b, c, d: corner values (top-left, top-right, bottom-right, bottom-left), threshold: number
// OUTPUT: state: integer 0–15
// ACTION: sets one bit per corner at or above the threshold (8, 4, 2, 1)
function getState(a, b, c, d, threshold) {
    return ((a >= threshold) << 3) | ((b >= threshold) << 2) | ((c >= threshold) << 1) | (d >= threshold);
}

// INPUT:  (constant, indexed by state 0–15)
// OUTPUT: list of side pairs per state, e.g. [["a","d"], ["b","c"]]
// ACTION: lookup table of which cell sides each line connects
//         (a = top, b = right, c = bottom, d = left)
const CASES = [[], [["c","d"]], [["b","c"]], [["b","d"]],
               [["a","b"]], [["a","d"],["b","c"]], [["a","c"]], [["a","d"]],
               [["a","d"]], [["a","c"]], [["a","b"],["c","d"]], [["a","b"]],
               [["b","d"]], [["b","c"]], [["c","d"]], []];

// INPUT:  side: "a" | "b" | "c" | "d", i, j: cell indices
// OUTPUT: edge ID string: "h:i:j" (horizontal edge) or "v:i:j" (vertical edge)
// ACTION: names the grid edge a point sits on, so both cells sharing
//         that edge produce the same ID
function edgeId(side, i, j) {
    switch (side) {
        case "a": return `h:${i}:${j}`;     // top    = horizontal edge at row j
        case "b": return `v:${i + 1}:${j}`; // right  = vertical edge at column i+1
        case "c": return `h:${i}:${j + 1}`; // bottom = horizontal edge at row j+1
        case "d": return `v:${i}:${j}`;     // left   = vertical edge at column i
    }
}

// INPUT:  field: 2D array, nLevels: number, minVal: number, step: number
// OUTPUT: segsByLevel: array (one per level) of [edgeIdA, edgeIdB] pairs
// ACTION: one pass over all cells; uses the cell's min/max to find only
//         the levels that cross it, then adds that level's segments
function buildAllSegments(field, nLevels, minVal, step) {
    const segsByLevel = Array.from({ length: nLevels }, () => []);
    const cols = field.length;
    const rows = field[0].length;

    for (let i = 0; i < cols - 1; i++) {
        for (let j = 0; j < rows - 1; j++) {
            const v0 = field[i][j];         // top-left
            const v1 = field[i + 1][j];     // top-right
            const v2 = field[i + 1][j + 1]; // bottom-right
            const v3 = field[i][j + 1];     // bottom-left

            const lo = Math.min(v0, v1, v2, v3);
            const hi = Math.max(v0, v1, v2, v3);

            // Levels are minVal + k * step. Only levels with lo < level <= hi cross this cell.
            const kStart = Math.max(0, Math.floor((lo - minVal) / step) + 1);
            const kEnd = Math.min(nLevels - 1, Math.floor((hi - minVal) / step));

            for (let k = kStart; k <= kEnd; k++) {
                const state = getState(v0, v1, v2, v3, minVal + k * step);
                for (const [s1, s2] of CASES[state]) {
                    segsByLevel[k].push([edgeId(s1, i, j), edgeId(s2, i, j)]);
                }
            }
        }
    }
    return segsByLevel;
}


// ===================== 4. STITCH THE EDGES TOGETHER INTO A SHAPE =====================

// INPUT:  segs: array of [edgeIdA, edgeIdB] pairs (one level)
// OUTPUT: chains: array of { ids: edgeId[] (in order), closed: boolean }
// ACTION: builds a neighbour map, walks open lines from their dead ends
//         first, then walks the remaining closed loops
function stitch(segs) {
    // 1. Build adjacency map: edge ID -> neighbouring edge IDs (at most 2)
    const adjacency = new Map();
    for (const [a, b] of segs) {
        if (!adjacency.has(a)) adjacency.set(a, []);
        if (!adjacency.has(b)) adjacency.set(b, []);
        adjacency.get(a).push(b);
        adjacency.get(b).push(a);
    }


    // 2. Walk from a starting point until there is no unvisited neighbour
    const visited = new Set();

    function traverse(start) {
        const ids = [start];
        let current = start;
        visited.add(start);

        while (true) {
            const next = adjacency.get(current).find(n => !visited.has(n));
            if (next === undefined) break; // no unvisited neighbour left
            ids.push(next);
            visited.add(next);
            current = next;
        }
        // Closed if the last point connects back to the first
        const closed = ids.length > 2 && adjacency.get(current).includes(start);
        return { ids, closed };
    }

    const chains = [];

    // 3a. Open lines first, starting from dead ends (points with one neighbour)
    // Start with nothing as visited, mark those with dead-ends aka adjacent to only one
    for (const [id, neighbours] of adjacency) {
        if (neighbours.length === 1 && !visited.has(id)) {
            chains.push(traverse(id));
        }
    }

    // 3b. Everything left over is a closed loop
    // Everything else must be in a closed loop
    for (const id of adjacency.keys()) {
        if (!visited.has(id)) {
            chains.push(traverse(id));
        }
    }
    return chains;
}


// ===================== 5. POINTS =====================

// INPUT:  id: edge ID ("h:i:j" or "v:i:j"), field: 2D array, threshold: number, res: number,
//         points: "interpolate" | "midpoint"
// OUTPUT: [x, y] in pixels
// ACTION: "interpolate" places the point where the value crosses the threshold
//         along that edge; "midpoint" always uses the middle of the edge
//         (classic blocky marching squares look)
function edgePoint(id, field, threshold, res, points = "interpolate") {
    const [dir, si, sj] = id.split(":");
    const i = +si, j = +sj;
    if (points === "midpoint") {
        return dir === "h" ? [(i + 0.5) * res, j * res] : [i * res, (j + 0.5) * res];
    }
    // Instaed of at midpoint, set it at whatever the midpoint is based on where it is, resulting in a more curved look
    if (dir === "h") {                       // between (i,j) and (i+1,j)
        const v0 = field[i][j], v1 = field[i + 1][j];
        return [(i + (threshold - v0) / (v1 - v0)) * res, j * res];
    } else {                                 // between (i,j) and (i,j+1), vertical
        const v0 = field[i][j], v1 = field[i][j + 1];
        return [i * res, (j + (threshold - v0) / (v1 - v0)) * res];
    }
}


// ===================== 6. CURVES =====================

// INPUT:  p: flat array [x0, y0, x1, y1, ...], closed: boolean
// OUTPUT: { n, x(i), y(i) }
// ACTION: safe neighbour lookup; wraps around for closed shapes,
//         repeats the end point for open ones
function accessor(p, closed) {
    const n = p.length / 2;
    const at = i => closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    return {
        n,
        x: i => p[2 * at(i)],
        y: i => p[2 * at(i) + 1],
    };
}

// All curve functions share this shape:
// INPUT:  p: flat point array, closed: boolean, o: settings { tension, ... }, pen
// OUTPUT: none (writes commands to pen)
const CURVES = {};

// ACTION: straight lines between points (jagged look)
CURVES.linear = function (p, closed, o, pen) {
    const n = p.length / 2;
    if (n < 2) return;
    pen.M(p[0], p[1]);
    for (let i = 1; i < n; i++) pen.L(p[2 * i], p[2 * i + 1]);
    if (closed) pen.Z();
};

// ACTION: smooth curve through every point; o.tension 0 = straight, 1 = standard
CURVES.catmullRom = function (p, closed, o, pen) {
    const { n, x, y } = accessor(p, closed);
    if (n < 2) return;
    const k = o.tension ?? 1;
    pen.M(x(0), y(0));
    const segs = closed ? n : n - 1; // closed has one extra segment back to the start
    for (let i = 0; i < segs; i++) {
        pen.C( // Curve using Bezier curve
            x(i) + (x(i + 1) - x(i - 1)) / 6 * k,     
            y(i) + (y(i + 1) - y(i - 1)) / 6 * k,
            x(i + 1) - (x(i + 2) - x(i)) / 6 * k,     
            y(i + 1) - (y(i + 2) - y(i)) / 6 * k,
            x(i + 1), y(i + 1)
        );
    }
    if (closed) pen.Z();
};

// ACTION: softest curve; cuts inside corners and never overshoots;
//         open lines keep their exact endpoints
CURVES.bspline = function (p, closed, o, pen) {
    const { n, x, y } = accessor(p, closed);
    if (n < 3) return CURVES.linear(p, closed, o, pen);
    // Where the curve passes near point i: (prev + 4 * current + next) / 6
    const isEnd = i => !closed && (i === 0 || i === n - 1);
    const sx = i => isEnd(i) ? x(i) : (x(i - 1) + 4 * x(i) + x(i + 1)) / 6;
    const sy = i => isEnd(i) ? y(i) : (y(i - 1) + 4 * y(i) + y(i + 1)) / 6;

    pen.M(sx(0), sy(0));
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
        // control points sit at 1/3 and 2/3 of the original segment
        pen.C(
            (2 * x(i) + x(i + 1)) / 3, (2 * y(i) + y(i + 1)) / 3,
            (x(i) + 2 * x(i + 1)) / 3, (y(i) + 2 * y(i + 1)) / 3,
            sx(i + 1), sy(i + 1)
        );
    }
    if (closed) pen.Z();
};

// ACTION: smooth curve through every point with continuous curvature;
//         closed shapes are padded with wrapped points and solved as open
CURVES.natural = function (p, closed, o, pen) {
    const n = p.length / 2;
    if (n < 3) return CURVES.linear(p, closed, o, pen);

    const pad = closed ? Math.min(3, n) : 0;
    const m = closed ? n + 2 * pad + 1 : n; // closed: extra point to return to the start
    const xs = new Float64Array(m), ys = new Float64Array(m);
    for (let j = 0; j < m; j++) {
        const i = (((j - pad) % n) + n) % n;
        xs[j] = p[2 * i];
        ys[j] = p[2 * i + 1];
    }
    const dx = solveNatural(xs), dy = solveNatural(ys);

    pen.M(xs[pad], ys[pad]);
    const end = closed ? pad + n : n - 1;
    for (let i = pad; i < end; i++) {
        pen.C(
            xs[i] + dx[i] / 3,         ys[i] + dy[i] / 3,
            xs[i + 1] - dx[i + 1] / 3, ys[i + 1] - dy[i + 1] / 3,
            xs[i + 1], ys[i + 1]
        );
    }
    if (closed) pen.Z();
};

// INPUT:  v: Float64Array of one coordinate (all x values, or all y values)
// OUTPUT: Float64Array of slopes at each point
// ACTION: solves the natural spline's tridiagonal system (Thomas algorithm)
//         [2 1        ] [D0]   [3(v1 - v0)  ]
//         [1 4 1      ] [D1] = [3(v2 - v0)  ]
//         [  ...      ] [..]   [...         ]
//         [      1 2  ] [Dn]   [3(vn - vn-1)]
function solveNatural(v) {
    const m = v.length;
    const c = new Float64Array(m); // modified upper diagonal
    const d = new Float64Array(m); // modified right-hand side, becomes the answer

    c[0] = 1 / 2;
    d[0] = 3 * (v[1] - v[0]) / 2;
    for (let i = 1; i < m; i++) {
        const last = i === m - 1;
        const diag = last ? 2 : 4;
        const upper = last ? 0 : 1;
        const rhs = last ? 3 * (v[i] - v[i - 1]) : 3 * (v[i + 1] - v[i - 1]);
        const denom = diag - c[i - 1];
        c[i] = upper / denom;
        d[i] = (rhs - d[i - 1]) / denom;
    }
    // back substitution
    for (let i = m - 2; i >= 0; i--) d[i] -= c[i] * d[i + 1];
    return d;
}


// ===================== 7. DRAW =====================

// INPUT:  v: number
// OUTPUT: number rounded to 2 decimals
// ACTION: keeps SVG path strings short
const r2 = v => Math.round(v * 100) / 100;

// INPUT:  (none)
// OUTPUT: pen with M, L, C, Z methods; toString() returns an SVG "d" string
// ACTION: collects drawing commands as text, with coordinates rounded to 2 decimals
class SvgPen {
    constructor() { this.d = []; }
    M(x, y) { this.d.push(`M${r2(x)},${r2(y)}`); }
    L(x, y) { this.d.push(`L${r2(x)},${r2(y)}`); }
    C(x1, y1, x2, y2, x, y) { this.d.push(`C${r2(x1)},${r2(y1)} ${r2(x2)},${r2(y2)} ${r2(x)},${r2(y)}`); }
    Z() { this.d.push("Z"); }
    toString() { return this.d.join(""); }
}

// INPUT:  ctx: CanvasRenderingContext2D
// OUTPUT: pen with M, L, C, Z methods
// ACTION: sends the same commands straight to canvas (moveTo, lineTo, bezierCurveTo, closePath)
function canvasPen(ctx) {
    return {
        M: (x, y) => ctx.moveTo(x, y),
        L: (x, y) => ctx.lineTo(x, y),
        C: (x1, y1, x2, y2, x, y) => ctx.bezierCurveTo(x1, y1, x2, y2, x, y),
        Z: () => ctx.closePath(),
    };
}

// INPUT:  segs: one level's segments, th: threshold, field, res,
//         settings: { curve, tension }, pen
// OUTPUT: none (writes to pen)
// ACTION: "segments" mode draws raw segments with no stitching;
//         any other mode stitches, converts to points and calls CURVES[settings.curve]
function drawLevel(segs, th, field, res, settings, pen) {
    const point = id => edgePoint(id, field, th, res, settings.points);

    if (settings.curve === "segments") {
        for (const [a, b] of segs) {
            const p = point(a), q = point(b);
            pen.M(p[0], p[1]);
            pen.L(q[0], q[1]);
        }
        return;
    }

    const curve = CURVES[settings.curve] || CURVES.linear;
    for (const chain of stitch(segs)) {
        const flat = chain.ids.flatMap(point); // [x0, y0, x1, y1, ...]
        curve(flat, chain.closed, settings, pen);
    }
}

// INPUT:  svg: SVG element, pathString: string, color: string
// OUTPUT: none
// ACTION: adds one <path> element (SVG output only)
function drawPath(svg, pathString, color = "black") {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathString);
    path.setAttribute("stroke", color);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-width", 1);
    svg.appendChild(path);
}

// INPUT:  field: 2D array, num_color: number, colorStops: array of [r, g, b],
//         settings: { curve, tension, res } (optional, merged over DEFAULT_SETTINGS)
// OUTPUT: none
// ACTION: SVG output. Builds every level's segments in one pass, then adds
//         one <path> per level to the SVG with id elementId
export function draw(field, num_color, colorStops = [[0, 0, 0], [255, 255, 255]], settings = {}, elementId = "background_contour") {
    const svg = document.getElementById(elementId);
    if (!svg) throw new Error(`contour: no element with id "${elementId}"`);
    const s = { ...DEFAULT_SETTINGS, res: field.res ?? gridRes, ...settings };
    const { levels, colors, step, minVal } = levelColors(num_color, colorStops);
    const segsByLevel = buildAllSegments(field, levels.length, minVal, step);

    for (let k = 0; k < levels.length; k++) {
        if (segsByLevel[k].length === 0) continue;
        const pen = new SvgPen();
        drawLevel(segsByLevel[k], levels[k], field, s.res, s, pen);
        drawPath(svg, pen.toString(), colors[k]);
    }
}

// INPUT:  ctx: CanvasRenderingContext2D, then the same as draw()
// OUTPUT: none
// ACTION: canvas output (faster at higher fps). Clears the canvas, then
//         strokes one path per level
export function drawCanvas(ctx, field, num_color, colorStops = [[0, 0, 0], [255, 255, 255]], settings = {}) {
    const s = { ...DEFAULT_SETTINGS, res: gridRes, ...settings };
    const { levels, colors, step, minVal } = levelColors(num_color, colorStops);
    const segsByLevel = buildAllSegments(field, levels.length, minVal, step);

    s.res = settings.res ?? field.res ?? gridRes;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.lineWidth = 1;
    for (let k = 0; k < levels.length; k++) {
        if (segsByLevel[k].length === 0) continue;
        ctx.beginPath();
        drawLevel(segsByLevel[k], levels[k], field, s.res, s, canvasPen(ctx));
        ctx.strokeStyle = colors[k];
        ctx.stroke();
    }
}


// ===================== EXTRA =====================

// INPUT:  p0, p3: end points {x, y}, p1, p2: control points {x, y},
//         t: number (0..1), pFinal: optional object to write into
// OUTPUT: {x, y} point on the curve at t
// ACTION: evaluates a cubic Bézier; useful for moving things along a contour
export function cubicBezier(p0, p1, p2, p3, t, pFinal) {
    pFinal = pFinal || {};
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    pFinal.x = a * p0.x + b * p1.x + c * p2.x + d * p3.x;
    pFinal.y = a * p0.y + b * p1.y + c * p2.y + d * p3.y;
    return pFinal;
}

// Exposed for testing
export { levelColors, buildAllSegments, stitch, edgePoint, CURVES, SvgPen, drawLevel };
