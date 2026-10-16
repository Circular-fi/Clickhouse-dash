// Side panels (left) and detail panels (right). Each panel uses one shell.
//
// ns.sidePanel.mount(el, options) -> { el, collapsed(), setCollapsed(v), drawerOpen(), setDrawerOpen(v) }
//   The left list of a page. Examples: the Explorer tree, the Functions list, the
//   Traces Attributes and Logs Fields facets, and the Metrics catalog. The panel is a column
//   --side-w wide. Its header has a title, a count or meta text, a 30 px search field and an
//   optional chip row. A body that scrolls on its own sits below the header. The content
//   renderer stays the page's. The page writes the markup:
//     <aside class="uiSide"> <div class="uiSide__head"> .uiSide__bar (the
//       collapse toggle .uiSide__toggle or the title .uiSide__title, the
//       .uiSide__meta, actions), .uiSide__search, .uiSide__chips
//     </div> <div class="uiSide__body"> ... </div> </aside>
//   options:
//     label             "Attributes": the names of the toggles
//     collapse          { button, storeKey, rootClass, onChange(collapsed) }:
//                       on wide windows, the panel folds to a 32 px rail.
//                       It uses .is-collapsed, and rootClass on <html> for the
//                       first paint. The head script of the page sets that class.
//     drawer            { toggle, host, backdrop, bind = true, manageToggle = true, icon, onChange(open) }:
//                       at --bp-md and below, the panel is a drawer over the content.
//                       The drawer is fixed under --shell-top. It opens with `toggle`, or with
//                       a .uiSide__drawerToggle in a bar that is built at the start of `host`.
//                       The drawer is an ns.layers layer: Escape and a press outside it close it,
//                       and the focus returns to the toggle.
//
// ns.detailPanel.create(options) -> panel
//   The right panel that shows one entity. It has two layouts:
//     "docked"    a column beside the content (Logs record, Spans, Services)
//     "floating"  over a canvas (the graph-kit panel of the Explorer graph,
//                 the service map and the trace graph)
//   Both layouts have one head: eyebrow, title, subtitle, and actions on the right. The one
//   close button is .closeCross.uiDetail__close. The panel is --detail-w wide. At --bp-md and
//   below, it is a bottom sheet. Escape works through ns.layers. A fixed panel is under --shell-top.
//   options:
//     el                an existing panel. Its markup has the shell classes.
//     host, id, className, label   build a panel. It is appended to host, and it is hidden.
//     layout            "docked" (default) | "floating"
//     closeLabel        the close button's name ("Close")
//     onClose(reason)   runs after the panel closes ("close", "escape", "back", ...)
//     returnFocus       element (or () => element) that gets the focus when the opener is gone
//   panel: { el, head, eyebrow, title, subtitle, actions, closeButton, body,
//            setHead({ eyebrow, title, subtitle, html }), setActions(html | nodes),
//            open({ opener }), close(reason, { restoreFocus }), isOpen() }
//
// ns.detailPanel.head({ eyebrow, title, subtitle, dot, closeLabel, onClose, actions })
//   -> a head element in the shell's markup, for the graph-kit panels.
//
// Room for a docked detail panel: below FOLD_BELOW px (and above --bp-md),
//   when one opens, it folds the shown side panels of the page to their rails. When it closes,
//   it unfolds the side panels that it folded. A rail that the viewer opened meanwhile
//   stays open. Neither change is remembered as the viewer's fold.
//
// The one URL parameter of a panel that shows one entity (span=, log=,
//   node=, svc=) is managed by ns.router.panel(name) (app_router.js). When the panel opens, a
//   history entry is pushed. A move inside the panel replaces that entry. When the panel closes,
//   the Back action goes to the previous entry if that entry is the panel's own. Therefore, Back closes an open panel.

import { dom, h, shell } from "./app_dom.js";
import { storage } from "./app_state.js";
import { icon } from "./app_ui_icon.js";
import { layers } from "./app_ui_layers.js";

const { $ } = dom;

let uid = 0;
const atMostMd = () => !!shell?.isAtMost?.("md");

// The remembered fold uses the values "1" and "0". It is stored with storage.pref (app_state.js),
// which is loaded before a page mounts a panel.
const foldPref = (key) => storage.pref(key, false);

