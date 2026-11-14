// from https://github.com/PrimitivePenguin/contour
import { draw　} from "./contour.js"
import { generatePerlin } from "./perlin_gen.js"

let animationID;
let isAnimating = false;
let stopped = false;
let lastUpdate = 0;
const targetFPS = 5; // ~50ms per frame
const interval = 1000 / targetFPS;
let t = 0; // tracks calculation
let curtime = new Date();
let pasttime = new Date();

// Animation tracker
let currentField = null;
let num_colors = null;
let colorlist = null;
let incrementFactor = null;
let dampeningFactor = null;
let scaleFactor = null;
let drawSettings = {}; // passed to draw(): { curve, tension, res }

// Animation
function animateLoop(timestamp, field, num_color, colorlist, increment, dampening, scale) {
    if (!isAnimating) {
        stopAnimation();
        return;
    }
    if (!lastUpdate) lastUpdate = timestamp;
    const elapsed = timestamp - lastUpdate;

    if (elapsed >= interval) {
        lastUpdate = timestamp - (elapsed % interval); // reset for next frame
        animate(field, num_color, colorlist, increment, dampening, scale);
    }

    animationID = requestAnimationFrame((ts) => {
        animateLoop(ts, field, num_color, colorlist, increment, dampening, scale);
    });
}

function animate(field, num_color, colorlist, increment, dampening, scale) {
    const svg = document.getElementById("background_contour");
    const paths = svg.querySelectorAll('path');
    paths.forEach(p => p.remove());


    // All changes to the initial base is applied here
    let modulatedField =  generatePerlin(field, scale, dampening, t, drawSettings.height ?? 1);
    // Redraw marching squares with updated values
    draw(modulatedField, num_color, colorlist, drawSettings);
    // Increment time
    t  += increment;
    t = Math.round(t * 10) /10;

    // Loop
}

export function startAnimation(field, colors, colorlistArg, increment, dampening, scale, settings = {}) {
    drawSettings = settings;
    // Remember the settings so resumeAnimation() can restart with them.
    // Saved even if already running, so restarting with new settings works.
    currentField = field;
    num_colors = colors;
    colorlist = colorlistArg;
    incrementFactor = increment;
    dampeningFactor = dampening;
    scaleFactor = scale;

    stopAnimation();
    stopped = false;
    resumeAnimation();
}

export function stopAnimation() {
    isAnimating = false;
    if (animationID) {
        cancelAnimationFrame(animationID);
        animationID = null;
    }
}

// Safe to call on any page: does nothing if startAnimation() was never
// called (static renderFrame pages) or if it's already running.
export function resumeAnimation() {
    if (isAnimating || !currentField) return;
    isAnimating = true;
    lastUpdate = 0;
    animationID = requestAnimationFrame((ts) => {
        animateLoop(ts, currentField, num_colors, colorlist, incrementFactor, dampeningFactor, scaleFactor);
    });
}


export function renderFrame(field, num_color, colorlist, dampening, scale, time = t, settings = {}) {
    const svg = document.getElementById("background_contour");
    svg.querySelectorAll('path').forEach(p => p.remove());
    const modulatedField = generatePerlin(field, scale, dampening, time, settings.height ?? 1);
    draw(modulatedField, num_color, colorlist, settings);
}


document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        // Page is not visible → stop animation
        stopAnimation();
        console.log("Animation paused (page hidden)");
    } else if (stopped == false){
        // Page is visible → resume animation
        resumeAnimation();
        console.log("Animation resumed (page visible)");
    }
    // if button pressed and viewer look away -> stop animation
    // if button not pressed and viewer looks away -> resume animation
});