(() => {
  "use strict";
  // Menus, pickers and dropdowns: one behaviour for every popup list of the
  // app (the header host / page / theme menus, the Run and Copy split
  // menus, the run settings, the Observability pickers, the Explorer and
  // chart menus, the row context menu). Each family keeps its look (the
  // themeSelect / tracePicker / runMenu classes); this module owns:
  //  - open / close: aria-expanded on the button, the root's open / closing
  //    classes (themeSelect--open / --closing, or is-open) and the 160 ms
  //    close motion before the list is hidden;
  //  - one menu open at a time (a submenu keeps its parents open);
  //  - placement: the list stays in the viewport (shifted, flipped above the
  //    button, or capped in height); a floating menu opens in the open
  //    <dialog> that holds its anchor, since the page outside a modal
  //    dialog is inert;
  //  - keys: Down / Up / Home / End move between the items, a typed prefix
  //    jumps to the next item starting with it, Enter / Space activate,
  //    Escape closes and returns the focus to the button, Tab closes;
  //    Down / Up on the button open the list;
  //  - focus: on open the selected item (or the first) takes the focus; on
  //    close by Escape or a pick the button gets it back unless the pick
  //    moved it somewhere else (a dialog);
  //  - dismissal: ONE pointerdown listener closes what the pointer lands
  //    outside of and ONE Escape listener the top menu, for every menu
  //    (layer() below is the only code that knows that stack).
  //
  //   bind(button, menu, options)  -> handle   an action or settings menu
  //   select(selectEl, options)    -> handle   a single-choice picker over a
  //                                            hidden native <select>, its
  //                                            label in the button
  //                                            ("Status - ALL")
  //   multi(button, menu, options) -> handle   a multi-select list (stays open)
  //   split(main, toggle, menu, o) -> handle   a split button's menu
  //   context(menu, { x, y, ... }) -> handle   a menu at a point (row menu)
  //   submenu(item, list, options) -> handle   a nested menu of an item
  //   place(menu, anchor)                      viewport clamp / flip
  //   host(anchor)                             where a floating menu mounts
  //
  // handle: { open(), close({ immediate, focus }), toggle(), isOpen(),
  //           place(), refresh() (select), set(value) (select), destroy() }
  const ns = window.ChDash;
  if (!ns) return;

  const CLOSE_MS = 160;
  const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]';
  const LISTS = '[role="menu"], [role="listbox"]';
  const TEXT_FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable=""], [contenteditable="true"]';
  const MARGIN = 8;

  // ---- Dismiss layer -------------------------------------------------------
  // The stack of open menus. When the shared dismiss layer (ns.layers) is
  // there, every entry goes to it instead: this function is the one place
  // to switch. An entry is { el(): elements that count as inside,
  // onDismiss(reason: "outside" | "escape") }.
  const localLayers = (() => {
    const stack = [];
    let listening = false;
    const inside = (entry, path, target) => entry.el().some((el) => el && (path.includes(el) || (target instanceof Node && el.contains(target))));
    function onPointerDown(event) {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      for (const entry of [...stack].reverse()) {
        if (inside(entry, path, event.target)) break;
        entry.onDismiss("outside");
      }
    }
    function onKeyDown(event) {
      if (event.key !== "Escape" || !stack.length || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      stack[stack.length - 1].onDismiss("escape");
    }
    return {
      push(entry) {
        stack.push(entry);
        if (!listening) {
          listening = true;
          document.addEventListener("pointerdown", onPointerDown, true);
          document.addEventListener("keydown", onKeyDown, true);
        }
        return { release() { const at = stack.indexOf(entry); if (at >= 0) stack.splice(at, 1); } };
      },
    };
  })();

  function layer(entry) {
    const shared = ns.layers;
    if (shared && typeof shared.push === "function" && shared !== localLayers) {
      const handle = shared.push({ el: entry.el, onDismiss: entry.onDismiss });
      return { release: () => { (handle?.release || handle?.pop || handle?.remove)?.call(handle); } };
    }
    return localLayers.push(entry);
  }

  // ---- Shared state --------------------------------------------------------
  const openHandles = new Set();

  function closeOthers(handle) {
    for (const other of [...openHandles]) {
      if (other === handle || other.contains(handle.button)) continue;
      other.close({ immediate: true });
    }
  }

  const visible = (el) => !el.hidden && el.getClientRects().length > 0;
  const enabled = (el) => !el.disabled && el.getAttribute("aria-disabled") !== "true";

  function itemsOf(menu, selector = ITEMS) {
    return [...menu.querySelectorAll(selector)].filter((el) => {
      const owner = el.closest(LISTS);
      if (owner && owner !== menu && menu.contains(owner)) return false;
      if (el.matches(ITEMS) && el.querySelector('input[type="checkbox"], input[type="radio"]')) return false;
      return visible(el) && enabled(el);
    });
  }

  function selectedItem(items) {
    return items.find((el) => el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true") || null;
  }

  function focusItem(el) {
    try { el?.focus({ preventScroll: false }); } catch { /* detached */ }
  }

  // ---- Placement -----------------------------------------------------------
  // Keeps an open list in the viewport with the CSS `translate` property
  // (independent of the families' transform motion): shifted left / right,
  // flipped above the anchor when the space below is short and above is
  // larger, or capped in height (it scrolls).
  function place(menu, anchor, { flip = true, gap = 4 } = {}) {
    if (!menu || menu.hidden) return;
    menu.style.translate = "";
    menu.style.maxHeight = "";
    const vw = document.documentElement.clientWidth || window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const m = menu.getBoundingClientRect();
    if (!m.width && !m.height) return;
    let dx = 0;
    let dy = 0;
    if (m.width > vw - 2 * MARGIN) dx = MARGIN - m.left;
    else if (m.right > vw - MARGIN) dx = vw - MARGIN - m.right;
    else if (m.left < MARGIN) dx = MARGIN - m.left;
    if (m.bottom > vh - MARGIN) {
      const a = anchor ? anchor.getBoundingClientRect() : null;
      const below = vh - MARGIN - m.top;
      const above = a ? a.top - gap - MARGIN : 0;
      if (flip && a && m.top >= a.bottom - 1 && above > below) {
        const height = Math.min(m.height, above);
        dy = a.top - gap - height - m.top;
        if (height < m.height) menu.style.maxHeight = `${Math.floor(height)}px`;
      } else if (below > 0) {
        menu.style.maxHeight = `${Math.floor(Math.max(96, below))}px`;
      }
      if (menu.style.maxHeight && getComputedStyle(menu).overflowY === "visible") menu.style.overflowY = "auto";
    }
    if (dx || dy) menu.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`;
  }

  // A floating menu (context menu, submenu) mounts in the open <dialog>
  // that holds its anchor: outside a modal dialog the page is inert.
  function host(anchor) {
    const dialog = anchor instanceof Element ? anchor.closest("dialog[open]") : null;
    return dialog || document.body;
  }

  // A floating menu at a client point: fixed, clamped to the viewport,
  // opened up / left of the point when it does not fit below / right.
  function placeAt(menu, x, y) {
    const vw = document.documentElement.clientWidth || window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left = Math.max(4, Math.min(x, vw - w - 4));
    const top = y + h + 4 <= vh ? y : Math.max(4, y - h);
    menu.style.position = "fixed";
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  // ---- Keys ------------------------------------------------------------------
  function bindKeys(menu, { items, close, back = null }) {
    let typed = "";
    let typedAt = 0;
    menu.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(LISTS) && target.closest(LISTS) !== menu && menu.contains(target.closest(LISTS))) return;
      if (event.key === "Tab") { close({ immediate: true, focus: false }); return; }
      if (target?.matches(TEXT_FIELD)) return;
      const list = items();
      let at = list.indexOf(target);
      if (at < 0 && target?.closest(ITEMS)) at = list.indexOf(target.closest(ITEMS));
      const move = (index) => { event.preventDefault(); focusItem(list[(index + list.length) % list.length]); };
      if (!list.length) return;
      if (event.key === "ArrowDown") return move(at < 0 ? 0 : at + 1);
      if (event.key === "ArrowUp") return move(at < 0 ? list.length - 1 : at - 1);
      if (event.key === "Home" || event.key === "PageUp") return move(0);
      if (event.key === "End" || event.key === "PageDown") return move(list.length - 1);
      if (event.key === "ArrowLeft" && back) { event.preventDefault(); back(); return; }
      if ((event.key === "Enter" || event.key === " ") && at >= 0 && !list[at].matches("button, input, a[href], summary")) {
        event.preventDefault();
        list[at].click();
        return;
      }
      if (event.key.length === 1 && event.key !== " ") {
        const now = Date.now();
        typed = now - typedAt > 600 ? event.key.toLowerCase() : typed + event.key.toLowerCase();
        typedAt = now;
        const label = (el) => String(el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
        const start = typed.length > 1 ? Math.max(0, at) : at + 1;
        const order = [...list.slice(start), ...list.slice(0, start)];
        const hit = order.find((el) => label(el).startsWith(typed));
        if (hit) { event.preventDefault(); focusItem(hit); }
      }
    });
  }

  // ---- bind ------------------------------------------------------------------
  // options:
  //   root            element holding the open / closing classes (default:
  //                   the button's .themeSelect / .runSplit / .picker)
  //   openClass       default themeSelect--open (themeSelect roots), else is-open
  //   closingClass    default themeSelect--closing (themeSelect roots)
  //   items           selector of the list's items (default: the ARIA item roles)
  //   focus           "item" (default: the selected or first item), "first",
  //                   "menu", "none" or a function returning the element
  //   closeOnSelect   true / false; default: a pick closes, except the
  //                   menuitemcheckbox / menuitemradio items of a settings menu
  //   canOpen()       false keeps it closed (a one-option picker)
  //   onOpen()        before it shows (fill the list); onClose()
  //   trigger         false: the button's click is the caller's (it calls toggle)
  //   placement       false: CSS alone places the list
  //   inside()        more elements that count as inside (a portal)
  function bind(button, menu, options = {}) {
    if (!button || !menu) return null;
    const root = options.root !== undefined ? options.root : button.closest(".themeSelect, .runSplit, .picker");
    const themed = !!root?.classList.contains("themeSelect");
    const openClass = options.openClass ?? (themed ? "themeSelect--open" : root ? "is-open" : "");
    const closingClass = options.closingClass ?? (themed ? "themeSelect--closing" : "");
    const animate = options.animate ?? !!openClass;
    let timer = 0;
    let entry = null;

    const isOpen = () => button.getAttribute("aria-expanded") === "true";
    const items = () => itemsOf(menu, options.items || ITEMS);
    const role = menu.getAttribute("role");
    if (!button.hasAttribute("aria-haspopup")) button.setAttribute("aria-haspopup", role === "listbox" ? "listbox" : "menu");
    button.setAttribute("aria-expanded", "false");
    if (menu.id) button.setAttribute("aria-controls", menu.id);
    if (!menu.hasAttribute("tabindex")) menu.tabIndex = -1;

    const handle = {
      button, menu, root,
      isOpen,
      contains: (el) => !!el && ((root && root.contains(el)) || menu.contains(el) || button === el),
      open, close, toggle,
      place: () => place(menu, button),
      destroy: () => { close({ immediate: true }); },
    };

    function focusOnOpen(how) {
      if (how === "none") return;
      if (typeof how === "function") { focusItem(how()); return; }
      if (how === "menu") { menu.focus({ preventScroll: true }); return; }
      const list = items();
      const target = how === "last" ? list[list.length - 1] : how === "first" ? list[0] : (selectedItem(list) || list[0]);
      if (target) focusItem(target);
      else menu.focus({ preventScroll: true });
    }

    function open({ focus } = {}) {
      if (button.disabled || (options.canOpen && options.canOpen() === false)) return;
      if (isOpen()) { focusOnOpen(focus ?? options.focus ?? "item"); return; }
      closeOthers(handle);
      clearTimeout(timer);
      timer = 0;
      options.onOpen?.();
      if (closingClass) root?.classList.remove(closingClass);
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      openHandles.add(handle);
      // The closed style is laid out first, so adding the open class now
      // still runs the opening motion and the list can take the focus.
      void menu.offsetHeight;
      if (openClass) root?.classList.add(openClass);
      if (options.placement !== false) place(menu, button);
      entry = layer({
        el: () => [root || button, button, menu, ...(options.inside?.() || [])],
        onDismiss: (reason) => close({ focus: reason === "escape", reason }),
      });
      focusOnOpen(focus ?? options.focus ?? "item");
      options.onOpened?.();
    }

    // focus: true (always), false (never) or "auto" (default: only when the
    // focus was in the list and nothing else took it).
    function close({ immediate = false, focus = "auto" } = {}) {
      const wasOpen = isOpen();
      if (!wasOpen && menu.hidden) return;
      entry?.release();
      entry = null;
      openHandles.delete(handle);
      const active = document.activeElement;
      const focusWasInside = !!active && active !== button && (menu.contains(active) || !!root?.contains(active));
      button.setAttribute("aria-expanded", "false");
      clearTimeout(timer);
      const finish = () => {
        timer = 0;
        menu.hidden = true;
        menu.style.translate = "";
        menu.style.maxHeight = "";
        if (closingClass) root?.classList.remove(closingClass);
        if (openClass) root?.classList.remove(openClass);
      };
      if (immediate || !animate || menu.hidden) finish();
      else {
        if (closingClass) root?.classList.add(closingClass);
        requestAnimationFrame(() => { if (!isOpen() && openClass) root?.classList.remove(openClass); });
        timer = setTimeout(() => { if (!isOpen()) finish(); }, CLOSE_MS);
      }
      // "auto": back to the button when the focus was in the list and a
      // pick did not move it elsewhere (a dialog it opened).
      const now = document.activeElement;
      const stranded = !now || now === document.body || !now.isConnected || menu.contains(now);
      if (focus === true || (focus === "auto" && wasOpen && focusWasInside && stranded)) button.focus({ preventScroll: true });
      if (wasOpen) options.onClose?.();
    }

    function toggle() {
      if (isOpen()) close();
      else open();
    }

    if (options.trigger !== false) {
      button.addEventListener("click", (event) => {
        if (button.disabled) return;
        event.preventDefault();
        toggle();
      });
    }
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (button.disabled || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      open({ focus: event.key === "ArrowUp" ? "last" : "first" });
    });
    bindKeys(menu, { items, close: (o) => close(o) });
    menu.addEventListener("click", (event) => {
      const item = event.target instanceof Element ? event.target.closest(`${ITEMS}, button`) : null;
      if (!item || !menu.contains(item) || !enabled(item) || !isOpen()) return;
      const owner = item.closest(LISTS);
      if (owner && owner !== menu && menu.contains(owner)) return;
      if (item.getAttribute("aria-haspopup") && item.getAttribute("aria-haspopup") !== "false") return;
      const keep = options.closeOnSelect === false
        || (options.closeOnSelect !== true && /^menuitem(checkbox|radio)$/.test(item.getAttribute("role") || ""))
        || (options.closeOnSelect !== true && !item.matches(ITEMS));
      if (!keep) close({ focus: "auto" });
    });
    return handle;
  }

  // ---- select ----------------------------------------------------------------
  // A single-choice picker over a native <select> (the data source: hidden,
  // tabindex -1, aria-hidden). The button reads "<label> - <option>"
  // (data-field-label on the select, or options.label). It adopts the
  // markup a page ships (root .tracePicker around the select, its button
  // and list) or builds it. A pick sets the select's value, fires its
  // change event and calls onChange(value). Mutations of the select (new
  // options, disabled) refresh it; so does a "tracepicker-refresh" event.
  //   options: { label, className, onChange(value), disableWhenEmpty }
  function select(selectEl, options = {}) {
    if (!selectEl) return null;
    if (selectEl._chdashMenu) return selectEl._chdashMenu;
    const shipped = selectEl.parentElement?.classList.contains("tracePicker") ? selectEl.parentElement : null;
    const root = shipped || document.createElement("div");
    let button = shipped?.querySelector(":scope > .tracePicker__button") || null;
    let list = shipped?.querySelector(":scope > .tracePicker__menu") || null;
    if (!shipped) {
      root.className = `themeSelect tracePicker${options.className ? ` ${options.className}` : ""}`;
      selectEl.parentNode.insertBefore(root, selectEl);
      root.appendChild(selectEl);
    }
    selectEl.classList.add("tracePicker__native");
    selectEl.tabIndex = -1;
    selectEl.setAttribute("aria-hidden", "true");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "button themeSelect__button tracePicker__button";
      root.appendChild(button);
    }
    if (!list) {
      list = document.createElement("div");
      list.className = "themeSelect__menu tracePicker__menu";
      list.setAttribute("role", "listbox");
      list.tabIndex = -1;
      list.hidden = true;
      root.appendChild(list);
    }
    button.setAttribute("aria-haspopup", "listbox");
    const name = selectEl.getAttribute("aria-label");
    if (name && !list.hasAttribute("aria-label")) list.setAttribute("aria-label", name);

    const handle = bind(button, list, { root });
    const label = () => String(options.label ?? selectEl.dataset.fieldLabel ?? "").trim();

    function refresh() {
      const chosen = selectEl.options[selectEl.selectedIndex] || selectEl.options[0] || null;
      const text = chosen?.textContent || "Select";
      const disableWhenEmpty = options.disableWhenEmpty ?? selectEl.dataset.disableWhenEmpty === "1";
      const hasValues = [...selectEl.options].some((option) => !option.hidden && String(option.value || "").length > 0);
      const unavailable = !!selectEl.disabled || (disableWhenEmpty && !hasValues);
      button.textContent = label() ? `${label()} \u00b7 ${text}` : text;
      button.disabled = unavailable;
      button.setAttribute("aria-disabled", unavailable ? "true" : "false");
      root.classList.toggle("is-disabled", unavailable);
      root.classList.toggle("is-empty", disableWhenEmpty && !hasValues);
      if (unavailable) handle.close({ immediate: true });
      const focused = list.contains(document.activeElement) ? document.activeElement?.dataset?.value : null;
      list.replaceChildren(...[...selectEl.options].filter((option) => !option.hidden).map((option) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "themeSelect__option tracePicker__option";
        item.setAttribute("role", "option");
        item.dataset.value = option.value;
        item.textContent = option.textContent || option.value || ns.format?.EMPTY || "-";
        item.disabled = !!option.disabled;
        item.setAttribute("aria-selected", option.value === selectEl.value ? "true" : "false");
        return item;
      }));
      if (focused != null) list.querySelector(`[data-value="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }

    function set(value, { notify = false } = {}) {
      selectEl.value = value;
      if (notify) selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      refresh();
    }

    // Before bind's own click handler closes the list (it runs on the list).
    list.addEventListener("click", (event) => {
      const item = event.target instanceof Element ? event.target.closest(".tracePicker__option") : null;
      if (!item || item.disabled || !list.contains(item)) return;
      const value = item.dataset.value;
      const changed = selectEl.value !== value;
      selectEl.value = value;
      if (changed) selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      refresh();
      handle.close({ focus: true });
      if (changed) options.onChange?.(value);
    }, true);
    selectEl.addEventListener("change", refresh);
    selectEl.addEventListener("tracepicker-refresh", refresh);
    new MutationObserver(refresh).observe(selectEl, { attributes: true, childList: true, subtree: true, characterData: true });
    refresh();
    Object.assign(handle, { refresh, set, select: selectEl });
    selectEl._chdashMenu = handle;
    selectEl.dataset.tracePickerReady = "1";
    return handle;
  }

  // ---- multi -----------------------------------------------------------------
  // A multi-select list: checkboxes (or aria-checked options) that stay
  // open on each pick; the caller renders the list (onOpen) and the button
  // label ("Service - 2 selected").
  function multi(button, menu, options = {}) {
    menu?.setAttribute("aria-multiselectable", "true");
    return bind(button, menu, { items: 'input[type="checkbox"], button, [role="option"]', closeOnSelect: false, ...options });
  }

  // ---- split -----------------------------------------------------------------
  // A split button: the main action stays a plain button; the toggle next
  // to it opens the menu of the other actions (Run | Run with profiling,
  // Copy JSON | Copy CSV / Download).
  function split(main, toggle, menu, options = {}) {
    const root = options.root !== undefined ? options.root : (main || toggle)?.closest(".runSplit") || null;
    return bind(toggle, menu, { root, focus: "first", ...options });
  }

  // ---- context and submenus -------------------------------------------------
  // A menu at a client point (a right click): mounted in host(anchor),
  // fixed, kept in the viewport, its first item focused; it closes on a
  // pick, Escape (focus back to returnFocus), a pointer outside, a scroll,
  // a resize or the window losing focus. options: { x, y, anchor,
  // returnFocus, onClose }.
  function context(menu, { x = 0, y = 0, anchor = null, returnFocus = null, onClose = null } = {}) {
    if (!menu) return null;
    for (const other of [...openHandles]) other.close({ immediate: true });
    if (!menu.hasAttribute("tabindex")) menu.tabIndex = -1;
    host(anchor || returnFocus).appendChild(menu);
    placeAt(menu, x, y);
    menu.classList.add("is-open");
    let entry = null;
    const cleanups = [];
    const items = () => itemsOf(menu);
    const handle = {
      button: null, menu, root: null,
      isOpen: () => menu.isConnected,
      contains: (el) => !!el && menu.contains(el),
      open: () => {},
      toggle: () => handle.close(),
      place: () => placeAt(menu, x, y),
      close({ focus = "auto" } = {}) {
        if (!openHandles.has(handle)) return;
        openHandles.delete(handle);
        entry?.release();
        entry = null;
        for (const off of cleanups.splice(0)) off();
        for (const sub of [...openHandles]) if (sub.parent === handle) sub.close({ immediate: true, focus: false });
        const hadFocus = menu.contains(document.activeElement);
        menu.remove();
        if (returnFocus?.isConnected && (focus === true || (focus === "auto" && (hadFocus || document.activeElement === document.body)))) {
          try { returnFocus.focus({ preventScroll: true }); } catch { /* detached */ }
        }
        onClose?.();
      },
      destroy: () => handle.close({ focus: false }),
    };
    openHandles.add(handle);
    entry = layer({ el: () => [menu, ...[...openHandles].filter((h) => h.parent === handle).map((h) => h.menu)], onDismiss: (reason) => handle.close({ focus: reason === "escape" }) });
    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };
    on(document, "scroll", (event) => { if (!(event.target instanceof Node) || !menu.contains(event.target)) handle.close({ focus: false }); }, { capture: true, passive: true });
    on(window, "resize", () => handle.close({ focus: false }), { passive: true });
    on(window, "blur", () => handle.close({ focus: false }));
    bindKeys(menu, { items, close: () => handle.close({ focus: "auto" }) });
    menu.addEventListener("click", (event) => {
      const item = event.target instanceof Element ? event.target.closest(ITEMS) : null;
      if (!item || !menu.contains(item) || !enabled(item) || item.closest(LISTS) !== menu) return;
      if (item.getAttribute("aria-haspopup") && item.getAttribute("aria-haspopup") !== "false") return;
      handle.close({ focus: false });
    });
    focusItem(items()[0]);
    return handle;
  }

  // A submenu of `item` (role=menuitem, aria-haspopup=menu) in `list` (a
  // role=menu element, mounted next to the parent menu): opens on a click,
  // Enter, Space, Right or after a short hover, beside the item (flipped
  // left when it does not fit); Left or Escape closes it back to the item.
  // options: { parent (the parent menu's handle), onOpen() }.
  function submenu(item, list, { parent = null, onOpen = null } = {}) {
    if (!item || !list) return null;
    item.setAttribute("aria-haspopup", "menu");
    item.setAttribute("aria-expanded", "false");
    if (!list.hasAttribute("tabindex")) list.tabIndex = -1;
    list.hidden = true;
    let entry = null;
    let hoverTimer = 0;
    const items = () => itemsOf(list);
    const handle = {
      button: item, menu: list, root: null, parent,
      isOpen: () => item.getAttribute("aria-expanded") === "true",
      contains: (el) => !!el && list.contains(el),
      open({ focus = "first" } = {}) {
        if (handle.isOpen()) { if (focus !== "none") focusItem(items()[0]); return; }
        for (const other of [...openHandles]) if (other !== handle && other.parent === parent) other.close({ immediate: true, focus: false });
        onOpen?.();
        const menuEl = item.closest(LISTS);
        (menuEl?.parentElement || host(item)).appendChild(list);
        list.hidden = false;
        list.classList.add("is-open");
        const a = item.getBoundingClientRect();
        const vw = document.documentElement.clientWidth || window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        const w = list.offsetWidth;
        const h = list.offsetHeight;
        const right = a.right + 2;
        const left = right + w + 4 <= vw ? right : Math.max(4, a.left - w - 2);
        list.style.position = "fixed";
        list.style.left = `${Math.round(left)}px`;
        list.style.top = `${Math.round(Math.max(4, Math.min(a.top - 4, vh - h - 4)))}px`;
        item.setAttribute("aria-expanded", "true");
        openHandles.add(handle);
        entry = layer({ el: () => [list, item], onDismiss: (reason) => handle.close({ focus: reason === "escape" }) });
        if (focus !== "none") focusItem(items()[0]);
      },
      close({ focus = false } = {}) {
        clearTimeout(hoverTimer);
        if (!handle.isOpen()) return;
        openHandles.delete(handle);
        entry?.release();
        entry = null;
        item.setAttribute("aria-expanded", "false");
        list.hidden = true;
        list.classList.remove("is-open");
        if (focus) focusItem(item);
      },
      toggle: () => (handle.isOpen() ? handle.close({ focus: true }) : handle.open()),
      place: () => {},
      destroy: () => { handle.close(); list.remove(); },
    };
    item.addEventListener("click", (event) => { event.preventDefault(); handle.open(); });
    item.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        handle.open();
      }
    });
    item.addEventListener("pointerenter", () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => handle.open({ focus: "none" }), 180); });
    item.addEventListener("pointerleave", () => clearTimeout(hoverTimer));
    bindKeys(list, { items, close: () => { handle.close(); parent?.close?.({ focus: false }); }, back: () => handle.close({ focus: true }) });
    list.addEventListener("click", (event) => {
      const pick = event.target instanceof Element ? event.target.closest(ITEMS) : null;
      if (!pick || !list.contains(pick) || !enabled(pick)) return;
      handle.close();
      parent?.close?.({ focus: false });
    });
    return handle;
  }

  // Closes every open menu (a view hides, a dialog opens).
  function closeAll({ immediate = true } = {}) {
    for (const handle of [...openHandles]) handle.close({ immediate, focus: false });
  }

  ns.menu = { bind, select, multi, split, context, submenu, place, host, closeAll, isAnyOpen: () => openHandles.size > 0 };
})();
