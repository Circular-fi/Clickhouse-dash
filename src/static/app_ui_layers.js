(() => {
  "use strict";

  // One dismiss stack for everything that opens over the page: menus,
  // popovers, side and detail panels, bottom sheets and dialogs.
  //
  //   ns.layers.push({ el, onDismiss, modal, trapFocus, ... }) -> handle
  //     handle.close({ restoreFocus = true, force }) -> takes the layer off
  //       (and the layers opened from it); the focus goes back to the opener
  //       when it was inside the layer (or nowhere; force: in any case)
  //     handle.release() -> close({ restoreFocus: false }) (the owner moves
  //       the focus itself), handle.isOpen(), handle.isTop(), handle.update({ ... })
  //   ns.layers.top() / ns.layers.handleOf(el) / ns.layers.isOpen(el)
  //   ns.layers.size() / ns.layers.closeAll(reason)
  //
  // The module owns the page's only Escape and click-outside listeners:
  //   - Escape closes the top layer only (the top one on screen: a layer of a
  //     hidden view waits for its view). A handler that consumed the key
  //     first (event.preventDefault(), e.g. a field clearing its text or an
  //     editor closing its suggestions) keeps it; Escape typed in a text
  //     field outside the top layer stays the field's.
  //   - One capture pointerdown listener: a press outside the top layers
  //     dismisses each of them that closes on an outside press (`outside`,
  //     on by default unless the layer is `modal` or `docked`), down to the
  //     first layer the press is inside or a modal one.
  //   - trapFocus keeps Tab inside the layer.
  // onDismiss(reason, event) runs when the stack dismisses a layer ("escape",
  // "outside", "parent", "close-all", "abort"); the owner closes its UI
  // there. It may return false to stay open; otherwise the layer is taken
  // off once it returns.
  //
  // Options:
  //   el          the layer's root element (required), or a list of
  //               elements / a function returning one (every element counts
  //               as inside; the first is the root): ns.menu's entries
  //   onDismiss   (reason, event) => void | false
  //   opener      the element the focus returns to (default: the focused
  //               element when pushed); a press on it is not "outside"
  //   inside      more elements a press inside does not dismiss (a toggle
  //               button, an anchor)
  //   modal       nothing under the layer takes outside presses or Escape
  //   docked      a panel beside the content (not dismissed by outside presses)
  //   outside     override the outside-press default
  //   escape      false: Escape does not dismiss this layer (it is skipped)
  //   trapFocus   Tab cycles inside el
  //   focus       element (or () => element) focused once pushed
  //   returnFocus false: never move the focus on close
  //   fallbackFocus element (or () => element) when the opener is gone
  //   signal      an AbortSignal: the layer is dismissed ("abort") when it aborts
  //   name        a label for debugging (ns.layers.debug())
  //
  // ns.lifecycle: listener scopes bound to a view's visibility.
  //   ns.lifecycle.scope(parent?) -> { signal, listen(target, type, fn, opts),
  //     add(dispose), child(), dispose(), active }
  //   ns.lifecycle.enter(name) -> the scope of a view just shown (the previous
  //     one is disposed); ns.lifecycle.leave(name) disposes it when the view is
  //     hidden; ns.lifecycle.current(name) -> the shown view's scope or null;
  //     ns.lifecycle.bind(name, (scope) => ...) runs on every enter(name) (and
  //     at once when the view shows): a module binds its global listeners
  //     there, with scope.listen(), and they last while the view shows.
  //   Names: "traces", "logs", "metrics" (app_obs_page.js), and
  //   "explorer:browse", "explorer:graph", "explorer:storage",
  //   "explorer:functions" (app_explorer.js).
  //   Listeners bound with { signal: scope.signal } go away with the scope:
  //   switching views never adds listeners.

  window.ChDash = window.ChDash || {};
  const ns = window.ChDash;
  if (ns.layers) return;
  const { $$ } = ns.dom;

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
  // bindFn(scope) runs each time the view is shown (now, when it shows).
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

  ns.lifecycle = Object.freeze({ scope, enter, leave, current, bind });

  // --------------------------------------------------------------- layers

  const stack = [];
  let uid = 0;

  const FOCUSABLE = "a[href], area[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex='-1']), [contenteditable=''], [contenteditable='true']";

  const resolve = (value) => (typeof value === "function" ? value() : value);

  // On screen: connected and laid out (a layer of a hidden view, or a closed
  // dialog, waits).
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

  // Every element of a layer (el may be a list, or a function returning one).
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

  // Layers opened from this one (their element or opener is inside it) go
  // with it.
  function children(layer) {
    const at = index(layer);
    return stack.slice(at + 1).filter((other) => holds(layer, other.el) || holds(layer, other.opener));
  }

  // force: the opener gets the focus wherever it is now (a native dialog
  // gives it back to the element focused before it opened by itself).
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

  // The stack asks the owner to close.
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
    // The focus comes back to what had it when the layer opened (not to an
    // element of the layer itself).
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

  // The top layer on screen, optionally the top one taking Escape.
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
    // Escape typed in a field of the page (not in a layer) is the field's.
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
        // The page under a modal layer is out of reach: the focus stays in it.
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

  ns.layers = Object.freeze({ push, top, handleOf, isOpen, closeAll, size: () => stack.length, debug });
})();
