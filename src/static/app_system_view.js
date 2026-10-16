// A System page (docs/system.md) shows the selected server. It does not show a database or a table.
// Each section has a page of its own (system.html, queries.html, disks.html). Each page has three parts, in this order:
// a row of links under the header, the section's filter bar (ns.filterBar), and the section.
// The filter bar is the same as the one in Observability. The time range comes first. The section's filters come next.
// The refresh button is at the right end.
// The section is one of these:
//   Overview  server tiles, databases, topology, Keeper and replication,
//             performance history and background activity, on one page
//             from top to bottom (app_system_overview.js);
//   Queries   the top query shapes of a window (app_system_queries.js);
//   Disks     the disks, their growth and what fills them
//             (app_system_disks.js).
// A section is an object that its module exports: { id, label, available(features), create(ctx) }.
// The page entry gives this object to startSystemPage (app_system.js). That function mounts the section here.
// If the server does not offer a section, the controller (Overview) handles the page.
//
// systemView.mountSection(root, { section, query, onQuery, onOpenTable, onOpenDatabase, databaseHref, onOpenSql,
//   shape, onOpenShape, onBack })
// It builds the section's filter bar and panel in the shell's #systemPage. It does this the first time only.
// Then it shows the section for `query` (the parameters of the address).
// Call it again with the same root (Back / Forward). It then shows the section for the new query.
// The shell draws the row of links to the sections. This module does not render or bind it.
// Call refresh(force) to reload the section. Use it after a host change.
//
// create(ctx) returns { show(query), refresh(force), query() }.
// The ctx object has these members:
//   panel     the content of the section;
//   bar       the filter bar (ns.filterBar.create makes it, kit.sectionBar() fills it);
//   openTable(database, table);
//   openDatabase(database, { tab })   opens the Explorer card of a database;
//   databaseHref(database, { tab })   returns the address of that card;
//   openSql(sql, { formatted });
//   setQuery(query, { history }).
// A section with address parameters returns them from query() as a query string. The string is "" for the defaults.
// The section gets the address parameters through show(query). It reports a change through setQuery.
//
// A query shape has a page of its own (shape.html, app_page_shape.js). The `shape` option (a hash) mounts the
// Queries section for that shape. That page has no row of links.
// onOpenShape(hash) opens the page of a shape from the list. onBack() returns from a shape to the list.
//
// Every figure belongs to the selected server. System tables are local to each node. A replica is therefore a host
// of its own in the host picker. The header names the host.

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
  // The section's filter bar sits between the row of links and the panel. Its action (the refresh button) is the form's submit.
  const bar = filterBar.create({
    id: `systemBar-${section.id}`,
    className: "systemFilterBar",
    dataset: { section: section.id },
  });
  // A shape's page has no filter bar of its own. The section moves the time range and the refresh button into the shape's head.
  if (nav) nav.after(bar.form);
  root.appendChild(panel);
  const controller = section.create({
    panel,
    bar,
    openTable: (database, table) => view.options.onOpenTable?.(database, table),
    // The Explorer card of a database. The Overview's treemap and Disks use it.
    openDatabase: (database, opts = {}) => view.options.onOpenDatabase?.(database, opts),
    databaseHref: (database, opts = {}) => (typeof view.options.databaseHref === "function" ? String(view.options.databaseHref(database, opts) || "") : ""),
    // The Query page editor opens with `sql`. The server formats the SQL unless formatted is false. The editor never runs the SQL by itself.
    openSql: (sql, { formatted = true } = {}) => {
      if (typeof view.options.onOpenSql !== "function") return Promise.reject(new Error("Open in Query is not available."));
      return Promise.resolve(view.options.onOpenSql(sql, { formatted }));
    },
    // One query shape (shape.html): its hash, the page of a shape from the list, and the way back.
    shape: String(options.shape || ""),
    openShape: (hash, opts = {}) => view.options.onOpenShape?.(hash, opts),
    back: () => view.options.onBack?.(),
    setQuery: (query, { history = "push" } = {}) => {
      view.options.query = String(query || "");
      view.options.onQuery?.(view.options.query, { history });
    },
  });
  // The phone fold. It runs after the section fills its bar.
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
