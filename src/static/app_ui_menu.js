// Menus, pickers and dropdowns. All popup lists of the app use one behaviour.
// This applies to the header host, page and theme menus, the Run and Copy split menus,
// the run settings, the Observability pickers, the Explorer, the chart and editor menus,
// the click-to-filter menu and the row context menus. Each family keeps its own look
// (themeSelect / tracePicker / runMenu...).
//
// This module owns:
//  - open / close: aria-expanded on the button. The root gets the open and closing classes
//    (themeSelect--open / --closing, or is-open). The list hides after a 160 ms close motion.
//  - one menu open at a time. A submenu keeps its parents open.
//  - placement: the list stays in the viewport. It is shifted, flipped above the button,
//    or capped in height. A floating menu (portal, context menu, submenu) mounts in the open
//    <dialog> that holds its anchor. The page outside a modal dialog is inert.
//  - keys: Down / Up / Home / End move between the items. A typed prefix jumps to the next
//    item that starts with it. Enter / Space activate the item. Escape closes the menu and
//    returns the focus to the button. Tab closes the menu. Down / Up on the button open the list.
//  - focus: when the menu opens from the keyboard, the selected item (or the first item)
//    takes the focus. From a pointer, the list itself takes the focus. A close by Escape
//    or a pick gives the focus back to the button, unless the pick moved the focus
//    somewhere else (for example to a dialog that the pick opened).
//  - dismissal: every open menu is an ns.layers layer. This is the one Escape and
//    outside-press listener of the page. layer() below is the only code that knows it.
//
//   bind(button, menu, options)  -> handle   an action or settings menu
//   select(selectEl, options)    -> handle   a single-choice picker over a
//                                            hidden native <select>, its
//                                            label in the button
//                                            ("Status - All")
//   multi(button, menu, options) -> handle   a multi-select list (stays open)
//   split(main, toggle, menu, o) -> handle   a split button's menu
//   context(menu, options)       -> handle   a menu at a point or under an
//                                            anchor (row and filter menus)
//   submenu(item, list, options) -> handle   a nested menu of an item
//   place(menu, anchor)                      viewport clamp / flip
//   host(anchor)                             where a floating menu mounts
//   closeAll()                               closes every open menu
//
// handle: { open(), close({ immediate, focus }), toggle(), isOpen(),
//           place(), button, menu, root } (+ refresh(), set(value) for select)

import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { layers } from "./app_ui_layers.js";

const { $, $$ } = dom;

const CLOSE_MS = 160;
const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]';
const LISTS = '[role="menu"], [role="listbox"]';
const TEXT_FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable=""], [contenteditable="true"]';
const MARGIN = 8;

// ---- Dismiss layer -------------------------------------------------------
// Every open menu is an ns.layers layer. app_ui_layers.js holds the one Escape and
// outside-press listener of the page. The stack is shared with popovers, panels and dialogs.
// layer() is the only code here that knows it.
// An entry is { el(): the elements that count as inside, onDismiss(reason:
// "outside" | "escape" | ...) }. ns.menu moves the focus itself.
function layer(entry) {
  const handle = layers?.push({ el: entry.el, onDismiss: (reason) => { entry.onDismiss(reason); }, returnFocus: false, name: "menu" }) || null;
  return { release: () => { handle?.release?.(); } };
}

// ---- Shared state --------------------------------------------------------
const openHandles = new Set();

// When a menu opens, the other menus close. The parent menus of the new menu stay open.
function closeOthers(handle) {
  for (const other of [...openHandles]) {
    if (other === handle || (handle.button && other.contains(handle.button))) continue;
    other.close({ immediate: true, focus: false });
  }
}

const visible = (el) => !el.hidden && el.getClientRects().length > 0;
const enabled = (el) => !el.disabled && el.getAttribute("aria-disabled") !== "true";

function itemsOf(menu, selector = ITEMS) {
  return [...$$(selector, menu)].filter((el) => {
    const owner = el.closest(LISTS);
    if (owner && owner !== menu && menu.contains(owner)) return false;
    if (el.matches(ITEMS) && $('input[type="checkbox"], input[type="radio"]', el)) return false;
    return visible(el) && enabled(el);
  });
}

