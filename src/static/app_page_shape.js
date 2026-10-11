// The page of one query shape (shape.html, /system/queries/<hash>): a page
// of its own, not a view of the System page. It has the page header, but
// not the System section tabs (Overview, Queries, Disks) nor the list of
// shapes: the Queries section (app_system_queries.js) runs on the one
// shape, with the time range and the refresh button of its filter bar.
//
//   /system/queries/<hash>[?from=&to=&runs=<order>&<the list's parameters>]
//
// The address keeps the list's parameters (sort, kind, errors, user,
// database, table, hide) from the list the shape was opened from, so "All
// queries" returns to that list: to the very list entry (the browser
// restores that page as it was left, or reads it again) when the shape was
// opened from it, else to the list of those parameters. The former address
// of a shape, /system/queries?q=<hash>, opens this page (the server
// redirects it; the Queries section does when the server is a proxy away).

import "./app_common.js";
import { api } from "./app_api.js";
import { boot } from "./app_boot.js";
import { dom } from "./app_dom.js";
import { header } from "./app_header.js";
import { meta } from "./app_meta.js";
import { router as routerMod } from "./app_router.js";
import { features } from "./app_state.js";
import { kit } from "./app_system_kit.js";
import { systemQueries } from "./app_system_queries.js";
import { systemView } from "./app_system_view.js";

const LIST_ROUTE = "/system/queries";
const SHAPE_PATH = /^\/system\/queries\/(\d{1,20})\/?$/;

const router = () => routerMod;

const hashOf = (path = router().current().path) => SHAPE_PATH.exec(String(path || ""))?.[1] || "";

function href(path, params) {
  const query = params.toString();
  return `${router().url(path)}${query ? `?${query}` : ""}`;
}

// The list's parameters of the address: everything but the shape's own.
function listParams() {
  const params = new URLSearchParams(router().current().params);
  params.delete("runs");
  return params;
}

const listHref = () => href(LIST_ROUTE, listParams());

// The list page is the entry right before this one: marked on the entry
// itself, so a reload keeps it (the referrer and the entry state both
// survive one). state.listBack counts the entries this page pushed since.
function markOpenedFromList() {
  if (Number(router().state().listBack) > 0 || !document.referrer) return;
  let from;
  try { from = new URL(document.referrer); } catch (_) { return; }
  if (from.origin !== window.location.origin) return;
  if (router().path(from.pathname).replace(/\/+$/, "") !== LIST_ROUTE) return;
  router().replace(null, { href: router().href(), state: { listBack: 1 } });
}

function back() {
  const steps = Number(router().state().listBack) || 0;
  if (steps > 0) router().back(steps);
  else window.location.assign(listHref());
}

// The address of the shape with the section's parameters (its range, the
// runs' order and the list's filters).
function writeAddress(query, history) {
  const steps = Number(router().state().listBack) || 0;
  const state = steps > 0 && history === "push" ? { listBack: steps + 1 } : undefined;
  router().write(history, null, { href: href(`${LIST_ROUTE}/${hashOf()}`, new URLSearchParams(query)), view: "shape", state });
}

// Another shape: its own page (the list's parameters travel with it).
function openShape(hash, { replace = false } = {}) {
  const target = href(`${LIST_ROUTE}/${encodeURIComponent(hash)}`, router().current().params);
  if (replace) window.location.replace(target);
  else window.location.assign(target);
}

function show() {
  systemView.mountSection(dom.byId("systemPage"), {
    section: systemQueries,
    shape: hashOf(),
    query: router().current().params.toString(),
    onQuery: (query, { history: mode = "push" } = {}) => writeAddress(query, mode),
    onOpenShape: openShape,
    onBack: back,
    // "Open in Query": the Query page's editor, through the session draft the Query page reads on load. Never run.
    onOpenSql: kit.openInQuery,
  });
}

// Back / Forward within the shape's page: its range or runs' order.
function onPopState() {
  if (hashOf()) show();
}

