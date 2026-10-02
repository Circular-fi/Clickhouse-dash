(() => {
  "use strict";

  // Explorer Storage view: one ncdu-style view of where the bytes are, at
  // the server, database or table scope. The sorted list (name, size, share
  // bar, rows, parts) is the main surface; the treemap is secondary, kept to a
  // limited height and drawn only when it can show a distribution (at least
  // three rectangles of >= 1% of the scope). Clicking a row or a rectangle
  // zooms into it.
  //
  //   server   -> databases (treemap: databases with their tables nested)
  //   database -> tables
  //   table    -> partitions (from the table detail endpoint)
  //
  // Byte accounting is the local on-disk accounting of /api/explorer/storage
  // (bytes_on_disk of active parts, total_bytes of Log-family engines).
  // Memory / Buffer / Dictionary RAM is reported, never drawn as disk area.
  //
  // ns.explorerStorage.show(container, { scope, includeSystem, fetchTable,
  // onScopeChange, onOpenTable }) mounts the full view. In the Explorer it is
  // the Catalog's Storage mode: the scope is the tree selection, a zoom asks
  // the shell to move that selection (onScopeChange), the tree's System chip
  // is includeSystem and fetchTable shares the card's table detail cache.
  // renderCompact() is the small variant embedded in the database page.

  const ns = window.ChDash;
  if (!ns) return;

  const STORAGE_CLIENT_TTL_MS = 30000;
  const TABLE_CLIENT_TTL_MS = 30000;
  const TREEMAP_MIN_ITEMS = 3;
  // The Explorer's "System" chip (app_explorer.js writes it).
  const INCLUDE_SYSTEM_KEY = ns.storage.KEYS.explorerIncludeSystem;
  const DASH = ns.format.EMPTY;
  const { h } = ns;

  const data = {
    hostId: "",
    storage: null,
    fetchedAtMs: 0,
    promise: null,
    error: null,
    tables: new Map(),
  };
  let view = null;

  // ---------------------------------------------------------------------------
  // Formatting: ns.format (docs/ui-foundations.md). Shares stay on a 0-100
  // scale for the bars; ns.format.percent takes a ratio.

  const format = ns.format;

  function percentText(value) {
    const n = Number(value);
    return value == null || !Number.isFinite(n) ? DASH : format.percent(n / 100);
  }

  function humanEngine(engine) {
    return String(engine || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  }

  function isSystemDatabaseName(name) {
    return ["system", "information_schema", "INFORMATION_SCHEMA"].includes(String(name || ""));
  }

  function normalizeScope(scope) {
    const database = String(scope?.database || "");
    return { database, table: database ? String(scope?.table || "") : "" };
  }

  function sameScope(a, b) {
    return a.database === b.database && a.table === b.table;
  }

  function hostId() {
    return String(ns.state?.selectedHostId || "");
  }

  // ---------------------------------------------------------------------------
  // Data

  function resetData() {
    data.hostId = hostId();
    data.storage = null;
    data.fetchedAtMs = 0;
    data.promise = null;
    data.error = null;
    data.tables.clear();
  }

  function storageFresh() {
    return !!data.storage && data.hostId === hostId() && Date.now() - data.fetchedAtMs < STORAGE_CLIENT_TTL_MS;
  }

  function loadStorage(force = false) {
    const host = hostId();
    if (!host) return Promise.resolve(null);
    if (data.hostId !== host) resetData();
    if (!force && storageFresh()) return Promise.resolve(data.storage);
    if (data.promise) return data.promise;
    data.error = null;
    data.promise = (async () => {
      try {
        const payload = await ns.api.getExplorerStorage(host, !!force);
        if (hostId() !== host) return null;
        data.storage = payload;
        data.fetchedAtMs = Date.now();
        return payload;
      } catch (error) {
        if (hostId() === host) data.error = error;
        return null;
      } finally {
        if (hostId() === host) data.promise = null;
      }
    })();
    return data.promise;
  }

  function tableKey(database, table) {
    return `${database}\0${table}`;
  }

  function loadTable(database, table, force = false) {
    const host = hostId();
    const key = tableKey(database, table);
    const entry = data.tables.get(key);
    if (!force && entry?.detail && Date.now() - entry.fetchedAtMs < TABLE_CLIENT_TTL_MS) return Promise.resolve(entry.detail);
    if (entry?.promise) return entry.promise;
    const next = { detail: entry?.detail || null, fetchedAtMs: entry?.fetchedAtMs || 0, error: null, promise: null };
    const fetchTable = view?.options?.fetchTable;
    next.promise = (async () => {
      try {
        const detail = typeof fetchTable === "function"
          ? await fetchTable(database, table, !!force)
          : await ns.api.getExplorerTable(host, database, table, !!force);
        if (hostId() !== host) return null;
        next.detail = detail;
        next.fetchedAtMs = Date.now();
        return detail;
      } catch (error) {
        next.error = error;
        return null;
      } finally {
        next.promise = null;
      }
    })();
    data.tables.set(key, next);
    while (data.tables.size > 32) data.tables.delete(data.tables.keys().next().value);
    return next.promise;
  }

  // ---------------------------------------------------------------------------
  // Levels: list rows + treemap tree for the current scope

  function storageDatabases(includeSystem) {
    return (data.storage?.databases || []).filter((item) => includeSystem || !(item.system || isSystemDatabaseName(item.name)));
  }

  function tableNode(database, table) {
    return {
      kind: "table",
      name: table.name,
      path: `${database}.${table.name}`,
      database,
      table: table.name,
      engine: humanEngine(table.engine),
      rows: table.rows == null ? null : Number(table.rows),
      bytes: Number(table.bytes || 0),
      count: 1,
    };
  }

  function serverLevel(includeSystem) {
    const databases = storageDatabases(includeSystem);
    const total = databases.reduce((sum, item) => sum + Number(item.bytes || 0), 0);
    const rows = databases.map((item) => ({
      key: item.name,
      name: item.name,
      bytes: Number(item.bytes || 0),
      rows: Number(item.rows || 0),
      count: Number(item.storing_tables || 0),
      objects: Number(item.objects || 0),
      resident: Number(item.resident_bytes || 0),
      zoom: { database: item.name },
    }));
    const tree = {
      kind: "server",
      name: "Server",
      path: "",
      bytes: total,
      count: databases.reduce((sum, item) => sum + Number(item.storing_tables || 0), 0),
      children: databases.filter((item) => Number(item.bytes || 0) > 0).map((item) => ({
        kind: "database",
        name: item.name,
        path: item.name,
        database: item.name,
        bytes: Number(item.bytes || 0),
        rows: Number(item.rows || 0),
        count: Number(item.storing_tables || 0),
        children: (item.tables || []).map((table) => tableNode(item.name, table)),
      })),
    };
    return {
      kind: "server",
      total,
      rows,
      tree,
      resident: databases.reduce((sum, item) => sum + Number(item.resident_bytes || 0), 0),
      databases,
    };
  }

  function databaseLevel(name) {
    const entry = (data.storage?.databases || []).find((item) => item.name === name) || null;
    if (!entry) return { kind: "database", missing: true, total: 0, rows: [], tree: null, resident: 0 };
    const rows = (entry.tables || []).map((table) => ({
      key: table.name,
      name: table.name,
      engine: humanEngine(table.engine),
      bytes: Number(table.bytes || 0),
      rows: table.rows == null ? null : Number(table.rows),
      parts: table.parts == null ? null : Number(table.parts),
      zoom: { database: name, table: table.name },
      open: { database: name, table: table.name },
    }));
    const tree = {
      kind: "database",
      name,
      path: name,
      database: name,
      bytes: Number(entry.bytes || 0),
      count: Number(entry.storing_tables || 0),
      children: (entry.tables || []).map((table) => tableNode(name, table)),
    };
    return {
      kind: "database",
      entry,
      total: Number(entry.bytes || 0),
      rows,
      tree,
      resident: Number(entry.resident_bytes || 0),
      omitted: Number(entry.omitted_tables || 0) > 0
        ? { count: Number(entry.omitted_tables), bytes: Number(entry.omitted_bytes || 0), rows: Number(entry.omitted_rows || 0) }
        : null,
    };
  }

  function tableLevel(database, table) {
    const entry = data.tables.get(tableKey(database, table)) || null;
    const detail = entry?.detail || null;
    const storageTable = ((data.storage?.databases || []).find((item) => item.name === database)?.tables || [])
      .find((item) => item.name === table) || null;
    const summary = detail?.summary || {};
    const engine = humanEngine(summary.engine || storageTable?.engine || "");
    const partitions = Array.isArray(detail?.partitions) ? detail.partitions : [];
    const total = partitions.length
      ? partitions.reduce((sum, item) => sum + Number(item.bytes || 0), 0)
      : Number(storageTable?.bytes || 0);
    const rows = partitions.map((item) => ({
      key: item.partition,
      name: item.partition === "" ? "(no partition)" : item.partition,
      bytes: Number(item.bytes || 0),
      rows: item.rows == null ? null : Number(item.rows),
      parts: item.parts == null ? null : Number(item.parts),
    }));
    const tree = {
      kind: "server",
      name: table,
      path: `${database}.${table}`,
      bytes: total,
      count: partitions.length,
      children: partitions.map((item) => ({
        kind: "partition",
        name: item.partition === "" ? "(no partition)" : item.partition,
        path: `${database}.${table}`,
        database,
        table,
        engine,
        rows: item.rows == null ? null : Number(item.rows),
        bytes: Number(item.bytes || 0),
        count: 1,
      })),
    };
    return {
      kind: "table",
      loading: !detail && !entry?.error,
      error: entry?.error || null,
      detail,
      storageTable,
      engine,
      total,
      rows,
      tree,
      resident: 0,
      partitionLimitReached: partitions.length >= 1000,
    };
  }

  // Rectangles of a materialized treemap that stand for real objects, i.e.
  // leaves that hold >= 1% of the root (everything smaller is in Others).
  function significantLeafCount(tree) {
    let count = 0;
    const visit = (item) => {
      if (!item || item.kind === "other") return;
      const children = Array.isArray(item.children) ? item.children : [];
      if (!children.length) { count += 1; return; }
      children.forEach(visit);
    };
    if (Array.isArray(tree?.children) && tree.children.length) tree.children.forEach(visit);
    return count;
  }

  // ---------------------------------------------------------------------------
  // Shared rendering helpers

  function renderLegend(container, tree) {
    if (!container) return;
    const families = ns.explorerTreemap?.engineLegend?.([tree]) || [];
    container.replaceChildren(...families.map((family) => {
      const item = h("span", { class: "explorerTreemapLegend__item" });
      const swatch = h("span", { class: "explorerTreemapLegend__swatch" });
      swatch.style.background = family.color;
      item.append(swatch, h("span", null, family.label));
      return item;
    }));
    container.hidden = !families.length;
  }

  function footnoteText({ threshold = 0, scopeLabel = "", resident = 0, treemapShown = false }) {
    const bits = ["On-disk bytes of active parts (local replica)"];
    if (treemapShown && threshold > 0) bits.push(`the map groups objects under 1% of ${scopeLabel} (< ${format.bytes(threshold)}) into Others`);
    if (resident > 0) bits.push(`RAM of Memory / Buffer / Dictionary not counted: ${format.bytes(resident)}`);
    return `${bits.join(" · ")}.`;
  }

  function shareBarCell(td, bytes, total, max) {
    const share = total > 0 ? bytes / total * 100 : null;
    td.classList.add("num");
    ns.table.cellBar(td, max > 0 ? Math.max(bytes > 0 ? 1.5 : 0, Math.min(100, bytes / max * 100)) : 0);
    td.textContent = share == null ? DASH : percentText(share);
    td.dataset.value = share == null ? "" : String(share);
  }

  // ---------------------------------------------------------------------------
  // Full view

  const COLUMNS = {
    server: [
      { key: "name", label: "Database", type: "text" },
      { key: "bytes", label: "Size", type: "num" },
      { key: "share", label: "Share", type: "share" },
      { key: "rows", label: "Rows", type: "num" },
      { key: "count", label: "Tables", type: "num", title: "Tables with on-disk data / all objects" },
    ],
    database: [
      { key: "name", label: "Table", type: "text" },
      { key: "engine", label: "Engine", type: "text" },
      { key: "bytes", label: "Size", type: "num" },
      { key: "share", label: "Share", type: "share" },
      { key: "rows", label: "Rows", type: "num" },
      { key: "parts", label: "Parts", type: "num", title: "Active parts" },
    ],
    table: [
      { key: "name", label: "Partition", type: "text" },
      { key: "bytes", label: "Size", type: "num" },
      { key: "share", label: "Share", type: "share" },
      { key: "rows", label: "Rows", type: "num" },
      { key: "parts", label: "Parts", type: "num", title: "Active parts" },
    ],
  };

  // The shell passes the tree's System chip; a standalone view reads the
  // stored chip state.
  function includeSystemOption() {
    if (typeof view?.options?.includeSystem === "boolean") return view.options.includeSystem;
    return ns.storage.pref(INCLUDE_SYSTEM_KEY, false).get();
  }

  function effectiveIncludeSystem() {
    return includeSystemOption() || isSystemDatabaseName(view?.scope?.database);
  }

  function mountView(container) {
    view?.treemap?.destroy();
    const root = h("section", { class: "explorerStorageView" });
    root.setAttribute("aria-label", "Storage");

    // No breadcrumb: the tree selection is the location. The meta line sums
    // the scope up.
    const header = h("header", { class: "explorerStorageView__header" });
    const heading = h("div", { class: "explorerStorageView__heading" });
    const meta = h("div", { class: "explorerStorageView__meta" });
    heading.append(meta);
    const actions = h("div", { class: "explorerStorageView__actions" });
    const openTable = h("button", { class: "button button--small explorerStorageView__open" }, "Open card");
    openTable.title = "Open the table card";
    openTable.type = "button";
    openTable.hidden = true;
    const refresh = h("button", { class: "button button--small explorerRefreshButton explorerStorageView__refresh" });
    refresh.type = "button";
    refresh.title = "Refresh storage";
    refresh.setAttribute("aria-label", "Refresh storage");
    refresh.innerHTML = '<svg class="refreshGlyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 5.25A5.25 5.25 0 1 0 13.1 10.5"/><path d="M13 2.75v3.1h-3.1"/></svg>';
    actions.append(openTable, refresh);
    header.append(heading, actions);

    const notice = h("div", { class: "explorerStorageView__notice" });
    notice.hidden = true;
    const map = h("section", { class: "explorerStorageView__map" });
    map.hidden = true;
    const mapHost = h("div", { class: "explorerTreemapPanel explorerTreemapPanel--storage" });
    const mapFooter = h("div", { class: "explorerTreemapFooter" });
    const legend = h("div", { class: "explorerTreemapLegend" });
    mapFooter.appendChild(legend);
    map.append(mapHost, mapFooter);
    const list = h("div", { class: "explorerStorageView__list" });
    const footnote = h("div", { class: "explorerStorageView__footnote" });
    root.append(header, notice, list, map, footnote);
    container.replaceChildren(root);

    view = {
      container,
      root,
      meta,
      openTable,
      refresh,
      notice,
      map,
      mapHost,
      legend,
      list,
      footnote,
      treemap: null,
      scope: { database: "", table: "" },
      options: {},
      sort: { server: { key: "bytes", dir: "desc" }, database: { key: "bytes", dir: "desc" }, table: { key: "bytes", dir: "desc" } },
    };

    refresh.addEventListener("click", () => void refreshView(true));
    openTable.addEventListener("click", () => {
      if (view.scope.table) openTableRoute(view.scope.database, view.scope.table);
    });
  }

  function openTableRoute(database, table) {
    if (typeof view?.options?.onOpenTable === "function") {
      view.options.onOpenTable(database, table);
      return;
    }
    window.location.assign(ns.router.url(`/explorer/${encodeURIComponent(database)}/${encodeURIComponent(table)}`));
  }

  function setScope(scope, { notify = true } = {}) {
    if (!view) return;
    const next = normalizeScope(scope);
    if (sameScope(next, view.scope)) return;
    view.scope = next;
    render();
    void ensureViewData(false);
    if (notify) view.options.onScopeChange?.({ ...next });
    view.root.querySelector(".explorerStorageView__list")?.scrollIntoView?.({ block: "nearest" });
  }

  function sortedRows(level, rows, total) {
    const sort = view.sort[level];
    const columns = COLUMNS[level];
    const column = columns.find((item) => item.key === sort.key) || columns[1];
    const key = column.key === "share" ? "bytes" : column.key;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = a[key];
      const right = b[key];
      if (left == null && right == null) return String(a.name).localeCompare(String(b.name));
      if (left == null) return 1;
      if (right == null) return -1;
      const order = column.type === "text"
        ? String(left).localeCompare(String(right), undefined, { numeric: true })
        : Number(left) - Number(right);
      return order * dir || String(a.name).localeCompare(String(b.name));
    });
  }

  function renderList(level, info) {
    const columns = COLUMNS[level];
    const table = h("table", { class: `explorerStorageList explorerStorageList--${level} dataTable dataTable--compact` });
    table.id = "explorerStorageList";
    const thead = h("thead");
    const headRow = h("tr");
    const sort = view.sort[level];
    for (const column of columns) {
      const th = h("th", { class: `explorerStorageList__th explorerStorageList__th--${column.key}${column.type === "text" ? "" : " num"}` }, column.label);
      th.scope = "col";
      ns.table.sortHeader(th, {
        key: column.key,
        dir: sort.key === column.key ? sort.dir : "",
        title: column.title || "",
        onSort: () => {
          const current = view.sort[level];
          const firstDir = column.type === "text" ? "asc" : "desc";
          view.sort[level] = current.key === column.key
            ? { key: column.key, dir: current.dir === "asc" ? "desc" : "asc" }
            : { key: column.key, dir: firstDir };
          render();
        },
      });
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = h("tbody");
    const rows = sortedRows(level, info.rows, info.total);
    const maxBytes = Math.max(0, ...info.rows.map((row) => Number(row.bytes || 0)));
    const maxRows = Math.max(0, ...info.rows.map((row) => Number(row.rows || 0)));
    for (const row of rows) {
      const tr = h("tr", { class: "explorerStorageList__row" });
      tr.dataset.name = row.key;
      if (row.zoom) tr.classList.add("is-zoomable");
      for (const column of columns) {
        const td = h("td", { class: `explorerStorageList__cell explorerStorageList__cell--${column.key}${column.type === "num" ? " num" : ""}` });
        if (column.key === "name") {
          if (row.zoom) {
            const button = h("button", { class: "explorerStorageList__name" }, row.name);
            button.type = "button";
            button.title = level === "server" ? `Show the tables of ${row.name}` : `Show the partitions of ${row.name}`;
            button.addEventListener("click", () => setScope(row.zoom));
            td.appendChild(button);
          } else {
            td.appendChild(h("span", { class: "explorerStorageList__name explorerStorageList__name--static" }, row.name));
          }
          if (row.open) {
            const open = h("button", { class: "explorerStorageList__open" }, "\u2197");
            open.type = "button";
            open.title = `Open ${row.open.database}.${row.open.table}`;
            open.setAttribute("aria-label", `Open ${row.open.database}.${row.open.table}`);
            open.addEventListener("click", (event) => {
              event.stopPropagation();
              openTableRoute(row.open.database, row.open.table);
            });
            td.appendChild(open);
          }
        } else if (column.key === "engine") {
          td.textContent = row.engine || DASH;
        } else if (column.key === "bytes") {
          td.textContent = format.bytes(row.bytes);
          td.dataset.value = String(row.bytes ?? "");
          if (row.resident > 0) td.title = `${format.bytes(row.resident)} RAM (Memory / Buffer / Dictionary) not counted`;
        } else if (column.key === "share") {
          shareBarCell(td, Number(row.bytes || 0), info.total, maxBytes);
        } else if (column.key === "rows") {
          td.textContent = row.rows == null ? DASH : format.count(row.rows);
          td.dataset.value = row.rows == null ? "" : String(row.rows);
          if (row.rows != null && maxRows > 0) td.title = format.compact(row.rows);
        } else if (column.key === "count") {
          td.textContent = row.objects > row.count ? `${format.count(row.count)} / ${format.count(row.objects)}` : format.count(row.count);
          td.dataset.value = String(row.count ?? "");
        } else if (column.key === "parts") {
          td.textContent = row.parts == null ? DASH : format.count(row.parts);
          td.dataset.value = row.parts == null ? "" : String(row.parts);
        }
        tr.appendChild(td);
      }
      if (row.zoom) {
        tr.addEventListener("click", (event) => {
          if (event.target.closest("button")) return;
          setScope(row.zoom);
        });
      }
      tbody.appendChild(tr);
    }
    if (info.omitted) {
      const tr = h("tr", { class: "explorerStorageList__row explorerStorageList__row--omitted" });
      for (const column of columns) {
        const td = h("td", { class: `explorerStorageList__cell explorerStorageList__cell--${column.key}${column.type === "num" ? " num" : ""}` });
        if (column.key === "name") td.textContent = `${format.countLabel(Number(info.omitted.count || 0), "smaller table")}`;
        else if (column.key === "bytes") td.textContent = format.bytes(info.omitted.bytes);
        else if (column.key === "share") shareBarCell(td, info.omitted.bytes, info.total, maxBytes);
        else if (column.key === "rows") td.textContent = format.count(info.omitted.rows);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    return table;
  }

  function renderTreemap(info, scopeName) {
    const treemap = ns.explorerTreemap;
    if (!treemap || !info.tree || !(info.total > 0)) {
      view.map.hidden = true;
      return { shown: false, threshold: 0 };
    }
    const { threshold, tree } = treemap.buildTreemap(info.tree);
    const shown = significantLeafCount(tree) >= TREEMAP_MIN_ITEMS;
    view.map.hidden = !shown;
    if (!shown) return { shown: false, threshold };
    if (!view.treemap) {
      view.treemap = treemap.mount(view.mapHost, {
        ariaLabel: "Storage treemap",
        emptyText: "No on-disk data.",
        formatBytes: (value) => format.bytes(value),
        onOpen: (target) => {
          if (target.kind === "table" && target.database && target.table) setScope({ database: target.database, table: target.table });
          else if (target.kind === "database") setScope({ database: target.database || target.name });
        },
      });
      view.mapHost.id = "explorerStorageTreemap";
    }
    view.treemap?.setTree(tree, { name: scopeName });
    renderLegend(view.legend, tree);
    return { shown: true, threshold };
  }

  // The notice above the map (ns.uiState.banner): an error with Retry, or a
  // neutral note (a stale distribution).
  function setNotice(text, kind = "") {
    const error = kind === "error";
    ns.uiState.banner(view.notice, { message: text, level: error ? "error" : "info", inset: true, retry: error ? () => { void refreshView(true); } : null });
  }

  function emptyList(text, loading = false) {
    if (loading) ns.uiState.loading(view.list, { label: text, compact: true });
    else if (text) ns.uiState.empty(view.list, { body: text, compact: true });
    else view.list.replaceChildren();
  }

  function render() {
    if (!view) return;
    const { database, table } = view.scope;
    const includeSystem = effectiveIncludeSystem();
    view.openTable.hidden = !table;
    ns.uiState.busy(view.refresh, !!data.promise);
    view.root.dataset.level = table ? "table" : database ? "database" : "server";

    if (!data.storage) {
      view.meta.textContent = data.promise ? "Loading\u2026" : "";
      view.map.hidden = true;
      view.footnote.textContent = "";
      if (data.error) {
        setNotice(String(data.error?.message || "The storage distribution could not be loaded."), "error");
        emptyList("The storage distribution is unavailable.");
      } else {
        setNotice("");
        emptyList(data.promise ? "Loading storage\u2026" : "", !!data.promise);
      }
      return;
    }
    setNotice(data.error ? `Showing the last loaded distribution: ${data.error.message || "refresh failed"}` : (data.storage.stale ? "Showing a stale distribution while the server refreshes it." : ""), data.error ? "error" : "");

    let level;
    let info;
    if (table) {
      level = "table";
      info = tableLevel(database, table);
      const bits = [info.engine || null];
      if (info.detail) bits.push(format.countLabel(info.rows.length, "partition"));
      bits.push(format.bytes(info.total));
      const rowsTotal = info.detail?.summary?.rows ?? info.storageTable?.rows;
      if (rowsTotal != null) bits.push(`${format.compact(rowsTotal)} rows`);
      view.meta.textContent = bits.filter(Boolean).join(" · ");
    } else if (database) {
      level = "database";
      info = databaseLevel(database);
      if (info.missing) {
        view.meta.textContent = "";
        view.map.hidden = true;
        view.footnote.textContent = "";
        emptyList(`Database ${database} is not visible to this connection.`);
        return;
      }
      const bits = [format.countLabel(Number(info.entry.storing_tables || 0), "table") + " with data", format.bytes(info.total)];
      if (Number(info.entry.objects || 0) > Number(info.entry.storing_tables || 0)) bits.push(`${format.count(info.entry.objects)} objects`);
      view.meta.textContent = bits.join(" · ");
    } else {
      level = "server";
      info = serverLevel(includeSystem);
      const storing = info.databases.reduce((sum, item) => sum + Number(item.storing_tables || 0), 0);
      view.meta.textContent = [format.countLabel(info.databases.length, "database"), `${format.countLabel(storing, "table")} with data`, format.bytes(info.total)].join(" · ");
    }

    const scopeName = table ? `${database}.${table}` : (database || "the server");
    const { shown, threshold } = renderTreemap(info, scopeName);
    view.footnote.textContent = footnoteText({ threshold, scopeLabel: table ? "the table" : database ? "the database" : "the server", resident: info.resident, treemapShown: shown });

    if (level === "table") {
      if (info.loading) { emptyList("Loading partitions\u2026"); return; }
      if (info.error) { emptyList(`Partitions unavailable: ${info.error.message || "request failed"}`); return; }
      if (!info.rows.length) {
        emptyList(info.total > 0
          ? `${info.engine || "This engine"} has no partitions: the table is stored as one unit of ${format.bytes(info.total)}.`
          : "This object stores no data on disk.");
        return;
      }
    } else if (level === "database" && !info.rows.length) {
      emptyList(info.resident > 0
        ? `No table of ${database} stores data on disk; its Memory / Buffer / Dictionary objects hold ${format.bytes(info.resident)} of RAM.`
        : `No table of ${database} stores data on disk.`);
      return;
    } else if (level === "server" && !info.rows.length) {
      emptyList("No database is visible to this connection.");
      return;
    }
    view.list.replaceChildren(renderList(level, info));
    if (level === "table" && info.partitionLimitReached) {
      view.list.appendChild(h("div", { class: "explorerStorageView__hint" }, "Only the 1,000 most recently modified partitions are listed."));
    }
  }

  async function ensureViewData(force) {
    if (!view) return;
    const promise = loadStorage(force);
    render();
    await promise;
    if (!view) return;
    const { database, table } = view.scope;
    if (database && table) {
      const tablePromise = loadTable(database, table, force);
      render();
      await tablePromise;
    }
    render();
  }

  async function refreshView(force) {
    if (!view) return;
    if (force && view.scope.table) data.tables.delete(tableKey(view.scope.database, view.scope.table));
    await ensureViewData(force);
  }

  function show(container, options = {}) {
    if (!container) return;
    if (!view || view.container !== container || !view.root.isConnected) mountView(container);
    view.options = { ...options };
    view.scope = normalizeScope(options.scope);
    render();
    void ensureViewData(!!options.refresh);
  }

  function hide() {
    // The view keeps its DOM and data; nothing polls while hidden.
  }

  function currentScope() {
    return view ? { ...view.scope } : { database: "", table: "" };
  }

  // ---------------------------------------------------------------------------
  // Compact variant (database page)
  //
  // The treemap band appears only when at least three tables hold >= 1% of
  // the database; otherwise one share strip shows how the bytes split (one
  // dominant table plus Others), so a 99.9% block never pushes the object
  // list below the fold.

  function renderCompact(container, { root, residentBytes = 0, name = "", onOpen, onShowStorage } = {}) {
    const treemap = ns.explorerTreemap;
    const section = h("section", { class: "explorerDatabaseStorage" });
    const head = h("div", { class: "explorerDatabaseStorage__head" });
    head.appendChild(h("h3", { class: "explorerSectionTitle" }, "Storage"));
    const total = Number(root?.bytes || 0);
    head.appendChild(h("span", { class: "explorerDatabaseStorage__meta" }, total > 0
      ? `${format.bytes(total)} on disk${residentBytes > 0 ? ` · ${format.bytes(residentBytes)} RAM` : ""}`
      : ""));
    if (typeof onShowStorage === "function") {
      const link = h("button", { class: "explorerDatabaseStorage__link" }, "Storage view");
      link.type = "button";
      link.title = `Open ${name} in the Storage view`;
      link.addEventListener("click", () => onShowStorage());
      head.appendChild(link);
    }
    section.appendChild(head);
    container.appendChild(section);
    if (!treemap || !(total > 0)) {
      section.appendChild(ns.uiState.block("empty", {
        compact: true,
        body: residentBytes > 0
          ? `No on-disk data. Resident memory: ${format.bytes(residentBytes)} (Memory / Buffer / Dictionary).`
          : "No on-disk data in this database.",
      }));
      return { destroy() {} };
    }
    const { threshold, tree } = treemap.buildTreemap(root);
    if (significantLeafCount(tree) >= TREEMAP_MIN_ITEMS) {
      const host = h("div", { class: "explorerTreemapPanel explorerTreemapPanel--database" });
      host.id = "explorerDatabaseTreemap";
      const footer = h("div", { class: "explorerTreemapFooter" });
      const legend = h("div", { class: "explorerTreemapLegend" });
      footer.append(legend, h("div", { class: "explorerTreemapFootnote" }, footnoteText({ threshold, scopeLabel: "the database", resident: residentBytes, treemapShown: true })));
      section.append(host, footer);
      renderLegend(legend, tree);
      const controller = treemap.mount(host, {
        ariaLabel: `${name} table size treemap`,
        formatBytes: (value) => format.bytes(value),
        onOpen: (target) => {
          if (target.kind === "table" && target.database && target.table) onOpen?.(target.database, target.table);
        },
      });
      controller?.setTree(tree, { name });
      return controller || { destroy() {} };
    }

    // Share strip: the materialized top level (tables >= 1% + Others). A
    // database of many tables that are each under 1% has no such level: it
    // is drawn as one Others segment.
    const top = Array.isArray(tree.children) && tree.children.length
      ? tree.children
      : [tree.kind === "table" ? tree : { kind: "other", name: "Others", members: Number(tree.count || 0), bytes: total }];
    const items = top.filter((item) => Number(item.bytes || 0) > 0);
    const strip = h("div", { class: "explorerStorageStrip" });
    strip.id = "explorerDatabaseStorageStrip";
    strip.setAttribute("role", "list");
    strip.setAttribute("aria-label", `${name} storage split`);
    const legend = h("div", { class: "explorerStorageStrip__legend" });
    for (const item of items) {
      const share = Number(item.bytes || 0) / total * 100;
      const other = item.kind === "other";
      const label = other ? `Others (${format.countLabel(Number(item.members || 0), "table")})` : item.name;
      const segment = h(other || !onOpen ? "span" : "button", { class: `explorerStorageStrip__segment${other ? " is-other" : ""}` });
      segment.setAttribute("role", "listitem");
      if (!other) {
        segment.dataset.table = item.table || item.name;
        segment.style.setProperty("--treemap-color", treemap.engineFamily(item.engine).color);
      }
      segment.style.flexGrow = String(Math.max(share, 0.6));
      segment.title = `${other ? `Others in ${name}` : `${name}.${item.name}`}\n${format.bytes(item.bytes)} · ${percentText(share)}`;
      if (share >= 12) segment.appendChild(h("span", { class: "explorerStorageStrip__label" }, `${label} · ${percentText(share)}`));
      if (!other && onOpen) {
        segment.type = "button";
        segment.addEventListener("click", () => onOpen(name, item.table || item.name));
      }
      strip.appendChild(segment);
      const entry = h("span", { class: "explorerStorageStrip__entry" });
      const swatch = h("span", { class: `explorerStorageStrip__swatch${other ? " is-other" : ""}` });
      if (!other) swatch.style.background = treemap.engineFamily(item.engine).color;
      entry.append(swatch, h("span", { class: "explorerStorageStrip__name" }, label), h("span", { class: "explorerStorageStrip__value" }, `${format.bytes(item.bytes)} · ${percentText(share)}`));
      legend.appendChild(entry);
    }
    section.append(strip, legend);
    return { destroy() {} };
  }

  window.addEventListener("chdash:host-changed", () => {
    view?.treemap?.destroy();
    if (view) view.treemap = null;
    resetData();
    // The shell resets its own scope and calls show() again; a standalone
    // view simply returns to the server scope.
    if (view?.root?.isConnected && view.container && !view.container.hidden) {
      view.scope = { database: "", table: "" };
      void ensureViewData(false);
    }
  });

  ns.explorerStorage = {
    show,
    hide,
    refresh: (force = false) => refreshView(force),
    currentScope,
    renderCompact,
    significantLeafCount,
  };
})();
