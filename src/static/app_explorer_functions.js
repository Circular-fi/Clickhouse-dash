// The Functions page: the list of the functions of the host grouped by category, the overview (categories, popular functions) and the
// card of one function. Loads GET /api/explorer/functions once for each host.

import { api } from "./app_api.js";
import { dom, h } from "./app_dom.js";
import { appendFunctionDocSection, splitFunctionDocumentation } from "./app_explorer_doc.js";
import { isMobileShell, listState, rootRow, setTreeDrawerOpen } from "./app_explorer_shell.js";
import { clear, model, searches, setError, syncExplorerUrl } from "./app_explorer_store.js";
import { POPULAR_FUNCTIONS, functionCategory, functionKey, functionKindBadge, functionOrigin, uniqueMetaBits } from "./app_explorer_summary.js";
import { format } from "./app_format.js";
import { state } from "./app_state.js";
import { badge as badgeMod } from "./app_ui_badge.js";
import { icon } from "./app_ui_icon.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { $, $$ } = dom;

function visibleFunctions() {
  const q = String(dom.explorerFunctionSearchInput?.value || "").trim().toLowerCase();
  const kind = String(dom.explorerFunctionCategorySelect?.value || "");
  const items = (model.functionsCatalog?.functions || []).filter((item) => {
    if (kind === "user-defined" && !item.user_defined) return false;
    if (kind && kind !== "user-defined" && item.kind !== kind) return false;
    if (!q) return true;
    return String(item.name || "").toLowerCase().includes(q);
  });
  if (!q) return items;
  const rank = (item) => {
    const name = String(item.name || "").toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.split(/[^a-z0-9_]+/).some((part) => part.startsWith(q))) return 2;
    if (name.includes(q)) return 3;
    return 4;
  };
  return items.sort((a, b) => rank(a) - rank(b) || String(a.name || "").localeCompare(String(b.name || "")));
}

function revealSelectedFunction(block = "nearest") {
  $(".explorerFunctionObject.is-selected", dom.explorerFunctionList)?.scrollIntoView?.({ block });
}

function selectFunction(item, category) {
  model.selectedFunctionKey = functionKey(item);
  model.expandedFunctionCategories.add(category);
  renderFunctionList();
  syncExplorerUrl("push");
  revealSelectedFunction();
}