function bindShell() {
  const route = (path) => api.resolveUrl(path);
  header.setPageSelectorValue("system");
  router().on("/system", onPopState);
  // Another host: the shape on screen reads it.
  window.addEventListener("chdash:host-changed", () => systemView?.refresh?.(false));
  // A page restored from the back/forward cache is as old as the visit: it reads again.
  window.addEventListener("pageshow", (event) => { if (event.persisted) systemView?.refresh?.(false); });
  // Queries turned off (system.top_queries): the System page is what is left.
  features?.on?.(() => {
    if (!features.get("system.enabled")) return; // app_header.js leaves the page
    if (!systemQueries.available(features.get("system"))) window.location.replace(route("system"));
  });
}

async function start() {
  bindShell();
  header.init();
  meta.init();
  if (!hashOf()) {
    window.location.replace(router().url("/system/queries"));
    return;
  }
  markOpenedFromList();
  show();
}

// handle:start - generated by tools/build_page_css.py (tools/module_graph.py): the namespace of every module of the page, for window.ChDash (app_loader.js). Do not edit.
import * as h_format from "./app_format.js";
import * as h_assets from "./app_assets.js";
import * as h_loader from "./app_loader.js";
import * as h_state from "./app_state.js";
import * as h_wasm from "./app_wasm.js";
import * as h_palette from "./app_palette.js";
import * as h_dom from "./app_dom.js";
import * as h_ui_layers from "./app_ui_layers.js";
import * as h_router from "./app_router.js";
import * as h_ui_popover from "./app_ui_popover.js";
import * as h_util from "./app_util.js";
import * as h_ui_icon from "./app_ui_icon.js";
import * as h_ui_panel from "./app_ui_panel.js";
import * as h_ui_tabs from "./app_ui_tabs.js";
import * as h_ui_segmented from "./app_ui_segmented.js";
import * as h_ui_menu from "./app_ui_menu.js";
import * as h_ui_state from "./app_ui_state.js";
import * as h_ui_search from "./app_ui_search.js";
import * as h_ui_copy from "./app_ui_copy.js";
import * as h_ui_table from "./app_ui_table.js";
import * as h_ui_badge from "./app_ui_badge.js";
import * as h_ui_sql from "./app_ui_sql.js";
import * as h_ui_kv from "./app_ui_kv.js";
import * as h_ui_stat from "./app_ui_stat.js";
import * as h_ui_chart from "./app_ui_chart.js";
import * as h_common from "./app_common.js";
import * as h_api from "./app_api.js";
import * as h_boot from "./app_boot.js";
import * as h_header from "./app_header.js";
import * as h_meta from "./app_meta.js";
import * as h_system_kit from "./app_system_kit.js";
import * as h_chart_core from "./app_chart_core.js";
import * as h_timerange from "./app_timerange.js";
import * as h_system_charts from "./app_system_charts.js";
import * as h_system_queries from "./app_system_queries.js";
import * as h_ui_filterbar from "./app_ui_filterbar.js";
import * as h_system_view from "./app_system_view.js";
h_loader.loader.expose([
  h_format,
  h_assets,
  h_loader,
  h_state,
  h_wasm,
  h_palette,
  h_dom,
  h_ui_layers,
  h_router,
  h_ui_popover,
  h_util,
  h_ui_icon,
  h_ui_panel,
  h_ui_tabs,
  h_ui_segmented,
  h_ui_menu,
  h_ui_state,
  h_ui_search,
  h_ui_copy,
  h_ui_table,
  h_ui_badge,
  h_ui_sql,
  h_ui_kv,
  h_ui_stat,
  h_ui_chart,
  h_common,
  h_api,
  h_boot,
  h_header,
  h_meta,
  h_system_kit,
  h_chart_core,
  h_timerange,
  h_system_charts,
  h_system_queries,
  h_ui_filterbar,
  h_system_view,
]);
// handle:end

boot(start);
