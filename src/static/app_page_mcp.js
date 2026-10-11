// The MCP integration page (mcp.html, /mcp-integration, docs/mcp-integration-page.md): the endpoint
// of the MCP server that is built into ChDash and the access keys of its clients. It is a page of
// its own and not tied to a host: the header block and the keys table come from /api/mcp/meta and
// /api/mcp/keys (ns.api, app_api.js), the key form and the one-time secret from app_mcp_form.js.
//
// This controller starts the page's modules (ns.loader), the header (ns.header.init: page switcher,
// theme), loads the two answers and runs the actions of a key: create and delete (a key is never
// changed). The details of a key open under its row (app_mcp_view.js). The keys (#mcpKeys, with the New key and Refresh buttons in its heading) and
// the side column (#mcpSide) are drawn again after every change; #mcpState holds the loading, the
// error and the "MCP is off" states. The page list of the switcher shows MCP only when /api/version reports
// features.mcp.enabled; a page opened with MCP off shows the HCL block that turns it on.

import "./app_common.js";
import { api } from "./app_api.js";
import { boot } from "./app_boot.js";
import { dom } from "./app_dom.js";
import { header } from "./app_header.js";
import { mcpForm } from "./app_mcp_form.js";
import { mcpView } from "./app_mcp_view.js";
import { dialog } from "./app_ui_dialog.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

// openKeyId: the key whose details show; filterText: the text of the keys filter (both survive a redraw of the list).
const state = { meta: null, keys: [], status: "loading", error: null, access: null, openKeyId: "", filterText: "" };
// Every read is cancelable (util.latest): "mcp.state" is the meta and the keys (a load or a reload: the newest wins and
// aborts the one in flight), "mcp.access" the counts of the data of the keys.
const STATE_KEY = "mcp.state";
const actions = () => ({
  onCreate: createKey,
  onDelete: deleteKey,
  onRefresh: (button) => reload(button),
  onRetry: () => load(),
  onOpenChange: (id) => { state.openKeyId = id; },
  onFilter: (text) => { state.filterText = text; },
  keyDetails: (args) => mcpForm.keyDetails(args),
  onDetailsClose: () => util.latest.cancelPrefix(mcpForm.REACH_SLOT),
});

// How many databases and tables each key reaches: asked once for all the keys, after the table is drawn, and written in
// its cells (the table is not drawn again, so a key that is open stays open).
async function loadAccess({ refresh = false } = {}) {
  if (state.status !== "ready" || !state.keys.length) {
    util.latest.cancel("mcp.access");
    return;
  }
  const req = util.latest("mcp.access");
  try {
    const access = await api.getMcpAccessSummary({ refresh, signal: req.signal });
    if (!req.isCurrent()) return;
    state.access = access;
    mcpView.fillAccess(dom.byId("mcpKeys"), access);
  } catch (error) {
    if (!req.isCurrent()) return;
    state.access = null;
    mcpView.fillAccess(dom.byId("mcpKeys"), null, util.errorText(error, "The data of the keys could not be counted."));
  }
}

// The view of the keys is the page's state, read when it is needed (a row that opens late reads the meta of now).
const liveView = Object.defineProperties({}, {
  meta: { get: () => state.meta, enumerable: true },
  keys: { get: () => state.keys, enumerable: true },
  status: { get: () => state.status, enumerable: true },
  error: { get: () => state.error, enumerable: true },
  openKeyId: { get: () => state.openKeyId, set: (value) => { state.openKeyId = value; }, enumerable: true },
  filterText: { get: () => state.filterText, enumerable: true },
});

function renderKeys({ refresh = false } = {}) {
  dom.byId("mcpLayout").hidden = false;
  dom.byId("mcpState").replaceChildren();
  mcpView.renderKeys(dom.byId("mcpKeys"), liveView, actions());
  // The counts that are known show at once; they are asked again (the grants of a host are kept 60 s by the server).
  if (state.access) mcpView.fillAccess(dom.byId("mcpKeys"), state.access);
  void loadAccess({ refresh });
}

// Nothing of the keys or the side column shows: the state is loading, off or in error.
function clearBody() {
  dom.byId("mcpKeys").replaceChildren();
  dom.byId("mcpSide").replaceChildren();
  dom.byId("mcpLayout").hidden = true;
}

function renderStateError(error) {
  uiState.error(dom.byId("mcpState"), { title: "Could not load the MCP state", body: util.errorText(error), retry: () => load() });
  clearBody();
}

// The first load: the header block and the keys, each with its own loading state.
// `retried`: MCP turned off between the two reads (the meta said on, the keys say off): the meta is read once more,
// and a second disagreement is an error, not a loop of requests.
async function load({ retried = false } = {}) {
  const req = util.latest(STATE_KEY);
  state.status = "loading";
  state.error = null;
  uiState.loading(dom.byId("mcpState"), { label: "Loading the MCP state\u2026" });
  clearBody();
  let meta;
  try {
    meta = await api.getMcpMeta({ signal: req.signal });
  } catch (error) {
    if (req.isCurrent()) renderStateError(error);
    return;
  }
  if (!req.isCurrent()) return;
  state.meta = meta;
  if (!meta.enabled) {
    mcpView.renderDisabled(dom.byId("mcpState"));
    return;
  }
  state.keys = [];
  mcpView.renderSide(dom.byId("mcpSide"), meta);
  renderKeys();
  try {
    state.keys = await api.getMcpKeys({ signal: req.signal });
    state.status = "ready";
  } catch (error) {
    if (!req.isCurrent()) return;
    if (error?.mcp?.code === "mcp_disabled" && !retried) {
      await load({ retried: true });
      return;
    }
    state.status = "error";
    state.error = error;
  }
  if (!req.isCurrent()) return;
  renderKeys();
}