function selectedItem(items) {
  return items.find((el) => el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true") || null;
}

function focusItem(el) {
  try { el?.focus({ preventScroll: false }); } catch { /* detached */ }
}

// A pick on a link item. The link navigates when its click is over. A link that is
// removed or hidden during its click does not navigate.
function afterPick(item, fn) {
  if (item?.matches?.("a[href]")) setTimeout(fn, 0);
  else fn();
}

// ---- Placement -----------------------------------------------------------
// Keeps an open list in the viewport. It uses the CSS `translate` property, which is
// independent of the transform motion of the families. The list is shifted left or right.
// It is flipped above the anchor when the space below is short and the space above is
// larger. Otherwise, the list is capped in height and it scrolls.
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

// A floating menu mounts in the open <dialog> that holds its anchor. The page outside a
// modal dialog is inert.
function host(anchor) {
  const dialog = anchor instanceof Element ? anchor.closest("dialog[open]") : null;
  return dialog || document.body;
}

// A floating menu at a point (x, y), or under the box of an anchor. The menu is fixed
// and clamped to the viewport. It opens above the point, or above the top of the anchor,
// when it does not fit below. With align "end", the right edge of the menu lines up with
// the right edge of the anchor.
function placeFloating(menu, { x = 0, y = 0, anchor = null, align = "start", gap = 4 } = {}) {
  const vw = document.documentElement.clientWidth || window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  menu.style.position = "fixed";
  menu.style.right = "auto";
  menu.style.bottom = "auto";
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left = x;
  let top = y;
  let above = y - h;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    left = align === "end" ? a.right - w : a.left;
    top = a.bottom + gap;
    above = a.top - gap - h;
  }
  left = Math.max(4, Math.min(left, vw - w - 4));
  top = top + h + 4 <= vh ? top : Math.max(4, above);
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
    const owner = target?.closest(LISTS);
    if (owner && owner !== menu && menu.contains(owner)) return;
    if (event.key === "Tab") { close({ immediate: true, focus: false }); return; }
    if (target?.matches(TEXT_FIELD)) return;
    const list = items();
    if (!list.length) return;
    let at = list.indexOf(target);
    if (at < 0 && target?.closest(ITEMS)) at = list.indexOf(target.closest(ITEMS));
    const move = (index) => { event.preventDefault(); focusItem(list[(index + list.length) % list.length]); };
    if (event.key === "ArrowDown") return move(at < 0 ? Math.max(0, list.indexOf(selectedItem(list))) : at + 1);
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
      const hit = [...list.slice(start), ...list.slice(0, start)].find((el) => label(el).startsWith(typed));
      if (hit) { event.preventDefault(); focusItem(hit); }
    }
  });
}

