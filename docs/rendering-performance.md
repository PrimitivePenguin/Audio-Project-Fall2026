# Long MIDI rendering

## Diagnosis

The old Canvas bitmap was viewport-sized, but its Perlin field and every contour path were built from `pianoSpacer` (the full composition). SVG additionally allocated a full-song surface. A 16,384-step pattern at 38px/step, 1,184px height and 10px resolution sampled 7,472,520 grid points before marching squares, stitching and curve construction. Bitmap size alone did not bound CPU or path memory.

Each scroll called `setView()` and painted immediately; a note update could then call `setRects()` and paint again. The editor emitted `jukebox:notes` for every playhead redraw, even when rectangles were unchanged. Piano drawing filtered the complete note set (twice with ghosts), and Tracks rebuilt all lane buckets on every frame. Merged test fixtures also assumed pre-theme hard-coded colors and the old local Dashboard API; fixtures now follow CSS variables and current integration contracts.

## Bounded contour geometry

`ContourRegionCache` retains at most three overscanned regions. Each region covers the viewport plus approximately 192px on each edge, rounded to the selected resolution. Coordinates are aligned to the original global noise grid. `generatePerlin()` accepts optional per-field cell offsets; ordinary toolbar and preview fields retain zero offsets and their existing animation behavior.

A cached region is reused while it covers the visible rectangle; old regions use LRU eviction. Fields are temporary, and only paths remain cached. Composition dimensions never determine field/path allocation. Both Canvas and SVG use viewport-sized surfaces, translate region-local paths into current viewport coordinates and mask out the sticky keyboard/ruler and composition boundary. SVG keeps base/highlight masks and the existing opacity/color styles. Canvas keeps the same base erasure/highlight clipping logic.

There are no visible tile borders: one overscanned field supplies the whole viewport. Global noise coordinates stay identical across windows. Curves are reconstructed from locally clipped contour chains: points far outside the overscan are omitted, so tiny natural-spline/chain-end differences can occur when a region changes. No color, level count, grid resolution, curve selection, opacity or toolbar animation setting was reduced.

Region misses build synchronously **before** clearing/replacing visible paths, preventing persistent unloaded chunks. Setters and scrolling share a single queued animation-frame paint using the latest state; obsolete intermediate scroll positions never build. This is bounded work rather than a background geometry worker. Very large viewports with maximum levels/minimum resolution can still produce a cold-build long task; a geometry worker would be the next step if real-browser profiles show that case matters. Nearby cache hits do not regenerate fields or paths.

## Editor redraw and note indexing

Scroll/resize bursts mark the editor dirty and flush in its existing playhead RAF. Pointer-coordinate mapping stays synchronous; editing actions can still draw immediately. Unchanged highlight rectangles do not emit `jukebox:notes`; visible rectangles are clipped to the viewport before either renderer receives them.

`NoteRenderIndex` holds original note references in balanced interval trees per MIDI pitch, using subtree maximum note ends. Queries prune offscreen times/pitches while retaining sustained notes crossing the viewport, original draw ordering, independent overlapping IDs and track filtering. Selected gesture previews are explicitly included even when their original positions are offscreen. Ghosts remain noninteractive references. Overview lanes/pitch ranges are cached and visible notes use the same interval index.

Caches rebuild on committed edits/history, sequence replacement, track/view synchronization and external `editor.refresh()`. Sequence identity, note-array identity and count changes are also detected. Integrations changing timing in place must call the existing `editor.refresh()` hook. No rendering cache changes canonical note data, track order, PPQ, MIDI export or audio timing.

## Large MIDI import

The benchmark also identified an independent stall inside the existing MIDI parsing pipeline. `MidiIO.parseAsync()` uses `/js/midi-import-worker.js` for files at least 128KiB when Workers are supported. The worker loads the same bundled library, `NoteSequence` and `MidiIO`, returns validated canonical JSON, and never imports an engine or creates audio. The main thread rehydrates notes/getters and commits through the existing `engine.importMidiSequence()` only after validation and the current import-token check.

A new import, Remove Imported MIDI, New Sequence or pagehide terminates obsolete workers. Small files, unsupported Workers and blocked worker assets use the original synchronous parser. Public synchronous `parse()` / `importInto()` APIs remain intact. Worker use does not shorten total decoding time; it moves that CPU cost off the UI thread. Main-thread hydration/model insertion remains proportional to note count. No third-party library was edited.

## Reproducible measurements

Run:

```sh
node --expose-gc src/test/performance/render-benchmark.cjs
node src/test/frontend/render-performance-tests.js
```

