// One dismiss stack for all elements that open over the page.
// Menus, popovers, side panels, detail panels, bottom sheets and dialogs use this stack.
//
//   ns.layers.push({ el, onDismiss, modal, trapFocus, ... }) -> handle
//     handle.close({ restoreFocus = true, force }) -> removes the layer
//       and the layers opened from it. The focus returns to the opener
//       when the focus was inside the layer. If not, the focus does not move.
//       With force, the focus goes to the opener in any case.
//     handle.release() -> close({ restoreFocus: false }). The owner moves
//       the focus itself. Also: handle.isOpen(), handle.isTop(), handle.update({ ... })
//   ns.layers.top() / ns.layers.handleOf(el) / ns.layers.isOpen(el)
//   ns.layers.size() / ns.layers.closeAll(reason)
//
// This module owns the only Escape and click-outside listeners of the page:
//
//   - Escape closes only the top layer. The top layer is the one on screen.
//     A layer of a hidden view waits for its view.
//     A handler that consumes the key first keeps it. Such a handler calls
//     event.preventDefault(), for example a field that clears its text or an
//     editor that closes its suggestions.
//     Escape typed in a text field outside the top layer belongs to the field.
//   - One capture pointerdown listener. A press outside the top layers dismisses
//     each layer that closes on an outside press (`outside`, on by default unless
//     the layer is `modal` or `docked`). The dismissal goes down to the first layer
//     that contains the press, or to a modal layer.
//   - trapFocus keeps the Tab key inside the layer.
//
// onDismiss(reason, event) runs when the stack dismisses a layer. The reasons are
// "escape", "outside", "parent", "close-all" and "abort". The owner closes its UI
// in this function. The function can return false to keep the layer open.
// Otherwise, the stack removes the layer after the function returns.
//
// Options:
//   el          the root element of the layer (required). It can also be a list of
//               elements, or a function that returns one. Every element counts as
//               inside. The first element is the root. Example: the entries of ns.menu.
//   onDismiss   (reason, event) => void | false
//   opener      the element that gets the focus back (default: the focused
//               element when the layer is pushed). A press on it is not an outside press.
//   inside      more elements. A press inside them does not dismiss the layer
//               (for example a toggle button or an anchor).
//   modal       no element under the layer gets outside presses or Escape.
//   docked      a panel beside the content. An outside press does not dismiss it.
//   outside     overrides the default for outside presses.
//   escape      false: Escape does not dismiss this layer. The stack skips the layer.
//   trapFocus   the Tab key cycles the focus inside el.
//   focus       element (or () => element) that gets the focus when the layer is pushed.
//   returnFocus false: the focus does not move on close.
//   fallbackFocus element (or () => element) that gets the focus when the opener is removed.
//   signal      an AbortSignal. The layer is dismissed with "abort" when the signal aborts.
//   name        a label for the debug output of ns.layers.debug().
//
// ns.lifecycle: listener scopes that follow the visibility of a view.
//   ns.lifecycle.scope(parent?) -> { signal, listen(target, type, fn, opts),
//     add(dispose), child(), dispose(), active }
//   ns.lifecycle.enter(name) -> the scope of the view that is just shown. The previous
//     scope is disposed. ns.lifecycle.leave(name) disposes the scope when the view is
//     hidden. ns.lifecycle.current(name) -> the scope of the shown view, or null.
//     ns.lifecycle.bind(name, (scope) => ...) runs on every enter(name). It also runs
//     at once when the view is shown. A module binds its global listeners
//     here, with scope.listen(). The listeners last while the view is shown.
//   Names: "traces", "logs" and "metrics" (app_obs_page.js and the trace page).
//   A page shows one view for as long as the page exists. The scope is never left.
//   The names "explorer:browse", "explorer:graph", "explorer:storage" and
//   "explorer:functions" belong to app_explorer_shell.js. The modes alternate in the page.
//   Listeners bound with { signal: scope.signal } end with the scope.
//   When a view changes, no listener is added.

import { dom } from "./app_dom.js";

const { $$ } = dom;

// ------------------------------------------------------------ lifecycle