// ------------------------------------------------------------ side panel

// The side panels that fold for a docked detail panel. See create().
const FOLD_BELOW = 1600;
const foldable = new Set();

function mountSide(panel, options = {}) {
  if (!panel) return null;
  panel.classList.add("uiSide");
  const label = String(options.label || panel.getAttribute("aria-label") || "list");
  const lower = label.toLowerCase();
  const collapse = options.collapse || null;
  const drawer = options.drawer || null;
  let drawerToggle = null;
  let backdrop = drawer?.backdrop || null;
  let layer = null;

  // -- collapse (wide windows)
  function collapsed() {
    if (!collapse) return false;
    return collapse.rootClass ? document.documentElement.classList.contains(collapse.rootClass) : panel.classList.contains("is-collapsed");
  }

  function syncCollapse() {
    if (!collapse) return;
    const value = collapsed();
    panel.classList.toggle("is-collapsed", value);
    const button = collapse.button;
    if (button) {
      button.setAttribute("aria-expanded", value ? "false" : "true");
      button.title = value ? `Show ${lower}` : `Hide ${lower}`;
      if (panel.id && !button.hasAttribute("aria-controls")) button.setAttribute("aria-controls", panel.id);
    }
  }

  // The panel is folded for a detail panel. This is not the choice of the viewer, and it is not remembered.
  let autoFolded = false;

  function applyCollapsed(next, { remember = true } = {}) {
    if (collapse.rootClass) document.documentElement.classList.toggle(collapse.rootClass, next);
    else panel.classList.toggle("is-collapsed", next);
    if (remember && collapse.storeKey) foldPref(collapse.storeKey).set(next);
    syncCollapse();
    collapse.onChange?.(next);
  }

  function setCollapsed(value) {
    if (!collapse) return;
    autoFolded = false;
    applyCollapsed(!!value);
  }

  function autoFold() {
    if (!collapse || collapsed() || atMostMd() || !panel.getClientRects().length) return;
    autoFolded = true;
    applyCollapsed(true, { remember: false });
  }
  function autoUnfold() {
    if (!autoFolded) return;
    autoFolded = false;
    if (collapsed()) applyCollapsed(false, { remember: false });
  }

  if (collapse) {
    // The remembered fold. A head script may have set the <html> class.
    if (collapse.storeKey && foldPref(collapse.storeKey).get() === true) {
      if (collapse.rootClass) document.documentElement.classList.add(collapse.rootClass);
      else panel.classList.add("is-collapsed");
    }
    collapse.button?.addEventListener("click", () => {
      // A phone has no rail: the panel is a drawer there.
      if (atMostMd() && drawer) { setDrawerOpen(false); return; }
      setCollapsed(!collapsed());
    });
    syncCollapse();
  }

  // -- drawer (narrow windows)
  function drawerOpen() {
    return panel.classList.contains("is-open");
  }

  function syncDrawerToggle() {
    if (!drawerToggle || drawer?.manageToggle === false) return;
    const open = drawerOpen();
    drawerToggle.setAttribute("aria-expanded", String(open));
    if (panel.id) drawerToggle.setAttribute("aria-controls", panel.id);
    if (drawer?.labelToggle !== false) drawerToggle.setAttribute("aria-label", open ? `Hide ${lower}` : `Show ${lower}`);
  }

  function setDrawerOpen(value) {
    if (!drawer) return;
    const open = !!value && atMostMd();
    if (open === drawerOpen()) { syncDrawerToggle(); return; }
    panel.classList.toggle("is-open", open);
    if (backdrop) backdrop.hidden = !open;
    if (open) {
      layer = layers.push({
        el: panel,
        name: panel.id || "sidePanel",
        opener: drawerToggle,
        inside: [drawerToggle].filter(Boolean),
        onDismiss: () => { setDrawerOpen(false); },
      });
    } else {
      const closing = layer;
      layer = null;
      closing?.close();
    }
    syncDrawerToggle();
    drawer.onChange?.(open);
  }

  if (drawer) {
    drawerToggle = drawer.toggle || null;
    if (!drawerToggle && drawer.host) {
      // A bar at the start of the main column, shown at --bp-md and below.
      const bar = h("div", { class: "uiSide__drawerBar" });
      drawerToggle = h("button", { class: "button button--small uiSide__drawerToggle" });
      drawerToggle.type = "button";
      if (panel.id) drawerToggle.id = `${panel.id}DrawerToggle`;
      drawerToggle.innerHTML = drawer.icon || icon("menu", { size: "sm" });
      drawerToggle.append(h("span", { class: "uiSide__drawerToggleText" }, label));
      bar.append(drawerToggle);
      drawer.host.prepend(bar);
    }
    if (!backdrop) {
      backdrop = h("div", { class: "uiSide__backdrop" });
      backdrop.hidden = true;
      panel.after(backdrop);
    }
    backdrop?.addEventListener("click", () => setDrawerOpen(false));
    if (drawerToggle && drawer.bind !== false) drawerToggle.addEventListener("click", () => setDrawerOpen(!drawerOpen()));
    try {
      window.matchMedia(shell.mediaQuery("md")).addEventListener("change", (event) => { if (!event.matches) setDrawerOpen(false); });
    } catch (_) { /* old browsers */ }
    syncDrawerToggle();
  }

  // The head marks the list as scrolled beneath it. The .is-scrolled class gives a soft edge.
  const sideHead = $(":scope > .uiSide__head", panel);
  const sideBody = $(":scope > .uiSide__body", panel);
  if (sideHead && sideBody) {
    sideBody.addEventListener("scroll", () => {
      const scrolled = sideBody.scrollTop > 0;
      if (sideHead.classList.contains("is-scrolled") !== scrolled) sideHead.classList.toggle("is-scrolled", scrolled);
    }, { passive: true });
  }

  const handle = { el: panel, collapsed, setCollapsed, drawerOpen, setDrawerOpen, drawerToggle: () => drawerToggle, syncDrawerToggle, autoFold, autoUnfold, autoFolded: () => autoFolded };
  if (collapse) foldable.add(handle);
  return handle;
}

