// from https://github.com/PrimitivePenguin/contour
import { draw } from "./contour.js"
import { generatePerlin } from "./perlin_gen.js"

const DEFAULT_ID = "background_contour";
const targetFPS = 5;
const interval = 1000 / targetFPS;

// One state object per SVG element id, so several contours can run at once.
// { field, num_color, colorlist, increment, dampening, scale, settings,
//   t, lastUpdate, animationID, isAnimating, stopped }
const animations = new Map();

// Removes the previous frame's paths and draws a new one into the given SVG
function drawInto(elementId, field, num_color, colorlist, dampening, scale, time, settings) {
    const svg = document.getElementById(elementId);
    if (!svg) {
        console.warn(`contour: no element with id "${elementId}"`);
        return false;
    }
    svg.querySelectorAll('path').forEach(p => p.remove());
    const modulatedField = generatePerlin(field, scale, dampening, time, settings.height ?? 1);
    draw(modulatedField, num_color, colorlist, settings, elementId);
    return true;
}

function animateLoop(timestamp, elementId) {
    const a = animations.get(elementId);
    if (!a || !a.isAnimating) return;

    if (!a.lastUpdate) a.lastUpdate = timestamp;
    const elapsed = timestamp - a.lastUpdate;

    if (elapsed >= interval) {
        a.lastUpdate = timestamp - (elapsed % interval); // reset for next frame
        if (!drawInto(elementId, a.field, a.num_color, a.colorlist, a.dampening, a.scale, a.t, a.settings)) {
            stopAnimation(elementId);
            return;
        }
        a.t = Math.round((a.t + a.increment) * 10) / 10;
    }

    a.animationID = requestAnimationFrame(ts => animateLoop(ts, elementId));
}

// Starts (or restarts with new settings) the animation in the SVG with this id.
// Note: field must come from its own setup() call; generatePerlin overwrites it every frame.
export function startAnimation(field, colors, colorlist, increment, dampening, scale, settings = {}, elementId = DEFAULT_ID) {
    const prev = animations.get(elementId);
    stopAnimation(elementId);
    animations.set(elementId, {
        field, num_color: colors, colorlist, increment, dampening, scale, settings,
        t: prev ? prev.t : 0,     // keep time on restart so it doesn't jump
        lastUpdate: 0, animationID: null, isAnimating: false, stopped: false,
    });
    resumeAnimation(elementId);
}

// Stops one animation by id. stopAnimation() with no id stops every animation.
export function stopAnimation(elementId) {
    const ids = elementId === undefined ? [...animations.keys()] : [elementId];
    for (const id of ids) {
        const a = animations.get(id);
        if (!a) continue;
        a.isAnimating = false;
        a.stopped = true;
        if (a.animationID) cancelAnimationFrame(a.animationID);
        a.animationID = null;
    }
}

// Resumes one animation by id, or every animation when called with no id.
// Does nothing for ids that were never started, or that are already running.
export function resumeAnimation(elementId) {
    const ids = elementId === undefined ? [...animations.keys()] : [elementId];
    for (const id of ids) {
        const a = animations.get(id);
        if (!a || a.isAnimating) continue;
        a.isAnimating = true;
        a.stopped = false;
        a.lastUpdate = 0;
        a.animationID = requestAnimationFrame(ts => animateLoop(ts, id));
    }
}

// Draws a single still frame into the SVG with this id.
export function renderFrame(field, num_color, colorlist, dampening, scale, time = 0, settings = {}, elementId = DEFAULT_ID) {
    drawInto(elementId, field, num_color, colorlist, dampening, scale, time, settings);
}

// Pause everything while the tab is hidden; on return, resume only the
// animations that were running (not ones the page stopped on purpose).
document.addEventListener("visibilitychange", () => {
    for (const [id, a] of animations) {
        if (document.hidden) {
            if (a.isAnimating) {
                a.isAnimating = false;
                if (a.animationID) cancelAnimationFrame(a.animationID);
                a.animationID = null;
            }
        } else if (!a.stopped) {
            resumeAnimation(id);
        }
    }
});
