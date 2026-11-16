// ui-main.js — wiring
// Used by two pages:
//   settings.html -> initUiPage(): form + live preview
//   index.html    -> applyUi(): loads saved settings, draws the piano contour with them

import { UiModel, loadSettings, stopsToColorList } from "./ui_model.js";
import { createUiView } from "./ui_view.js";
import { attachUiController } from "./ui_controller.js";
import { setup } from "/contour/perlin_gen.js";
import { renderFrame } from "/contour/contour_animation.js";

// INPUT:  model: UiModel
// OUTPUT: { levels, colorlist, offcolorlist, dampening, scale, settings, res }
// ACTION: translates the model into the exact arguments renderFrame / startAnimation take.
//         offColor disabled -> offcolorlist = colorlist (no separate pressed colour).
//         The contour renderer is a second "view" of the model.
export function toContourArgs(model) {
    // TODO: const s = model.settings; const { canvasDampening, canvasScale } = model.derived(); ...
}

// INPUT:  svgId: id of the svg to draw in; model
// OUTPUT: function redraw(needsRebuild)
// ACTION: keeps one field; rebuilds it with setup(res, svgId) only when needsRebuild
//         (or the first time), then renderFrame(svgId, field, ...toContourArgs(model))
export function createContourRenderer(svgId, model) {
    // TODO
}

// INPUT:  root: #ui element (default looks it up)
// OUTPUT: Promise<{ model, view, detach }>
// ACTION: settings page: new model -> await loadSettings -> view -> controller ->
//         preview renderer subscribed to model.onChange((s, keys, rebuild) => redraw(rebuild))
export async function initUiPage(root = document.getElementById("ui")) {
    // TODO
}

// INPUT:  none
// OUTPUT: Promise<UiModel>
// ACTION: index.html: loads saved settings so the piano contour uses them.
//         index.html then replaces its hard-coded canvasColorList / canvasSettings / canvasLevels
//         with toContourArgs(model).
export async function applyUi() {
    // TODO
}

// Auto-start on the settings page only
if (document.getElementById("ui")) initUiPage();
