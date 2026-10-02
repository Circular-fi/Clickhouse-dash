(() => {
  "use strict";

  // Popovers and tooltips: one placement, one tooltip, one popover shell.
  //
  //   place(anchor, el, { side, align, offset, margin, flip }) -> { left, top, side }
  //     Puts the fixed element `el` beside `anchor` (an element, a rect or a
  //     point { x, y }): side "bottom" (default) | "top" | "right" | "left",
  //     align "start" | "center" (default) | "end", `offset` px away (6),
  //     flipped to the other side when it does not fit, then kept `margin`
  //     px (8) inside the viewport.
  //
  //   tip(el, content, { selector, side, align, offset, html, className }) -> { show(target), hide(), destroy() }
  //     A hover / focus tooltip on el (or, with `selector`, on each matching
  //     descendant of el). content: text, a Node, or (target) => text | Node
  //     | null (html: true for markup the caller escaped). One .uiTip
  //     (role=tooltip) for the page, named by the target's
  //     aria-describedby while shown; Escape hides it.
  //
  //   follow({ className, side, align, offset, host }) -> { el, show(point | anchor, content, opts), hide(), destroy() }
  //     A tooltip that follows the pointer over a canvas or a chart (it is
  //     not announced: role=tooltip, no live region).
  //
  //   open(anchor, content, { className, label, role, side, align, offset,
  //        onClose, focus, closeOnScroll, trapFocus, returnFocus, fallbackFocus })
  //     -> { el, close(), place(), update(content), isOpen() }
  //     A click-opened popover (.uiPopover, role=dialog by default) beside
  //     its anchor: an ns.layers layer (Escape, a press outside, focus back
  //     to the anchor), closed when the page scrolls it away or resizes.
  //
  //   flash(anchor, text = "Copied") -> a short confirmation beside a button
  //     (role=status: it is the result of the user's own action).

  window.ChDash = window.ChDash || {};
  const ns = window.ChDash;
  if (ns.popover) return;

  const MARGIN = 8;
  let uid = 0;

  // ------------------------------------------------------------ placement

  function rectOf(anchor) {
    if (!anchor) return null;
    if (typeof anchor.getBoundingClientRect === "function") return anchor.getBoundingClientRect();
    if (Number.isFinite(anchor.left) && Number.isFinite(anchor.top)) {
      const right = Number.isFinite(anchor.right) ? anchor.right : anchor.left + (anchor.width || 0);
      const bottom = Number.isFinite(anchor.bottom) ? anchor.bottom : anchor.top + (anchor.height || 0);
      return { left: anchor.left, top: anchor.top, right, bottom, width: right - anchor.left, height: bottom - anchor.top };
    }
    if (Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) return { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y, width: 0, height: 0 };
    return null;
  }

  const OPPOSITE = { top: "bottom", bottom: "top", left: "right", right: "left" };

  function place(anchor, el, { side = "bottom", align = "center", offset = 6, margin = MARGIN, flip = true } = {}) {
    const box = rectOf(anchor);
    if (!box || !el) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const vertical = side === "top" || side === "bottom";
    const fits = (s) => {
      if (s === "bottom") return box.bottom + offset + height <= vh - margin;
      if (s === "top") return box.top - offset - height >= margin;
      if (s === "right") return box.right + offset + width <= vw - margin;
      return box.left - offset - width >= margin;
    };
    const room = (s) => (s === "bottom" ? vh - box.bottom : s === "top" ? box.top : s === "right" ? vw - box.right : box.left);
    let at = side in OPPOSITE ? side : "bottom";
    if (flip && !fits(at) && (fits(OPPOSITE[at]) || room(OPPOSITE[at]) > room(at))) at = OPPOSITE[at];
    let left;
    let top;
    if (vertical) {
      top = at === "bottom" ? box.bottom + offset : box.top - offset - height;
      left = align === "start" ? box.left : align === "end" ? box.right - width : box.left + box.width / 2 - width / 2;
    } else {
      left = at === "right" ? box.right + offset : box.left - offset - width;
      top = align === "start" ? box.top : align === "end" ? box.bottom - height : box.top + box.height / 2 - height / 2;
    }
    left = Math.max(margin, Math.min(vw - width - margin, left));
    top = Math.max(margin, Math.min(vh - height - margin, top));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.dataset.side = at;
    return { left, top, side: at };
  }

  function fill(el, content, html) {
    if (content instanceof Node) el.replaceChildren(content);
    else if (html) el.innerHTML = String(content ?? "");
    else el.textContent = String(content ?? "");
  }

  // Inside a modal dialog, floating elements live in it (the top layer
  // covers the body).
  function hostFor(anchor) {
    const node = anchor instanceof Element ? anchor : null;
    return node?.closest?.("dialog[open]") || ns.dialog?.host?.() || document.body;
  }

  // ------------------------------------------------------------ tooltips

  let shared = null;
  function sharedTip() {
    if (shared && shared.isConnected) return shared;
    shared = document.createElement("div");
    shared.className = "uiTip";
    shared.id = "uiTip";
    shared.setAttribute("role", "tooltip");
    shared.hidden = true;
    document.body.appendChild(shared);
    return shared;
  }

  let shownFor = null;
  let shownScope = null;

  function describe(target, on) {
    const ids = String(target.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== "uiTip");
    if (on) ids.push("uiTip");
    if (ids.length) target.setAttribute("aria-describedby", ids.join(" "));
    else target.removeAttribute("aria-describedby");
  }

  function hideShared() {
    if (shownFor) describe(shownFor, false);
    shownFor = null;
    shownScope?.dispose();
    shownScope = null;
    if (shared) shared.hidden = true;
  }

  function tip(el, content, options = {}) {
    const { selector = "", side = "top", align = "center", offset = 6, html = false, className = "" } = options;
    if (!el) return { show() {}, hide() {}, destroy() {} };
    const scope = ns.lifecycle.scope();
    const owned = new Set();

    const targetOf = (node) => {
      if (!(node instanceof Element)) return null;
      if (!selector) return el.contains(node) ? el : null;
      const match = node.closest(selector);
      return match && el.contains(match) ? match : null;
    };

    function show(target) {
      if (!target || !target.isConnected) return;
      const value = typeof content === "function" ? content(target) : content;
      if (value == null || value === "") { if (shownFor === target) hideShared(); return; }
      const node = sharedTip();
      if (shownFor && shownFor !== target) hideShared();
      node.className = `uiTip${className ? ` ${className}` : ""}`;
      const host = hostFor(target);
      if (node.parentElement !== host) host.appendChild(node);
      fill(node, value, html);
      node.hidden = false;
      place(target, node, { side, align, offset });
      if (shownFor !== target) {
        shownFor = target;
        owned.add(target);
        describe(target, true);
        shownScope = ns.lifecycle.scope();
        // Escape hides the tip (the key goes on to the layers); so does a
        // scroll that moves the target.
        shownScope.listen(document, "keydown", (event) => { if (event.key === "Escape") hideShared(); }, true);
        shownScope.listen(window, "scroll", () => hideShared(), { capture: true, passive: true });
      }
    }

    function hide(target = null) {
      if (!shownFor || (target && target !== shownFor) || !owned.has(shownFor)) return;
      hideShared();
    }

    scope.listen(el, "pointerover", (event) => {
      if (event.pointerType === "touch") return;
      const target = targetOf(event.target);
      if (target && target !== shownFor) show(target);
    });
    scope.listen(el, "pointerout", (event) => {
      const target = targetOf(event.target);
      if (target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) hide(target);
    });
    scope.listen(el, "focusin", (event) => { const target = targetOf(event.target); if (target) show(target); });
    scope.listen(el, "focusout", (event) => { const target = targetOf(event.target); if (target) hide(target); });

    return {
      show,
      hide: () => hide(),
      destroy() {
        hide();
        scope.dispose();
      },
    };
  }

  // host: the element the tip lives in (default: the body, or the open
  // dialog); a tip in its component's own host goes away with it.
  function follow({ className = "", side = "right", align = "start", offset = 12, host = null } = {}) {
    const el = document.createElement("div");
    el.className = `uiTip${className ? ` ${className}` : ""}`;
    el.setAttribute("role", "tooltip");
    el.hidden = true;
    if (host) host.appendChild(el);
    return {
      el,
      // content undefined: keep what the caller wrote into el.
      show(at, content, opts = {}) {
        const parent = host || hostFor(at instanceof Element ? at : null);
        if (el.parentElement !== parent) parent.appendChild(el);
        if (content !== undefined) fill(el, content, opts.html === true);
        el.hidden = false;
        place(at, el, { side: opts.side || side, align: opts.align || align, offset: opts.offset ?? offset });
      },
      hide() { el.hidden = true; },
      destroy() { el.remove(); },
    };
  }

  // ------------------------------------------------------------- popovers

  function open(anchor, content, options = {}) {
    const {
      className = "", label = "", role = "dialog", side = "bottom", align = "center", offset = 6,
      onClose = null, focus = null, closeOnScroll = true, trapFocus = false, html = true,
    } = options;
    const el = document.createElement("div");
    el.className = `uiPopover${className ? ` ${className}` : ""}`;
    el.id = options.id || `uiPopover${++uid}`;
    if (role) el.setAttribute("role", role);
    if (label) el.setAttribute("aria-label", label);
    el.tabIndex = -1;
    if (content instanceof Node) el.appendChild(content);
    else if (html) el.innerHTML = String(content ?? "");
    else el.textContent = String(content ?? "");
    hostFor(anchor).appendChild(el);
    const anchorEl = anchor instanceof Element ? anchor : null;
    const scope = ns.lifecycle.scope();
    let closed = false;
    const reposition = () => place(anchor, el, { side, align, offset });
    reposition();

    const handle = {
      el,
      place: reposition,
      update(next) {
        if (next instanceof Node) el.replaceChildren(next);
        else el.innerHTML = String(next ?? "");
        reposition();
      },
      isOpen: () => !closed,
      close(opts = {}) {
        if (closed) return;
        closed = true;
        scope.dispose();
        layer.close(opts);
        el.remove();
        anchorEl?.setAttribute?.("aria-expanded", "false");
        if (typeof onClose === "function") onClose();
      },
    };
    const layer = ns.layers.push({
      el,
      name: options.name || className || "popover",
      opener: options.returnFocus || anchorEl,
      fallbackFocus: options.fallbackFocus || null,
      trapFocus,
      inside: anchorEl ? [anchorEl] : [],
      onDismiss: (reason) => { handle.close({ restoreFocus: reason !== "outside" }); },
    });
    if (anchorEl && anchorEl.hasAttribute("aria-haspopup")) anchorEl.setAttribute("aria-expanded", "true");
    if (closeOnScroll) {
      // Only a scroll that moves the anchor: the scroll event of a scroll
      // made before opening (a click bringing its button into view) arrives
      // once the popover is open, with the anchor where it already was.
      const at = () => { const box = anchorEl?.getBoundingClientRect?.(); return box ? `${Math.round(box.left)},${Math.round(box.top)}` : ""; };
      const openedAt = at();
      scope.listen(window, "scroll", (event) => {
        if (event.target instanceof Node && el.contains(event.target)) return;
        if (anchorEl && at() === openedAt) return;
        handle.close({ restoreFocus: false });
      }, { capture: true, passive: true });
      scope.listen(window, "resize", () => handle.close({ restoreFocus: false }), { passive: true });
    }
    const target = typeof focus === "function" ? focus(el) : focus;
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    return handle;
  }

  // ---------------------------------------------------------------- flash

  function flash(anchor, text = "Copied", { duration = 1200 } = {}) {
    if (!(anchor instanceof Element) || !anchor.isConnected) return;
    const el = document.createElement("div");
    el.className = "uiTip uiTip--flash";
    el.setAttribute("role", "status");
    el.style.visibility = "hidden";
    hostFor(anchor).appendChild(el);
    // The text lands in the live region after it is in the document, so it
    // is announced.
    requestAnimationFrame(() => {
      el.textContent = text;
      el.style.visibility = "";
      place(anchor, el, { side: "top", offset: 6 });
    });
    setTimeout(() => el.remove(), duration);
  }

  ns.popover = Object.freeze({ place, tip, follow, open, flash, hideTip: hideShared });
})();
