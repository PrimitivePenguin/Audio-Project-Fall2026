// ui-controller.js — CONTROLLER
// The user changes things in the View; this file listens to those events,
// turns DOM values into model values, and calls the Model.
// It never edits the DOM itself: Model emits -> View re-renders.

import { hexToRgb, saveSettings } from "./ui-model.js";

// INPUT:  model: UiModel; view: from createUiView
// OUTPUT: detach function (removes every listener)
// ACTION: wires all inputs:
//   "input"  on sliders (#res, #numLevels, #noise, #tension, #lineWidth) -> handle(model.update({...}))
//   "change" on #curveType, radio[name=points], #offColorToggle          -> handle(model.update({...}))
//   stop lists: one delegated listener per list (rows are added/removed) -> onStopEvent
//   #addStop / #addOffStop click                                         -> model.addStop(list)
//   #saveUi click  -> onSave;  #resetUi click -> model.reset()
//   model.onChange(...)    -> view.render(settings)
export function attachUiController(model, view) {
    // TODO
}

// INPUT:  e: input/click event inside a [data-list] container; model
// OUTPUT: none
// ACTION: row = e.target.closest("[data-index]"), list = row.closest("[data-list]").dataset.list
//         range  -> update that stop's pos (+e.target.value)
//         color  -> update that stop's rgb (hexToRgb(e.target.value))
//         delete -> model.removeStop(list, index)
export function onStopEvent(e, model, view) {
    // TODO
}

// INPUT:  result: { ok, errors } from any model call; view
// OUTPUT: none
// ACTION: error checking + feedback: if !ok show the first error (kind "error"), else clear it
export function handle(result, view) {
    // TODO
}

// INPUT:  model; view
// OUTPUT: Promise<void>
// ACTION: disables the Save button, awaits saveSettings(model), shows "Saved" or the error, re-enables
export async function onSave(model, view) {
    // TODO
}

// INPUT:  fn; ms
// OUTPUT: throttled fn
// ACTION: for sliders that rebuild the field (res, noise) so dragging doesn't rebuild every pixel
export function throttle(fn, ms = 100) {
    // TODO
}