Node 26 CPU sample, actual default-style 10px grid, 10 levels, noise 0.35/scale 0.21, Catmull-Rom tension 1, height 1.5. Noise is randomly seeded each process; timings vary. Canvas uses a no-op Path2D implementation, so these numbers exclude browser/GPU raster costs. The original 16,384-step full build was deliberately skipped to avoid excessive allocation; its grid-point count is calculated, not a timing result.

| Operation | Before | After |
|---|---:|---:|
| 1,024-step full contour build | 331.54 ms / 468,360 grid points | viewport region: 13,332 points |
| Canvas region cold build at far timeline position | full-song geometry | 10.54 ms |
| SVG region cold build | full-song geometry | 14.01 ms |
| Nearby region-cache lookup, Canvas / SVG | no region cache | 0.0035 / 0.0006 ms |
| 50,000-note full filter + lane rebuild vs viewport query | 14.113 ms | 0.013 ms |
| 50,000-note index construction | — | 21.34 ms, once per invalidation |

The contour comparison uses a 900×600 viewport with overscan; the old whole-song allocation uses the fixed 1,184px piano height. Different surfaces are intentional: the improvement is avoiding full-composition work. Note-query timings are not complete renderer timings.

After-only binary import and fake-DOM drawing measurements (no browser painting):

| Notes | Steps | Parse | Parse + first render | Subsequent Piano / Tracks draw |
|---:|---:|---:|---:|---:|
| 100 | 16 | 1.13 ms | 1.91 ms | 0.181 / 0.117 ms |
| 1,000 | 1,024 | 4.45 ms | 5.65 ms | 0.135 / 0.079 ms |
| 10,000 | 16,384 | 38.82 ms | 47.36 ms | 0.135 / 0.082 ms |
| 50,000 | 16,384 | 3,136.30 ms | 3,187.38 ms | 0.198 / 0.131 ms |

These import numbers deliberately call synchronous `parse()` to expose remaining decoder CPU, not to claim worker/browser responsiveness measurements. Browser FPS, audible playback, GPU/path memory and long-task frequency were not measured; no browser automation runtime is installed here. Dense overlapping notes all visible at once still require drawing every visible note; gesture/history snapshots also remain proportional to composition size.

## Manual browser verification

1. Import representative 100/1,000/10,000/50,000-note files at short and 1,024/16,384-step lengths. Record Network (worker assets), Performance and Memory profiles. Separate worker decoding, main-thread model commit, contour cold build and steady scrolling; compare browser long tasks/frame times, not Node figures.
2. Test both Canvas and SVG in appearance settings, every curve, custom color/off-color palettes and opacity, minimum grid resolution/maximum levels. Keep the animated toolbar enabled. Check short-song boundaries and long sustained notes.
3. Scroll rapidly far right/left and vertically; reverse direction repeatedly. Confirm full decorative coverage after each frame, correct note highlighting, no ruler/key overpainting, and no seams. Resize, change browser zoom and test DPR 1/2; inspect that surfaces remain viewport-sized and heap settles rather than growing with timeline distance.
4. Play from the cursor through follow midpoint locking, manual interruption/rearming, custom loop wraps, Pause/Resume and Stop. Listen to synth, drums and samples while scrolling; audio timing must remain independent. Confirm one scheduler and one editor RAF chain.
5. Create/move/resize/group-edit/delete/copy/paste, Undo/Redo and ghost notes; switch/reorder/delete tracks and import/save/load projects. Verify index invalidation and unchanged note IDs/timing/export. Start a second large import or New Sequence while decoding; the stale result must never commit.
6. Block Workers via browser policy and verify graceful synchronous import fallback/error handling. Expect long decoding to block in that fallback; do not treat it as equivalent to the worker path.

## Changed files and validation

Production changes: `index.html`, `css/sequencer.css` (comments only), `contour/canvas_overlay.js`, `contour/contour.js`, `contour/perlin_gen.js`, new `contour/region_cache.js` and `contour/svg_overlay.js`, `js/PianoRollEditor.js`, `js/sequencer-ui.js`, `js/midi-io.js`, new `js/midi-import-worker.js`.

Test changes: `editor-test-support.js`, `editor-tests.js`, `integration-tests.js`, `multitrack-tests.js`, `navigation-follow-tests.js`, `sequencer-tests.js`, `track-management-tests.js`, `workspace-tests.js`, new `render-performance-tests.js`, and new `src/test/performance/render-benchmark.cjs`. Documentation: this file and `docs/sequencer-api.md`.

Validation: 257 frontend tests passed, 28 Spring Boot tests passed, syntax checks passed for 41 JavaScript/CJS files, and `git diff --check` passed. Real browser/audio verification remains manual. The checkout was already `main`; no branch, commit, pull, reset, push or PR actions were performed.