// When a docked detail panel opens, the shown side panels fold to their rails
// while the window is narrower than FOLD_BELOW. When the panel closes, they unfold.
function foldSides(open) {
  for (const side of foldable) {
    if (!side.el.isConnected) { foldable.delete(side); continue; }
    if (open) {
      if (window.innerWidth < FOLD_BELOW) side.autoFold();
    } else {
      side.autoUnfold();
    }
  }
}

// ---------------------------------------------------------- detail panel

function fill(node, value, html) {
  if (!node) return;
  if (value instanceof Node) node.replaceChildren(value);
  else if (html) node.innerHTML = String(value ?? "");
  else node.textContent = String(value ?? "");
  node.hidden = value == null || value === "";
}

function closeButton(label, onClose) {
  const button = h("button", { class: "closeCross uiDetail__close" }, icon.el("x"));
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = `${label} (Esc)`;
  if (onClose) button.addEventListener("click", onClose);
  return button;
}

// A head in the shell's markup. With graphKit: true, the head keeps the graph-kit
// aliases (graphKitPanel__*). The content styles and the tests use these names.
function head({ eyebrow = "", title = "", subtitle = "", dot = "", titleId = "", closeLabel = "Close", onClose = null, actions = null, graphKit = false } = {}) {
  const alias = (name) => (graphKit ? ` graphKitPanel__${name}` : "");
  const header = h("header", { class: `uiDetail__head${alias("head")}` });
  const titles = h("div", { class: `uiDetail__titles${alias("titles")}` });
  if (eyebrow) titles.append(h("span", { class: `uiDetail__eyebrow${alias("eyebrow")}` }, eyebrow));
  const heading = h("h2", { class: `uiDetail__title${alias("title")}` });
  if (titleId) heading.id = titleId;
  if (dot) {
    const swatch = h("span", { class: `uiDetail__dot${alias("dot")}` });
    swatch.style.background = dot;
    heading.append(swatch);
  }
  if (title instanceof Node) heading.append(title);
  else heading.append(document.createTextNode(String(title ?? "")));
  titles.append(heading);
  if (subtitle) titles.append(h("span", { class: `uiDetail__subtitle${alias("subtitle")}` }, subtitle));
  header.append(titles);
  if (actions) {
    const box = h("div", { class: "uiDetail__actions" });
    if (actions instanceof Node) box.append(actions);
    else box.innerHTML = String(actions);
    header.append(box);
  }
  const close = closeButton(closeLabel, onClose);
  if (graphKit) close.classList.add("graphKitPanel__close");
  header.append(close);
  return header;
}

