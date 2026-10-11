// The object tree of the Catalog: the databases and their objects with their sizes, the search, the type chips (Tables, Views, MV,
// Dict, System) and the rule that an object that is shown cannot be hidden by a chip.

import { dom, h } from "./app_dom.js";
import { loadDatabaseTables } from "./app_explorer_data.js";
import { listState, rootRow, setTreeDrawerOpen, syncScopeUp } from "./app_explorer_shell.js";
import { actions, browseRootShown, clear, model, parts, searches, selectedTable, selectionScope, shellEl } from "./app_explorer_store.js";
import { TREE_KINDS, engineKey, filterKindOf, healthLabel, isSystemDatabaseName, nonStoringSummary, objectKind, storageCatalogEligible, summaryByDatabase, tablesByDatabase, treeBadge, treeKind, treeObjectTitle } from "./app_explorer_summary.js";
import { format } from "./app_format.js";
import { storage } from "./app_state.js";
import { icon as iconMod } from "./app_ui_icon.js";

const { byId, $, $$ } = dom;

const TYPE_FILTERS = ["tables", "views", "mv", "dict"];
const KEYS = storage.KEYS;

function sidebarObjectVisible(table) {
  if (!table) return false;
  if (!model.includeSystem && isSystemDatabaseName(table.database)) return false;
  return model.filters[filterKindOf(table)] !== false;
}

function visibilityRequirementsForCurrentObject() {
  const table = selectedTable();
  const graphRequirements = model.mode === "graph" ? (parts.graph?.visibilityRequirements?.() || {}) : {};
  return {
    includeSystem: !!graphRequirements.includeSystem || !!table && isSystemDatabaseName(table.database)
      || !!model.selectedDatabase && isSystemDatabaseName(model.selectedDatabase),
    // A selected object cannot be hidden by the filter that would exclude
    // it: its type chip stays pressed and locked until the selection moves.
    kind: table ? filterKindOf(table) : null,
    includeNonStoring: !!table && nonStoringSummary(table) || !!graphRequirements.includeNonStoring,
  };
}

function persistVisibilityOptions() {
  storage.pref(KEYS.explorerIncludeSystem, false).set(model.includeSystem);
  storage.pref(KEYS.explorerTypeFilters, "").set(TYPE_FILTERS.filter((key) => model.filters[key] !== false).join(","));
}

function loadVisibilityOptions() {
  model.includeSystem = storage.pref(KEYS.explorerIncludeSystem, false).get();
  const stored = storage.pref(KEYS.explorerTypeFilters, null).get();
  if (stored != null) {
    const enabled = new Set(String(stored).split(",").filter(Boolean));
    for (const key of TYPE_FILTERS) model.filters[key] = enabled.has(key);
  } else if (storage.pref(KEYS.explorerIncludeNonStoring, true).get() === false) {
    // Former "Include non-storing objects" switch.
    model.filters.views = false;
    model.filters.mv = false;
  }
}

function syncFilterChips(required) {
  const root = shellEl("explorerTreeFilters");
  if (!root) return;
  for (const chip of $$(".explorerFilterChip[data-filter]", root)) {
    const key = String(chip.dataset.filter || "");
    const system = key === "system";
    const pressed = system ? model.includeSystem : model.filters[key] !== false;
    const locked = system ? !!required.includeSystem : required.kind === key;
    chip.setAttribute("aria-pressed", String(pressed));
    chip.classList.toggle("is-on", pressed);
    // A locked chip stays focusable (aria-disabled, not disabled) and
    // names its reason to assistive tech (aria-describedby) as well as in
    // its tooltip; its width never changes (the lock dot overlays it).
    const reason = system ? "Required while the selected object belongs to a system database." : "Required while the selected object is of this type.";
    chip.disabled = false;
    chip.classList.toggle("is-locked", locked);
    if (!chip.dataset.baseTitle) chip.dataset.baseTitle = chip.title || "";
    chip.title = locked ? reason : chip.dataset.baseTitle;
    const reasonId = `${chip.id || `explorerFilter-${key}`}Reason`;
    let note = byId(reasonId);
    if (locked) {
      if (!note) {
        note = h("span", { id: reasonId, class: "srOnly" });
        root.appendChild(note);
      }
      note.textContent = reason;
      chip.setAttribute("aria-disabled", "true");
      chip.setAttribute("aria-describedby", reasonId);
    } else {
      note?.remove();
      chip.removeAttribute("aria-disabled");
      chip.removeAttribute("aria-describedby");
    }
  }
}