// Empty state: what the catalog contains (categories with counts, popular
// functions) instead of a bare "Select a function".
function renderFunctionOverview() {
  const empty = dom.explorerFunctionEmpty;
  if (!empty) return;
  const functions = model.functionsCatalog?.functions || [];
  empty.classList.toggle("explorerFunctionOverview", functions.length > 0);
  if (!functions.length) {
    if (model.loadingFunctions) uiState.loading(empty, { label: "Loading functions\u2026" });
    else uiState.empty(empty, { title: "Select a function", body: "Its documentation comes from the selected ClickHouse server, when it has some." });
    return;
  }
  empty.removeAttribute("aria-busy");
  const counts = new Map();
  for (const item of functions) {
    const category = functionCategory(item);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const header = h("div", { class: "explorerFunctionOverview__header" });
  header.append(
    h("strong", { class: "explorerFunctionOverview__title" }, `${format.countLabel(functions.length, "function")} in ${format.countLabel(counts.size, "category", "categories")}`),
    h("span", { class: "explorerFunctionOverview__sub" }, model.functionsCatalog?.documentation_available === false
      ? "This server does not expose system.documentation: names and categories only."
      : "Pick a function on the left, search by name, or start from a category."),
  );
  const popular = POPULAR_FUNCTIONS
    .map((name) => functions.find((item) => item.name === name && !item.user_defined))
    .filter(Boolean);
  const sections = [header];
  if (popular.length) {
    const block = h("section", { class: "explorerFunctionOverview__section" });
    block.appendChild(h("h3", { class: "explorerFunctionOverview__heading" }, "Popular"));
    const list = h("div", { class: "explorerFunctionOverview__chips" });
    list.id = "explorerFunctionPopular";
    for (const item of popular) {
      const button = h("button", { class: "explorerFunctionOverview__chip" }, item.name);
      button.type = "button";
      button.title = `${item.name} · ${functionCategory(item)}`;
      button.addEventListener("click", () => selectFunction(item, functionCategory(item)));
      list.appendChild(button);
    }
    block.appendChild(list);
    sections.push(block);
  }
  // Every category with its count, largest first: a button opens that
  // category in the list (on a phone, the list's drawer).
  const block = h("section", { class: "explorerFunctionOverview__section" });
  block.appendChild(h("h3", { class: "explorerFunctionOverview__heading" }, "Categories"));
  const grid = h("div", { class: "explorerFunctionOverview__categories" });
  grid.id = "explorerFunctionCategories";
  for (const [category, count] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const button = h("button", { class: "explorerFunctionOverview__category" });
    button.type = "button";
    button.dataset.category = category;
    button.append(h("span", { class: "explorerFunctionOverview__categoryName" }, category), h("span", { class: "explorerFunctionOverview__categoryCount" }, format.count(count)));
    button.addEventListener("click", () => openFunctionCategory(category));
    grid.appendChild(button);
  }
  block.appendChild(grid);
  sections.push(block);
  empty.replaceChildren(...sections);
}

function openFunctionCategory(category) {
  model.expandedFunctionCategories.add(category);
  renderFunctionList();
  if (isMobileShell()) setTreeDrawerOpen(true);
  const group = [...($$(".explorerFunctionGroup", dom.explorerFunctionList) || [])].find((el) => el.dataset.category === category);
  group?.scrollIntoView?.({ block: "start" });
  $(".explorerTreeDatabase", group)?.focus({ preventScroll: true });
}

function renderFunctionDetail() {
  const item = (model.functionsCatalog?.functions || []).find((candidate) => functionKey(candidate) === model.selectedFunctionKey) || null;
  if (dom.explorerFunctionEmpty) dom.explorerFunctionEmpty.hidden = !!item;
  if (!item) renderFunctionOverview();
  if (dom.explorerFunctionDetail) dom.explorerFunctionDetail.hidden = !item;
  if (!item) return;
  if (dom.explorerFunctionDetailName) dom.explorerFunctionDetailName.textContent = item.name || "Function";
  if (dom.explorerFunctionDetailMeta) {
    const category = functionCategory(item);
    const kind = item.kind === "Aggregate Function" && category !== "Aggregate"
      ? "Aggregate function"
      : (item.kind === "Table Function" && category !== "Table functions" ? "Table function" : "");
    const bits = uniqueMetaBits([category, kind, item.user_defined ? functionOrigin(item) : "", item.introduced_in ? `since ${item.introduced_in}` : ""]);
    dom.explorerFunctionDetailMeta.textContent = bits.join(" · ");
  }
  if (!dom.explorerFunctionDescription) return;

  clear(dom.explorerFunctionDescription);
  const sections = splitFunctionDocumentation(item.description || "");
  const description = sections.description || (item.description || "");
  if (description) appendFunctionDocSection(dom.explorerFunctionDescription, "Description", description);
  appendFunctionDocSection(dom.explorerFunctionDescription, "Syntax", item.syntax || sections.syntax, { code: true });
  const argumentsDoc = [item.arguments, item.parameters].filter((value) => String(value || "").trim()).join("\n\n");
  appendFunctionDocSection(dom.explorerFunctionDescription, "Arguments", argumentsDoc || sections.arguments);
  appendFunctionDocSection(dom.explorerFunctionDescription, "Returns", item.returned_value || sections.returns);
  appendFunctionDocSection(dom.explorerFunctionDescription, "Examples", item.examples || sections.examples);
  appendFunctionDocSection(dom.explorerFunctionDescription, "See also", sections.seeAlso);
  if (item.introduced_in) appendFunctionDocSection(dom.explorerFunctionDescription, "Introduced", `ClickHouse ${item.introduced_in}`);

  const aliases = Array.isArray(item.alias_documents) ? item.alias_documents : [];
  for (const aliased of aliases) {
    if (!aliased || !aliased.name) continue;
    const aliasSection = h("section", { class: "functionDoc__section functionDoc__alias" });
    aliasSection.appendChild(h("h3", { class: "functionDoc__sectionTitle" }, `Alias documentation · ${aliased.name}`));
    const aliasSections = splitFunctionDocumentation(aliased.description || "");
    const aliasDescription = aliasSections.description || (aliased.description || "");
    if (aliasDescription) appendFunctionDocSection(aliasSection, "Description", aliasDescription);
    appendFunctionDocSection(aliasSection, "Syntax", aliased.syntax || aliasSections.syntax, { code: true });
    const aliasArguments = [aliased.arguments, aliased.parameters].filter((value) => String(value || "").trim()).join("\n\n");
    appendFunctionDocSection(aliasSection, "Arguments", aliasArguments || aliasSections.arguments);
    appendFunctionDocSection(aliasSection, "Returns", aliased.returned_value || aliasSections.returns);
    appendFunctionDocSection(aliasSection, "Examples", aliased.examples || aliasSections.examples);
    if (aliased.introduced_in) appendFunctionDocSection(aliasSection, "Introduced", `ClickHouse ${aliased.introduced_in}`);
    dom.explorerFunctionDescription.appendChild(aliasSection);
  }
  if (!dom.explorerFunctionDescription.childElementCount) {
    dom.explorerFunctionDescription.appendChild(uiState.block("empty", { body: "This server has no documentation for this function.", compact: true }));
  }
}

function renderFunctionList() {
  if (!dom.explorerFunctionList) return;
  const items = visibleFunctions();
  clear(dom.explorerFunctionList);
  if (!items.length) {
    dom.explorerFunctionList.appendChild(listState(model.loadingFunctions ? "loading" : "empty", model.loadingFunctions ? "Loading functions\u2026" : "No functions found", null, { handle: searches.functions, input: dom.explorerFunctionSearchInput }));
    renderFunctionDetail();
    return;
  }
  dom.explorerFunctionList.appendChild(functionRootRow(items.length));
  const searching = !!String(dom.explorerFunctionSearchInput?.value || "").trim();
  const groups = new Map();
  for (const item of items) {
    const category = functionCategory(item);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  }
  for (const [category, groupItems] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const section = h("section", { class: "explorerTreeGroup explorerFunctionGroup" });
    section.dataset.category = category;
    const selectedInGroup = groupItems.some((item) => functionKey(item) === model.selectedFunctionKey);
    const expanded = searching || selectedInGroup || model.expandedFunctionCategories.has(category);
    const row = h("div", { class: "explorerTreeDatabaseRow" });
    const toggle = h("button", { class: "explorerTreeDatabaseToggle" }, icon.el("chevron-right", { size: "sm", className: "icon--disclosure" }));
    toggle.type = "button";
    toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${category}`);
    toggle.title = toggle.getAttribute("aria-label");
    toggle.setAttribute("aria-expanded", String(expanded));
    const header = h("button", { class: "explorerTreeDatabase" });
    header.type = "button";
    header.append(h("span", { class: "explorerTreeDatabase__name" }, category), h("span", { class: "explorerTreeDatabase__count explorerFunctionGroup__count" }, format.count(groupItems.length)));
    const toggleGroup = () => {
      if (model.expandedFunctionCategories.has(category)) model.expandedFunctionCategories.delete(category);
      else model.expandedFunctionCategories.add(category);
      renderFunctionList();
    };
    toggle.addEventListener("click", toggleGroup);
    header.addEventListener("click", toggleGroup);
    row.append(toggle, header);
    section.appendChild(row);
    if (expanded) {
      const children = h("div", { class: "explorerTreeChildren" });
      for (const item of groupItems.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))) {
        const key = functionKey(item);
        const button = h("button", { class: "explorerTreeObject explorerFunctionObject" });
        button.type = "button";
        button.classList.toggle("is-selected", key === model.selectedFunctionKey);
        // One line per function: the group already names the category,
        // so only a kind badge that adds information is kept.
        button.appendChild(h("span", { class: "explorerTreeObject__name explorerFunctionObject__name" }, item.name || "\u2014"));
        const badge = functionKindBadge(item, category);
        if (badge) button.appendChild(badgeMod.el(badge, { shape: "pill", className: "explorerFunctionObject__badge" }));
        button.title = item.name || "";
        button.addEventListener("click", () => { selectFunction(item, category); setTreeDrawerOpen(false); });
        children.appendChild(button);
      }
      section.appendChild(children);
    }
    dom.explorerFunctionList.appendChild(section);
  }
  renderFunctionDetail();
}

// The functions load in flight: { hostId, force, promise }. The same host reuses it, unless the call is a forced
// Refresh over a plain load; another host replaces it (the answer of the old host is dropped).
let functionsLoad = null;

// A change of host drops the load in flight (the answer of the old host is dropped by its slot of util.latest).
function forgetFunctionsLoad() {
  functionsLoad = null;
}

async function refreshFunctions(force) {
  if (!model.active) return null;
  const hostId = String(state.selectedHostId || "");
  if (!hostId) return null;
  if (!force && model.functionsCatalog) {
    renderFunctionList();
    renderFunctionDetail();
    return null;
  }
  if (functionsLoad && functionsLoad.hostId === hostId && (!force || functionsLoad.force)) return functionsLoad.promise;
  const req = util.latest("explorer.functions");
  const load = { hostId, force: !!force, promise: null };
  functionsLoad = load;
  model.loadingFunctions = true;
  setError(null);
  uiState.busy(dom.explorerFunctionRefreshButton, true);
  renderFunctionList();
  load.promise = (async () => {
    try {
      const payload = await api.getExplorerFunctions(hostId, !!force, { signal: req.signal });
      if (!req.isCurrent() || String(state.selectedHostId || "") !== hostId || !model.active || model.section !== "functions") return;
      model.functionsCatalog = payload;
      const keys = new Set((payload?.functions || []).map(functionKey));
      if (!keys.has(model.selectedFunctionKey)) model.selectedFunctionKey = null;
      const route = model.routeIntent;
      if (route?.workspace === "explorer" && route.section === "functions") model.routeIntent = null;
      let missing = "";
      if (route?.workspace === "explorer" && route.section === "functions" && route.functionName) {
        const item = (payload?.functions || []).find((candidate) => candidate.name === route.functionName) || null;
        if (item) model.selectedFunctionKey = functionKey(item);
        else missing = route.functionName;
      }
      renderFunctionList();
      // An address that names no function (a dropped UDF, a typo) keeps the catalog: the overview shows, with the reason.
      if (missing) setError(new Error(`${missing} is not a function of this host.`));
      if (route?.functionName && !missing) revealSelectedFunction("center");
    } catch (e) {
      if (!req.isCurrent() || util.isAbort(e)) return;
      setError(e);
      model.functionsCatalog = null;
      model.selectedFunctionKey = null;
      renderFunctionList();
    } finally {
      if (functionsLoad === load) {
        functionsLoad = null;
        model.loadingFunctions = false;
        uiState.busy(dom.explorerFunctionRefreshButton, false);
      }
    }
  })();
  return load.promise;
}

// The Functions list's root: the Functions overview (categories, popular).
function functionRootRow(count) {
  const current = !model.selectedFunctionKey;
  return rootRow({ id: "explorerFunctionRoot", icon: "function", label: "All functions", count, title: "All functions: the categories and the popular functions", current, open: () => openFunctionsOverview() });
}

function openFunctionsOverview({ history = "push" } = {}) {
  model.selectedFunctionKey = null;
  renderFunctionList();
  syncExplorerUrl(history);
  $("#explorerFunctionRoot", dom.explorerFunctionList)?.focus({ preventScroll: true });
}

export { forgetFunctionsLoad, refreshFunctions, renderFunctionDetail, renderFunctionList, revealSelectedFunction };
