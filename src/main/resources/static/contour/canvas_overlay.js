// canvas_overlay.js — canvas version of the contour overlay (overlay.js is the SVG one)
// The canvas only has to be as big as what is visible: the contour paths cover the
// whole area, and setView() says which part of it the canvas is showing.

import { buildContourPaths, paintContour } from "./contour.js";
import { generatePerlin, setup } from "./perlin_gen.js";

// INPUT:  canvas: <canvas> element; options { baseAlpha: opacity of the contour outside the rects }
// OUTPUT: { build, setView, setRects, paint }
// ACTION: keeps the built paths, the rects and the view; every change repaints.
export function createCanvasContour(canvas, { baseAlpha = 1 } = {}) {
    const ctx = canvas.getContext("2d");
    let paths = null;
    let args = null;
    let rects = [];
    let rectsKey = "[]";
    let view = { width: 0, height: 0, offsetX: 0, offsetY: 0, clip: null };

    function paint() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!paths || !args) return;
        const ratio = window.devicePixelRatio || 1;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.save();
        if (view.clip) {
            ctx.beginPath();
            ctx.rect(view.clip.x, view.clip.y, view.clip.width, view.clip.height);
            ctx.clip();
        }
        ctx.translate(-view.offsetX, -view.offsetY);
        paintContour(ctx, paths, args.levels, args.offcolorlist, args.colorlist,
                     { rects, baseAlpha, lineWidth: args.settings.lineWidth });
        ctx.restore();
    }

    return {
        // INPUT:  sizeElementId: id of the element the contour should cover (the field is sized to it);
        //         contourArgs: from toContourArgs(model)
        // ACTION: the expensive step: new field + noise + paths, then paint
        build(sizeElementId, contourArgs) {
            args = contourArgs;
            const field = generatePerlin(setup(args.res, sizeElementId), args.scale, args.dampening, 0,
                                         args.settings.height ?? 1);
            paths = buildContourPaths(field, args.levels, { ...args.settings, res: args.res });
            paint();
        },

        // INPUT:  { width, height }: visible size in CSS px; { offsetX, offsetY }: where the canvas
        //         sits inside the contour (scroll position); clip: optional { x, y, width, height }
        //         in canvas coordinates, nothing is drawn outside it
        // ACTION: resizes the bitmap when needed (sharp on high-DPI screens / browser zoom), then paints
        setView({ width, height, offsetX = 0, offsetY = 0, clip = null }) {
            view = { width, height, offsetX, offsetY, clip };
            const ratio = window.devicePixelRatio || 1;
            const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio));
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;
            paint();
        },

        // INPUT:  rects: [{ x, y, width, height }] in contour coordinates (e.g. the notes)
        // ACTION: inside them the highlight colours are drawn instead of the base colours
        setRects(newRects) {
            const key = JSON.stringify(newRects);
            if (key === rectsKey) return;   // unchanged: skip the repaint
            rectsKey = key;
            rects = newRects;
            paint();
        },

        paint,
    };
}
