import { buildContourStrings, levelColors } from "./contour.js";
import { createContourOverlay, setClipRects } from "./overlay.js";
import { ContourRegionCache, framePainter } from "./region_cache.js";

export function createSvgContour(svg) {
    const overlay = createContourOverlay(svg);
    const cache = new ContourRegionCache(buildContourStrings);
    let args = null;
    let rects = [];
    let view = null;
    let viewKey = "";
    let rectsKey = "[]";
    let lastRegion = null;
    let lastArgs = null;
    const paint = framePainter(() => {
        if (!args || !view || !view.width || !view.height) return;
        const region = cache.get(view, args);
        svg.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`);
        if (region !== lastRegion || args !== lastArgs) {
            overlay.base.replaceChildren();
            overlay.hi.replaceChildren();
            const base = levelColors(args.levels, args.offcolorlist).colors;
            const high = levelColors(args.levels, args.colorlist).colors;
            region.paths.forEach((d, index) => {
                for (const [layer, color] of [[overlay.base, base[index]], [overlay.hi, high[index]]]) {
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    path.setAttribute('d', d);
                    path.setAttribute('stroke', color);
                    path.setAttribute('stroke-width', args.settings.lineWidth);
                    path.setAttribute('fill', 'none');
                    layer.appendChild(path);
                }
            });
            lastRegion = region;
            lastArgs = args;
        }
        const transform = `translate(${region.x - view.offsetX} ${region.y - view.offsetY})`;
        for (const layer of [overlay.base, overlay.hi]) {
            for (const path of layer.children) path.setAttribute('transform', transform);
        }
        setClipRects(overlay, rects.map((rect) => ({ ...rect, x: rect.x - view.offsetX, y: rect.y - view.offsetY })));
    });
    return {
        build(sizeElementId, next) { args = next; paint(); },
        setView(next) {
            const key = JSON.stringify(next);
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
