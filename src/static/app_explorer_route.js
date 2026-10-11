// The addresses of the Explorer: /explorer/catalog[/<db>[/<table>[/<tab>]]][?mode=graph] and /explorer/functions[/<name>], and the
// former addresses that still open them. parseExplorerRoute reads an address, catalogPath writes one.

import { router } from "./app_router.js";

// The Catalog lives under /explorer/catalog and Functions under
// /explorer/functions: two fixed prefixes, so a database or a table named
// "functions" is only ever /explorer/catalog/functions.
const CATALOG_ROUTE_SEGMENT = "catalog";
const FUNCTIONS_ROUTE_SEGMENT = "functions";
// Former route of the Storage section (later the Catalog's Storage mode):
// /explorer/_system[?database=&table=] stays an alias of the storage of
// the database page (/explorer/catalog/<db>, scrolled to it) or of the
// table card's Storage tab (/explorer/catalog/<db>/<table>?tab=storage),
// or of the databases overview. The server serves it; the other former
// addresses (/explorer/<db>/..., /explorer/_functions, /explorer/_monitoring,
// /explorer/_operations) answer a redirect (server.cpp).
const SYSTEM_ROUTE_SEGMENT = "_system";

// Catalog modes; Browse is the default and has no ?mode= parameter. The
// former Storage mode is the storage of the database page and the Storage
// tab of the table card.
const MODES = ["browse", "graph"];

// Table detail tabs (app_explorer_detail.js hides the ones without content).
const TABS = ["Columns", "Preview", "Storage", "Operations", "Lineage", "DDL"];
const DEFAULT_TAB = TABS[0];

// Former tab slugs open the tab that took their content over.
const TAB_BY_SLUG = new Map([
  ...TABS.map((label) => [label.toLowerCase(), label]),
  ["overview", "Columns"], ["schema", "Columns"], ["data", "Preview"],
]);

// The database page has no tabs: its objects, then its storage. A former
// ?tab=storage (or ?tab=objects) address opens it, the storage scrolled
// into view.
function databaseFocusOf(slug) {
  return String(slug || "").toLowerCase() === "storage" ? "storage" : "";
}

function decodeRouteSegment(value) {
  try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
}

function encodeRouteSegment(value) {
  return encodeURIComponent(String(value || ""));
}

// The address bar is ns.router's (app_router.js); the Explorer writes it
// while its workspace shows.
const appRoute = (path) => router.url(path);

// One URL scheme for the Catalog:
//   /explorer/catalog[/<db>[/<table>]][?tab=<table card tab>|?mode=graph]
// Browse (no mode) names the table card's tab in ?tab= (Columns, the
// default, has none; a database page has no tabs); Graph adds
// &graph=lineage|storage&depth=N. Aliases, rewritten to that form by
// applyRouteFromLocation:
//   ?view=browse|graph (former Browse / Graph views),
//   ?mode=storage and /explorer/_system[?database=&table=] (the former
//   Storage mode and view): the table card's Storage tab, the database
//   page scrolled to its storage, or the databases overview at the root,
//   /explorer/catalog/<db>?tab=storage|objects (the former database card tabs):
//   the database page, scrolled to its storage for the first,
//   /explorer/catalog/<db>/<table>/<tab> (the card tab as a path segment) and the
//   former card tab slugs (overview, schema, data).
function parseExplorerRoute(pathname = window.location.pathname) {
  const path = router.path(pathname).replace(/\/+$/, "") || "/";
  const params = router.current().params;
  const modeParam = String(params.get("mode") || "");
  const mode = MODES.includes(modeParam) ? modeParam : (params.get("view") === "graph" ? "graph" : "browse");
  // The former Storage mode: the Storage tab of the card, in Browse.
  const storageAlias = modeParam === "storage";
  const graphType = params.get("graph") === "storage" ? "physical" : "logical";
  const hasDepth = params.has("depth");
  const parsedDepth = hasDepth ? Number(params.get("depth")) : Number.NaN;
  const graphDepth = Number.isFinite(parsedDepth) ? Math.max(0, Math.min(8, Math.trunc(parsedDepth))) : 1;
  const catalog = { workspace: "explorer", section: "tables", database: "", table: "", tab: DEFAULT_TAB, databaseFocus: "", mode, graphType, graphDepth };
  // The bare /explorer is the server's redirect; it reads as the Catalog root here too.
  if (path === "/explorer") return catalog;
  if (!path.startsWith("/explorer/")) return { workspace: "query" };
  const parts = path.slice("/explorer/".length).split("/").filter(Boolean).map(decodeRouteSegment);
  if (parts[0] === FUNCTIONS_ROUTE_SEGMENT) {
    return { workspace: "explorer", section: "functions", functionName: parts[1] || "" };
  }
  if (parts[0] === SYSTEM_ROUTE_SEGMENT) {
    const database = params.get("database") || "";
    const table = database ? params.get("table") || "" : "";
    return { ...catalog, mode: "browse", database, table, tab: "Storage", databaseFocus: table ? "" : "storage" };
  }
  // Any other address (/explorer/catalog[/<db>[/<table>[/<tab>]]]) is the Catalog.
  const scope = parts[0] === CATALOG_ROUTE_SEGMENT ? parts.slice(1) : parts;
  const database = scope[0] || "";
  const table = scope[1] || "";
  const slug = storageAlias ? "storage" : String(params.get("tab") || scope[2] || "");
  const tab = TAB_BY_SLUG.get((slug || DEFAULT_TAB).toLowerCase()) || DEFAULT_TAB;
  return { ...catalog, database, table, tab, databaseFocus: table ? "" : databaseFocusOf(slug) };
}

// The Catalog URL of a scope in a mode (the scheme of parseExplorerRoute).
function catalogPath({ database = "", table = "", tab = DEFAULT_TAB, mode = "browse", graphRoute = null } = {}) {
  let path = `/explorer/${CATALOG_ROUTE_SEGMENT}`;
  if (database) path += `/${encodeRouteSegment(database)}`;
  if (database && table) path += `/${encodeRouteSegment(table)}`;
  const params = new URLSearchParams();
  if (mode === "browse" && database && table && tab && tab !== DEFAULT_TAB) params.set("tab", String(tab).toLowerCase());
  if (mode !== "browse") params.set("mode", mode);
  if (mode === "graph") {
    const route = graphRoute || { mode: "logical", depth: 1 };
    params.set("graph", route.mode === "physical" ? "storage" : "lineage");
    if (route.mode !== "physical") params.set("depth", String(route.depth ?? 1));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export { CATALOG_ROUTE_SEGMENT, DEFAULT_TAB, FUNCTIONS_ROUTE_SEGMENT, MODES, appRoute, catalogPath, encodeRouteSegment, parseExplorerRoute };
