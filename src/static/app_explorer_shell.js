// This module builds the frame of the Explorer. The frame has the view tabs and the Browse | Graph tabs.
// It also has the lifecycle scope of the mode on screen, the side panels (the tree and the function list), and their drawer on a phone. It also has the first row of a list.

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
// Views (top tabs) and their containers. The other Explorer modules render into these containers:
//   catalog    #explorerListView: the object tree and #explorerCatalogMain.
//              The mode bar switches between two modes of one scope,
//              the tree selection (nothing, a database or an object):
//                browse   #explorerCatalogView (#explorerDetailPane): the
//                         databases overview, the database page or the
//                         table card. Their storage uses
//                         ns.explorerStorage)
//                graph    #explorerGraphPane, focused on the selection
//   functions  #explorerFunctionsPane
// Routes: the Catalog is /explorer/catalog[/<db>[/<table>[/<tab>]]][?tab=<tab>|?mode=graph]
// (parseExplorerRoute). The Functions view uses /explorer/functions[/<name>]. The server
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

// The Explorer view or Catalog mode on screen is an ns.lifecycle scope.
// The scope names are "explorer:browse", "explorer:graph" and "explorer:functions".
// A mode removes the bindings that it creates with ns.lifecycle.bind when another mode shows.
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
  // The Browse and Graph tabs belong to the Catalog view only.
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
  // Every Catalog mode shares one tree. When the panel changes, the drawer closes.
  const paneId = pane?.id || "";
  if (paneId !== model.drawerPaneId) setTreeDrawerOpen(false);
  model.drawerPaneId = paneId;
}

// The Browse and Graph tabs are second-level tabs on the nav row. They follow Catalog and Functions and a divider.
// This matches Observability: Search, Services and Service map follow Traces, Logs and Metrics.
// The tabs show on the Catalog only. To move to the parent scope, use the icon tool of the graph toolbar.
// Browse has the tree and the card header instead.
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
  // A narrow window scrolls the row sideways. The selected tab shows clear of the faded edges.
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

// The side panel that a view shows as a drawer on a phone. The value is null when there is no such panel.
function drawerPane(view = currentView()) {
  if (view === "catalog") return { id: "explorerListPane", label: "Objects" };
  if (view === "functions") return { id: "explorerFunctionListPane", label: "Functions" };
  return null;
}

// The tree becomes a drawer at --bp-md (ns.shell, app_dom.js).
function isMobileShell() {
  return !!shell?.isAtMost("md");
}

// The tree and the Functions list use ns.sidePanel shells. On wide windows, they are always open.
// They have no rail and no head bar. The search leads the panel, and its refresh button is on the same line.
// On phones, they are drawers over the content. The #explorerTreeToggle button on the nav row opens the drawer for the pane of the view.
// The drawer is an ns.layers layer. So Escape, and a press outside the drawer, close it.
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
      // The toggle is shared by both panes. The Explorer names it (syncViewTabs).
      bind: false,
      manageToggle: false,
      onChange: (open) => { if (!open && model.treeOpen && drawerPane()?.id === id) setTreeDrawerOpen(false); },
    },
  });
  return sidePanels[id];
}

// On a phone, the tree is an off-canvas drawer over the content.
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

// The loading, empty or failed state of a tree or a list (ns.uiState, compact).
// `clear` is the search field. When the search finds nothing, the field gives a "Clear the search" action.
function listState(kind, text, retry, clear) {
  const action = clear?.handle && clear.input?.value ? { label: "Clear the search", onClick: () => { clear.handle.clear(); clear.input.focus(); } } : null;
  return uiState.block(kind, kind === "loading" ? { label: text, compact: true } : { body: text, compact: true, retry, action });
}

// The first row of a list is its root. Examples: "All databases (8)" in the tree and "All functions (1,949)" in the Functions list.
// The count is the count of what the list shows, with its filters and search applied. The row is current while nothing is selected.
// A click opens the overview and closes the drawer of a phone.
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