function syncVisibilityOptionLocks({ propagate = false } = {}) {
  const required = visibilityRequirementsForCurrentObject();
  let changed = false;
  if (required.includeSystem && !model.includeSystem) { model.includeSystem = true; changed = true; }
  if (required.kind && model.filters[required.kind] === false) { model.filters[required.kind] = true; changed = true; }
  const includeNonStoring = model.filters.views !== false || model.filters.mv !== false || required.includeNonStoring;
  if (includeNonStoring !== model.includeNonStoring) { model.includeNonStoring = includeNonStoring; changed = true; }
  syncFilterChips(required);
  if (changed) persistVisibilityOptions();
  if ((changed || propagate) && model.mode === "graph") {
    const effective = parts.graph?.setVisibilityOptions?.({ includeSystem: model.includeSystem, includeNonStoring: model.includeNonStoring });
    if (effective) {
      model.includeSystem = !!effective.includeSystem;
      model.includeNonStoring = !!effective.includeNonStoring;
      syncFilterChips(required);
    }
  }
}

function toggleTypeFilter(key) {
  if (key === "system") model.includeSystem = !model.includeSystem;
  else if (TYPE_FILTERS.includes(key)) model.filters[key] = model.filters[key] === false;
  else return;
  persistVisibilityOptions();
  syncVisibilityOptionLocks({ propagate: true });
  renderTableList();
  if (model.section === "tables" && model.mode === "browse" && model.selectedDatabase && !model.selectedKey) actions.renderDatabaseDetail(model.selectedDatabase);
}

function visibleTables() {
  const q = String(dom.explorerSearchInput?.value || "").trim().toLowerCase();
  const storageMode = model.mode === "graph" && parts.graph?.isStorageMode?.();
  return (model.catalog?.tables || []).filter((table) => {
    if (!model.includeSystem && ["system", "information_schema", "INFORMATION_SCHEMA"].includes(String(table.database || ""))) return false;
    // Buffer is a special case in Storage: although it owns no persistent
    // parts, it is a real write-routing object and is shown together with the
    // table it flushes into. Other non-storing objects still obey the toggle.
    const storageBuffer = storageMode && engineKey(table) === "buffer";
    if (!model.includeNonStoring && nonStoringSummary(table) && !storageBuffer) return false;
    if (!q) return true;
    return `${table.database}.${table.name} ${table.engine || ""} ${objectKind(table)}`.toLowerCase().includes(q);
  });
}

// Text with every case-insensitive occurrence of `query` wrapped in <mark>.
// A tree name cut in the middle when it does not fit: the head ends in an
// ellipsis, the tail (the end that tells "events_local" from "events_dist")
// stays, and the title gives the whole name. Search matches are marked
// across both parts.
function middleText(className, text, query) {
  const value = String(text || "");
  const q = String(query || "").toLowerCase();
  const marks = [];
  if (q) {
    const lower = value.toLowerCase();
    for (let index = lower.indexOf(q); index >= 0; index = lower.indexOf(q, index + q.length)) marks.push([index, index + q.length]);
  }
  const part = (cls, from, to) => {
    const el = h("span", { class: cls });
    let at = from;
    for (const [start, end] of marks) {
      const a = Math.max(start, from);
      const b = Math.min(end, to);
      if (a >= b) continue;
      if (a > at) el.appendChild(document.createTextNode(value.slice(at, a)));
      el.appendChild(h("mark", { class: "explorerTreeMark" }, value.slice(a, b)));
      at = b;
    }
    if (at < to) el.appendChild(document.createTextNode(value.slice(at, to)));
    return el;
  };
  // The tail starts at the last "_", "." or "-" ("chdash_rich_\u2026_scratch2"
  // and "chdash_rich_\u2026_scratch" cut alike), else on the last third.
  // The cut never splits a search match.
  let cut = value.length > 12 ? value.length - Math.min(10, Math.ceil(value.length / 3)) : value.length;
  const sep = Math.max(value.lastIndexOf("_"), value.lastIndexOf("."), value.lastIndexOf("-"));
  if (value.length > 12 && sep > 2 && value.length - sep >= 3 && value.length - sep <= 16) cut = sep;
  for (const [start, end] of marks) if (start < cut && cut < end) cut = end < value.length ? end : start;
  const el = h("span", { class: [className, "midTrunc"], title: value });
  el.append(part("midTrunc__head", 0, cut));
  if (cut > 0 && cut < value.length) el.append(part("midTrunc__tail", cut, value.length));
  return el;
}

