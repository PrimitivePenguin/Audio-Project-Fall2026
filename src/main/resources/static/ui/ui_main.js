// ui_main.js — wiring
// Used by two pages:
//   settings.html -> initUiPage(): form + live preview
//   index.html    -> applyUi(): loads saved settings, draws the piano contour with them

import { UiModel, loadSettings, stopsToColorList } from "./ui_model.js";
import { createUiView } from "./ui_view.js";
import { attachUiController } from "./ui_controller.js";
import { setup } from "/contour/perlin_gen.js";
import { renderFrame } from "/contour/contour_animation.js";
import { createContourOverlay, setClipRects } from "/contour/overlay.js";
import { createCanvasContour } from "/contour/canvas_overlay.js";

// Vertical exaggeration index.html uses for the piano contour (not a user setting).
const CONTOUR_HEIGHT = 1.5;

// INPUT:  model: UiModel
// OUTPUT: { levels, colorlist, offcolorlist, dampening, scale, settings, res, renderer }
// ACTION: translates the model into the exact arguments renderFrame / startAnimation take.
//         offColor disabled -> offcolorlist = colorlist (no separate pressed colour).
//         The contour renderer is a second "view" of the model.
export function toContourArgs(model) {
    const s = model.settings;
    const { canvasDampening, canvasScale } = model.derived();
    const colorlist = stopsToColorList(s.colorStops);
    const offcolorlist = s.offColor.enabled ? stopsToColorList(s.offColor.stops) : colorlist;
    return {
        levels: s.numLevels,
        colorlist,
        offcolorlist,
        dampening: canvasDampening,
        scale: canvasScale,
        res: s.res,
        renderer: s.renderer,   // "canvas" | "svg": which element / draw path the page uses
        settings: {
            curve: s.curve.type,
            tension: s.curve.tension,
            points: s.curve.points,
            lineWidth: s.curve.lineWidth,
            height: CONTOUR_HEIGHT,
        },
    };
}

// INPUT:  svgId: id of the svg to draw in; model
// OUTPUT: function redraw(needsRebuild)
// ACTION: keeps one field; rebuilds it with setup(res, svgId) only when needsRebuild
//         (or the first time), then renderFrame(svgId, field, ...toContourArgs(model))
export function createContourRenderer(svgId, model) {
    let field = null;
    return function redraw(needsRebuild = false) {
        if (!document.getElementById(svgId)) return;
        const a = toContourArgs(model);
        if (!field || needsRebuild) field = setup(a.res, svgId);
        renderFrame(svgId, field, a.levels, a.colorlist, a.offcolorlist, a.dampening, a.scale, 0, a.settings);
    };
}

// INPUT:  root: #ui element (default looks it up)
// OUTPUT: Promise<{ model, view, detach }>
// ACTION: settings page: new model -> await loadSettings -> view -> controller ->
//         preview renderer subscribed to model.onChange((s, keys, rebuild) => redraw(rebuild))
export async function initUiPage(root = document.getElementById("ui")) {
    const model = new UiModel();
    const loaded = await loadSettings(model);
    const view = createUiView(root);
    const detachController = attachUiController(model, view);

    // Live preview. The svg gets the same base/hi layers as the piano overlay, with the
    // middle third "pressed", so both colour lists are visible at once.
    // Two preview elements, one per renderer; only the one matching settings.renderer is shown.
    const preview = view.els.preview;
    const previewCanvas = view.els.previewCanvas;
    const previewId = preview ? preview.id : "uiPreview";
    const overlay = preview ? createContourOverlay(preview) : null;
    const redrawSvg = createContourRenderer(previewId, model);
    const canvasContour = previewCanvas ? createCanvasContour(previewCanvas) : null;

    function redraw(needsRebuild = false) {
        const useCanvas = Boolean(canvasContour) && (model.settings.renderer !== "svg" || !preview);
        if (preview) preview.style.display = useCanvas ? "none" : "";
        if (previewCanvas) previewCanvas.style.display = useCanvas ? "" : "none";
        const shown = useCanvas ? previewCanvas : preview;
        if (!shown) return;
        const w = shown.clientWidth, h = shown.clientHeight;
        if (!w || !h) return;
        const pressed = [{ x: Math.round(w / 3), y: 0, width: Math.round(w / 3), height: h }];
        if (useCanvas) {
            canvasContour.setRects(pressed);
            canvasContour.setView({ width: w, height: h });
            canvasContour.build(previewCanvas.id, toContourArgs(model));
        } else {
            setClipRects(overlay, pressed);
            redrawSvg(needsRebuild);
        }
    }
    // switching renderer shows an element that may have been resized while hidden: rebuild its field
    const unsubscribe = model.onChange((s, keys, rebuild) => redraw(rebuild || keys.has("renderer")));

    // the field is sized to the preview, so rebuild it whenever that changes size (also runs once on observe)
    const observer = new ResizeObserver(() => redraw(true));
    if (preview) observer.observe(preview);
    if (previewCanvas) observer.observe(previewCanvas);

    if (loaded.errors.length) view.showStatus(loaded.errors[0], "error");
    else if (loaded.source === "local") view.showStatus("Loaded the settings saved on this device", "info");

    return {
        model,
        view,
        detach: () => {
            detachController();
            unsubscribe();
            observer.disconnect();
        },
    };
}

// INPUT:  none
// OUTPUT: Promise<UiModel>
// ACTION: index.html: loads saved settings so the piano contour uses them.
//         index.html then replaces its hard-coded canvasColorList / canvasSettings / canvasLevels
//         with toContourArgs(model).
export async function applyUi() {
    const model = new UiModel();
    await loadSettings(model);
    return model;
}

// Auto-start on the settings page only
if (document.getElementById("ui")) initUiPage();