// ---- bind ------------------------------------------------------------------
// options:
//   root            element that holds the open and closing classes (default:
//                   the button's .themeSelect / .runSplit / .picker)
//   openClass       default themeSelect--open (themeSelect roots), else is-open
//   closingClass    default themeSelect--closing (themeSelect roots)
//   items           selector of the list's items (default: the ARIA item roles)
//   focus           "item" (default: the selected or first item), "first",
//                   "last", "menu", "none" or a function that returns the element
//   closeOnSelect   true / false; default: a pick closes, except the
//                   menuitemcheckbox / menuitemradio items of a settings menu
//   canOpen()       false keeps it closed (a one-option picker)
//   onOpen()        before it shows (fill the list); onClose()
//   trigger         false: the caller handles the click on the button. The caller calls toggle.
//   placement       false: CSS alone places the list
//   portal          true: the list opens fixed in host(button). It is not inside a container that clips it or
//                   re-renders it. It aligns with the button ("start" / "end": portalAlign)
//                   and gets the is-open class.
//   keys            false: a panel with its own keys and picks (the time range panel).
//                   The menu sets no item keys. A click inside the panel never closes it.
//   inside()        more elements that count as inside
function bind(button, menu, options = {}) {
  if (!button || !menu) return null;
  const root = options.root !== undefined ? options.root : button.closest(".themeSelect, .runSplit, .picker");
  const themed = !!root?.classList.contains("themeSelect");
  const openClass = options.openClass ?? (themed ? "themeSelect--open" : root ? "is-open" : "");
  const closingClass = options.closingClass ?? (themed ? "themeSelect--closing" : "");
  const animate = options.animate ?? !!openClass;
  const portal = !!options.portal;
  let home = null;
  let timer = 0;
  let entry = null;

  const isOpen = () => button.getAttribute("aria-expanded") === "true";
  const items = () => itemsOf(menu, options.items || ITEMS);
  const role = menu.getAttribute("role");
  if (!button.hasAttribute("aria-haspopup")) button.setAttribute("aria-haspopup", role === "listbox" ? "listbox" : role === "dialog" ? "dialog" : "menu");
  button.setAttribute("aria-expanded", "false");
  if (menu.id) button.setAttribute("aria-controls", menu.id);
  if (!menu.hasAttribute("tabindex")) menu.tabIndex = -1;

  const handle = {
    button, menu, root,
    isOpen,
    contains: (el) => !!el && ((root && root.contains(el)) || menu.contains(el) || button === el),
    open, close, toggle,
    place: () => (portal ? placeFloating(menu, { anchor: button, align: options.portalAlign || "start" }) : place(menu, button)),
  };

  function focusOnOpen(how) {
    if (how === "none") return;
    if (typeof how === "function") { focusItem(how() || menu); return; }
    if (how === "menu") { menu.focus({ preventScroll: true }); return; }
    const list = items();
    // A listbox opens on its selected option. A menu opens on its first item.
    const target = how === "last" ? list[list.length - 1] : how === "first" || role !== "listbox" ? list[0] : (selectedItem(list) || list[0]);
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
    if (portal) {
      if (!home) home = { parent: menu.parentNode, next: menu.nextSibling };
      host(button).appendChild(menu);
    }
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    openHandles.add(handle);
    // The closed style is laid out first. Therefore, adding the open class now
    // still runs the motion of the open state, and the list can take the focus.
    void menu.offsetHeight;
    if (openClass) root?.classList.add(openClass);
    if (portal) menu.classList.add("is-open");
    if (options.placement !== false) handle.place();
    entry = layer({
      el: () => [root || button, button, menu, ...(options.inside?.() || [])],
      onDismiss: (reason) => close({ focus: reason === "escape" }),
    });
    focusOnOpen(focus ?? options.focus ?? "item");
    options.onOpened?.();
  }

  // focus: true (always), false (never) or "auto" (default). With "auto", the focus goes
  // back to the button when the focus was in the list and nothing else took the focus.
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
      if (portal) {
        menu.classList.remove("is-open");
        for (const prop of ["position", "left", "top", "right", "bottom"]) menu.style.removeProperty(prop);
        // The element returns to its place. It is removed too when that place left the page.
        if (home?.parent?.isConnected) {
          if (menu.parentNode !== home.parent) home.parent.insertBefore(menu, home.next?.parentNode === home.parent ? home.next : null);
        } else if (home?.parent) menu.remove();
      }
    };
    if (immediate || !animate || menu.hidden) finish();
    else {
      if (closingClass) root?.classList.add(closingClass);
      requestAnimationFrame(() => { if (!isOpen() && openClass) root?.classList.remove(openClass); });
      timer = setTimeout(() => { if (!isOpen()) finish(); }, CLOSE_MS);
    }
    const now = document.activeElement;
    const stranded = !now || now === document.body || !now.isConnected || menu.contains(now);
    if (focus === true || (focus === "auto" && wasOpen && focusWasInside && stranded)) button.focus({ preventScroll: true });
    if (wasOpen) options.onClose?.();
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  // A pointer opens the list, and the focus goes to the list itself. No focus ring
  // shows on an item. Down / Up then move from there. Enter / Space open the list
  // on its selected or first item.
  if (options.trigger !== false) {
    button.addEventListener("click", (event) => {
      if (button.disabled) return;
      event.preventDefault();
      if (isOpen()) close();
      else open({ focus: event.detail > 0 && typeof options.focus !== "function" && options.focus !== "none" ? "menu" : undefined });
    });
  }
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (button.disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    open({ focus: event.key === "ArrowUp" ? "last" : "first" });
  });
  if (options.keys !== false) bindKeys(menu, { items, close: (o) => close(o) });
  menu.addEventListener("click", (event) => {
    if (options.keys === false) return;
    const item = event.target instanceof Element ? event.target.closest(`${ITEMS}, button, a[href]`) : null;
    if (!item || !menu.contains(item) || !enabled(item) || !isOpen()) return;
    const owner = item.closest(LISTS);
    if (owner && owner !== menu && menu.contains(owner)) return;
    if (item.getAttribute("aria-haspopup") && item.getAttribute("aria-haspopup") !== "false") return;
    const keep = options.closeOnSelect === false
      || (options.closeOnSelect !== true && /^menuitem(checkbox|radio)$/.test(item.getAttribute("role") || ""))
      || (options.closeOnSelect !== true && !item.matches(ITEMS));
    if (!keep) afterPick(item, () => close({ focus: "auto" }));
  });
  return handle;
}