function scope(parent = null) {
  const controller = new AbortController();
  const disposers = [];
  const signal = controller.signal;
  const api = {
    signal,
    get active() { return !signal.aborted; },
    listen(target, type, fn, options) {
      if (!target || signal.aborted) return api;
      const opts = typeof options === "boolean" ? { capture: options } : { ...(options || {}) };
      target.addEventListener(type, fn, { ...opts, signal });
      return api;
    },
    add(dispose) {
      if (typeof dispose !== "function") return api;
      if (signal.aborted) dispose();
      else disposers.push(dispose);
      return api;
    },
    child() {
      return scope(signal);
    },
    dispose() {
      if (signal.aborted) return;
      controller.abort();
      while (disposers.length) {
        try { disposers.pop()(); } catch (error) { console.error(error); }
      }
    },
  };
  if (parent) {
    const parentSignal = parent.signal || parent;
    if (parentSignal.aborted) api.dispose();
    else parentSignal.addEventListener("abort", () => api.dispose(), { once: true, signal });
  }
  return api;
}

const views = new Map();
const binders = new Map();
function enter(name) {
  views.get(name)?.dispose();
  const next = scope();
  views.set(name, next);
  for (const bindFn of binders.get(name) || []) {
    try { bindFn(next); } catch (error) { console.error(error); }
  }
  return next;
}
// bindFn(scope) runs each time the view is shown. If the view is already shown, it runs now.
function bind(name, bindFn) {
  if (typeof bindFn !== "function") return;
  if (!binders.has(name)) binders.set(name, []);
  binders.get(name).push(bindFn);
  const shown = current(name);
  if (shown) bindFn(shown);
}
function leave(name) {
  const current = views.get(name);
  views.delete(name);
  current?.dispose();
}
function current(name) {
  const found = views.get(name);
  return found && found.active ? found : null;
}

export const lifecycle = Object.freeze({ scope, enter, leave, current, bind });

// --------------------------------------------------------------- layers

const stack = [];
let uid = 0;

const FOCUSABLE = "a[href], area[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex='-1']), [contenteditable=''], [contenteditable='true']";

const resolve = (value) => (typeof value === "function" ? value() : value);

// On screen: connected and laid out. A layer of a hidden view or a closed dialog waits.
function rendered(el) {
  return !!el && el.isConnected && el.getClientRects().length > 0;
}

function focusable(node) {
  return node instanceof HTMLElement && node !== document.body && node.isConnected && !node.disabled
    && (node.matches(FOCUSABLE) || node.hasAttribute("tabindex") || node instanceof HTMLDialogElement)
    && !node.closest("[hidden], [inert]") && node.getClientRects().length > 0;
}

function tabbables(root) {
  return [...$$(FOCUSABLE, root)].filter((node) => focusable(node) && node.tabIndex >= 0);
}

