// A System page (docs/system.md): the selected server, one section per page, a row of links to
// the sections under the header (app_system_view.js):
//
//   /system[?from=&to=]                  Overview (system.html): the charts' time range
//   /system/queries[?from=&to=&sort=&kind=&hide=0&runs=]   (queries.html)
//   /system/disks[?from=&to=]                              (disks.html)
//
// Each page's entry imports its own section's module (a section is an object, { id, label, available, create }) and
// hands it to startSystemPage(); each section keeps its own parameters; Back / Forward walk the browser's history, from page to page and, within
// a page, from one query string to the next. One query shape is a page of its own too
// (shape.html, app_page_shape.js). The former Explorer addresses
// (/explorer/_monitoring[/<section>], /explorer/_operations) answer a redirect here
// (server.cpp redirect_to_system).
//
// This controller starts the page's modules (through ns.loader), the header (ns.header.init: host
// picker, page switcher, theme) and the view; a host change refreshes the section on screen.

import { api } from "./app_api.js";
import { dom as domMod } from "./app_dom.js";
import { header } from "./app_header.js";
import { router as routerMod } from "./app_router.js";
import { features } from "./app_state.js";
import { kit } from "./app_system_kit.js";
import { systemView } from "./app_system_view.js";

const ROUTE = "/system";
// The section this page shows: startSystemPage() gets it ({ id: "overview", "queries" or "disks", ... }).
let SECTION = null;

const router = () => routerMod;

const sectionPath = () => (SECTION.id === "overview" ? ROUTE : `${ROUTE}/${SECTION.id}`);

// The address of the section with its query, as a replace (the page's own address is the
// section's: a change of parameters) or a push (a new search).
function writeAddress(query, history) {
  const href = `${router().url(sectionPath())}${query ? `?${query}` : ""}`;
  router().write(history, null, { href, view: "system" });
}

let shownQuery = "";

function show(query) {
  shownQuery = String(query || "");
  systemView.mountSection(domMod.byId("systemPage"), {
    section: SECTION,
    query: shownQuery,
    onQuery: (nextQuery, { history: mode = "push" } = {}) => {
      shownQuery = String(nextQuery || "");
      writeAddress(shownQuery, mode);
    },
    // A shape of the list: its own page (shape.html), with the list's
    // parameters; replace: the former /system/queries?q=<hash> address.
    onOpenShape: (hash, { replace = false } = {}) => {
      const params = new URLSearchParams(shownQuery);
      params.delete("q");
      const query = params.toString();
      const target = `${router().url(`${ROUTE}/queries/${encodeURIComponent(hash)}`)}${query ? `?${query}` : ""}`;
      if (replace) window.location.replace(target);
      else window.location.assign(target);
    },
    // A table of the Activity: its card in the Explorer.
    onOpenTable: (database, table) => {
      window.location.assign(router().url(`/explorer/catalog/${encodeURIComponent(database)}/${encodeURIComponent(table)}`));
    },
    onOpenDatabase: (database, options = {}) => {
      window.location.assign(databaseHref(database, options));
    },
    databaseHref,
    // "Open in Query" (Queries): the Query page's editor, through the session draft the Query page reads on load. Never run.
    onOpenSql: kit.openInQuery,
  });
}

// A database's Explorer page (tab: "storage" scrolls to its storage).
function databaseHref(database, { tab = "" } = {}) {
  const path = `/explorer/catalog/${encodeURIComponent(String(database || ""))}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
  return router().url(path);
}

// Back / Forward within the page: another query string of the section.
function onPopState() {
  const query = router().current().params.toString();
  if (query !== shownQuery) show(query);
}

// The links to the sections the server offers: Queries only with system.top_queries.
function renderRow() {
  const f = features.get("system");
  for (const link of domMod.$$("#systemTabs [data-section]")) {
    link.hidden = link.getAttribute("data-section") === "queries" && f?.top_queries === false;
  }
}

function bindShell() {
  const route = (path) => api.resolveUrl(path);
  header.setPageSelectorValue("system");
  router().on(ROUTE, onPopState);
  // Another host: the section on screen reads it.
  window.addEventListener("chdash:host-changed", () => systemView?.refresh?.(false));
  // A page restored from the back/forward cache is as old as the visit: it reads again.
  window.addEventListener("pageshow", (event) => { if (event.persisted) systemView?.refresh?.(false); });
  // A section a new answer of /api/version turns off (Queries without
  // system.top_queries) leaves for Overview.
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
  // The entry carries the router's state (its view) from the first paint on; the address, its
  // fragment (#performance) included, stays as it is.
  router().write("replace", null, { href: router().href(), view: "system" });
}

