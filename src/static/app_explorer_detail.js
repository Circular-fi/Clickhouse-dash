// This is the table card. It shows the tabs of a selected object: Columns, Preview, Storage, Operations, Lineage and DDL.
// It also shows the body of the tab on screen. The Catalog calls three parts: the header, the tabs and the body.
// app_explorer_table.js selects a table and asks for these three parts. The Catalog entry passes this module to explorer.use(). So the Functions page never loads it.
//
// The card layout has a header (name, chips and the replication banner), the tabs and the tab body.
// It also has an About panel of value and context tiles beside the body. On a narrow pane, the About panel appears above the body.
// The tabs are modules of their own: app_explorer_detail_columns.js, _storage.js, _operations.js and _preview.js.
// The pure part is app_explorer_detail_model.js.

import { dom, h } from "./app_dom.js";
import { renderAbout } from "./app_explorer_detail_about.js";
import { destroyCardMaps, dependencyChip, emptyNote, unavailableMessage, watchExpressions } from "./app_explorer_detail_cells.js";
import { renderColumnsTab } from "./app_explorer_detail_columns.js";
import { renderDetailHeader, replicaHealthDot } from "./app_explorer_detail_header.js";
import { availableTabs, sectionUnavailable, visibleDependencies } from "./app_explorer_detail_model.js";
import { renderOperationsTab } from "./app_explorer_detail_operations.js";
import { renderPreviewTab } from "./app_explorer_detail_preview.js";
import { renderStorageTab } from "./app_explorer_detail_storage.js";
import { destroyDatabaseTreemap } from "./app_explorer_database.js";
import { actions, clear, model, parts, syncExplorerUrl } from "./app_explorer_store.js";
import { format } from "./app_format.js";
import { sqlBlock } from "./app_ui_sql.js";
import { tabs as tabsMod } from "./app_ui_tabs.js";

const { $ } = dom;

function openTab(label) {
  model.tab = label;
  renderTabs();
  renderTabContent();
  syncExplorerUrl("push");
}

function renderTabs() {
  if (!dom.explorerDetailTabs) return;
  const tabs = availableTabs(model.detail);
  if (!tabs.includes(model.tab) && !model.detail?._loading) {
    // A deep link to a tab that this object does not have opens the first tab. For example, /storage on a View does this.
    // Keep the address bar in sync.
    model.tab = tabs[0];
    if (model.detail) syncExplorerUrl("replace");
  }
  if (tabs.length <= 1) {
    dom.explorerDetailTabs.hidden = true;
    dom.explorerDetailTabs.replaceChildren();
    return;
  }
  dom.explorerDetailTabs.hidden = false;
  tabsMod?.render(dom.explorerDetailTabs, tabs.map((label) => ({ value: label, label })), { selected: model.tab });
}

function renderLineageTab(container, detail) {
  const deps = visibleDependencies(detail);
  const s = detail.summary || {};
  const toolbar = h("div", { class: "explorerLineageToolbar" });
  toolbar.appendChild(h("span", { class: "explorerLineageToolbar__note" }, "Only objects readable by the runner are listed."));
  const open = h("button", { class: "button button--small" }, "Open lineage graph");
  open.type = "button";
  open.addEventListener("click", () => {
    actions.setMode("graph");
    parts.graph?.focusTable?.(s.database, s.name);
    syncExplorerUrl("push");
  });
  toolbar.appendChild(open);
  container.appendChild(toolbar);
  if (!deps.length) {
    container.appendChild(emptyNote(sectionUnavailable("dependencies") ? "Dependency metadata unavailable." : "No visible dependencies."));
    return;
  }
  // Both directions always render. So the layout keeps its shape when one side is empty.
  const matrix = h("div", { class: "explorerDependencyMatrix explorerLineage" });
  for (const relation of ["upstream", "downstream"]) {
    const items = deps
      .filter((dep) => String(dep.relation || "").toLowerCase() === relation)
      .slice()
      .sort((a, b) => `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`, undefined, { numeric: true, sensitivity: "base" }));
    const group = h("section", { class: "explorerDependencyGroup explorerLineage__group" });
    group.dataset.relation = relation;
    const title = h("h3", { class: "explorerLineage__title" }, relation === "upstream" ? "Upstream" : "Downstream");
    title.appendChild(h("span", { class: "explorerSection__count" }, format.count(items.length)));
    group.appendChild(title);
    const list = h("div", { class: "explorerLineage__list" });
    if (!items.length) list.appendChild(emptyNote(relation === "upstream" ? "Nothing feeds this object." : "Nothing reads from this object."));
    for (const dep of items) list.appendChild(dependencyChip(dep, s.database, { cluster: detail.distributed?.cluster || "" }));
    group.appendChild(list);
    matrix.appendChild(group);
  }
  container.appendChild(matrix);
}

function renderDdl(container, detail) {
  if (!detail.ddl) return container.appendChild(unavailableMessage("DDL"));
  const ddl = String(detail.formatted_ddl || detail.ddl);
  if (detail.ddl_format_error) container.appendChild(emptyNote(`Formatter unavailable: ${detail.ddl_format_error}`));

  // The shared read-only SQL block (sqlBlock) has the highlighter of the editor, a line gutter and the copy button.
  // The block grows with the DDL.
  const wrap = sqlBlock({ sql: ddl, gutter: true, copy: true, label: "CREATE statement", className: "explorerDdlWrap" });
  $(".sqlBlock__gutter", wrap)?.classList.add("explorerDdlGutter");
  $(".sqlBlock__body", wrap)?.classList.add("explorerDdl");
  $(".sqlBlock__copy", wrap)?.classList.add("explorerDdlCopy");
  container.appendChild(wrap);
}

function renderTabContent() {
  const container = dom.explorerDetailContent;
  if (!container) return;
  destroyDatabaseTreemap();
  destroyCardMaps();
  clear(container);
  const detail = model.detail;
  if (!detail) return;
  const card = h("div", { class: "explorerCard" });
  const main = h("div", { class: "explorerCard__main" });
  main.dataset.tab = String(model.tab || "").toLowerCase();
  card.appendChild(main);
  const about = renderAbout(detail);
  if (about) card.appendChild(about);
  container.appendChild(card);
  if (detail._loading) {
    main.appendChild(emptyNote("Loading detailed metadata\u2026"));
    return;
  }
  switch (model.tab) {
    case "Preview": renderPreviewTab(main, detail); break;
    case "Storage": renderStorageTab(main, detail); break;
    case "Operations": renderOperationsTab(main, detail); break;
    case "Lineage": renderLineageTab(main, detail); break;
    case "DDL": renderDdl(main, detail); break;
    default: renderColumnsTab(main, detail); break;
  }
}

// The tab row of the card (.contentTabs) uses the shared tab behaviour (click, arrows, Home / End, roving tabindex; app_ui_tabs.js).
// The database page has no tabs. This function is called one time, when the Catalog starts.
function init() {
  watchExpressions();
  tabsMod?.bind(dom.explorerDetailTabs, { onSelect: (label) => { if (model.selectedKey) openTab(label); } });
}

// These are the requests that the card tabs make to the card (app_explorer_store.js, `actions`).
Object.assign(actions, { openTab, renderTabContent });

const explorerDetail = { init, renderDetailHeader, renderTabs, renderTabContent, replicaHealthDot };

export { explorerDetail };
