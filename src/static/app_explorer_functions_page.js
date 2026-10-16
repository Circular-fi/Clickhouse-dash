// The controller of the Functions page (functions.html, /explorer/functions[/<name>]).
// It controls the list of the functions of the host and the card of one function.
// It starts the page. It applies the address (a function, or the overview).
// It loads the functions of the host. It forgets them when the host changes.
// It shares the store and the modules of the Functions list (app_explorer_functions.js).
// It shares them with the Catalog controller (app_explorer.js).
// It loads none of the Catalog (the tree, the database page, the table card, the graph).

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

// The page is on screen. The server can turn off the Explorer. Then none of it runs.
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

// The address: a function opens its card. The bare address opens the overview.
// Back / Forward also come here (ns.router).
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
    // Go back to the Functions overview (All functions, then Back).
    model.selectedFunctionKey = null;
    renderFunctionList();
  }
  model.routeIntent = null;
}

function resetForHost() {
  // Everything of the old host stops now. Its read aborts.
  // The load that waits on that read is forgotten. The new host starts its own load.
  // (ARCH-F-097, ARCH-F-140)
  util.latest.cancelPrefix("explorer.");
  forgetFunctionsLoad();
  model.loadingFunctions = false;
  uiState.busy(dom.explorerFunctionRefreshButton, false);
  meta.ensureHighlighterData();
  renderFunctionList();
  if (model.active) refreshFunctions(false);
}

function init() {
  // The detail pane scrolls. A keyboard user can reach it (a region while it overflows).
  for (const pane of $$(".explorerDetailPane")) util.scrollFocus(pane, { label: pane.id ? "Object details" : "Function details", mutations: true });
  // Back and Forward inside the page (ns.router: the one popstate listener).
  router.on("/explorer", () => applyRouteFromLocation());
  // The Catalog | Functions row has links to two pages.
  shell?.edgeCues?.(shellEl("explorerNavTabs"));
  sidePanel("explorerFunctionListPane");
  shellEl("explorerTreeToggle")?.addEventListener("click", () => setTreeDrawerOpen(!model.treeOpen));
  try {
    window.matchMedia(shell.mediaQuery("md")).addEventListener("change", (event) => { if (!event.matches) setTreeDrawerOpen(false); });
  } catch {}
  dom.explorerFunctionRefreshButton?.addEventListener("click", () => refreshFunctions(true));
  searches.functions = search.bind(dom.explorerFunctionSearchInput, () => renderFunctionList());
  dom.explorerFunctionCategorySelect?.addEventListener("change", renderFunctionList);
  // Function kind chips work like the tree's type chips. A filled chip is a kind that the list shows.
  // Every chip is filled when no filter narrows the list. Only one kind is active at a time.
  // Press the only filled chip again to list every function.
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