// ---- select ----------------------------------------------------------------
// A single-choice picker over a native <select>. The native select is the data source.
// It is hidden, with tabindex -1 and aria-hidden. The button reads "<label> - <option>"
// (data-field-label on the select, or options.label).
//
// The picker adopts the markup that a page ships (root .tracePicker around the select,
// with its button and list). Otherwise, the picker builds the markup.
// A pick sets the select's value, fires its change event and calls onChange(value).
// Changes of the select (new options, disabled) refresh the picker. A "tracepicker-refresh"
// event also refreshes it.
//   options: { label, className, onChange(value), disableWhenEmpty }
function select(selectEl, options = {}) {
  if (!selectEl) return null;
  if (selectEl._chdashMenu) return selectEl._chdashMenu;
  const shipped = selectEl.parentElement?.classList.contains("tracePicker") ? selectEl.parentElement : null;
  const root = shipped || document.createElement("div");
  let button = $(":scope > .tracePicker__button", shipped) || null;
  let list = $(":scope > .tracePicker__menu", shipped) || null;
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
  const name = selectEl.getAttribute("aria-label") || selectEl.dataset.fieldLabel;
  if (name && !list.hasAttribute("aria-label")) list.setAttribute("aria-label", name);

  const handle = bind(button, list, { root });
  const label = () => String(options.label ?? selectEl.dataset.fieldLabel ?? "").trim();

  function refresh() {
    const chosen = selectEl.options[selectEl.selectedIndex] || selectEl.options[0] || null;
    const text = chosen?.textContent || "Select";
    const disableWhenEmpty = options.disableWhenEmpty ?? selectEl.dataset.disableWhenEmpty === "1";
    const hasValues = [...selectEl.options].some((option) => !option.hidden && String(option.value || "").length > 0);
    const unavailable = !!selectEl.disabled || (disableWhenEmpty && !hasValues);
    // The label is in a span of its own. A long value ends in an ellipsis, because a
    // flex button cannot cut its bare text. The title shows the whole value.
    const full = label() ? `${label()} \u00b7 ${text}` : text;
    button.replaceChildren(h("span", { class: "tracePicker__label" }, full));
    button.title = full;
    button.disabled = unavailable;
    button.setAttribute("aria-disabled", unavailable ? "true" : "false");
    root.classList.toggle("is-disabled", unavailable);
    root.classList.toggle("is-empty", disableWhenEmpty && !hasValues);
    if (unavailable) handle.close({ immediate: true, focus: false });
    const focused = list.contains(document.activeElement) ? document.activeElement?.dataset?.value : null;
    list.replaceChildren(...[...selectEl.options].filter((option) => !option.hidden).map((option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "themeSelect__option tracePicker__option";
      item.setAttribute("role", "option");
      item.dataset.value = option.value;
      item.textContent = option.textContent || option.value || format?.EMPTY || "-";
      item.disabled = !!option.disabled;
      item.setAttribute("aria-selected", option.value === selectEl.value ? "true" : "false");
      return item;
    }));
    if (focused != null) [...list.children].find((item) => item.dataset.value === focused)?.focus({ preventScroll: true });
  }

  function set(value, { notify = false } = {}) {
    selectEl.value = value;
    if (notify) selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    refresh();
  }

  // This handler runs before the click handler of bind, in the capture phase. It runs the pick first, then the close.
  list.addEventListener("click", (event) => {
    const item = event.target instanceof Element ? event.target.closest(".tracePicker__option") : null;
    if (!item || item.disabled || !list.contains(item)) return;
    const value = item.dataset.value;
    const changed = selectEl.value !== value;
    selectEl.value = value;
    if (changed) selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    refresh();
    handle.close({ focus: document.activeElement === document.body || !document.activeElement || list.contains(document.activeElement) });
    if (changed) options.onChange?.(value);
  }, true);
  selectEl._chdashMenu = handle;
  selectEl.dataset.tracePickerReady = "1";
  selectEl.addEventListener("change", refresh);
  selectEl.addEventListener("tracepicker-refresh", refresh);
  new MutationObserver(refresh).observe(selectEl, { attributes: true, childList: true, subtree: true, characterData: true });
  refresh();
  Object.assign(handle, { refresh, set, select: selectEl });
  return handle;
}

