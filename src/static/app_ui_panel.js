(() => {
  "use strict";

  // Side panels (left) and detail panels (right): one shell each.
  //
  // ns.sidePanel.mount(el, options) -> { el, collapsed(), setCollapsed(v), drawerOpen(), setDrawerOpen(v) }
  //   The left list of a page (the Explorer tree, the Functions list, the
  //   Traces Attributes / Logs Fields facets, the Metrics catalog): a column
  //   --side-w wide with a header (title, count / meta, a 30 px search, an
  //   optional chip row) over a body that scrolls on its own. The content
  //   renderer stays the page's. Markup (the page writes it):
  //     <aside class="uiSide"> <div class="uiSide__head"> .uiSide__bar (the
  //       collapse toggle .uiSide__toggle or the title .uiSide__title, the
  //       .uiSide__meta, actions), .uiSide__search, .uiSide__chips
  //     </div> <div class="uiSide__body"> ... </div> </aside>
  //   options:
  //     label             "Attributes": the toggles' names
  //     collapse          { button, storeKey, rootClass, onChange(collapsed) }:
  //                       wide windows fold the panel to a 32 px rail
  //                       (.is-collapsed, and rootClass on <html> for the
  //                       first paint, which the page's head script sets)
  //     drawer            { toggle, host, backdrop, bind = true, onChange(open) }:
  //                       at --bp-md and below the panel is a drawer over the
  //                       content, opened by `toggle` (or a .uiSide__drawerToggle
  //                       built at the start of `host`); an ns.layers layer
  //                       (Escape, a press outside, focus back to the toggle)
  //
  // ns.detailPanel.create(options) -> panel
  //   The right panel that shows one entity. Two layouts:
  //     "docked"    a column beside the content (Logs record, Spans, Services)
  //     "floating"  over a canvas (the graph-kit panel of the Explorer graph,
  //                 the service map and the trace graph)
  //   Both: one head (eyebrow, title, subtitle; actions on the right, then
  //   the one close button .closeCross.uiDetail__close), --detail-w wide, a
  //   bottom sheet at --bp-md and below, Escape through ns.layers, under
  //   --shell-top when fixed.
  //   options:
  //     el                an existing panel (its markup has the shell classes)
  //     host, id, className, label   build one (appended to host, hidden)
  //     layout            "docked" (default) | "floating"
  //     closeLabel        the close button's name ("Close")
  //     onClose(reason)   after it closed ("close", "escape", "back", ...)
  //     returnFocus       element (or () => element) when the opener is gone
  //   panel: { el, head, eyebrow, title, subtitle, actions, closeButton, body,
  //            setHead({ eyebrow, title, subtitle, html }), setActions(html | nodes),
  //            open({ opener }), close(reason, { restoreFocus }), isOpen() }
  //
  // ns.detailPanel.head({ eyebrow, title, subtitle, dot, closeLabel, onClose, actions })
  //   -> a head element in the shell's markup (the graph-kit panels).
  //
  // ns.detailPanel.urlParam(name) -> { get(search?), open(value), move(value), clear() }
  //   The one URL parameter of a panel that shows one entity: open pushes a
  //   history entry, a move inside the panel (next / previous) replaces it,
  //   and closing goes Back when the entry is the panel's own (otherwise it
  //   replaces), so Back closes an open panel.

  window.ChDash = window.ChDash || {};
  const ns = window.ChDash;
  if (ns.sidePanel && ns.detailPanel) return;

  let uid = 0;
  const atMostMd = () => !!ns.shell?.isAtMost?.("md");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function read(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* optional */ }
  }

  // ------------------------------------------------------------ side panel

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

    function setCollapsed(value) {
      if (!collapse) return;
      const next = !!value;
      if (collapse.rootClass) document.documentElement.classList.toggle(collapse.rootClass, next);
      if (collapse.storeKey) write(collapse.storeKey, next ? "1" : "0");
      syncCollapse();
      collapse.onChange?.(next);
    }

    if (collapse) {
      if (collapse.storeKey && collapse.rootClass && read(collapse.storeKey) === "1") document.documentElement.classList.add(collapse.rootClass);
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
      if (!drawerToggle) return;
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
        layer = ns.layers.push({
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
        drawerToggle = el("button", "button button--small uiSide__drawerToggle");
        drawerToggle.type = "button";
        drawerToggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11"/></svg>';
        drawerToggle.append(el("span", "uiSide__drawerToggleText", label));
        drawer.host.prepend(drawerToggle);
      }
      if (!backdrop && drawer.host !== undefined) {
        backdrop = el("div", "uiSide__backdrop");
        backdrop.hidden = true;
        panel.after(backdrop);
      }
      backdrop?.addEventListener("click", () => setDrawerOpen(false));
      if (drawerToggle && drawer.bind !== false) drawerToggle.addEventListener("click", () => setDrawerOpen(!drawerOpen()));
      try {
        window.matchMedia(ns.shell.mediaQuery("md")).addEventListener("change", (event) => { if (!event.matches) setDrawerOpen(false); });
      } catch (_) { /* old browsers */ }
      syncDrawerToggle();
    }

    return { el: panel, collapsed, setCollapsed, drawerOpen, setDrawerOpen, drawerToggle: () => drawerToggle, syncDrawerToggle };
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
    const button = el("button", "closeCross uiDetail__close", "×");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = `${label} (Esc)`;
    if (onClose) button.addEventListener("click", onClose);
    return button;
  }

  // A head in the shell's markup. graphKit: true keeps the graph-kit
  // aliases (graphKitPanel__*) its content styles and tests name.
  function head({ eyebrow = "", title = "", subtitle = "", dot = "", titleId = "", closeLabel = "Close", onClose = null, actions = null, graphKit = false } = {}) {
    const alias = (name) => (graphKit ? ` graphKitPanel__${name}` : "");
    const header = el("header", `uiDetail__head${alias("head")}`);
    const titles = el("div", `uiDetail__titles${alias("titles")}`);
    if (eyebrow) titles.append(el("span", `uiDetail__eyebrow${alias("eyebrow")}`, eyebrow));
    const heading = el("h2", `uiDetail__title${alias("title")}`);
    if (titleId) heading.id = titleId;
    if (dot) {
      const swatch = el("span", `uiDetail__dot${alias("dot")}`);
      swatch.style.background = dot;
      heading.append(swatch);
    }
    if (title instanceof Node) heading.append(title);
    else heading.append(document.createTextNode(String(title ?? "")));
    titles.append(heading);
    if (subtitle) titles.append(el("span", `uiDetail__subtitle${alias("subtitle")}`, subtitle));
    header.append(titles);
    if (actions) {
      const box = el("div", "uiDetail__actions");
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
      panel = el("aside", `uiDetail uiDetail--${layout}${options.className ? ` ${options.className}` : ""}`);
      panel.id = id;
      panel.hidden = true;
      const titleId = `${id}Title`;
      const header = el("header", "uiDetail__head");
      const titles = el("div", "uiDetail__titles");
      const eyebrow = el("span", "uiDetail__eyebrow");
      eyebrow.hidden = true;
      const title = el("h2", "uiDetail__title");
      title.id = titleId;
      const subtitle = el("span", "uiDetail__subtitle");
      subtitle.hidden = true;
      titles.append(eyebrow, title, subtitle);
      const actions = el("div", "uiDetail__actions");
      header.append(titles, actions, closeButton(closeLabel, null));
      const body = el("div", "uiDetail__body");
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
    const part = (name) => panel.querySelector(`:scope > .uiDetail__head .uiDetail__${name}, :scope > .uiDetail__head > .uiDetail__${name}`);

    const api = {
      el: panel,
      get head() { return panel.querySelector(":scope > .uiDetail__head"); },
      get eyebrow() { return part("eyebrow"); },
      get title() { return part("title"); },
      get subtitle() { return part("subtitle"); },
      get actions() { return part("actions"); },
      get closeButton() { return panel.querySelector(":scope > .uiDetail__head > .uiDetail__close"); },
      get body() { return panel.querySelector(":scope > .uiDetail__body"); },
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
        panel.hidden = false;
        openState = true;
        if (!layer || !layer.isOpen()) {
          layer = ns.layers.push({
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
        // The focus leaves with the layer before the panel hides (a hidden
        // focused element would drop it on the body).
        closing?.close({ restoreFocus });
        panel.hidden = true;
        options.onClose?.(reason);
      },
    };
    panel.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest(".uiDetail__close") : null;
      if (button && panel.contains(button) && button.closest(".uiDetail") === panel) api.close("close");
    });
    return api;
  }

  // ------------------------------------------------------------- URL state

  function urlParam(name) {
    const marker = `detail:${name}`;
    const current = () => new URL(window.location.href);
    const withValue = (value) => {
      const url = current();
      if (value == null || value === "") url.searchParams.delete(name);
      else url.searchParams.set(name, String(value));
      return `${url.pathname}${url.search}${url.hash}`;
    };
    return {
      name,
      get(search = window.location.search) {
        return new URLSearchParams(search).get(name) || "";
      },
      // A new entity in the panel: its own history entry.
      open(value) {
        if (this.get() === String(value)) return;
        const state = { ...(window.history.state || {}), detail: marker };
        if (this.get()) window.history.replaceState(state, "", withValue(value));
        else window.history.pushState(state, "", withValue(value));
      },
      // Next / previous inside the open panel.
      move(value) {
        if (this.get() === String(value)) return;
        window.history.replaceState({ ...(window.history.state || {}) }, "", withValue(value));
      },
      // The panel closed: its own entry goes (Back); a panel restored from
      // a link or a reload has none and only drops the parameter.
      clear() {
        if (!this.get()) return false;
        if (window.history.state?.detail === marker) {
          window.history.back();
          return true;
        }
        const state = { ...(window.history.state || {}) };
        delete state.detail;
        window.history.replaceState(state, "", withValue(""));
        return false;
      },
    };
  }

  ns.sidePanel = Object.freeze({ mount: mountSide });
  ns.detailPanel = Object.freeze({ create, head, urlParam, closeButton });
})();