// A reload that keeps what is on screen: after an action, and the Refresh button.
async function reload(button = null) {
  const req = util.latest(STATE_KEY);
  if (button) {
    uiState.busy(button, true);
    mcpForm.forgetReach();
  }
  try {
    const [meta, keys] = await Promise.all([api.getMcpMeta({ signal: req.signal }), api.getMcpKeys({ signal: req.signal })]);
    if (!req.isCurrent()) return;
    if (!meta.enabled) {
      state.meta = meta;
      mcpView.renderDisabled(dom.byId("mcpState"));
      clearBody();
      return;
    }
    state.meta = meta;
    state.keys = keys;
    state.status = "ready";
    mcpView.renderSide(dom.byId("mcpSide"), meta);
    // The Refresh button reads the grants of the MCP users again; an action (a key made or deleted) uses what is kept.
    renderKeys({ refresh: !!button });
  } catch (error) {
    if (!req.isCurrent()) return;
    showAlert(error);
  } finally {
    if (button?.isConnected) uiState.busy(button, false);
  }
}

function showAlert(error) {
  const box = dom.byId("mcpAlert");
  if (!box) return;
  uiState.banner(box, { message: util.errorText(error, "The change failed.") });
  box.hidden = !box.textContent;
  if (!box.hidden) box.scrollIntoView?.({ block: "nearest" });
}

function clearAlert() {
  const box = dom.byId("mcpAlert");
  if (box) {
    box.replaceChildren();
    box.hidden = true;
  }
}

// The focus after a list that was drawn again: the same button of the same row, else New key.
function focusRow(id, action) {
  const row = id ? dom.$(`tr[data-key-id="${CSS.escape(id)}"]`, dom.byId("mcpKeys")) : null;
  const target = (row && dom.$(`[data-action="${action}"]:not(:disabled)`, row)) || dom.byId("mcpNewKey");
  target?.focus();
}

// An action: the call, then a reload of the list. A failure shows above the table.
async function run(call, { id = "", action = "", message = "" } = {}) {
  clearAlert();
  try {
    const result = await call();
    await reload();
    if (message) uiState.announce(message);
    focusRow(id, action);
    return result;
  } catch (error) {
    // A key that is gone, or MCP turned off meanwhile: the list is stale. The reload draws the
    // table again, so the error shows after it.
    if (["not_found", "mcp_disabled", "storage_not_configured"].includes(error?.mcp?.code)) await reload();
    showAlert(error);
    return null;
  }
}

async function createKey(opener) {
  clearAlert();
  const result = await mcpForm.openKeyForm({ meta: state.meta, submit: (input) => api.createMcpKey(input) });
  if (!result) {
    opener?.focus?.();
    return;
  }
  // The secret shows at once and only once: the list is read again behind the dialog, never in front of it.
  const reloading = reload();
  uiState.announce(`Key ${result.key.name} created`);
  await mcpForm.showSecret({ meta: state.meta, key: result.key, secret: result.secret });
  await reloading;
  focusRow(result.key.id, "open");
}

// What a destructive action touches: the hosts of the key.
function reach(key) {
  const hosts = !key.hosts.length ? "no host" : key.hosts.includes("*") ? "all hosts" : key.hosts.join(", ");
  return `This key reads ${hosts}.`;
}

async function deleteKey(key) {
  const ok = await dialog.confirm({
    title: `Delete key ${key.name}?`,
    message: `This cannot be undone. Clients that use this key lose access at once. ${reach(key)}`,
    confirmLabel: "Delete key",
    danger: true,
    className: "mcpDialog",
  });
  if (!ok) {
    focusRow(key.id, "remove");
    return;
  }
  await run(() => api.deleteMcpKey(key.id), { message: `Key ${key.name} deleted` });
}

async function start() {
  header.setPageSelectorValue("mcp");
  header.init();
  // A page restored from the back/forward cache is as old as the visit: it reads again.
  window.addEventListener("pageshow", (event) => { if (event.persisted) void reload(); });
  await load();
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
import * as h_route_notice from "./app_route_notice.js";
import * as h_boot from "./app_boot.js";
import * as h_header from "./app_header.js";
import * as h_mcp_view from "./app_mcp_view.js";
import * as h_ui_dialog from "./app_ui_dialog.js";
import * as h_mcp_form from "./app_mcp_form.js";
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
  h_route_notice,
  h_boot,
  h_header,
  h_mcp_view,
  h_ui_dialog,
  h_mcp_form,
]);
// handle:end

boot(start);