// The databases the tree lists (the System chip adds the system ones).
function visibleDatabases() {
  const catalog = model.catalog;
  return [...new Set([
    ...(catalog?.databases || []),
    ...(catalog?.tables || []).map((table) => String(table.database || "")),
  ].filter(Boolean))]
    .filter((database) => model.includeSystem || !isSystemDatabaseName(database))
    .sort((a, b) => a.localeCompare(b));
}

// The tree's root: the Catalog root (the databases overview in Browse,
// every database in Graph).
function treeRootRow(count) {
  const current = model.section === "tables" && !model.selectedKey && !model.selectedDatabase && !selectionScope().database;
  return rootRow({ id: "explorerTreeRoot", icon: "stack", label: "All databases", count, title: "All databases: their sizes and the databases overview", current, open: () => actions.openCatalogRoot() });
}

function renderTableList() {
  if (!dom.explorerTableList) return;
  clear(dom.explorerTableList);
  syncScopeUp();
  // The databases overview follows the catalog (a load, the System chip).
  if (browseRootShown()) actions.renderBrowseRoot();
  const catalog = model.catalog;
  const databases = visibleDatabases();

  if (!databases.length) {
    dom.explorerTableList.appendChild(listState(model.loadingCatalog ? "loading" : "empty", model.loadingCatalog ? "Loading databases\u2026" : "No accessible databases"));
    return;
  }

  // Its count (the databases shown) is written once the loop below knows it.
  const root = treeRootRow(0);
  dom.explorerTableList.appendChild(root);
  const query = String(dom.explorerSearchInput?.value || "").trim().toLowerCase();
  const groupedTables = tablesByDatabase(catalog?.tables || []);
  const summaries = summaryByDatabase(catalog?.database_summaries || []);
  const databaseBytes = (database) => {
    const value = Number(summaries.get(database)?.bytes);
    return Number.isFinite(value) ? value : null;
  };
  let shown = 0;
  for (const database of databases) {
    const allItems = (groupedTables.get(database) || []).filter((table) => sidebarObjectVisible(table));
    const items = allItems.filter((table) => !query || `${table.database}.${table.name} ${table.engine || ""}`.toLowerCase().includes(query));
    const loaded = model.databaseTablesLoaded.has(database);
    const loading = model.databaseTablesLoading.has(database);
    const databaseMatches = !!query && database.toLowerCase().includes(query);
    // While searching, a loaded database without any match is dropped and a
    // loaded database with matches is shown open (its stored state is kept).
    if (query && loaded && !items.length && !databaseMatches) continue;
    shown += 1;
    const expanded = model.expandedDatabases.has(database) || (!!query && loaded && items.length > 0);
    const section = h("section", { class: "explorerTreeGroup" });
    const header = h("div", { class: `explorerTreeDatabaseRow${model.selectedDatabase === database ? " is-selected" : ""}` });
    const toggle = h("button", { class: "explorerTreeDatabaseToggle" }, iconMod.el("chevron-right", { size: "sm", className: "icon--disclosure" }));
    toggle.type = "button";
    toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${database}`);
    toggle.title = toggle.getAttribute("aria-label");
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (expanded) {
        const selectedTableInDatabase = typeof model.selectedKey === "string" && model.selectedKey.startsWith(`${database}\0`);
        const selectedDatabase = model.selectedDatabase === database;
        if (selectedTableInDatabase || selectedDatabase) {
          // Collapsing the branch that currently owns the detail view should
          // never leave a hidden table selected. Switch to the database view
          // while keeping the branch collapsed.
          actions.selectDatabase(database, { expand: false });
          return;
        }
        model.expandedDatabases.delete(database);
      } else {
        model.expandedDatabases.add(database);
        if (!loaded) void loadDatabaseTables(database);
      }
      renderTableList();
    });
    const headerMain = h("button", { class: "explorerTreeDatabase" });
    headerMain.type = "button";
    const databaseSummary = summaries.get(database) || null;
    let objects = "";
    if (loaded) objects = format.countLabel(allItems.length, "object");
    else if (databaseSummary && Number.isFinite(Number(databaseSummary.tables))) objects = format.countLabel(Number(databaseSummary.tables), "object");
    // The row's figure column is bytes only (as on object rows): the
    // object count is in the title, so it never takes the name's room;
    // the column says "Loading\u2026" while the branch loads.
    const countText = loading ? "Loading\u2026" : "";
    const bytes = databaseBytes(database);
    // Sizes are plain figures: the shares are in the databases overview
    // and the database page, as bars of their own.
    const size = h("span", { class: "explorerTreeDatabase__size" }, bytes == null ? "" : format.bytes(bytes));
    if (bytes == null || loading) size.hidden = true;
    headerMain.title = [database, objects, bytes == null ? "" : `${format.bytes(bytes)} on disk`].filter(Boolean).join(" \u00b7 ");
    const count = h("span", { class: "explorerTreeDatabase__count" }, countText);
    if (!countText) count.hidden = true;
    headerMain.append(
      middleText("explorerTreeDatabase__name", database, query),
      count,
      size,
    );
    headerMain.addEventListener("click", () => { actions.selectDatabase(database); setTreeDrawerOpen(false); });
    header.append(toggle, headerMain);
    section.appendChild(header);

    if (expanded) {
      const children = h("div", { class: "explorerTreeChildren" });
      if (loading && !loaded) {
        children.appendChild(listState("loading", "Loading tables\u2026"));
      } else if (model.databaseLoadErrors.has(database) && !loaded) {
        children.appendChild(listState("error", "Unable to load tables", () => void loadDatabaseTables(database, true)));
      } else if (loaded && !items.length) {
        const filteredOut = (groupedTables.get(database) || []).length > 0;
        children.appendChild(listState("empty", query ? "No matching objects" : (filteredOut ? "No objects match the type filters" : "No accessible tables or views")));
      } else {
        const badges = new Map(items.map((table) => [table, treeBadge(table)]));
        for (const table of items.sort((a, b) => a.name.localeCompare(b.name))) {
          const key = `${table.database}\0${table.name}`;
          const kind = treeKind(table);
          const button = h("button", { class: `explorerTreeObject explorerTreeObject--${kind}` });
          button.type = "button";
          button.classList.toggle("is-selected", key === model.selectedKey);
          button.dataset.database = table.database;
          button.dataset.table = table.name;
          button.dataset.kind = kind;
          const icon = iconMod.el(TREE_KINDS[kind].icon, { size: "sm", className: `explorerTreeObject__icon explorerTreeObject__icon--${kind}` });
          const name = middleText("explorerTreeObject__name", table.name, query);
          const srKind = h("span", { class: "srOnly" }, `${TREE_KINDS[kind].label}, `);
          button.append(icon, srKind, name);
          // Replicated tables carry the replica health dot (item 19); other
          // tables only show a dot when they are not healthy.
          const replicaDot = parts.detailView?.replicaHealthDot?.(table);
          const health = String(table.health || "healthy");
          if (replicaDot) {
            button.appendChild(replicaDot);
          } else if (health === "warning" || health === "error") {
            const dot = h("span", { class: `explorerTreeObject__health explorerTreeObject__health--${health}` });
            dot.setAttribute("aria-label", healthLabel(table));
            button.appendChild(dot);
          }
          const badge = badges.get(table);
          if (badge) button.appendChild(h("span", { class: "explorerTreeObject__size" }, badge.text));
          button.title = treeObjectTitle(table);
          const storageBlocked = model.mode === "graph" && parts.graph?.isStorageMode?.() && !storageCatalogEligible(table);
          button.disabled = !!storageBlocked;
          button.classList.toggle("is-storage-blocked", !!storageBlocked);
          if (storageBlocked) {
            button.title = `${button.title}\nThis object does not store data and has no storage topology.`;
            button.appendChild(iconMod.el("ban", { size: "sm", className: "explorerTreeObject__blocked" }));
          }
          button.addEventListener("click", () => {
            if (button.disabled) return;
            setTreeDrawerOpen(false);
            void actions.selectTable(table.database, table.name);
          });
          children.appendChild(button);
        }
      }
      section.appendChild(children);
      if (!loaded && !loading && !model.databaseLoadErrors.has(database)) queueMicrotask(() => void loadDatabaseTables(database));
    }
    dom.explorerTableList.appendChild(section);
  }
  if (!shown) dom.explorerTableList.appendChild(listState("empty", "No matching databases or objects", null, { handle: searches.tree, input: dom.explorerSearchInput }));
  const rootCount = $(".explorerTreeRoot__count", root);
  if (rootCount) rootCount.textContent = `(${format.count(shown)})`;
}

actions.renderTableList = renderTableList;

export { loadVisibilityOptions, renderTableList, sidebarObjectVisible, syncVisibilityOptionLocks, toggleTypeFilter, visibleDatabases };
