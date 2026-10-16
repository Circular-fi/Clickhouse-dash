// This module defines the addresses of the Explorer. The addresses are /explorer/catalog[/<db>[/<table>[/<tab>]]][?mode=graph] and /explorer/functions[/<name>].
// This module also handles the former addresses that still open the Explorer. parseExplorerRoute reads an address. catalogPath writes an address.

import { router } from "./app_router.js";

// The Catalog uses the prefix /explorer/catalog. Functions use the prefix /explorer/functions.
// These are two fixed prefixes. A database or a table named "functions" is only /explorer/catalog/functions.
const CATALOG_ROUTE_SEGMENT = "catalog";
const FUNCTIONS_ROUTE_SEGMENT = "functions";
// This is the former route of the Storage section. Later, it became the Storage mode of the Catalog.
// The route /explorer/_system[?database=&table=] stays an alias of the storage. It opens one of these pages:
// the storage of the database page (/explorer/catalog/<db>, scrolled to it), the Storage tab of the table card (/explorer/catalog/<db>/<table>?tab=storage), or the databases overview.
// The server serves this route. The other former addresses (/explorer/<db>/..., /explorer/_functions, /explorer/_monitoring, /explorer/_operations) get a redirect (server.cpp).
const SYSTEM_ROUTE_SEGMENT = "_system";

// Catalog modes. Browse is the default mode. It has no ?mode= parameter.
// The former Storage mode is now the storage of the database page and the Storage tab of the table card.
const MODES = ["browse", "graph"];

// The tabs of the table detail. app_explorer_detail.js hides the tabs that have no content.
const TABS = ["Columns", "Preview", "Storage", "Operations", "Lineage", "DDL"];
const DEFAULT_TAB = TABS[0];

// Former tab slugs open the tab that took over their content.
const TAB_BY_SLUG = new Map([
  ...TABS.map((label) => [label.toLowerCase(), label]),
  ["overview", "Columns"], ["schema", "Columns"], ["data", "Preview"],
]);

// The database page has no tabs. It has its objects and then its storage.
// An old address with ?tab=storage or ?tab=objects opens the database page. The storage is scrolled into view.
function databaseFocusOf(slug) {
  return String(slug || "").toLowerCase() === "storage" ? "storage" : "";
}

function decodeRouteSegment(value) {
  try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
}

function encodeRouteSegment(value) {
  return encodeURIComponent(String(value || ""));
}

// The address bar uses ns.router from app_router.js. The Explorer writes the address bar while its workspace shows.
const appRoute = (path) => router.url(path);

// This is the URL scheme of the Catalog:
//   /explorer/catalog[/<db>[/<table>]][?tab=<table card tab>|?mode=graph]
// Browse has no mode. It uses ?tab= to name the table card tab. Columns is the default tab and has no ?tab= value. A database page has no tabs.
// Graph adds &graph=lineage|storage&depth=N.
// These aliases are rewritten to this form by applyRouteFromLocation:
//   ?view=browse|graph (former Browse and Graph views),
//   ?mode=storage and /explorer/_system[?database=&table=] (the former Storage mode and view). They open the Storage tab of the table card, or the database page scrolled to its storage, or the databases overview at the root,
//   /explorer/catalog/<db>?tab=storage|objects (the former database card tabs). This opens the database page. With tab=storage, the page scrolls to the storage,
//   /explorer/catalog/<db>/<table>/<tab> (the card tab as a path segment), and
//   the former card tab slugs (overview, schema, data).
function parseExplorerRoute(pathname = window.location.pathname) {
  const path = router.path(pathname).replace(/\/+$/, "") || "/";
  const params = router.current().params;
  const modeParam = String(params.get("mode") || "");
  const mode = MODES.includes(modeParam) ? modeParam : (params.get("view") === "graph" ? "graph" : "browse");
  // The former Storage mode uses the Storage tab of the card, in Browse.
  const storageAlias = modeParam === "storage";
  const graphType = params.get("graph") === "storage" ? "physical" : "logical";
  const hasDepth = params.has("depth");
  const parsedDepth = hasDepth ? Number(params.get("depth")) : Number.NaN;
  const graphDepth = Number.isFinite(parsedDepth) ? Math.max(0, Math.min(8, Math.trunc(parsedDepth))) : 1;
  const catalog = { workspace: "explorer", section: "tables", database: "", table: "", tab: DEFAULT_TAB, databaseFocus: "", mode, graphType, graphDepth };
  // The bare /explorer address is the redirect of the server. This function reads it as the Catalog root.
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

// The Catalog URL for a scope in a mode. The scheme is the one of parseExplorerRoute.
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
