import { generatePerlin } from "./perlin_gen.js";

// A small LRU of overscanned, grid-aligned windows. No composition-sized allocation.
// Global cell coordinates sample the same noise as the original whole-song field.
export class ContourRegionCache {
    constructor(buildPaths, capacity = 3) {
        this.buildPaths = buildPaths;
        this.capacity = capacity;
        this.regions = [];
        this.key = null;
        this.buildCount = 0;
    }

    get(view, args) {
        const key = JSON.stringify([args.res, args.levels, args.scale, args.dampening, args.settings]);
        if (this.key !== key) {
            this.key = key;
            this.regions.length = 0;
        }
        const right = view.offsetX + view.width;
        const bottom = view.offsetY + view.height;
        const found = this.regions.findIndex((region) => region.x <= view.offsetX && region.y <= view.offsetY &&
            region.x + region.width >= right && region.y + region.height >= bottom);
        if (found >= 0) {
            const [region] = this.regions.splice(found, 1);
            this.regions.push(region);
            return region;
        }
        const res = args.res;
        const margin = Math.ceil(192 / res) * res;
        const x = Math.max(0, Math.floor((view.offsetX - margin) / res) * res);
        const y = Math.max(0, Math.floor((view.offsetY - margin) / res) * res);
        const width = Math.ceil((right + margin - x) / res) * res;
        const height = Math.ceil((bottom + margin - y) / res) * res;
        const field = Array.from({ length: width / res + 1 }, () => new Float64Array(height / res + 1));
        field.res = res;
        field.offsetXCells = x / res;
        field.offsetYCells = y / res;
        generatePerlin(field, args.scale, args.dampening, 0, args.settings.height ?? 1);
        const region = { x, y, width, height, paths: this.buildPaths(field, args.levels, args.settings) };
        this.buildCount++;
        this.regions.push(region);
        if (this.regions.length > this.capacity) this.regions.shift();
        return region;
    }
}

// Latest state wins: setters, scrolls and note events share one paint per frame.
export function framePainter(paint) {
    let pending = null;
    return () => {
        if (pending !== null) return;
        pending = requestAnimationFrame(() => {
            pending = null;
            paint();
        });
    };
}