function textField(node) {
  if (!(node instanceof Element)) return false;
  if (node.isContentEditable) return true;
  if (node instanceof HTMLTextAreaElement) return true;
  if (!(node instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"].includes(node.type);
}

// Every element of a layer. The el option can be a list or a function that returns one.
function elementsOf(layer) {
  const value = layer.elFn ? layer.elFn() : layer.root;
  return (Array.isArray(value) ? value : [value]).filter((node) => node instanceof Element);
}

function holds(layer, node) {
  return node instanceof Node && elementsOf(layer).some((el) => el.contains(node));
}

function shown(layer) {
  return elementsOf(layer).some(rendered);
}

function inside(layer, node) {
  if (!(node instanceof Node)) return false;
  if (holds(layer, node)) return true;
  if (layer.opener instanceof Node && layer.opener.contains(node)) return true;
  return layer.inside.some((other) => other instanceof Node && other.contains(node));
}

function insideAny(node) {
  return stack.some((layer) => holds(layer, node));
}

function index(layer) {
  return stack.indexOf(layer);
}

function prune() {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (!elementsOf(stack[i]).some((el) => el.isConnected)) remove(stack[i], { restoreFocus: false });
  }
}

// Layers opened from this one are removed with it. Their element or opener is inside this layer.
function children(layer) {
  const at = index(layer);
  return stack.slice(at + 1).filter((other) => holds(layer, other.el) || holds(layer, other.opener));
}

// force: the opener gets the focus wherever the focus is now. A native dialog
// gives the focus back to the element that had it before the dialog opened by itself.
function restoreFocusFrom(layer, force = false) {
  if (layer.returnFocus === false) return;
  const active = document.activeElement;
  const lost = !active || active === document.body || !active.isConnected || holds(layer, active) || !focusable(active);
  if (!lost && !force) return;
  const fallback = resolve(layer.fallbackFocus);
  const target = [layer.opener, ...(Array.isArray(fallback) ? fallback : [fallback])].find(focusable);
  target?.focus({ preventScroll: true });
}

function remove(layer, { restoreFocus = true, force = false } = {}) {
  const at = index(layer);
  if (at < 0) return;
  for (const child of children(layer).reverse()) dismiss(child, "parent", null);
  stack.splice(index(layer), 1);
  layer.unlisten?.();
  if (restoreFocus) restoreFocusFrom(layer, force);
}

// The stack asks the owner to close the layer.
function dismiss(layer, reason, event) {
  if (index(layer) < 0) return false;
  let kept = false;
  if (typeof layer.onDismiss === "function") {
    try { kept = layer.onDismiss(reason, event) === false; } catch (error) { console.error(error); }
  }
  if (kept) return false;
  remove(layer);
  return true;
}

function handleFor(layer) {
  return layer.handle;
}

function configure(layer, options) {
  const has = (key) => Object.prototype.hasOwnProperty.call(options, key);
  if (has("onDismiss")) layer.onDismiss = options.onDismiss;
  if (has("modal")) layer.modal = !!options.modal;
  if (has("docked")) layer.docked = !!options.docked;
  if (has("trapFocus")) layer.trapFocus = !!options.trapFocus;
  if (has("escape")) layer.escape = options.escape !== false;
  if (has("returnFocus")) layer.returnFocus = options.returnFocus;
  if (has("fallbackFocus")) layer.fallbackFocus = options.fallbackFocus;
  if (has("inside")) layer.inside = (Array.isArray(options.inside) ? options.inside : [options.inside]).filter(Boolean);
  if (has("opener") && options.opener) layer.opener = options.opener;
  if (has("name")) layer.name = String(options.name || "");
  layer.outside = has("outside") ? !!options.outside : (layer.outsideSet ? layer.outside : !(layer.modal || layer.docked));
  if (has("outside")) layer.outsideSet = true;
}

function push(options = {}) {
  const elFn = typeof options.el === "function" ? options.el : Array.isArray(options.el) ? () => options.el : null;
  const first = elFn ? (Array.isArray(elFn()) ? elFn()[0] : elFn()) : options.el;
  const el = first instanceof Element ? first : null;
  if (!el) throw new TypeError("ns.layers.push: el must be an element (or a list / function of elements)");
  prune();
  const existing = elFn ? null : stack.find((layer) => layer.root === el && !layer.elFn);
  if (existing) {
    configure(existing, options);
    return existing.handle;
  }
  const active = document.activeElement;
  const layer = {
    id: ++uid,
    root: el,
    elFn,
    get el() { return elementsOf(this)[0] || this.root; },
    onDismiss: null,
    modal: false,
    docked: false,
    trapFocus: false,
    escape: true,
    outside: true,
    outsideSet: false,
    returnFocus: true,
    fallbackFocus: null,
    inside: [],
    opener: null,
    name: "",
    unlisten: null,
  };
  // The focus returns to the element that had it when the layer opened.
  // The focus does not go to an element of the layer itself.
  if (active instanceof HTMLElement && active !== document.body && !holds(layer, active)) layer.opener = active;
  configure(layer, options);
  if (options.signal) {
    const signal = options.signal;
    if (signal.aborted) return closedHandle(el);
    const onAbort = () => dismiss(layer, "abort", null);
    signal.addEventListener("abort", onAbort, { once: true });
    layer.unlisten = () => signal.removeEventListener("abort", onAbort);
  }
  layer.handle = Object.freeze({
    id: layer.id,
    el,
    close: (opts) => remove(layer, opts || {}),
    release: () => remove(layer, { restoreFocus: false }),
    dismiss: (reason = "close") => dismiss(layer, reason, null),
    isOpen: () => index(layer) >= 0,
    isTop: () => topLayer() === layer,
    update: (opts) => { if (index(layer) >= 0) configure(layer, opts || {}); },
  });
  stack.push(layer);
  const focus = resolve(options.focus);
  if (focusable(focus)) focus.focus({ preventScroll: true });
  return layer.handle;
}

function closedHandle(el) {
  return Object.freeze({ id: 0, el, close() {}, release() {}, dismiss() { return false; }, isOpen: () => false, isTop: () => false, update() {} });
}

// The top layer on screen. An option limits the search to the top layer that takes Escape.
function topLayer(filter = null) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const layer = stack[i];
    if (!shown(layer)) continue;
    if (filter && !filter(layer)) {
      if (layer.modal) return null;
      continue;
    }
    return layer;
  }
  return null;
}