// ---- multi -----------------------------------------------------------------
// A multi-select list. It has checkboxes (or aria-checked options) that keep the list
// open on each pick. The caller renders the list (onOpen) and the button
// label ("Service - 2 selected"). A listbox is marked multiselectable.
// A popup that holds check boxes and other controls is a dialog (the MCP
// Usage pickers). That dialog has no such state.
function multi(button, menu, options = {}) {
  if (menu?.getAttribute("role") === "listbox") menu.setAttribute("aria-multiselectable", "true");
  return bind(button, menu, { items: 'input[type="checkbox"], button, [role="option"]', closeOnSelect: false, ...options });
}

// ---- split -----------------------------------------------------------------
// A split button. The main action stays a plain button. The toggle next to it opens
// the menu of the other actions (Run | Run with profiling,
// Copy JSON | Copy CSV / Download).
function split(main, toggle, menu, options = {}) {
  const root = options.root !== undefined ? options.root : (main || toggle)?.closest(".runSplit") || null;
  return bind(toggle, menu, { root, focus: "first", ...options });
}

// ---- context menus and submenus -------------------------------------------
const floating = new WeakMap(); // menu element -> { current handle }

// A menu at a point (a right click: x, y) or under an anchor (a click on a
// value: anchor, align). The menu is mounted in host(anchor) and is fixed. It stays in the
// viewport, and its first item gets the focus. The menu closes on a pick. It also closes on
// Escape, which gives the focus back to returnFocus. It closes on a pointer outside the menu,
// on a scroll outside the menu, on a resize, or when the window loses the focus.
//
// options: { x, y, anchor, align, returnFocus,
// expanded (an element whose aria-expanded follows the menu), remove
// (default true: the menu leaves the document on close; false: hidden),
// within (the element whose open dialog hosts it), onClose }.
function context(menu, { x = 0, y = 0, anchor = null, align = "start", returnFocus = null, expanded = null, within = null, remove = true, onClose = null } = {}) {
  if (!menu) return null;
  for (const other of [...openHandles]) other.close({ immediate: true, focus: false });
  let state = floating.get(menu);
  if (!state) {
    state = { current: null };
    floating.set(menu, state);
    bindKeys(menu, { items: () => itemsOf(menu), close: (o) => state.current?.close(o) });
    menu.addEventListener("click", (event) => {
      const item = event.target instanceof Element ? event.target.closest(ITEMS) : null;
      if (!item || !menu.contains(item) || !enabled(item) || item.closest(LISTS) !== menu) return;
      if (item.getAttribute("aria-haspopup") && item.getAttribute("aria-haspopup") !== "false") return;
      const current = state.current;
      afterPick(item, () => current?.close({ focus: false }));
    });
    // When another item gets the pointer or the focus, the open submenu closes.
    const leaveSubmenus = (event) => {
      const item = event.target instanceof Element ? event.target.closest(ITEMS) : null;
      if (!item || item.closest(LISTS) !== menu) return;
      for (const sub of [...openHandles]) if (sub.parent === state.current && sub.button !== item) sub.close({ focus: false });
    };
    menu.addEventListener("pointerover", leaveSubmenus);
    menu.addEventListener("focusin", leaveSubmenus);
  }
  if (!menu.hasAttribute("tabindex")) menu.tabIndex = -1;
  host(within || anchor || returnFocus).appendChild(menu);
  menu.hidden = false;
  placeFloating(menu, { x, y, anchor, align });
  menu.classList.add("is-open");
  expanded?.setAttribute?.("aria-expanded", "true");
  let entry = null;
  const cleanups = [];
  const handle = {
    button: null, menu, root: null,
    isOpen: () => openHandles.has(handle),
    contains: (el) => !!el && menu.contains(el),
    open: () => {},
    toggle: () => handle.close(),
    place: () => placeFloating(menu, { x, y, anchor, align }),
    close({ focus = "auto" } = {}) {
      if (!openHandles.has(handle)) return;
      openHandles.delete(handle);
      if (state.current === handle) state.current = null;
      entry?.release();
      entry = null;
      for (const off of cleanups.splice(0)) off();
      for (const sub of [...openHandles]) if (sub.parent === handle) sub.close({ focus: false });
      const hadFocus = menu.contains(document.activeElement);
      menu.classList.remove("is-open");
      if (remove) menu.remove();
      else menu.hidden = true;
      expanded?.setAttribute?.("aria-expanded", "false");
      const back = returnFocus || expanded;
      if (back?.isConnected && (focus === true || (focus === "auto" && (hadFocus || document.activeElement === document.body)))) {
        try { back.focus({ preventScroll: true }); } catch { /* detached */ }
      }
      onClose?.();
    },
  };
  state.current = handle;
  openHandles.add(handle);
  // The anchor counts as inside. A click on it again is handled by the toggle of the caller.
  entry = layer({
    el: () => [menu, expanded, ...[...openHandles].filter((h) => h.parent === handle).map((h) => h.menu)].filter(Boolean),
    onDismiss: (reason) => handle.close({ focus: reason === "escape" }),
  });
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };
  const inMenus = (node) => node instanceof Node && (menu.contains(node) || [...openHandles].some((h) => h.parent === handle && h.menu.contains(node)));
  on(document, "scroll", (event) => { if (!inMenus(event.target)) handle.close({ focus: false }); }, { capture: true, passive: true });
  on(window, "resize", () => handle.close({ focus: false }), { passive: true });
  on(window, "blur", () => handle.close({ focus: false }));
  focusItem(itemsOf(menu)[0]);
  return handle;
}

