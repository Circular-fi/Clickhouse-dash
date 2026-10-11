// The controller of the Functions page (functions.html, /explorer/functions[/<name>]): the list of the functions of the host and the card of one.
// It starts the page, applies its address (a function, or the overview), loads the functions of the host and forgets them when the host changes.
// It shares the store and the modules of the Functions list (app_explorer_functions.js) with the Catalog's controller (app_explorer.js) and loads
// none of the Catalog (the tree, the database page, the table card, the graph).

import { dom, shell } from "./app_dom.js";
import { forgetFunctionsLoad, refreshFunctions, renderFunctionDetail, renderFunctionList, revealSelectedFunction } from "./app_explorer_functions.js";
import { parseExplorerRoute } from "./app_explorer_route.js";
import { sidePanel, setTreeDrawerOpen, syncViewTabs } from "./app_explorer_shell.js";
import { explorerFeatures, model, searches, shellEl } from "./app_explorer_store.js";
import { functionKey } from "./app_explorer_summary.js";
import { header } from "./app_header.js";
import { meta } from "./app_meta.js";
import { router } from "./app_router.js";
import { search } from "./app_ui_search.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { $$ } = dom;

// The page is on screen: the Explorer is a feature the server can turn off, and then nothing of it runs.
function openPage() {
  if (explorerFeatures().enabled === false) return false;
  model.active = true;
  model.section = "functions";
  header.setPageSelectorValue("explorer");
  return true;
}

function showFunctions() {
  if (dom.explorerFunctionsPane) dom.explorerFunctionsPane.hidden = false;
  syncViewTabs();
  renderFunctionList();
  if (model.active) refreshFunctions(false);
}

// The address: a function opens its card, the bare address the overview. Back / Forward come here too (ns.router).
function applyRouteFromLocation() {
  const route = parseExplorerRoute();
  model.routeIntent = route;
  if (!openPage()) return;
  showFunctions();
  if (!model.functionsCatalog) return;
  if (route.functionName) {
    const item = (model.functionsCatalog.functions || []).find((candidate) => candidate.name === route.functionName) || null;
    model.selectedFunctionKey = item ? functionKey(item) : null;
    renderFunctionList();
    renderFunctionDetail();
    revealSelectedFunction("center");
  } else if (model.selectedFunctionKey) {
    // Back to the Functions overview (All functions, then Back).
    model.selectedFunctionKey = null;
    renderFunctionList();
  }
  model.routeIntent = null;
}

function resetForHost() {
  // Everything of the old host stops now: its read aborts, and the load that was waiting on it is forgotten, so the new host starts its own
  // (ARCH-F-097, ARCH-F-140).
  util.latest.cancelPrefix("explorer.");
  forgetFunctionsLoad();
  model.loadingFunctions = false;
  uiState.busy(dom.explorerFunctionRefreshButton, false);
  meta.ensureHighlighterData();
  renderFunctionList();
  if (model.active) refreshFunctions(false);
}

function init() {
  // The detail pane scrolls: a keyboard user reaches it (a region while it overflows).
  for (const pane of $$(".explorerDetailPane")) util.scrollFocus(pane, { label: pane.id ? "Object details" : "Function details", mutations: true });
  // Back / Forward within the page (ns.router: the one popstate listener).
  router.on("/explorer", () => applyRouteFromLocation());
  // The Catalog | Functions row is links to two pages.
  shell?.edgeCues?.(shellEl("explorerNavTabs"));
  sidePanel("explorerFunctionListPane");
  shellEl("explorerTreeToggle")?.addEventListener("click", () => setTreeDrawerOpen(!model.treeOpen));
  try {
    window.matchMedia(shell.mediaQuery("md")).addEventListener("change", (event) => { if (!event.matches) setTreeDrawerOpen(false); });
  } catch {}
  dom.explorerFunctionRefreshButton?.addEventListener("click", () => refreshFunctions(true));
  searches.functions = search.bind(dom.explorerFunctionSearchInput, () => renderFunctionList());
  dom.explorerFunctionCategorySelect?.addEventListener("change", renderFunctionList);
  // Function kind chips, like the tree's type chips: a filled chip is a
  // kind the list shows (every chip filled when nothing narrows it). One
  // kind at a time; pressing the only filled chip again lists every function.
  const functionChips = [...($$(".explorerFilterChip[data-function-kind]", shellEl("explorerFunctionFilters")) || [])];
  for (const chip of functionChips) {
    chip.addEventListener("click", () => {
      const kind = String(chip.dataset.functionKind || "");
      const value = String(dom.explorerFunctionCategorySelect?.value || "") === kind ? "" : kind;
      if (dom.explorerFunctionCategorySelect) dom.explorerFunctionCategorySelect.value = value;
      for (const candidate of functionChips) {
        const pressed = !value || String(candidate.dataset.functionKind || "") === value;
        candidate.setAttribute("aria-pressed", String(pressed));
        candidate.classList.toggle("is-on", pressed);
      }
      renderFunctionList();
    });
  }
  window.addEventListener("chdash:host-changed", resetForHost);
  meta.ensureHighlighterData();
  applyRouteFromLocation();
}

const functionsPage = { init, refreshFunctions };

export { functionsPage };
