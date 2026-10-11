// The frame of the Explorer: the view tabs, the Browse | Graph tabs, the lifecycle scope of the mode on screen, the side panels (the
// tree, the function list) and their drawer on a phone, and the first row of a list.

import { dom, h, shell } from "./app_dom.js";
import { explorerFeatures, model, selectionScope, shellEl } from "./app_explorer_store.js";
import { format } from "./app_format.js";
import { icon as iconMod } from "./app_ui_icon.js";
import { lifecycle } from "./app_ui_layers.js";
import { sidePanel as sidePanelMod } from "./app_ui_panel.js";
import { uiState } from "./app_ui_state.js";
import { tabs as tabsMod } from "./app_ui_tabs.js";

const { byId, $, $$ } = dom;

// ---------------------------------------------------------------------------
// Explorer shell: top-level view tabs, Catalog modes, mobile tree drawer.
//
// Views (top tabs) and their containers (other Explorer modules render into
// these):
//   catalog    #explorerListView: the object tree + #explorerCatalogMain,
//              whose mode bar switches between two modes of one scope,
//              the tree selection (nothing, a database or an object):
//                browse   #explorerCatalogView (#explorerDetailPane): the
//                         databases overview, the database page or the
//                         table card (their storage draws through
//                         ns.explorerStorage)
//                graph    #explorerGraphPane, focused on the selection
//   functions  #explorerFunctionsPane
// Routes: the Catalog is /explorer/catalog[/<db>[/<table>[/<tab>]]][?tab=<tab>|?mode=graph]
// (parseExplorerRoute), functions /explorer/functions[/<name>]. The server
// itself is the System page (/system, app_system.js).
const VIEWS = ["catalog", "functions"];

function currentView() {
  if (model.section === "functions") return "functions";
  return "catalog";
}

function modeAvailability() {
  // ns.features: graph.enabled already requires lineage or storage_topology.
  const f = explorerFeatures();
  return {
    browse: f.enabled && f.browse,
    graph: f.enabled && f.graph.enabled,
  };
}

// The Explorer view or Catalog mode on screen is an ns.lifecycle scope
// ("explorer:browse", "explorer:graph", "explorer:functions"): what a mode
// binds while it
// shows (ns.lifecycle.bind) goes when another one shows.
let lifecycleName = "";
function syncLifecycle() {
  const next = model.section === "functions" ? "explorer:functions" : `explorer:${model.mode}`;
  if (next === lifecycleName) return;
  if (lifecycleName) lifecycle?.leave(lifecycleName);
  lifecycleName = next;
  lifecycle?.enter(next);
}

function syncViewTabs() {
  syncLifecycle();
  const view = currentView();
  // Browse | Graph belong to the Catalog view only.
  syncModeTabs();
  const shell = shellEl("explorerTopBar")?.closest?.(".explorerShell");
  if (shell) {
    shell.dataset.explorerView = view;
    shell.dataset.explorerMode = model.mode;
  }
  // Every view with a side panel gets the drawer toggle on a phone.
  const pane = drawerPane(view);
  const toggle = shellEl("explorerTreeToggle");
  if (toggle) {
    toggle.hidden = !pane;
    if (pane) {
      toggle.setAttribute("aria-controls", pane.id);
      toggle.title = pane.label;
      const text = $(".explorerTreeToggle__text", toggle);
      if (text) text.textContent = pane.label;
    }
  }
  // Every Catalog mode shares the one tree; another panel starts closed.
  const paneId = pane?.id || "";
  if (paneId !== model.drawerPaneId) setTreeDrawerOpen(false);
  model.drawerPaneId = paneId;
}

// The Catalog's Browse | Graph: second-level tabs on the nav row, after
// Catalog | Functions and a divider (as Observability's Search / Services /
// Service map after Traces / Logs / Metrics), on the Catalog only. The way
// up to the parent scope is an icon tool of the graph toolbar (Browse has
// the tree and the card header).
function syncModeTabs() {
  const available = modeAvailability();
  const tabs = shellEl("explorerModeTabs");
  let shown = 0;
  for (const button of $$("[data-mode]", tabs) || []) {
    button.hidden = !available[String(button.dataset.mode || "")];
    if (!button.hidden) shown += 1;
  }
  tabsMod?.select(tabs, model.mode, "mode");
  const hidden = shown < 2 || currentView() !== "catalog";
  if (tabs) tabs.hidden = hidden;
  const sep = shellEl("explorerModeSep");
  if (sep) sep.hidden = hidden;
  // A narrow window scrolls the row sideways: the selected tab shows clear
  // of the faded edges.
  const row = shellEl("explorerNavTabs");
  const active = hidden ? $(".is-active", shellEl("explorerViewTabs")) : $(".is-active", tabs);
  if (row && active) shell?.revealInRow?.(row, active);
  syncScopeUp();
}

