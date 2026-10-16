// A System page (docs/system.md). It shows the selected server, with one section for each page.
// A row of links under the header leads to the sections (app_system_view.js):
//
//   /system[?from=&to=]                  Overview (system.html): the charts' time range
//   /system/queries[?from=&to=&sort=&kind=&hide=0&runs=]   (queries.html)
//   /system/disks[?from=&to=]                              (disks.html)
//
// The entry of each page imports the module of its own section. A section is an object: { id, label, available, create }.
// The entry passes the section to startSystemPage(). Each section keeps its own parameters.
// Back and Forward move through the browser's history. They move from page to page.
// Within a page, they move from one query string to the next.
// One query shape is a page of its own too (shape.html, app_page_shape.js).
// The former Explorer addresses (/explorer/_monitoring[/<section>], /explorer/_operations) redirect to this page
// (server.cpp redirect_to_system).
//
// This controller starts the modules of the page (through ns.loader). It also starts the header (ns.header.init:
// host picker, page switcher, theme) and the view. A host change refreshes the section on screen.

import { api } from "./app_api.js";
import { dom } from "./app_dom.js";
import { header } from "./app_header.js";
import { router as routerMod } from "./app_router.js";
import { features } from "./app_state.js";
import { kit } from "./app_system_kit.js";
import { systemView } from "./app_system_view.js";

const ROUTE = "/system";
// The section that this page shows. startSystemPage() receives it ({ id: "overview", "queries" or "disks", ... }).
let SECTION = null;

const router = () => routerMod;

const sectionPath = () => (SECTION.id === "overview" ? ROUTE : `${ROUTE}/${SECTION.id}`);

// The address of the section, with its query. The function uses a replace or a push.
// A replace is for a change of parameters, because the page address is the section address. A push is for a new search.
function writeAddress(query, history) {
  const href = `${router().url(sectionPath())}${query ? `?${query}` : ""}`;
  router().write(history, null, { href, view: "system" });
}

let shownQuery = "";

function show(query) {
  shownQuery = String(query || "");
  systemView.mountSection(dom.byId("systemPage"), {
    section: SECTION,
    query: shownQuery,
    onQuery: (nextQuery, { history: mode = "push" } = {}) => {
      shownQuery = String(nextQuery || "");
      writeAddress(shownQuery, mode);
    },
    // A shape of the list has its own page (shape.html). The page takes the parameters of the list.
    // With replace, the former address /system/queries?q=<hash> is replaced.
    onOpenShape: (hash, { replace = false } = {}) => {
      const params = new URLSearchParams(shownQuery);
      params.delete("q");
      const query = params.toString();
      const target = `${router().url(`${ROUTE}/queries/${encodeURIComponent(hash)}`)}${query ? `?${query}` : ""}`;
      if (replace) window.location.replace(target);
      else window.location.assign(target);
    },
    // A table of the Activity. This opens its card in the Explorer.
    onOpenTable: (database, table) => {
      window.location.assign(router().url(`/explorer/catalog/${encodeURIComponent(database)}/${encodeURIComponent(table)}`));
    },
    onOpenDatabase: (database, options = {}) => {
      window.location.assign(databaseHref(database, options));
    },
    databaseHref,
    // "Open in Query" (Queries) opens the editor of the Query page, through the session draft that the Query page reads on load.
    // It never runs the SQL.
    onOpenSql: kit.openInQuery,
  });
}

// The Explorer page of a database (tab: "storage" scrolls to its storage).
function databaseHref(database, { tab = "" } = {}) {
  const path = `/explorer/catalog/${encodeURIComponent(String(database || ""))}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
  return router().url(path);
}

// Back and Forward inside the page. The page shows another query string of the section.
function onPopState() {
  const query = router().current().params.toString();
  if (query !== shownQuery) show(query);
}

// The links to the sections that the server offers. Queries appears only with system.top_queries.
function renderRow() {
  const f = features.get("system");
  for (const link of dom.$$("#systemTabs [data-section]")) {
    link.hidden = link.getAttribute("data-section") === "queries" && f?.top_queries === false;
  }
}

function bindShell() {
  const route = (path) => api.resolveUrl(path);
  header.setPageSelectorValue("system");
  router().on(ROUTE, onPopState);
  // Another host: the section on screen reads the new host.
  window.addEventListener("chdash:host-changed", () => systemView?.refresh?.(false));
  // A page that the back/forward cache restores is as old as the visit. The page reads again.
  window.addEventListener("pageshow", (event) => { if (event.persisted) systemView?.refresh?.(false); });
  // A new answer of /api/version can turn off a section. For example, Queries without
  // system.top_queries leaves for Overview.
  features?.on?.(() => {
    if (!features.get("system.enabled")) return; // app_ui.js leaves the page
    renderRow();
    if (SECTION.id !== "overview" && !SECTION.available(features.get("system"))) window.location.replace(route("system"));
  });
}

export async function startSystemPage(section) {
  SECTION = section;
  bindShell();
  header.init();
  renderRow();
  show(router().current().params.toString());
  // The entry carries the router's state, with its view, from the first paint. The address does not change,
  // including its fragment (#performance).
  router().write("replace", null, { href: router().href(), view: "system" });
}
