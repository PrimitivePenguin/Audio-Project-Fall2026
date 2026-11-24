import { buildContourPaths, paintContour } from "./contour.js";
import { ContourRegionCache, framePainter } from "./region_cache.js";

export function createCanvasContour(canvas, { baseAlpha = 1 } = {}) {
    const ctx = canvas.getContext("2d");
    const cache = new ContourRegionCache(buildContourPaths);
    let args = null;
    let rects = [];
    let rectsKey = "[]";
    let viewKey = "";
    let view = { width: 0, height: 0, offsetX: 0, offsetY: 0, clip: null };
    const paint = framePainter(() => {
        if (!args || !view.width || !view.height) return;
        const region = cache.get(view, args);
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(view.width * ratio));
        const height = Math.max(1, Math.round(view.height * ratio));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.save();
        if (view.clip) {
            ctx.beginPath();
            ctx.rect(view.clip.x, view.clip.y, view.clip.width, view.clip.height);
            ctx.clip();
        }
        ctx.translate(region.x - view.offsetX, region.y - view.offsetY);
        const localRects = rects.map((rect) => ({ ...rect, x: rect.x - region.x, y: rect.y - region.y }));
        paintContour(ctx, region.paths, args.levels, args.offcolorlist, args.colorlist,
            { rects: localRects.filter((rect) => !rect.opaque), baseAlpha, lineWidth: args.settings.lineWidth });
        for (const rect of localRects) {
            if (rect.opaque) ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
        }
        ctx.restore();
    });
    return {
        // Retain the public API; composition size is deliberately never read here.
        build(sizeElementId, contourArgs) {
            args = contourArgs;
            paint();
        },
        setView({ width, height, offsetX = 0, offsetY = 0, clip = null }) {
            const next = { width, height, offsetX, offsetY, clip };
            const key = JSON.stringify([next, window.devicePixelRatio || 1]);
            if (key === viewKey) return;
            viewKey = key;
            view = next;
            paint();
        },
        setRects(next) {
            const key = JSON.stringify(next);
            if (key === rectsKey) return;
            rectsKey = key;
            rects = next;
            paint();
        },
        paint
    };
}