function syncScopeUp() {
  const button = shellEl("explorerScopeUp");
  if (!button) return;
  const scope = selectionScope();
  const shown = model.section === "tables" && model.mode !== "browse" && !!scope.database;
  button.hidden = !shown;
  if (!shown) return;
  const label = scope.table ? `Up to ${scope.database}` : "Up to all databases";
  button.title = label;
  button.setAttribute("aria-label", label);
}

// The side panel a view slides in as a drawer on a phone (null: none).
function drawerPane(view = currentView()) {
  if (view === "catalog") return { id: "explorerListPane", label: "Objects" };
  if (view === "functions") return { id: "explorerFunctionListPane", label: "Functions" };
  return null;
}

// The tree becomes a drawer at --bp-md (ns.shell, app_dom.js).
function isMobileShell() {
  return !!shell?.isAtMost("md");
}

// The tree and the Functions list: ns.sidePanel shells, always open on
// wide windows (no rail and no head bar: the search, with its refresh
// button on its line, leads the panel); a drawer over the content on
// phones, which #explorerTreeToggle on the nav row opens for the view's
// pane (an ns.layers layer, so Escape and a press outside close it).
const sidePanels = {};
function sidePanel(id) {
  if (sidePanels[id] || !byId(id)) return sidePanels[id] || null;
  const pane = byId(id);
  const tree = id === "explorerListPane";
  sidePanels[id] = sidePanelMod.mount(pane, {
    label: tree ? "Objects" : "Functions",
    drawer: {
      toggle: shellEl("explorerTreeToggle"),
      backdrop: pane.nextElementSibling?.classList.contains("explorerTreeBackdrop") ? pane.nextElementSibling : null,
      // The toggle is shared by both panes: the Explorer names it (syncViewTabs).
      bind: false,
      manageToggle: false,
      onChange: (open) => { if (!open && model.treeOpen && drawerPane()?.id === id) setTreeDrawerOpen(false); },
    },
  });
  return sidePanels[id];
}

// Mobile: the tree is an off-canvas drawer over the content.
function setTreeDrawerOpen(open) {
  const shell = shellEl("explorerTopBar")?.closest?.(".explorerShell");
  const value = !!open && isMobileShell();
  model.treeOpen = value;
  shell?.classList.toggle("is-tree-open", value);
  const current = drawerPane()?.id || "";
  for (const id of ["explorerListPane", "explorerFunctionListPane"]) sidePanel(id)?.setDrawerOpen(value && id === current);
  const toggle = shellEl("explorerTreeToggle");
  if (toggle) {
    const label = (drawerPane()?.label || "Objects").toLowerCase();
    toggle.setAttribute("aria-expanded", String(value));
    toggle.setAttribute("aria-label", value ? `Hide ${label}` : `Show ${label}`);
  }
}

// The loading, empty or failed state of a tree or list (ns.uiState, compact).
// `clear`: the search field whose search found nothing (a "Clear the search" way out).
function listState(kind, text, retry, clear) {
  const action = clear?.handle && clear.input?.value ? { label: "Clear the search", onClick: () => { clear.handle.clear(); clear.input.focus(); } } : null;
  return uiState.block(kind, kind === "loading" ? { label: text, compact: true } : { body: text, compact: true, retry, action });
}

// A list's first row, its root: "All databases (8)" in the tree, "All
// functions (1,949)" in the Functions list. The count is what the list
// shows (its filters and search applied); current while nothing is
// selected; a click opens the overview (and closes a phone's drawer).
function rootRow({ id, icon, label, count, title, current, open }) {
  const button = h("button", {
    class: `explorerTreeDatabase explorerTreeRoot${current ? " is-selected" : ""}`,
    id,
    type: "button",
    title,
  }, iconMod.el(icon, { size: "sm", className: "explorerTreeRoot__icon" }),
  h("span", { class: "explorerTreeDatabase__name" }, `${label} `, h("span", { class: "explorerTreeRoot__count" }, `(${format.count(count)})`)));
  if (current) button.setAttribute("aria-current", "true");
  button.addEventListener("click", () => {
    setTreeDrawerOpen(false);
    if (!current) open();
  });
  return h("div", { class: "explorerTreeGroup explorerTreeRootGroup" }, button);
}

export { currentView, isMobileShell, listState, modeAvailability, rootRow, setTreeDrawerOpen, sidePanel, syncModeTabs, syncScopeUp, syncViewTabs };