// A submenu of `item` (a role=menuitem of a context menu) in `list` (a
// role=menu element). The submenu opens on a click, on Enter, on Space, on Right, or when the
// pointer enters the item. It opens beside the item, or on the left when it does not
// fit. Left or Escape closes the submenu and returns the focus to its item. A pick closes the
// whole menu. options: { parent (the context menu's handle), onOpen(list)
// (fill it) }.
function submenu(item, list, { parent = null, onOpen = null } = {}) {
  if (!item || !list) return null;
  item.setAttribute("aria-haspopup", "menu");
  item.setAttribute("aria-expanded", "false");
  if (!list.hasAttribute("tabindex")) list.tabIndex = -1;
  let entry = null;
  const items = () => itemsOf(list);
  const handle = {
    button: item, menu: list, root: null, parent,
    isOpen: () => openHandles.has(handle),
    contains: (el) => !!el && list.contains(el),
    open({ focus = "first" } = {}) {
      if (!handle.isOpen()) {
        for (const other of [...openHandles]) if (other !== handle && other.parent === parent) other.close({ focus: false });
        onOpen?.(list);
        host(item).appendChild(list);
        list.hidden = false;
        list.classList.add("is-open");
        list.style.position = "fixed";
        const a = item.getBoundingClientRect();
        const vw = document.documentElement.clientWidth || window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        const w = list.offsetWidth;
        const h = list.offsetHeight;
        const left = a.right + w + 4 <= vw ? a.right + 2 : Math.max(4, a.left - w - 2);
        list.style.left = `${Math.round(left)}px`;
        list.style.top = `${Math.round(Math.max(4, Math.min(a.top - 4, vh - h - 4)))}px`;
        item.setAttribute("aria-expanded", "true");
        openHandles.add(handle);
        // The parent menu counts as inside. The parent handles a pointer that points back at it.
        // Another item closes the submenu.
        entry = layer({ el: () => [list, item, parent?.menu].filter(Boolean), onDismiss: (reason) => handle.close({ focus: reason === "escape" }) });
      }
      if (focus !== "none") focusItem(items()[0]);
    },
    close({ focus = false } = {}) {
      if (!handle.isOpen()) return;
      openHandles.delete(handle);
      entry?.release();
      entry = null;
      item.setAttribute("aria-expanded", "false");
      list.classList.remove("is-open");
      list.remove();
      if (focus) focusItem(item);
    },
    toggle: () => (handle.isOpen() ? handle.close({ focus: true }) : handle.open()),
    place: () => {},
  };
  item.addEventListener("click", (event) => { event.preventDefault(); handle.open(); });
  item.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    handle.open();
  });
  item.addEventListener("pointerenter", () => handle.open({ focus: "none" }));
  bindKeys(list, { items, close: () => { handle.close(); parent?.close?.({ focus: false }); }, back: () => handle.close({ focus: true }) });
  list.addEventListener("click", (event) => {
    const pick = event.target instanceof Element ? event.target.closest(ITEMS) : null;
    if (!pick || !list.contains(pick) || !enabled(pick)) return;
    afterPick(pick, () => { handle.close(); parent?.close?.({ focus: false }); });
  });
  return handle;
}

// Closes every open menu. This happens when a view hides or a dialog opens.
function closeAll() {
  for (const handle of [...openHandles]) handle.close({ immediate: true, focus: false });
}

export const menu = { bind, select, multi, split, context, submenu, place, host, closeAll, isAnyOpen: () => openHandles.size > 0 };
