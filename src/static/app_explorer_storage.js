(() => {
  "use strict";

  // Explorer Storage view: one ncdu-style view of where the bytes are, with a
  // breadcrumb server > database > table. The sorted list (name, size, share
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
  // ns.explorerStorage.show(container, { scope, ... }) mounts the full view;
  // renderCompact() is the small variant embedded in the database page.

  const ns = window.ChDash;
  if (!ns) return;

  const STORAGE_CLIENT_TTL_MS = 30000;
  const TABLE_CLIENT_TTL_MS = 30000;
  const TREEMAP_MIN_ITEMS = 3;
  const INCLUDE_SYSTEM_KEY = "chdash.explorer.includeSystem";
  const DASH = "\u2014";

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
  // Formatting

  function fmtBytes(value) {
    const n = Number(value);
    return value == null || !Number.isFinite(n) ? DASH : ns.util.formatBytes(n);
  }

  function fmtInt(value) {
    const n = Number(value);
    return value == null || !Number.isFinite(n) ? DASH : ns.util.formatInt(n);
  }

  function fmtCompact(value) {
    const n = Number(value);
    if (value == null || !Number.isFinite(n)) return DASH;
    try {
      return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
    } catch {
      return String(Math.trunc(n));
    }
  }

  function fmtPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DASH;
    if (n === 0) return "0%";
    if (n > 0 && n < 0.1) return "<0.1%";
    return `${n.toFixed(n < 10 ? 1 : 0)}%`;
  }

  function plural(count, singular, pluralText = `${singular}s`) {
    const value = Math.max(0, Number(count || 0));
    return `${fmtInt(value)} ${value === 1 ? singular : pluralText}`;
  }

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
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
    next.promise = (async () => {
      try {
        const detail = await ns.api.getExplorerTable(host, database, table, !!force);
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
      const item = node("span", "explorerTreemapLegend__item");
      const swatch = node("span", "explorerTreemapLegend__swatch");
      swatch.style.background = family.color;
      item.append(swatch, node("span", "", family.label));
      return item;
    }));
    container.hidden = !families.length;
  }

  function footnoteText({ threshold = 0, scopeLabel = "", resident = 0, treemapShown = false }) {
    const bits = ["On-disk bytes of active parts (local replica)"];
    if (treemapShown && threshold > 0) bits.push(`the map groups objects under 1% of ${scopeLabel} (< ${fmtBytes(threshold)}) into Others`);
    if (resident > 0) bits.push(`RAM of Memory / Buffer / Dictionary not counted: ${fmtBytes(resident)}`);
    return `${bits.join(" · ")}.`;
  }

  function shareBarCell(td, bytes, total, max) {
    const share = total > 0 ? bytes / total * 100 : null;
    const bar = node("span", "explorerStorageList__bar");
    const fill = node("span", "explorerStorageList__fill");
    fill.style.width = `${max > 0 ? Math.max(bytes > 0 ? 1.5 : 0, Math.min(100, bytes / max * 100)).toFixed(2) : 0}%`;
    bar.appendChild(fill);
    td.append(bar, node("span", "explorerStorageList__pct", share == null ? DASH : fmtPercent(share)));
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

  function includeSystemOption() {
    if (typeof view?.options?.includeSystem === "boolean") return view.options.includeSystem;
    try { return localStorage.getItem(INCLUDE_SYSTEM_KEY) === "1"; } catch { return false; }
  }

  function effectiveIncludeSystem() {
    return includeSystemOption() || isSystemDatabaseName(view?.scope?.database);
  }

  function mountView(container) {
    view?.treemap?.destroy();
    const root = node("section", "explorerStorageView");
    root.setAttribute("aria-label", "Storage");

    const header = node("header", "explorerStorageView__header");
    const heading = node("div", "explorerStorageView__heading");
    const crumbs = node("nav", "explorerStorageCrumbs");
    crumbs.setAttribute("aria-label", "Storage scope");
    const meta = node("div", "explorerStorageView__meta");
    heading.append(crumbs, meta);
    const actions = node("div", "explorerStorageView__actions");
    const option = node("label", "explorerStorageView__option");
    const includeSystem = node("input");
    includeSystem.type = "checkbox";
    option.append(includeSystem, node("span", "", "System databases"));
    const openTable = node("button", "button button--small explorerStorageView__open", "Open table");
    openTable.type = "button";
    openTable.hidden = true;
    const refresh = node("button", "button button--small explorerRefreshButton explorerStorageView__refresh");
    refresh.type = "button";
    refresh.title = "Refresh storage";
    refresh.setAttribute("aria-label", "Refresh storage");
    refresh.innerHTML = '<svg class="refreshGlyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 5.25A5.25 5.25 0 1 0 13.1 10.5"/><path d="M13 2.75v3.1h-3.1"/></svg>';
    actions.append(openTable, option, refresh);
    header.append(heading, actions);

    const notice = node("div", "explorerStorageView__notice");
    notice.hidden = true;
    const map = node("section", "explorerStorageView__map");
    map.hidden = true;
    const mapHost = node("div", "explorerTreemapPanel explorerTreemapPanel--storage");
    const mapFooter = node("div", "explorerTreemapFooter");
    const legend = node("div", "explorerTreemapLegend");
    mapFooter.appendChild(legend);
    map.append(mapHost, mapFooter);
    const list = node("div", "explorerStorageView__list");
    const footnote = node("div", "explorerStorageView__footnote");
    root.append(header, notice, list, map, footnote);
    container.replaceChildren(root);

    view = {
      container,
      root,
      crumbs,
      meta,
      includeSystem,
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

    includeSystem.addEventListener("change", () => {
      if (includeSystem.disabled) return;
      const value = !!includeSystem.checked;
      if (typeof view.options.onIncludeSystemChange === "function") {
        view.options.includeSystem = value;
        view.options.onIncludeSystemChange(value);
      } else {
        try { localStorage.setItem(INCLUDE_SYSTEM_KEY, value ? "1" : "0"); } catch {}
      }
      render();
    });
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
    const base = String(window.__CHDASH_BASE_PATH__ || "/").replace(/\/+$/, "");
    window.location.assign(`${base}/explorer/${encodeURIComponent(database)}/${encodeURIComponent(table)}/overview`);
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

  function renderCrumbs() {
    const { database, table } = view.scope;
    const items = [{ label: hostId() || "Server", title: "Whole server", scope: {} }];
    if (database) items.push({ label: database, title: `Database ${database}`, scope: { database } });
    if (table) items.push({ label: table, title: `Table ${database}.${table}`, scope: { database, table } });
    const list = node("ol", "explorerStorageCrumbs__list");
    items.forEach((item, index) => {
      const li = node("li", "explorerStorageCrumbs__item");
      const last = index === items.length - 1;
      if (last) {
        const current = node("span", "explorerStorageCrumbs__current", item.label);
        current.setAttribute("aria-current", "page");
        current.title = item.title;
        li.appendChild(current);
      } else {
        const button = node("button", "explorerStorageCrumbs__link", item.label);
        button.type = "button";
        button.title = item.title;
        button.addEventListener("click", () => setScope(item.scope));
        li.appendChild(button);
      }
      list.appendChild(li);
    });
    view.crumbs.replaceChildren(list);
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
    const table = node("table", `explorerStorageList explorerStorageList--${level}`);
    table.id = "explorerStorageList";
    const thead = node("thead");
    const headRow = node("tr");
    const sort = view.sort[level];
    for (const column of columns) {
      const th = node("th", `explorerStorageList__th explorerStorageList__th--${column.type} explorerStorageList__th--${column.key}`);
      th.scope = "col";
      const active = sort.key === column.key;
      const button = node("button", "explorerStorageList__sort", column.label);
      button.type = "button";
      if (column.title) button.title = column.title;
      if (active) {
        th.setAttribute("aria-sort", sort.dir === "asc" ? "ascending" : "descending");
        th.dataset.sort = sort.dir;
      }
      button.addEventListener("click", () => {
        const current = view.sort[level];
        const firstDir = column.type === "text" ? "asc" : "desc";
        view.sort[level] = current.key === column.key
          ? { key: column.key, dir: current.dir === "asc" ? "desc" : "asc" }
          : { key: column.key, dir: firstDir };
        render();
      });
      th.appendChild(button);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = node("tbody");
    const rows = sortedRows(level, info.rows, info.total);
    const maxBytes = Math.max(0, ...info.rows.map((row) => Number(row.bytes || 0)));
    const maxRows = Math.max(0, ...info.rows.map((row) => Number(row.rows || 0)));
    for (const row of rows) {
      const tr = node("tr", "explorerStorageList__row");
      tr.dataset.name = row.key;
      if (row.zoom) tr.classList.add("is-zoomable");
      for (const column of columns) {
        const td = node("td", `explorerStorageList__cell explorerStorageList__cell--${column.key}`);
        if (column.key === "name") {
          if (row.zoom) {
            const button = node("button", "explorerStorageList__name", row.name);
            button.type = "button";
            button.title = level === "server" ? `Show the tables of ${row.name}` : `Show the partitions of ${row.name}`;
            button.addEventListener("click", () => setScope(row.zoom));
            td.appendChild(button);
          } else {
            td.appendChild(node("span", "explorerStorageList__name explorerStorageList__name--static", row.name));
          }
          if (row.open) {
            const open = node("button", "explorerStorageList__open", "\u2197");
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
          td.textContent = fmtBytes(row.bytes);
          td.dataset.value = String(row.bytes ?? "");
          if (row.resident > 0) td.title = `${fmtBytes(row.resident)} RAM (Memory / Buffer / Dictionary) not counted`;
        } else if (column.key === "share") {
          shareBarCell(td, Number(row.bytes || 0), info.total, maxBytes);
        } else if (column.key === "rows") {
          td.textContent = row.rows == null ? DASH : fmtInt(row.rows);
          td.dataset.value = row.rows == null ? "" : String(row.rows);
          if (row.rows != null && maxRows > 0) td.title = fmtCompact(row.rows);
        } else if (column.key === "count") {
          td.textContent = row.objects > row.count ? `${fmtInt(row.count)} / ${fmtInt(row.objects)}` : fmtInt(row.count);
          td.dataset.value = String(row.count ?? "");
        } else if (column.key === "parts") {
          td.textContent = row.parts == null ? DASH : fmtInt(row.parts);
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
      const tr = node("tr", "explorerStorageList__row explorerStorageList__row--omitted");
      for (const column of columns) {
        const td = node("td", `explorerStorageList__cell explorerStorageList__cell--${column.key}`);
        if (column.key === "name") td.textContent = `${plural(info.omitted.count, "smaller table")}`;
        else if (column.key === "bytes") td.textContent = fmtBytes(info.omitted.bytes);
        else if (column.key === "share") shareBarCell(td, info.omitted.bytes, info.total, maxBytes);
        else if (column.key === "rows") td.textContent = fmtInt(info.omitted.rows);
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
        formatBytes: (value) => fmtBytes(value),
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

  function setNotice(text, kind = "") {
    view.notice.hidden = !text;
    view.notice.className = `explorerStorageView__notice${kind ? ` is-${kind}` : ""}`;
    view.notice.textContent = text || "";
  }

  function emptyList(text) {
    view.list.replaceChildren(node("div", "explorerStorageView__empty", text));
  }

  function render() {
    if (!view) return;
    const { database, table } = view.scope;
    const includeSystem = effectiveIncludeSystem();
    view.includeSystem.checked = includeSystem;
    view.includeSystem.disabled = isSystemDatabaseName(database);
    view.includeSystem.closest("label").hidden = !!database;
    view.openTable.hidden = !table;
    view.refresh.disabled = !!data.promise;
    renderCrumbs();
    view.root.dataset.level = table ? "table" : database ? "database" : "server";

    if (!data.storage) {
      view.meta.textContent = data.promise ? "Loading\u2026" : "";
      view.map.hidden = true;
      view.footnote.textContent = "";
      if (data.error) {
        setNotice(String(data.error?.message || "Storage distribution unavailable."), "error");
        emptyList("Storage distribution unavailable.");
      } else {
        setNotice("");
        emptyList(data.promise ? "Loading storage\u2026" : "");
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
      if (info.detail) bits.push(plural(info.rows.length, "partition"));
      bits.push(fmtBytes(info.total));
      const rowsTotal = info.detail?.summary?.rows ?? info.storageTable?.rows;
      if (rowsTotal != null) bits.push(`${fmtCompact(rowsTotal)} rows`);
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
      const bits = [plural(info.entry.storing_tables, "table") + " with data", fmtBytes(info.total)];
      if (Number(info.entry.objects || 0) > Number(info.entry.storing_tables || 0)) bits.push(`${fmtInt(info.entry.objects)} objects`);
      view.meta.textContent = bits.join(" · ");
    } else {
      level = "server";
      info = serverLevel(includeSystem);
      const storing = info.databases.reduce((sum, item) => sum + Number(item.storing_tables || 0), 0);
      view.meta.textContent = [plural(info.databases.length, "database"), `${plural(storing, "table")} with data`, fmtBytes(info.total)].join(" · ");
    }

    const scopeName = table ? `${database}.${table}` : (database || "the server");
    const { shown, threshold } = renderTreemap(info, scopeName);
    view.footnote.textContent = footnoteText({ threshold, scopeLabel: table ? "the table" : database ? "the database" : "the server", resident: info.resident, treemapShown: shown });

    if (level === "table") {
      if (info.loading) { emptyList("Loading partitions\u2026"); return; }
      if (info.error) { emptyList(`Partitions unavailable: ${info.error.message || "request failed"}`); return; }
      if (!info.rows.length) {
        emptyList(info.total > 0
          ? `${info.engine || "This engine"} has no partitions: the table is stored as one unit of ${fmtBytes(info.total)}.`
          : "This object stores no data on disk.");
        return;
      }
    } else if (level === "database" && !info.rows.length) {
      emptyList(info.resident > 0
        ? `No table of ${database} stores data on disk; its Memory / Buffer / Dictionary objects hold ${fmtBytes(info.resident)} of RAM.`
        : `No table of ${database} stores data on disk.`);
      return;
    } else if (level === "server" && !info.rows.length) {
      emptyList("No database is visible to this connection.");
      return;
    }
    view.list.replaceChildren(renderList(level, info));
    if (level === "table" && info.partitionLimitReached) {
      view.list.appendChild(node("div", "explorerStorageView__hint", "Only the 1,000 most recently modified partitions are listed."));
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
    const section = node("section", "explorerDatabaseStorage");
    const head = node("div", "explorerDatabaseStorage__head");
    head.appendChild(node("h3", "explorerSectionTitle", "Storage"));
    const total = Number(root?.bytes || 0);
    head.appendChild(node("span", "explorerDatabaseStorage__meta", total > 0
      ? `${fmtBytes(total)} on disk${residentBytes > 0 ? ` · ${fmtBytes(residentBytes)} RAM` : ""}`
      : ""));
    if (typeof onShowStorage === "function") {
      const link = node("button", "explorerDatabaseStorage__link", "Storage view");
      link.type = "button";
      link.title = `Open ${name} in the Storage view`;
      link.addEventListener("click", () => onShowStorage());
      head.appendChild(link);
    }
    section.appendChild(head);
    container.appendChild(section);
    if (!treemap || !(total > 0)) {
      section.appendChild(node("div", "explorerEmptySection", residentBytes > 0
        ? `No on-disk data. Resident memory: ${fmtBytes(residentBytes)} (Memory / Buffer / Dictionary).`
        : "No on-disk data in this database."));
      return { destroy() {} };
    }
    const { threshold, tree } = treemap.buildTreemap(root);
    if (significantLeafCount(tree) >= TREEMAP_MIN_ITEMS) {
      const host = node("div", "explorerTreemapPanel explorerTreemapPanel--database");
      host.id = "explorerDatabaseTreemap";
      const footer = node("div", "explorerTreemapFooter");
      const legend = node("div", "explorerTreemapLegend");
      footer.append(legend, node("div", "explorerTreemapFootnote", footnoteText({ threshold, scopeLabel: "the database", resident: residentBytes, treemapShown: true })));
      section.append(host, footer);
      renderLegend(legend, tree);
      const controller = treemap.mount(host, {
        ariaLabel: `${name} table size treemap`,
        formatBytes: (value) => fmtBytes(value),
        onOpen: (target) => {
          if (target.kind === "table" && target.database && target.table) onOpen?.(target.database, target.table);
        },
      });
      controller?.setTree(tree, { name });
      return controller || { destroy() {} };
    }

    // Share strip: the materialized top level (tables >= 1% + Others).
    const items = (Array.isArray(tree.children) && tree.children.length ? tree.children : [tree])
      .filter((item) => Number(item.bytes || 0) > 0);
    const strip = node("div", "explorerStorageStrip");
    strip.id = "explorerDatabaseStorageStrip";
    strip.setAttribute("role", "list");
    strip.setAttribute("aria-label", `${name} storage split`);
    const legend = node("div", "explorerStorageStrip__legend");
    for (const item of items) {
      const share = Number(item.bytes || 0) / total * 100;
      const other = item.kind === "other";
      const label = other ? `Others (${plural(item.members, "table")})` : item.name;
      const segment = node(other || !onOpen ? "span" : "button", `explorerStorageStrip__segment${other ? " is-other" : ""}`);
      segment.setAttribute("role", "listitem");
      if (!other) {
        segment.dataset.table = item.table || item.name;
        segment.style.setProperty("--treemap-color", treemap.engineFamily(item.engine).color);
      }
      segment.style.flexGrow = String(Math.max(share, 0.6));
      segment.title = `${other ? `Others in ${name}` : `${name}.${item.name}`}\n${fmtBytes(item.bytes)} · ${fmtPercent(share)}`;
      if (share >= 12) segment.appendChild(node("span", "explorerStorageStrip__label", `${label} · ${fmtPercent(share)}`));
      if (!other && onOpen) {
        segment.type = "button";
        segment.addEventListener("click", () => onOpen(name, item.table || item.name));
      }
      strip.appendChild(segment);
      const entry = node("span", "explorerStorageStrip__entry");
      const swatch = node("span", `explorerStorageStrip__swatch${other ? " is-other" : ""}`);
      if (!other) swatch.style.background = treemap.engineFamily(item.engine).color;
      entry.append(swatch, node("span", "explorerStorageStrip__name", label), node("span", "explorerStorageStrip__value", `${fmtBytes(item.bytes)} · ${fmtPercent(share)}`));
      legend.appendChild(entry);
    }
    section.append(strip, legend);
    return { destroy() {} };
  }

  window.addEventListener("chdash:host-changed", () => {
    view?.treemap?.destroy();
    if (view) view.treemap = null;
    resetData();
    if (view?.root?.isConnected && view.container && !view.container.hidden) {
      view.scope = { database: "", table: "" };
      view.options.onScopeChange?.({ ...view.scope });
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
