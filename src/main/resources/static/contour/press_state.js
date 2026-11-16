
const listeners = new Set();

// INPUT: id: string (unique / key/button), el: element
// OUTPUT: none
// ACTION: records and notifies every surface
export const pressed = new Map(); // id -> element

export function press(id, el) {
    if (pressed.has(id)) return;
    pressed.set(id, el);
    listeners.forEach(f =>f("press", id, el));
}

export function release(id) {
    const el = pressed.get(id);
    if (!el) return;
    pressed.delete(id);
    listeners.forEach(f =>f("release", id, el));
}

// INPUT:  f: function(type, id, el)
// OUTPUT: function that unsubscribes
export function onChange(f) {
  listeners.add(f);
  return () => listeners.delete(f);
}


