// A System page (docs/system.md): the selected server, not a database or a table. Each section is a page of its own
// (system.html, queries.html, disks.html): a row of links under the header, then the section's filter bar (ns.filterBar,
// the one of Observability: the time range first, the section's filters, the refresh button at the right end), then the
// section:
//   Overview  the server tiles, the databases, the topology, Keeper and
//             replication, the performance history and the background
//             activity, one page top to bottom (app_system_overview.js);
//   Queries   the top query shapes of a window (app_system_queries.js);
//   Disks     the disks, their growth and what fills them
//             (app_system_disks.js).
// A section is an object that its module exports, { id, label, available(features), create(ctx) }: the entry of the
// page hands it to startSystemPage (app_system.js), which mounts it here. A section that the server does not offer
// leaves the page to the controller (Overview).
//
// systemView.mountSection(root, { section, query, onQuery, onOpenTable, onOpenDatabase, databaseHref, onOpenSql,
//   shape, onOpenShape, onBack })
// builds the section's filter bar and panel in the shell's #systemPage the first time, and shows the section on `query`
// (the parameters of the address). Called again with the same root (Back / Forward), it shows the section on the new
// query. The shell's row of links to the sections is the page's (nothing to render or bind). refresh(force) reloads
// the section (a host change).
//
// create(ctx) returns { show(query), refresh(force), query() }. ctx holds panel (its content), bar (its filter bar,
// ns.filterBar.create: kit.sectionBar() fills it), openTable(database, table), openDatabase(database, { tab }) (its
// Explorer card), databaseHref(database, { tab }) (that address), openSql(sql, { formatted }) and setQuery(query,
// { history }). A section with address parameters returns them from query() as a query string ("" for its defaults),
// receives the address's in show(query) and reports a change through setQuery.
//
// One query shape is a page of its own (shape.html, app_page_shape.js): `shape` (a hash) mounts the Queries section on
// that shape with no row of links, onOpenShape(hash) opens a shape's page from the list and onBack() leaves a shape for
// the list.
//
// Every figure is the selected server's own: system tables are local to each node, so a replica is a host of its own in
// the host picker (the header names it).

import { dom, h, shell } from "./app_dom.js";
import { filterBar } from "./app_ui_filterbar.js";

const { $ } = dom;

// The mounted section: { root, nav, section, controller, options }.
let view = null;

function build(root, section, options) {
  const nav = options.shape ? null : $(".systemPage__nav", root);
  if (nav) shell?.edgeCues?.($("#systemTabs", root));
  const panel = h("div", {
    class: "systemPage__panel",
    id: `systemPanel-${section.id}`,
    role: "tabpanel",
    dataset: { section: section.id },
    aria: { labelledby: `systemTab-${section.id}` },
  });
  // The section's filter bar, between the row of links and the panel; its action (the refresh button) is the form's submit.
  const bar = filterBar.create({
    id: `systemBar-${section.id}`,
    className: "systemFilterBar",
    dataset: { section: section.id },
  });
  // A shape's page has no filter bar of its own: its section moves the time range and the refresh button into the shape's head.
  if (nav) nav.after(bar.form);
  root.appendChild(panel);
  const controller = section.create({
    panel,
    bar,
    openTable: (database, table) => view.options.onOpenTable?.(database, table),
    // A database's Explorer card (the Overview's treemap, Disks).
    openDatabase: (database, opts = {}) => view.options.onOpenDatabase?.(database, opts),
    databaseHref: (database, opts = {}) => (typeof view.options.databaseHref === "function" ? String(view.options.databaseHref(database, opts) || "") : ""),
    // The Query page's editor with `sql` (formatted by the server unless formatted is false); it never runs there by itself.
    openSql: (sql, { formatted = true } = {}) => {
      if (typeof view.options.onOpenSql !== "function") return Promise.reject(new Error("Open in Query is not available."));
      return Promise.resolve(view.options.onOpenSql(sql, { formatted }));
    },
    // One query shape (shape.html): its hash, a shape's page from the list, and the way back.
    shape: String(options.shape || ""),
    openShape: (hash, opts = {}) => view.options.onOpenShape?.(hash, opts),
    back: () => view.options.onBack?.(),
    setQuery: (query, { history = "push" } = {}) => {
      view.options.query = String(query || "");
      view.options.onQuery?.(view.options.query, { history });
    },
  });
  // The phone fold, once the section filled its bar.
  if (!options.shape) filterBar.mountSummary(bar.form);
  return { panel, bar, controller };
}

function mountSection(root, options = {}) {
  const { section } = options;
  if (!root || !section) return;
  if (!view || view.root !== root) {
    view = { root, section, options: { ...options }, built: null };
    view.built = build(root, section, view.options);
    document.documentElement.dataset.systemSection = section.id;
  }
  view.options = { ...options };
  view.built.controller.show(String(options.query || ""));
}

function refresh(force = true) {
  view?.built?.controller.refresh?.(force);
}

export const systemView = { mountSection, refresh };