function create(options = {}) {
  const layout = options.layout === "floating" ? "floating" : "docked";
  const closeLabel = String(options.closeLabel || "Close");
  let panel = options.el || null;
  if (!panel) {
    const id = options.id || `uiDetail${++uid}`;
    panel = h("aside", { class: `uiDetail uiDetail--${layout}${options.className ? ` ${options.className}` : ""}` });
    panel.id = id;
    panel.hidden = true;
    const titleId = `${id}Title`;
    const header = h("header", { class: "uiDetail__head" });
    const titles = h("div", { class: "uiDetail__titles" });
    const eyebrow = h("span", { class: "uiDetail__eyebrow" });
    eyebrow.hidden = true;
    const title = h("h2", { class: "uiDetail__title" });
    title.id = titleId;
    const subtitle = h("span", { class: "uiDetail__subtitle" });
    subtitle.hidden = true;
    titles.append(eyebrow, title, subtitle);
    const actions = h("div", { class: "uiDetail__actions" });
    header.append(titles, actions, closeButton(closeLabel, null));
    const body = h("div", { class: "uiDetail__body" });
    panel.append(header, body);
    panel.setAttribute("aria-labelledby", titleId);
    (options.host || document.body).appendChild(panel);
  } else {
    panel.classList.add("uiDetail", `uiDetail--${layout}`);
  }
  if (options.label) panel.setAttribute("aria-label", options.label);
  if (!panel.hasAttribute("role")) panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  if (!panel.hasAttribute("tabindex")) panel.tabIndex = -1;

  let layer = null;
  let openState = !panel.hidden;
  const part = (name) => $(`:scope > .uiDetail__head .uiDetail__${name}, :scope > .uiDetail__head > .uiDetail__${name}`, panel);

  const api = {
    el: panel,
    get head() { return $(":scope > .uiDetail__head", panel); },
    get eyebrow() { return part("eyebrow"); },
    get title() { return part("title"); },
    get subtitle() { return part("subtitle"); },
    get actions() { return part("actions"); },
    get closeButton() { return $(":scope > .uiDetail__head > .uiDetail__close", panel); },
    get body() { return $(":scope > .uiDetail__body", panel); },
    setHead({ eyebrow, title, subtitle, html = false } = {}) {
      if (eyebrow !== undefined) fill(api.eyebrow, eyebrow, html);
      if (title !== undefined) { const node = api.title; fill(node, title, html); if (node) node.hidden = false; }
      if (subtitle !== undefined) fill(api.subtitle, subtitle, html);
    },
    setActions(content) {
      const box = api.actions;
      if (!box) return;
      if (content instanceof Node) box.replaceChildren(content);
      else box.innerHTML = String(content ?? "");
    },
    isOpen: () => openState,
    open({ opener = null } = {}) {
      const opening = !openState;
      panel.hidden = false;
      openState = true;
      if (opening && layout === "docked") foldSides(true);
      if (!layer || !layer.isOpen()) {
        layer = layers.push({
          el: panel,
          name: panel.id || "detailPanel",
          docked: true,
          opener: opener || undefined,
          fallbackFocus: options.returnFocus || null,
          onDismiss: (reason) => { api.close(reason, { restoreFocus: true }); },
        });
      }
      return api;
    },
    close(reason = "close", { restoreFocus = true } = {}) {
      if (!openState && panel.hidden) return;
      openState = false;
      const closing = layer;
      layer = null;
      // The focus leaves with the layer before the panel hides. A hidden element that has the focus sends the focus to the body.
      closing?.close({ restoreFocus });
      panel.hidden = true;
      if (layout === "docked") foldSides(false);
      options.onClose?.(reason);
    },
  };
  panel.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest(".uiDetail__close") : null;
    if (button && panel.contains(button) && button.closest(".uiDetail") === panel) api.close("close");
  });
  return api;
}

export const sidePanel = Object.freeze({ mount: mountSide, FOLD_BELOW });
export const detailPanel = Object.freeze({ create, head, closeButton });
