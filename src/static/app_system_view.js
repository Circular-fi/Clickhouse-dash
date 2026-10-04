(() => {
  "use strict";

  // The System page's sections (docs/system.md): the selected server, not a
  // database or a table. Underlined section tabs under the header, the
  // section's controls on the right of the same row:
  //   Overview  the server tiles, the databases, the topology, Keeper and
  //             replication, the performance history and the background
  //             activity, one page top to bottom (app_system_overview.js);
  //   Queries   the top query shapes of a window (app_system_queries.js);
  //   Disks     the disks, their growth and what fills them
  //             (app_system_disks.js).
  // A section registers itself (register() below, from its module); a
  // section that is not registered or not available has no tab and its
  // address falls back to Overview.
  //
  // ns.systemView.show(root, { section, query, onSection, onQuery,
  //   onOpenTable, onOpenDatabase, databaseHref, onOpenSql })
  // mounts the view on `section` in the shell's #systemPage; onSection(section,
  // { history, query }) tells the page controller (app_system.js) which section
  // shows (history "push" for a tab, "replace" for a fallback). hide() stops
  // the timers; refresh(force) reloads the section on screen (a host change).
  //
  // Every figure is the selected server's own: system tables are local to
  // each node, so a replica is a host of its own in the host picker (the
  // header names it).

  const ns = window.ChDash;
  if (!ns) return;
  const { h } = ns;
  const { $ } = ns.dom;
  const format = ns.format;
  const SEP = " · ";

  // One Auto-refresh choice for the Overview (its tiles and activity every
  // 5 s, its charts every 30 s).
  const autoRefreshPref = () => ns.storage.pref(ns.storage.KEYS.systemAutoRefresh, false);

  const hostId = () => String(ns.state?.selectedHostId || "");
  const features = () => ns.features.get("system");
  const number = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

  // ---------------------------------------------------------------------------
  // Sections

  const sections = [];

  // A section: { id, label, order, available(features), create(ctx) }.
  // create returns { show(query), hide(), refresh(force), query() };
  // ctx holds panel (its content), actions (its controls in the tab row),
  // openTable(database, table), openDatabase(database, { tab }) (its
  // Explorer card), databaseHref(database, { tab }) (that address),
  // openSql(sql, { formatted }) and setQuery(query, { history }). A section
  // with address parameters returns them from query() as a query string
  // ("" for its defaults), receives the address's in show(query) when the
  // address opened it (undefined for a tab click: it keeps its own) and
  // reports a change through setQuery.
  function register(section) {
    if (!section?.id || sections.some((item) => item.id === section.id)) return;
    sections.push(section);
    sections.sort((a, b) => (a.order || 0) - (b.order || 0));
    if (view) renderTabs();
  }

  function availableSections() {
    const f = features();
    return sections.filter((section) => section.available(f));
  }

  let view = null;

  function renderTabs() {
    const items = availableSections().map((section) => ({
      value: section.id,
      label: section.label,
      id: `systemTab-${section.id}`,
      controls: `systemPanel-${section.id}`,
    }));
    ns.tabs.render(view.tabs, items, { attr: "section", selected: view.section });
  }

  function controllerOf(section) {
    let controller = view.controllers.get(section.id);
    if (!controller) {
      const panel = h("div", {
        class: "systemPage__panel",
        id: `systemPanel-${section.id}`,
        role: "tabpanel",
        dataset: { section: section.id },
        aria: { labelledby: `systemTab-${section.id}` },
        hidden: true,
      });
      const actions = h("div", { class: "systemPage__actions", dataset: { section: section.id }, hidden: true });
      view.root.appendChild(panel);
      view.nav.appendChild(actions);
      controller = section.create({
        panel,
        actions,
        openTable: (database, table) => {
          if (typeof view?.options?.onOpenTable === "function") view.options.onOpenTable(database, table);
        },
        // A database's Explorer card (the Overview's treemap, Disks).
        openDatabase: (database, options = {}) => {
          if (typeof view?.options?.onOpenDatabase === "function") view.options.onOpenDatabase(database, options);
        },
        databaseHref: (database, options = {}) => (typeof view?.options?.databaseHref === "function" ? String(view.options.databaseHref(database, options) || "") : ""),
        // The Query page's editor with `sql` (formatted by the server unless
        // formatted is false); it never runs there by itself.
        openSql: (sql, { formatted = true } = {}) => {
          if (typeof view?.options?.onOpenSql !== "function") return Promise.reject(new Error("Open in Query is not available."));
          return Promise.resolve(view.options.onOpenSql(sql, { formatted }));
        },
        // Only the section on screen writes the address.
        setQuery: (query, { history = "push" } = {}) => {
          if (view?.section !== section.id || !view.active) return;
          view.options.query = String(query || "");
          view.options.onQuery?.(view.options.query, { history });
        },
      });
      controller.panel = panel;
      controller.actions = actions;
      view.controllers.set(section.id, controller);
    }
    return controller;
  }

  // Shows `id` (or the first available section); history says how the page
  // writes the address when the section differs from the asked one.
  // query: the address's parameters when the address opened the section
  // (undefined for a tab: the section keeps its own).
  function select(id, { history = "push", query } = {}) {
    if (!view) return;
    const available = availableSections();
    if (!available.length) return;
    const section = available.find((item) => item.id === id) || available[0];
    const changed = section.id !== view.section;
    if (changed && view.section) view.controllers.get(view.section)?.hide();
    view.section = section.id;
    renderTabs();
    for (const [key, controller] of view.controllers) {
      controller.panel.hidden = key !== section.id;
      controller.actions.hidden = key !== section.id;
    }
    const controller = controllerOf(section);
    controller.panel.hidden = false;
    controller.actions.hidden = false;
    document.documentElement.dataset.systemSection = section.id;
    controller.show(section.id === id ? query : undefined);
    if (section.id !== id || (changed && history === "push")) {
      const own = typeof controller.query === "function" ? String(controller.query() || "") : "";
      view.options.query = own;
      view.options.onSection?.(section.id, { history: section.id !== id && history !== "push" ? "replace" : history, query: own });
    }
  }

  // The shell ships the tab row (#systemTabs in #systemPage, so the first
  // paint has it); the view renders the tabs again from the registered
  // sections and adds each section's controls and panel.
  function mount(root) {
    let tabs = $("#systemTabs", root);
    let nav = tabs?.parentElement || null;
    if (!tabs || !nav) {
      tabs = h("div", { id: "systemTabs", class: "contentTabs contentTabs--nav systemPage__tabs", aria: { label: "System sections" } });
      nav = h("nav", { class: "systemPage__nav", aria: { label: "System sections" } }, tabs);
      root.prepend(nav);
    }
    view = { root, nav, tabs, section: "", controllers: new Map(), options: {}, active: false };
    ns.tabs.bind(tabs, { attr: "section", onSelect: (id) => select(String(id || ""), { history: "push" }) });
    ns.shell?.edgeCues?.(tabs);
  }

  function show(root, options = {}) {
    if (!root) return;
    if (!view || view.root !== root) mount(root);
    view.options = { ...options };
    view.active = true;
    select(String(options.section || ""), { history: "replace", query: String(options.query || "") });
  }

  function hide() {
    if (!view) return;
    view.active = false;
    view.controllers.get(view.section)?.hide();
  }

  function refresh(force = true) {
    if (!view?.active) return;
    view.controllers.get(view.section)?.refresh(force);
  }

  // ---------------------------------------------------------------------------
  // Shared pieces

  // A section's controls in the tab row: `lead` (a time range picker) and,
  // with onAutoRefresh, the Auto-refresh choice, then the refresh button.
  // No caption: the header names the server, the panels say what they show.
  function sectionBar({ id, label, onRefresh, onAutoRefresh = null, autoRefreshTitle = "", lead = null }) {
    let input = null;
    let option = null;
    if (onAutoRefresh) {
      input = h("input", { type: "checkbox", id: `systemAutoRefresh-${id}` });
      input.addEventListener("change", () => onAutoRefresh(!!input.checked));
      option = h("label", { class: "systemBar__option", title: autoRefreshTitle || null }, input, h("span", null, "Auto-refresh"));
    }
    const button = h("button", {
      type: "button",
      class: "button button--small explorerRefreshButton systemBar__refresh",
      id: `systemRefresh-${id}`,
      title: `Refresh ${label}`,
      aria: { label: `Refresh ${label}` },
    }, ns.icon.el("refresh", { size: "sm", className: "refreshGlyph" }));
    button.addEventListener("click", onRefresh);
    const bar = h("div", { class: ["systemBar", !onAutoRefresh && "systemBar--noAuto"] }, lead, option, button);
    return { bar, input, option, button };
  }

  // The Observability time range picker on its markup root, in a bar of its
  // own (the hidden native select of the filter bars is optional: no form).
  function rangePicker(id) {
    const root = h("div", { class: "themeSelect tracePicker tracePicker--range" },
      h("button", { type: "button", class: "button themeSelect__button tracePicker__button", id: `${id}RangeButton`, aria: { haspopup: "dialog", expanded: "false" } }, "Time range"));
    const wrap = h("div", { class: "traceSearchBar systemRange" }, h("div", { class: "traceSearchBar__range systemRange__picker" }, root));
    return { root, wrap };
  }

  const REASONS = {
    disabled: "Disabled",
    not_granted: "Not granted",
    unsupported: "Not supported",
    window_too_large: "Too large",
    readonly_account: "Read-only account",
    failed: "Unavailable",
  };

  function issueText(issue) {
    const table = issue.table || "tables";
    switch (issue.reason) {
      case "disabled": return `system.${table} is disabled on this server (server configuration).`;
      case "not_granted": return `The system account cannot read system.${table}.`;
      case "unsupported": return `This ClickHouse version lacks a column of system.${table}.`;
      case "window_too_large": return "The read hit its time or row limit.";
      case "readonly_account": return "The system account's profile has readonly = 1, so the query limits cannot be set (use readonly = 2).";
      default: return ns.util.errorText(issue.message, `system.${table} could not be read.`);
    }
  }

  // A panel that could not be read: why, and the GRANT to run when a grant
  // is missing. One element per issue, in place of the panel's content.
  function issueBlock(issue) {
    const el = h("div", { class: "systemIssue", dataset: { reason: issue.reason || "failed", panel: issue.panel || "" } },
      h("div", { class: "systemIssue__head" },
        ns.badge.el(REASONS[issue.reason] || REASONS.failed, { tone: issue.reason === "disabled" ? "neutral" : "warn" }),
        h("span", { class: "systemIssue__text" }, issue.text || issueText(issue))));
    if (issue.hint) {
      const copy = ns.ui.copyButton(null, () => issue.hint, { label: "Copy the GRANT statement", className: "systemIssue__copy" });
      el.appendChild(h("div", { class: "systemIssue__hint" }, h("code", { class: "systemIssue__code" }, issue.hint), copy));
    }
    if (issue.message && issue.reason !== "failed") el.title = issue.message;
    return el;
  }

  // A card's head: its title, a count and an extra element (a badge).
  function cardHead(title, count = "", extra = null) {
    return h("div", { class: "systemCard__head" },
      h("h3", { class: "systemCard__title" }, title),
      count ? h("span", { class: "systemCard__count" }, count) : null,
      extra);
  }

  function card(key, title, count, extra) {
    return h("section", { class: "systemCard", dataset: { card: key } }, cardHead(title, count, extra));
  }

  // A part of the Overview: a heading (h2) and its content; extra sits on
  // the heading's right.
  function part(key, title, extra = null) {
    const head = h("div", { class: "systemPart__head" }, h("h2", { class: "systemPart__title", id: `systemPartTitle-${key}` }, title), extra);
    const body = h("div", { class: "systemPart__body" });
    const el = h("section", { class: "systemPart", id: `systemPart-${key}`, dataset: { part: key }, aria: { labelledby: `systemPartTitle-${key}` } }, head, body);
    return { el, head, body };
  }

  // A delay in whole seconds: "0 s" rather than "0 ns".
  const seconds = (value) => (Number(value) > 0 ? format.duration.fromSeconds(value) : "0 s");

  function dataTable(id, headers, rows) {
    const head = h("tr", null, headers.map((header) => h("th", { scope: "col", class: [header.num && "num", header.className], title: header.title || null }, header.label)));
    return h("div", { class: "systemTableWrap" },
      h("table", { class: "dataTable dataTable--compact systemTable", id }, h("thead", null, head), h("tbody", null, rows)));
  }

  ns.systemView = {
    show, hide, refresh, register,
    sections: () => availableSections().map((section) => section.id),
    active: () => (view?.active ? view.section : ""),
    // The pieces the sections' modules share.
    kit: Object.freeze({ sectionBar, rangePicker, issueBlock, issueText, cardHead, card, part, dataTable, seconds, autoRefreshPref, hostId, number, features, SEP }),
  };
})();