function onKeydown(event) {
  if (!stack.length) return;
  if (event.key === "Tab") {
    trap(event);
    return;
  }
  if (event.key !== "Escape" && event.key !== "Esc") return;
  if (event.defaultPrevented || event.isComposing) return;
  prune();
  const layer = topLayer((candidate) => candidate.escape);
  if (!layer) return;
  const target = event.target instanceof Element ? event.target : null;
  // Escape typed in a field of the page, outside any layer, belongs to the field.
  if (target && textField(target) && !insideAny(target)) return;
  event.preventDefault();
  dismiss(layer, "escape", event);
}

function trap(event) {
  const layer = topLayer();
  if (!layer || !layer.trapFocus) return;
  const items = tabbables(layer.el);
  const active = document.activeElement;
  if (!items.length) {
    event.preventDefault();
    if (layer.el instanceof HTMLElement) {
      if (!layer.el.hasAttribute("tabindex")) layer.el.tabIndex = -1;
      layer.el.focus({ preventScroll: true });
    }
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (!holds(layer, active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  } else if (event.shiftKey && (active === first || active === layer.el)) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function onPointerdown(event) {
  if (!stack.length) return;
  if (event.button != null && event.button > 0) return;
  prune();
  const target = event.target;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const layer = stack[i];
    if (!layer || !shown(layer)) continue;
    if (inside(layer, target)) return;
    if (layer.outside) dismiss(layer, "outside", event);
    if (layer.modal) {
      // The page under a modal layer cannot be reached. The focus stays inside the layer.
      if (index(layer) >= 0) event.preventDefault();
      return;
    }
  }
}

function top() {
  const layer = topLayer();
  return layer ? handleFor(layer) : null;
}

function handleOf(el) {
  return stack.find((layer) => layer.root === el || (layer.elFn && holds(layer, el) && layer.el === el))?.handle || null;
}

function isOpen(el) {
  return !!handleOf(el);
}

function closeAll(reason = "close-all") {
  for (const layer of [...stack].reverse()) dismiss(layer, reason, null);
}

function debug() {
  return stack.map((layer) => ({ id: layer.id, name: layer.name, modal: layer.modal, docked: layer.docked, outside: layer.outside, shown: shown(layer) }));
}

document.addEventListener("keydown", onKeydown);
document.addEventListener("pointerdown", onPointerdown, true);

// The open modal dialogs, bottom first. app_ui_dialog.js adds and removes its own dialogs.
// The page outside a modal dialog is inert. A floating element (menu, popover, tip, copy fallback) mounts in the top dialog: host().
const modals = [];
const modalOpened = (dialog) => { modals.push(dialog); };
const modalClosed = (dialog) => {
  const index = modals.indexOf(dialog);
  if (index >= 0) modals.splice(index, 1);
  return index >= 0;
};
const host = () => modals[modals.length - 1] || document.body;

export const layers = Object.freeze({ push, top, handleOf, isOpen, closeAll, size: () => stack.length, debug, host, modalOpened, modalClosed });
