import { onChange, pressed } from "./press_state.js";

let overlayCount = 0;

// INPUT:  container: Element the overlay should cover, OR an existing <svg>
//         that is already positioned over the area (it is filled in place)
// OUTPUT: { svg, base, hi, clip }
// ACTION: sets up an SVG with a normal layer, a highlight layer, and its
//         own clipPath. The highlight layer only shows inside the clip rects.
export function createContourOverlay(container) {
  const NS = "http://www.w3.org/2000/svg";
  const n = ++overlayCount;
  const clipId = `pressed-${n}`;   // ids must be unique on the page
  const maskId = `pressed-hole-${n}`;
  const isSvg = container instanceof SVGSVGElement;
  const svg = isSvg ? container : document.createElementNS(NS, "svg");
  svg.classList.add("contour-overlay");
  svg.innerHTML = `
    <defs>
      <clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"></clipPath>
      <mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
        <rect x="0" y="0" width="100%" height="100%" fill="white"></rect>
      </mask>
    </defs>
    <g class="base" mask="url(#${maskId})"></g>
    <g class="hi" clip-path="url(#${clipId})"></g>`;
  if (!isSvg) container.appendChild(svg);
  return {
    svg,
    base: svg.querySelector(".base"),
    hi: svg.querySelector(".hi"),
    clip: svg.querySelector("clipPath"),
    mask: svg.querySelector("mask"),
  };
}

// INPUT:  overlay: from createContourOverlay,
//         rects: [{ x, y, width, height }] in the overlay's own coordinates
// OUTPUT: none
// ACTION: replaces the areas from the last call (e.g. the piano roll's notes):
//         the hi layer shows inside them and the base layer is cut out of them,
//         so only the highlight colours are drawn there. Rects added by
//         attachSurface presses are kept.
//
//         Firefox does not always repaint a layer when only the children of
//         its <mask>/<clipPath> change (a deleted note left a hole in the base
//         contour). So each call builds a new clipPath and mask under new ids
//         and points the layers at them; a changed url(#id) always repaints.
let areaVersion = 0;
export function setClipRects(overlay, rects) {
  const key = JSON.stringify(rects);
  if (overlay.lastRects === key) return;   // unchanged: skip the DOM work
  overlay.lastRects = key;

  const v = ++areaVersion;
  const clip = overlay.clip.cloneNode(false);
  const mask = overlay.mask.cloneNode(false);
  clip.id = `${overlay.clip.id.replace(/_v\d+$/, "")}_v${v}`;
  mask.id = `${overlay.mask.id.replace(/_v\d+$/, "")}_v${v}`;
  // keep everything except the previous areas: press rects in the clip,
  // the full white rect in the mask
  for (const r of overlay.clip.querySelectorAll("rect:not([data-area])")) clip.appendChild(r);
  for (const r of overlay.mask.querySelectorAll("rect:not([data-area])")) mask.appendChild(r);
  overlay.clip.replaceWith(clip);
  overlay.mask.replaceWith(mask);
  overlay.clip = clip;
  overlay.mask = mask;
  overlay.hi.setAttribute("clip-path", `url(#${clip.id})`);
  overlay.base.setAttribute("mask", `url(#${mask.id})`);

  for (const { x, y, width, height } of rects) {
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", x);
    r.setAttribute("y", y);
    r.setAttribute("width", width);
    r.setAttribute("height", height);
    r.dataset.area = "";
    overlay.clip.appendChild(r);
    const hole = r.cloneNode();
    hole.setAttribute("fill", "black");   // black in a mask = hidden
    overlay.mask.appendChild(hole);
  }
}

// INPUT:  root: Element that owns it, rect: () => DOMRect (screen coordinates)
// OUTPUT: a stand-in "element" for things drawn on a canvas (e.g. piano keys)
//         that can be passed to press() like a real element
export function virtualTarget(root, rect) {
  return { virtualRoot: root, getBoundingClientRect: rect };
}

// INPUT:  root: Element (piano or toolbar), options { mode, overlay }
//         mode: "plain" | "contour" | "both"; overlay: from createContourOverlay, or null
// OUTPUT: function that detaches the surface
// ACTION: reacts to presses of elements inside root. Falls back to "plain"
//         when there is no overlay
export function attachSurface(root, { mode = "plain", overlay = null } = {}) {
  const useContour = overlay && (mode === "contour" || mode === "both");
  const usePlain = !useContour || mode === "both";

  // real elements: inside root; virtual targets: created for this root
  const owns = el => el instanceof Node ? root.contains(el) : el?.virtualRoot === root;

  function addRect(id, el) {
    const k = el.getBoundingClientRect(), s = overlay.svg.getBoundingClientRect();
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", k.left - s.left);
    r.setAttribute("y", k.top - s.top);
    r.setAttribute("width", k.width);
    r.setAttribute("height", k.height);
    r.dataset.id = id;
    overlay.clip.appendChild(r);
  }

  const off = onChange((type, id, el) => {
    if (!owns(el)) return;  // pressed somewhere else
    if (usePlain && el instanceof Element) el.classList.toggle("is-pressed", type === "press");
    if (useContour) {
      if (type === "press") addRect(id, el);
      else overlay.clip.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
    }
  });

  // keep rects aligned when the layout changes
  const ro = new ResizeObserver(() => {
    if (!useContour) return;
    overlay.clip.querySelectorAll("rect[data-id]").forEach(r => r.remove());
    for (const [id, el] of pressed) if (owns(el)) addRect(id, el);
  });
  ro.observe(root);

  return () => { off(); ro.disconnect(); };
}
