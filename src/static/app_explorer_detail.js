(() => {
  "use strict";

  // Explorer table detail: header, tabs and every tab body of a selected
  // object. app_explorer.js (tree, routing, selection) creates it once with
  // its model and shared helpers and delegates renderDetailHeader /
  // renderTabs / renderTabContent to it.
  //
  // Card layout: header (name + chips, replication banner), tabs
  // Columns / Preview / Storage / Operations / Lineage / DDL (tabs without
  // content are hidden), the tab body, and an About panel of value + context
  // tiles beside it (above it when the pane is narrow).
  const ns = window.ChDash;
  if (!ns) return;

  const PREVIEW_LIMITS = [50, 100, 500];
  const PREVIEW_LIMIT_KEY = "chdash.explorer.previewLimit";
  // Formats from ns.format (docs/ui-foundations.md); EMPTY marks an absent value.
  const format = ns.format;
  const DASH = format.EMPTY;

  function create(ctx) {
    const { dom, state, api, util, ui, storage } = ns;
    const graph = ns.explorerGraph;
    const {
      model, node, clear, appRoute, setError, quoteIdent, humanEngine,
      healthLabel, summaryFootprintBytes, summaryRowsLabel, isViewLikeSummary, isMergeTreeSummary, isDictionarySummary,
      isDistributedSummary, isLogFamilySummary, isResidentMemorySummary, renderHighlightedCode, destroyDatabaseTreemap, selectTable,
      setMode, setWorkspace, syncExplorerUrl,
    } = ctx;

    // ---- small helpers ------------------------------------------------------

    function optionalNumber(value) {
      if (value == null || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }

    function percentValue(value, total) {
      const v = Number(value);
      const t = Number(total);
      if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return null;
      return Math.max(0, Math.min(100, (v / t) * 100));
    }

    function sectionUnavailable(name) {
      const unavailable = new Set(model.detail?.unavailable_sections || []);
      return unavailable.has(name);
    }

    // The one empty / unavailable style of the card: a muted line, no box.
    function emptyNote(text) {
      return node("div", "explorerEmptyNote", text);
    }

    function unavailableMessage(label) {
      return emptyNote(`${label} is unavailable on this server or is not enabled.`);
    }

    function engineKey(summary) {
      return String(summary?.engine || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    function isReplicatedSummary(summary) {
      return !!summary?.replication?.available || engineKey(summary).startsWith("replicated");
    }

    function visibleDependencies(detail) {
      return (detail?.dependencies || []).filter((d) => !/^_?row$/i.test(String(d.table || "")));
    }

    function isEmptyRowSummary(summary) {
      return optionalNumber(summary?.rows) === 0;
    }

    function ratioLabel(uncompressed, compressed) {
      const u = optionalNumber(uncompressed);
      const c = optionalNumber(compressed);
      if (u == null || c == null || c <= 0 || u <= 0) return null;
      const ratio = u / c;
      return `${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)}\u00d7`;
    }

    // Shares are kept on a 0-100 scale for the bars; ns.format.percent takes a ratio.
    function percentText(value) {
      return value == null ? DASH : format.percent(Number(value) / 100);
    }

    // A DateTime text of the server's system tables: browser-local text, the
    // server value (and ISO) in the tooltip (decision 48).
    function timeCell(td, value) {
      const time = ui.serverTime(value);
      td.textContent = time.text;
      if (time.title) td.title = time.title;
    }

    // In-cell bar normalised to the column maximum (shared Query gauge cell).
    function gaugeCell(td, value, max, text) {
      td.classList.add("resultTable__gaugeCell", "resultTable__numeric");
      const n = optionalNumber(value);
      const fill = n == null || max <= 0 ? 0 : Math.max(0, Math.min(100, (Math.abs(n) / max) * 100));
      td.style.setProperty("--gaugeFill", `${fill}%`);
      td.textContent = text;
    }

    function numericCell(td, text) {
      td.classList.add("resultTable__numeric");
      td.textContent = text;
    }

    // Text cell that ellipsises in CSS and keeps the full value as tooltip.
    function textCell(td, value, className = "") {
      const text = value == null || value === "" ? DASH : String(value);
      td.textContent = text;
      if (className) td.classList.add(...className.split(" ").filter(Boolean));
      if (text.length > 12) td.title = text;
    }

    function columnMax(items, read) {
      let max = 0;
      for (const item of items) {
        const n = optionalNumber(read(item));
        if (n != null && Math.abs(n) > max) max = Math.abs(n);
      }
      return max;
    }

    // The shared Query result table with column specs instead of positional
    // renderers: { label, type, value(item), render(td, item, value), head }.
    // Row numbers always start at 1 per table.
    function staticTable({ className, specs, items, rowIndexValue = null, decorateRow = null, rowDetails = false }) {
      const rows = items.map((item) => {
        const row = specs.map((spec) => spec.value(item));
        row.__explorerItem = item;
        return row;
      });
      const table = ns.results?.createStaticResultTable?.({
        columns: specs.map((spec) => spec.label),
        types: specs.map((spec) => spec.type || "String"),
        rows,
        className: `explorerTable ${className}`,
        indexSortable: false,
        nullsLast: true,
        rowDetails,
        rowIndexValue: rowIndexValue ? (row) => rowIndexValue(row?.__explorerItem) : null,
        decorateHeader: (th, headCtx) => {
          const spec = specs[headCtx.columnIndex];
          th.title = spec?.head || spec?.label || "";
          if (spec?.numeric) th.classList.add("explorerTable__numHead");
        },
        decorateRow: (tr, rowCtx) => decorateRow?.(tr, rowCtx.row?.__explorerItem || null),
        renderCell: (td, cellCtx) => {
          const spec = specs[cellCtx.columnIndex];
          const item = cellCtx.row?.__explorerItem;
          if (spec?.render) spec.render(td, item, cellCtx.value);
          else if (spec?.numeric) numericCell(td, cellCtx.value == null ? DASH : format.count(cellCtx.value));
          else textCell(td, cellCtx.value, spec?.cellClass || "");
          return true;
        },
      });
      if (!table) throw new Error("Shared result table component is unavailable.");
      return table;
    }

    // Collapsible section with a count; returns its body.
    function section(container, { id, title, count = null, open = true, note = "" }) {
      const details = node("details", "explorerSection");
      details.dataset.section = id;
      details.open = open;
      const summary = node("summary", "explorerSection__summary");
      summary.appendChild(node("span", "explorerSection__title", title));
      if (count != null) summary.appendChild(node("span", "explorerSection__count", format.count(count)));
      if (note) summary.appendChild(node("span", "explorerSection__note", note));
      const body = node("div", "explorerSection__body");
      details.append(summary, body);
      container.appendChild(details);
      return body;
    }

    // Renders sections with data first, then one muted line naming the empty
    // ones ("No active merges \u00b7 No mutations").
    function renderSections(container, sections) {
      const shown = sections.filter((item) => item && item.hasData);
      const idle = sections.filter((item) => item && !item.hasData && item.emptyText);
      for (const item of shown) {
        const body = section(container, { id: item.id, title: item.title, count: item.count ?? null, note: item.note || "" });
        item.render(body);
      }
      if (idle.length) {
        const line = node("div", "explorerIdleLine");
        line.dataset.sections = idle.map((item) => item.id).join(" ");
        line.textContent = idle.map((item) => item.emptyText).join(" \u00b7 ");
        container.appendChild(line);
      }
      if (!shown.length && !idle.length) container.appendChild(emptyNote("Nothing to show for this object."));
    }

    // ---- object identity ----------------------------------------------------

    function objectType(engine) {
      const key = String(engine || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (key === "materializedview") return "mv";
      if (key === "view" || key === "parameterizedview" || key === "liveview" || key === "windowview") return "view";
      if (key === "dictionary") return "dictionary";
      if (key === "buffer") return "buffer";
      if (key === "distributed") return "distributed";
      if (!key) return "unknown";
      return "table";
    }

    const OBJECT_GLYPHS = {
      table: "\u25a6", view: "\u25c7", mv: "\u25c6", dictionary: "\u25c8",
      buffer: "\u25a4", distributed: "\u25a5", unknown: "\u25a2",
    };

    function objectIcon(engine) {
      const type = objectType(engine);
      const icon = node("span", `explorerObjIcon explorerObjIcon--${type}`, OBJECT_GLYPHS[type] || OBJECT_GLYPHS.unknown);
      icon.setAttribute("aria-hidden", "true");
      return icon;
    }

    function shortName(database, table, contextDatabase) {
      return String(database || "") === String(contextDatabase || "") ? String(table || "") : `${database}.${table}`;
    }

    const DEPENDENCY_KINDS = {
      materialized_view: ["MV", "Materialized View trigger / target"],
      view: ["View", "View reads this object at query time"],
      buffer: ["Buffer", "Buffer flushes into its destination table"],
      distributed_route: ["Route", "Distributed routes reads and writes to this local table on every shard"],
      dependency: ["", "Dependency recorded by ClickHouse"],
    };

    function dependencyChip(dep, contextDatabase, { cluster = "" } = {}) {
      const button = node("button", "explorerLineageChip");
      button.type = "button";
      const qualified = `${dep.database || DASH}.${dep.table || DASH}`;
      const [kindLabel, kindTitle] = DEPENDENCY_KINDS[dep.kind] || DEPENDENCY_KINDS.dependency;
      button.dataset.kind = dep.kind || "dependency";
      button.title = [qualified, dep.engine ? humanEngine(dep.engine) : "", kindTitle].filter(Boolean).join(" \u00b7 ");
      button.appendChild(objectIcon(dep.engine));
      button.appendChild(node("span", "explorerLineageChip__name", shortName(dep.database, dep.table, contextDatabase)));
      if (dep.kind === "distributed_route" && cluster) button.appendChild(node("span", "explorerLineageChip__meta", `on ${cluster}`));
      else if (kindLabel) button.appendChild(node("span", "explorerLineageChip__meta", kindLabel));
      button.addEventListener("click", () => void selectTable(dep.database, dep.table));
      return button;
    }

    // ---- tabs ---------------------------------------------------------------

    // Operations is shown when one of its sections has something to show;
    // otherwise About carries the one-line idle summary.
    function hasOperations(detail) {
      const summary = detail?.summary || {};
      if (isViewLikeSummary(summary) || isDictionarySummary(summary)) return false;
      if (detail?._loading) return true;
      return operationSections(detail).some((item) => item.hasData);
    }

    function availableTabs(detail) {
      const summary = detail?.summary || {};
      const loading = !!detail?._loading;
      const viewLike = isViewLikeSummary(summary);
      const empty = isEmptyRowSummary(summary);
      const tabs = ["Columns"];
      // An empty table has nothing to preview or inspect physically.
      if (!viewLike && !empty) tabs.push("Preview");
      if (!empty && (isMergeTreeSummary(summary) || isLogFamilySummary(summary))) tabs.push("Storage");
      if (!empty && hasOperations(detail)) tabs.push("Operations");
      if (loading || visibleDependencies(detail).length) tabs.push("Lineage");
      if (loading || detail?.ddl) tabs.push("DDL");
      return tabs;
    }

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
        // A deep link to a tab this object does not have (e.g. /storage on a
        // View) opens its first tab; keep the address bar in sync.
        model.tab = tabs[0];
        if (model.detail) syncExplorerUrl("replace");
      }
      if (tabs.length <= 1) {
        dom.explorerDetailTabs.hidden = true;
        dom.explorerDetailTabs.replaceChildren();
        return;
      }
      dom.explorerDetailTabs.hidden = false;
      ns.tabs?.render(dom.explorerDetailTabs, tabs.map((label) => ({ value: label, label })), { selected: model.tab });
    }
    // The card's tab row (.contentTabs): the shared tab behaviour (click,
    // arrows, Home / End, roving tabindex; app_ui_tabs.js).
    ns.tabs?.bind(dom.explorerDetailTabs, { onSelect: (label) => openTab(label) });

    // ---- header -------------------------------------------------------------

    function metaChip(text, { kind = "", title = "", dot = "" } = {}) {
      const chip = node("span", `explorerMetaChip${kind ? ` explorerMetaChip--${kind}` : ""}`);
      if (dot) {
        const mark = node("i", `explorerHealthDot explorerHealthDot--${dot}`);
        mark.setAttribute("aria-hidden", "true");
        chip.appendChild(mark);
      }
      chip.appendChild(node("span", "", text));
      if (title) chip.title = title;
      return chip;
    }

    function healthState(summary) {
      const health = String(summary?.health || "healthy");
      return health === "error" ? "error" : health === "warning" ? "warning" : "healthy";
    }

    function headerChips(detail) {
      const s = detail.summary || {};
      const viewLike = isViewLikeSummary(s);
      const chips = [metaChip(humanEngine(s.engine), { kind: "engine", title: s.engine_full || s.engine || "" })];
      if (!detail._loading && !viewLike && s.health) {
        const warnings = Array.isArray(s.warnings) ? s.warnings : [];
        chips.push(metaChip(healthLabel(s), { kind: "health", dot: healthState(s), title: warnings.join("\n") || "No problem reported by system metadata." }));
      }
      if (!viewLike && s.rows != null) chips.push(metaChip(summaryRowsLabel(s), { kind: "rows" }));
      const footprint = summaryFootprintBytes(s);
      if (!viewLike && footprint != null && footprint > 0) {
        const resident = isResidentMemorySummary(s);
        chips.push(metaChip(`${format.bytes(footprint)} ${resident ? "RAM" : "on disk"}`, {
          kind: "size",
          title: resident ? "Resident memory on this server" : `Bytes on disk of this server's active parts (${detail.metric_scope || "local-replica"})`,
        }));
      }
      const parts = Number(s.active_parts || 0);
      if (!viewLike && parts > 0) chips.push(metaChip(format.countLabel(parts, "part"), { kind: "parts", title: `${format.countLabel(Number(s.partitions || 0), "partition")}` }));
      return chips;
    }

    function replicationStatus(r) {
      if (!r?.available) return null;
      // Same thresholds as the backend health classification.
      if (r.readonly || r.session_expired || Number(r.active_replicas) === 0) return "error";
      if (Number(r.active_replicas) < Number(r.total_replicas) || Number(r.queue_size) > 1000 || Number(r.absolute_delay_seconds) > 60) return "warning";
      return "healthy";
    }

    function renderReplicationBanner(detail) {
      const host = dom.explorerSummaryCards;
      if (!host) return;
      const r = detail.summary?.replication || {};
      if (!r.available) {
        host.hidden = true;
        host.classList.remove("explorerSummaryCards--banner");
        host.replaceChildren();
        return;
      }
      const status = replicationStatus(r);
      const banner = node("div", `explorerReplicaBanner explorerReplicaBanner--${status}`);
      const dot = node("i", `explorerHealthDot explorerHealthDot--${status}`);
      dot.setAttribute("aria-hidden", "true");
      const facts = [
        `${format.count(r.active_replicas)}/${format.count(r.total_replicas)} replicas active`,
        `queue ${format.count(r.queue_size)}`,
        `delay ${format.count(r.absolute_delay_seconds)} s`,
      ];
      if (r.readonly) facts.push("read-only");
      if (r.session_expired) facts.push("Keeper session expired");
      banner.append(dot, node("strong", "explorerReplicaBanner__title", "Replicated"), node("span", "explorerReplicaBanner__facts", facts.join(" \u00b7 ")));
      if (r.replica_name) banner.appendChild(node("span", "explorerReplicaBanner__replica", `this replica: ${r.replica_name}`));
      if (availableTabs(detail).includes("Operations")) {
        const open = node("button", "explorerReplicaBanner__open", "Details");
        open.type = "button";
        open.addEventListener("click", () => openTab("Operations"));
        banner.appendChild(open);
      }
      host.className = "explorerSummaryCards explorerSummaryCards--banner";
      host.hidden = false;
      host.replaceChildren(banner);
    }

    function renderDetailHeader() {
      const detail = model.detail;
      if (!detail) return;
      const s = detail.summary || {};
      if (dom.explorerEmptyState) dom.explorerEmptyState.hidden = true;
      if (dom.explorerDetail) dom.explorerDetail.hidden = false;
      if (dom.explorerDetailName) dom.explorerDetailName.textContent = `${s.database || ""}.${s.name || ""}`;
      if (dom.explorerDetailMeta) {
        const chips = node("span", "explorerMetaChips");
        chips.append(...headerChips(detail));
        dom.explorerDetailMeta.replaceChildren(chips);
      }
      if (dom.explorerHealthBadge) {
        dom.explorerHealthBadge.hidden = true;
        dom.explorerHealthBadge.textContent = "";
      }
      if (dom.explorerWarnings) {
        const warnings = Array.isArray(s.warnings) ? s.warnings : [];
        dom.explorerWarnings.hidden = !warnings.length;
        dom.explorerWarnings.replaceChildren(...warnings.map((warning) => node("div", "explorerWarning", warning)));
      }
      renderReplicationBanner(detail);
    }

    // ---- About panel ----------------------------------------------------------

    function extractTableTtl(detail) {
      if (detail?.table_ttl) return String(detail.table_ttl);
      const ddl = String(detail?.formatted_ddl || detail?.ddl || "");
      if (!ddl) return "";
      const match = ddl.match(/(?:^|\n)TTL\s+([\s\S]*?)(?=\n(?:SETTINGS|COMMENT|AS\s+SELECT|POPULATE|EMPTY\s+AS)\b|;?\s*$)/i);
      return match ? String(match[1] || "").trim().replace(/\s+/g, " ") : "";
    }

    function splitTopLevel(text) {
      const parts = [];
      let depth = 0;
      let quote = "";
      let current = "";
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
          current += ch;
          if (ch === "\\" && i + 1 < text.length) { current += text[i + 1]; i += 1; continue; }
          if (ch === quote) quote = "";
          continue;
        }
        if (ch === "'" || ch === "`" || ch === "\"") quote = ch;
        else if (ch === "(") depth += 1;
        else if (ch === ")") depth = Math.max(0, depth - 1);
        else if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
        current += ch;
      }
      if (current.trim()) parts.push(current.trim());
      return parts;
    }

    // "observed_at + toIntervalDay(30) RECOMPRESS CODEC(ZSTD(3))" ->
    // "observed_at + 30 d \u2192 RECOMPRESS ZSTD(3)"; a bare rule deletes.
    function prettyTtlRule(rule) {
      const units = { Second: "s", Minute: "min", Hour: "h", Day: "d", Week: "w", Month: "mo", Quarter: "q", Year: "y" };
      let text = String(rule || "").replace(/toInterval(Second|Minute|Hour|Day|Week|Month|Quarter|Year)\((\d+)\)/g, (_, unit, n) => `${n} ${units[unit]}`);
      text = text.replace(/INTERVAL\s+(\d+)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|QUARTER|YEAR)S?\b/gi, (_, n, unit) => `${n} ${units[unit.charAt(0) + unit.slice(1).toLowerCase()]}`);
      const action = text.match(/\s+(RECOMPRESS|TO\s+VOLUME|TO\s+DISK|DELETE|GROUP\s+BY)\b([\s\S]*)$/i);
      if (!action) return `${text.trim()} \u2192 DELETE`;
      const base = text.slice(0, action.index).trim();
      let rest = `${action[1].toUpperCase().replace(/\s+/g, " ")}${action[2]}`.trim();
      rest = rest.replace(/^RECOMPRESS\s+CODEC\(([\s\S]*)\)$/i, "RECOMPRESS $1");
      return `${base} \u2192 ${rest}`;
    }

    function aboutTile(label, value, context = null, { mono = false, title = "", id = "", wide = false } = {}) {
      const tile = node("div", `explorerAboutTile${wide ? " explorerAboutTile--wide" : ""}`);
      if (id) tile.dataset.tile = id;
      tile.appendChild(node("div", "explorerAboutTile__label", label));
      const valueEl = node("div", `explorerAboutTile__value${mono ? " is-code" : ""}`);
      if (value instanceof Node) valueEl.appendChild(value);
      else valueEl.textContent = String(value);
      if (title || (!(value instanceof Node) && String(value).length > 28)) valueEl.title = title || String(value);
      tile.appendChild(valueEl);
      const contexts = (Array.isArray(context) ? context : [context]).filter((item) => item != null && item !== "");
      for (const item of contexts) {
        const el = item instanceof Node ? item : node("div", "explorerAboutTile__context", item);
        if (!(item instanceof Node) && String(item).length > 36) el.title = String(item);
        tile.appendChild(el);
      }
      return tile;
    }

    function aboutTiles(detail) {
      const s = detail.summary || {};
      const r = s.replication || {};
      const tiles = [];
      const viewLike = isViewLikeSummary(s);
      const resident = isResidentMemorySummary(s);
      const mergeTree = isMergeTreeSummary(s);
      const database = s.database || "";

      // Engine (+ where it routes for Buffer / Distributed / replicas).
      const engineContext = [];
      if (detail.distributed?.cluster) engineContext.push(`cluster ${detail.distributed.cluster}`);
      if (r.available && r.replica_name) engineContext.push(`replica ${r.replica_name}`);
      if (s.engine && humanEngine(s.engine).replace(/\s+/g, "") !== s.engine) engineContext.push(s.engine);
      tiles.push(aboutTile("Engine", humanEngine(s.engine), engineContext.join(" \u00b7 "), { id: "engine", title: s.engine_full || s.engine || "" }));

      const routeKind = objectType(s.engine) === "mv" ? "materialized_view" : objectType(s.engine) === "buffer" ? "buffer" : "";
      const targets = routeKind
        ? visibleDependencies(detail).filter((dep) => dep.relation === "downstream" && dep.kind === routeKind && objectType(dep.engine) !== "mv")
        : [];
      if (targets.length) {
        const list = node("div", "explorerAboutTile__chips");
        list.append(...targets.map((dep) => dependencyChip(dep, database)));
        tiles.push(aboutTile(routeKind === "buffer" ? "Flushes to" : "Writes to", list, null, { id: "target" }));
      }

      const footprint = summaryFootprintBytes(s);
      if (!viewLike && footprint != null && footprint > 0) {
        const rowsText = s.rows == null ? "" : summaryRowsLabel(s);
        tiles.push(aboutTile("Size", format.bytes(footprint), [resident ? "in RAM" : "on disk", rowsText].filter(Boolean).join(" \u00b7 "), { id: "size" }));
      } else if (!viewLike && s.rows != null) {
        tiles.push(aboutTile("Rows", format.count(s.rows), null, { id: "rows" }));
      }

      const ratio = mergeTree ? ratioLabel(s.uncompressed_bytes, s.compressed_bytes) : null;
      if (ratio) {
        const codecs = (detail.default_compression_codecs || []).filter(Boolean);
        tiles.push(aboutTile("Compression", ratio, [
          `${format.bytes(s.uncompressed_bytes)} \u2192 ${format.bytes(s.compressed_bytes)}`,
          codecs.length ? `default codec ${codecs.join(" / ")}` : "",
        ], { id: "compression", title: "Uncompressed / compressed bytes of the active parts" }));
      }

      // Log-family engines report ClickHouse's uncompressed total, not parts.
      if (!mergeTree && isLogFamilySummary(s) && s.uncompressed_bytes != null) {
        tiles.push(aboutTile("Uncompressed", format.bytes(s.uncompressed_bytes), "data before compression", { id: "uncompressed" }));
      }

      const parts = Number(s.active_parts || 0);
      if (parts > 0) tiles.push(aboutTile("Parts", format.countLabel(parts, "active part"), format.countLabel(Number(s.partitions || 0), "partition"), { id: "parts" }));

      if (s.sorting_key) {
        const pk = String(s.primary_key || "");
        tiles.push(aboutTile("Sorting key", s.sorting_key, pk && pk !== s.sorting_key ? `PRIMARY KEY ${pk}` : "ORDER BY \u00b7 also the primary key", { mono: true, id: "sorting_key" }));
      }
      if (s.partition_key) tiles.push(aboutTile("Partition key", s.partition_key, null, { mono: true, id: "partition_key" }));
      if (s.sampling_key) tiles.push(aboutTile("Sampling key", s.sampling_key, null, { mono: true, id: "sampling_key" }));

      const ttl = extractTableTtl(detail);
      if (ttl) {
        const rules = splitTopLevel(ttl);
        const list = node("ol", "explorerAboutTile__rules");
        for (const rule of rules) {
          const item = node("li", "", prettyTtlRule(rule));
          item.title = rule;
          list.appendChild(item);
        }
        tiles.push(aboutTile("TTL", format.countLabel(rules.length, "rule"), list, { id: "ttl", wide: true, title: ttl }));
      }

      if (mergeTree && s.storage_policy) {
        const disks = [...new Set((detail.storage || []).map((disk) => disk.disk).filter(Boolean))];
        tiles.push(aboutTile("Storage policy", s.storage_policy, disks.length ? `disks ${disks.join(", ")}` : null, { mono: true, id: "storage_policy" }));
      }

      if (r.available) {
        const list = node("div", "explorerAboutTile__replicas");
        for (const replica of r.replicas || []) {
          const chip = node("span", "explorerReplicaChip");
          const dot = node("i", `explorerHealthDot explorerHealthDot--${replica.active ? "healthy" : "error"}`);
          dot.setAttribute("aria-hidden", "true");
          chip.append(dot, node("span", "", replica.name === r.replica_name ? `${replica.name} (this)` : replica.name));
          chip.title = replica.active ? "Active" : "Inactive";
          list.appendChild(chip);
        }
        tiles.push(aboutTile("Replicas", `${format.count(r.active_replicas)}/${format.count(r.total_replicas)} active`, (r.replicas || []).length ? list : null, { id: "replicas" }));
      }

      if (detail.distributed?.table) {
        const target = { database: detail.distributed.database, table: detail.distributed.table, kind: "distributed_route" };
        const visible = visibleDependencies(detail).find((dep) => dep.kind === "distributed_route" && dep.database === target.database && dep.table === target.table);
        const value = visible ? dependencyChip(visible, database) : shortName(target.database, target.table, database);
        tiles.push(aboutTile("Local table", value, `on every shard of ${detail.distributed.cluster}`, { mono: true, id: "local_table", title: `${target.database}.${target.table}` }));
        const shards = new Set((detail.topology || []).map((member) => member.shard_num)).size;
        if ((detail.topology || []).length) {
          tiles.push(aboutTile("Cluster", detail.distributed.cluster, `${format.countLabel(shards, "shard")} \u00b7 ${format.countLabel(detail.topology.length, "replica")}`, { mono: true, id: "cluster" }));
        }
      }

      const dbBytes = optionalNumber(detail.footprint_scope?.database_bytes);
      const allBytes = optionalNumber(detail.footprint_scope?.clickhouse_bytes);
      if (!viewLike && !resident && footprint != null && footprint > 0 && dbBytes != null && dbBytes > 0) {
        const dbShare = percentValue(footprint, dbBytes);
        const allShare = allBytes ? percentValue(footprint, allBytes) : null;
        tiles.push(aboutTile("Share", `${percentText(dbShare)} of ${database}`, allShare == null ? null : `${percentText(allShare)} of all databases`, { id: "share" }));
      }

      const activeAges = (detail.parts || []).filter((part) => part.active).map((part) => optionalNumber(part.age_seconds)).filter((age) => age != null);
      const newest = activeAges.length ? Math.min(...activeAges) : null;
      const schemaTime = String(s.metadata_modification_time || "");
      if (newest != null || schemaTime) {
        tiles.push(aboutTile(
          "Last modified",
          newest != null ? `${format.duration.fromSeconds(newest)} ago` : ui.serverTime(schemaTime).text,
          [newest != null ? "newest part written" : "schema changed", newest != null && schemaTime ? `schema changed ${ui.serverTime(schemaTime).text}` : ""],
          { id: "modified", title: schemaTime ? ui.serverTime(schemaTime).title : "" },
        ));
      }

      if (!isViewLikeSummary(s) && !isDictionarySummary(s) && !detail._loading && !hasOperations(detail) && !isEmptyRowSummary(s)) {
        const idle = operationSections(detail).filter((item) => item.emptyText).map((item) => item.emptyText);
        if (idle.length) tiles.push(aboutTile("Activity", "Idle", idle.join(" \u00b7 "), { id: "activity" }));
      }

      const deps = visibleDependencies(detail);
      if (deps.length) {
        const up = deps.filter((dep) => String(dep.relation) === "upstream").length;
        const down = deps.length - up;
        const link = node("button", "explorerAboutTile__link", "Open lineage");
        link.type = "button";
        link.addEventListener("click", () => openTab("Lineage"));
        tiles.push(aboutTile("Lineage", `${format.count(up)} upstream \u00b7 ${format.count(down)} downstream`, link, { id: "lineage" }));
      }
      return tiles;
    }

    function renderAbout(detail) {
      const tiles = aboutTiles(detail);
      if (!tiles.length) return null;
      const aside = node("aside", "explorerAbout");
      aside.setAttribute("aria-label", "About this object");
      aside.appendChild(node("h3", "explorerAbout__title", "About"));
      const grid = node("div", "explorerAbout__tiles");
      grid.append(...tiles);
      aside.appendChild(grid);
      // Narrow panes show the About tiles above the tab body: the first ones
      // stay visible, the rest behind a toggle (hidden by CSS on wide panes).
      if (tiles.length > 4) {
        const collapsed = model.aboutExpanded !== true;
        aside.classList.toggle("is-collapsed", collapsed);
        const toggle = node("button", "explorerAbout__toggle", collapsed ? `Show all ${tiles.length}` : "Show less");
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.addEventListener("click", () => {
          model.aboutExpanded = aside.classList.contains("is-collapsed");
          aside.classList.toggle("is-collapsed", !model.aboutExpanded);
          toggle.textContent = model.aboutExpanded ? "Show less" : `Show all ${tiles.length}`;
          toggle.setAttribute("aria-expanded", String(model.aboutExpanded));
        });
        aside.appendChild(toggle);
      }
      return aside;
    }

    // ---- Columns tab ----------------------------------------------------------

    function isImplementationSubcolumn(column) {
      if (!column?.is_subcolumn) return false;
      return /(?:^|\.)(?:size|size\d+)$/i.test(String(column.name || ""));
    }

    function columnKeyBadges(column, summary) {
      const badges = [];
      const pk = String(summary?.primary_key || "");
      const pkDiffers = !!pk && pk !== String(summary?.sorting_key || "");
      if (column.is_in_sorting_key) badges.push(["ORDER BY", "Part of the sorting key (ORDER BY)"]);
      if (column.is_in_primary_key && (pkDiffers || !column.is_in_sorting_key)) badges.push(["PK", "Part of the primary key (sparse index)"]);
      if (column.is_in_partition_key) badges.push(["PARTITION", "Used by the partition key (PARTITION BY)"]);
      if (column.is_in_sampling_key) badges.push(["SAMPLE", "Used by the sampling key (SAMPLE BY)"]);
      return badges;
    }

    // "CODEC(Delta(8), ZSTD(1))" -> "Delta(8), ZSTD(1)".
    function shortCodec(codec) {
      const text = String(codec || "").trim();
      const match = text.match(/^CODEC\(([\s\S]*)\)$/i);
      return match ? match[1].trim() : text;
    }

    function columnRows(detail) {
      const tableFootprint = summaryFootprintBytes(detail.summary || {});
      const observedDefaults = (detail.default_compression_codecs || []).map((value) => String(value || "").trim()).filter(Boolean);
      const defaultCodec = !isMergeTreeSummary(detail.summary)
        ? ""
        : observedDefaults.length === 1
          ? `${observedDefaults[0]} (default)`
          : observedDefaults.length > 1
            ? `${observedDefaults.join(" / ")} (part defaults)`
            : "DEFAULT";
      const allColumns = Array.isArray(detail.columns) ? detail.columns : [];
      const visibleColumns = allColumns.filter((column) => !isImplementationSubcolumn(column));
      // A storage Tuple hierarchy is not limited to a top-level Tuple(...).
      // Array(Tuple(...)) and deeper Array wrappers expose the same named
      // physical subcolumns and use the same disclosure control.
      const tupleRoots = allColumns
        .filter((column) => !column?.is_subcolumn && /Tuple\s*\(/i.test(String(column?.type || "")))
        .map((column) => String(column.name || ""))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
      const implementationByRoot = new Map();
      for (const c of allColumns) {
        if (!isImplementationSubcolumn(c)) continue;
        const name = String(c.name || "");
        const root = tupleRoots.find((candidate) => name.startsWith(`${candidate}.`));
        if (!root) continue;
        if (!implementationByRoot.has(root)) implementationByRoot.set(root, []);
        implementationByRoot.get(root).push(c);
      }

      let topLevelColumnPosition = 0;
      const rows = [];
      for (const c of visibleColumns) {
        const compressed = optionalNumber(c.compressed_bytes);
        const uncompressed = optionalNumber(c.uncompressed_bytes);
        const name = String(c.name || DASH);
        const tupleParent = c.is_subcolumn ? (tupleRoots.find((root) => name.startsWith(`${root}.`)) || null) : null;
        const tupleRoot = tupleRoots.includes(name) ? name : null;
        rows.push({
          position: c.is_subcolumn ? null : ++topLevelColumnPosition,
          name,
          type: String(c.type || ""),
          default_kind: String(c.default_kind || ""),
          default_expression: String(c.default_expression || ""),
          comment: String(c.comment || ""),
          keys: c.is_subcolumn ? [] : columnKeyBadges(c, detail.summary),
          codec: shortCodec(c.codec) || defaultCodec,
          explicit_codec: !!c.codec && !c.is_subcolumn,
          compressed,
          uncompressed,
          percent: compressed == null ? null : percentValue(compressed, tableFootprint),
          is_subcolumn: !!c.is_subcolumn,
          tuple_root: tupleRoot,
          tuple_parent: tupleParent,
        });

        // size0/sizeN are real on-disk Array offset streams. Keep the
        // implementation names out of the UI, but account for their bytes as
        // one explicit physical child so the children add up to the parent.
        if (tupleRoot) {
          const implementation = implementationByRoot.get(tupleRoot) || [];
          if (implementation.length) {
            const compressedValues = implementation.map((item) => optionalNumber(item.compressed_bytes)).filter((value) => value != null);
            const uncompressedValues = implementation.map((item) => optionalNumber(item.uncompressed_bytes)).filter((value) => value != null);
            const implementationCompressed = compressedValues.length ? compressedValues.reduce((sum, value) => sum + value, 0) : null;
            const implementationUncompressed = uncompressedValues.length ? uncompressedValues.reduce((sum, value) => sum + value, 0) : null;
            rows.push({
              position: null,
              name: `${tupleRoot}.[offsets]`,
              type: `Physical Array offset stream${implementation.length === 1 ? "" : "s"}: ${implementation.map((item) => item.name).join(", ")}`,
              default_kind: "",
              default_expression: "",
              comment: "",
              keys: [],
              codec: shortCodec(c.codec) || defaultCodec,
              compressed: implementationCompressed,
              uncompressed: implementationUncompressed,
              percent: implementationCompressed == null ? null : percentValue(implementationCompressed, tableFootprint),
              is_subcolumn: true,
              tuple_root: null,
              tuple_parent: tupleRoot,
            });
          }
        }
      }
      return rows;
    }

    function renderColumnsTab(container, detail) {
      if (sectionUnavailable("columns")) container.appendChild(unavailableMessage("Column metadata"));
      const rows = columnRows(detail);
      if (!rows.length) {
        if (!sectionUnavailable("columns")) container.appendChild(emptyNote("No readable columns."));
        return;
      }
      const topLevel = rows.filter((row) => !row.is_subcolumn);
      // Distributed / View columns report 0 bytes: no byte columns at all then.
      const hasBytes = rows.some((row) => Number(row.compressed) > 0);
      const hasKeys = topLevel.some((row) => row.keys.length);
      // One shared default codec is stated once (About > Compression); the
      // column appears only when some column declares its own CODEC().
      const codecs = new Set(topLevel.map((row) => row.codec || ""));
      const hasCodec = topLevel.some((row) => row.explicit_codec) || codecs.size > 1;
      const compressedMax = columnMax(rows.filter((row) => !row.is_subcolumn), (row) => row.compressed);
      const tupleExpanded = new Set();
      let table = null;

      const specs = [
        {
          label: "Column",
          value: (item) => item.name,
          render: (td, item) => {
            td.classList.add("explorerColumns__name");
            if (item.tuple_root) {
              const open = tupleExpanded.has(item.tuple_root);
              const toggle = node("button", "explorerTreeDatabaseToggle explorerStorageTupleToggle", open ? "\u2304" : "\u203a");
              toggle.type = "button";
              toggle.setAttribute("aria-expanded", String(open));
              toggle.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${item.tuple_root}`);
              toggle.addEventListener("click", (event) => {
                event.stopPropagation();
                const opening = !tupleExpanded.has(item.tuple_root);
                if (opening) tupleExpanded.add(item.tuple_root);
                else tupleExpanded.delete(item.tuple_root);
                toggle.textContent = opening ? "\u2304" : "\u203a";
                toggle.setAttribute("aria-expanded", String(opening));
                toggle.setAttribute("aria-label", `${opening ? "Collapse" : "Expand"} ${item.tuple_root}`);
                for (const row of table?.querySelectorAll?.("tbody tr[data-tuple-parent]") || []) {
                  if (row.dataset.tupleParent === item.tuple_root) row.hidden = !opening;
                }
              });
              td.append(toggle, node("span", "explorerStorageTupleName", item.name));
            } else {
              td.appendChild(node("span", item.tuple_parent ? "explorerStorageTupleName explorerStorageTupleName--child" : "explorerStorageTupleName", item.name));
            }
            td.title = item.comment ? `${item.name}\n${item.comment}` : item.name;
            // The comment reads under the name and wraps (two lines at most).
            if (item.comment) td.appendChild(node("span", "explorerColumns__comment", item.comment));
          },
        },
        {
          label: "Type",
          head: "Type, then its DEFAULT / MATERIALIZED / ALIAS / EPHEMERAL expression",
          value: (item) => item.type,
          render: (td, item) => {
            td.classList.add("explorerColumns__type");
            td.appendChild(node("span", "explorerColumns__typeName", item.type || DASH));
            td.title = item.type || "";
            if (item.default_kind) {
              const line = node("span", "explorerColumns__default");
              line.append(node("span", "explorerBadge explorerBadge--default", item.default_kind), node("span", "explorerColumns__expr", item.default_expression));
              td.appendChild(line);
              td.title = `${item.type}\n${item.default_kind} ${item.default_expression}`;
            }
          },
        },
      ];
      if (hasKeys) specs.push({
        label: "Keys",
        head: "Sorting (ORDER BY), primary, partition and sampling key membership",
        value: (item) => item.keys.map(([label]) => label).join(" "),
        render: (td, item) => {
          td.classList.add("explorerColumns__keys");
          for (const [label, title] of item.keys) {
            const badge = node("span", `explorerBadge explorerBadge--key explorerBadge--${label.toLowerCase().replace(/[^a-z]+/g, "-")}`, label);
            badge.title = title;
            td.appendChild(badge);
          }
        },
      });
      if (hasCodec) specs.push({
        label: "Codec",
        value: (item) => item.codec || "",
        render: (td, item) => {
          td.classList.add("explorerColumns__codec");
          td.textContent = item.codec || DASH;
          if (item.codec) td.title = item.codec;
        },
      });
      if (hasBytes) {
        specs.push({
          label: "Compressed",
          type: "Float64",
          numeric: true,
          head: "Compressed bytes on disk (bar: share of the largest column)",
          value: (item) => item.compressed,
          render: (td, item) => {
            td.classList.add("explorerStorageGaugeCell");
            gaugeCell(td, item.compressed, compressedMax, item.compressed == null ? DASH : format.bytes(item.compressed));
          },
        });
        specs.push({
          label: "Ratio",
          type: "Float64",
          numeric: true,
          head: "Uncompressed / compressed",
          value: (item) => (item.compressed > 0 && item.uncompressed != null ? item.uncompressed / item.compressed : null),
          render: (td, item) => {
            numericCell(td, ratioLabel(item.uncompressed, item.compressed) || DASH);
            if (item.uncompressed != null) td.title = `${format.bytes(item.uncompressed)} uncompressed`;
          },
        });
        specs.push({
          label: "% table",
          type: "Float64",
          numeric: true,
          head: "Compressed bytes / table bytes on disk",
          value: (item) => item.percent,
          render: (td, item) => {
            td.classList.add("explorerStoragePercentCell");
            numericCell(td, item.percent == null ? DASH : percentText(item.percent));
          },
        });
      }

      table = staticTable({
        className: "explorerStorageResultTable--columns explorerColumnsTable",
        specs,
        items: rows,
        rowIndexValue: (item) => item?.position ?? "",
        decorateRow: (tr, item) => {
          if (!item?.tuple_parent) return;
          tr.dataset.tupleParent = item.tuple_parent;
          tr.classList.add("explorerStorageTupleChild");
          tr.hidden = !tupleExpanded.has(item.tuple_parent);
          const indexCell = tr.querySelector(".resultTable__rowIndex");
          if (indexCell) {
            indexCell.textContent = "";
            indexCell.setAttribute("aria-hidden", "true");
          }
        },
      });
      container.appendChild(table);

      if (sectionUnavailable("wide_column_sizes")) {
        container.appendChild(emptyNote("Wide per-column storage counters are unavailable on this server; a dash is shown instead of fabricating 0%."));
      } else if (sectionUnavailable("wide_subcolumn_sizes")) {
        container.appendChild(emptyNote("Tuple subcolumn names are available, but this server does not expose per-subcolumn Wide byte counters."));
      }
    }

    // ---- Storage tab ----------------------------------------------------------

    function structureCompressedBytes(detail, prefix, summaryValue) {
      const fromSummary = optionalNumber(summaryValue);
      if (fromSummary != null) return fromSummary;
      const matching = (detail.indexes_and_projections || []).filter((item) => String(item.kind || "").startsWith(prefix));
      if (!matching.length) return 0;
      let total = 0;
      for (const item of matching) {
        const value = optionalNumber(item.compressed_bytes);
        if (value == null) return null;
        total += value;
      }
      return total;
    }

    function structureOnDiskBytes(detail, prefix) {
      const matching = (detail.indexes_and_projections || []).filter((item) => String(item.kind || "").startsWith(prefix));
      if (!matching.length) return 0;
      let total = 0;
      for (const item of matching) {
        const value = optionalNumber(item.on_disk_bytes);
        if (value == null) return null;
        total += value;
      }
      return total;
    }

    function storageComposition(detail) {
      const storage = detail.column_storage || {};
      const footprint = summaryFootprintBytes(detail.summary || {});
      const wideParts = Number(storage.wide_parts || 0);
      const compactParts = Number(storage.compact_parts || 0);
      const rawWide = wideParts > 0 ? optionalNumber(storage.wide_on_disk_bytes) : (compactParts > 0 ? 0 : null);
      const rawCompact = compactParts > 0 ? optionalNumber(storage.compact_on_disk_bytes) : (wideParts > 0 ? 0 : null);
      const projectionBytes = structureOnDiskBytes(detail, "projection:");
      // ClickHouse exposes skipping-index compressed bytes, but not a standalone
      // bytes_on_disk counter. Account those known index files explicitly; all
      // remaining parent-part overhead stays in the Wide/Compact base footprint.
      const indexBytes = structureCompressedBytes(detail, "index:", detail.summary?.secondary_indices_bytes);

      const known = [footprint, rawWide, rawCompact, projectionBytes, indexBytes].every((value) => value != null);
      if (!known || footprint <= 0) return { known: false, footprint, items: [] };

      const structureBytes = projectionBytes + indexBytes;
      if (structureBytes < 0 || structureBytes > footprint) return { known: false, footprint, items: [] };
      const baseBytes = footprint - structureBytes;
      const rawBase = rawWide + rawCompact;
      if (baseBytes > 0 && rawBase <= 0) return { known: false, footprint, items: [] };

      let wideBytes = 0;
      let compactBytes = 0;
      if (baseBytes > 0) {
        if (wideParts > 0 && compactParts <= 0) {
          wideBytes = baseBytes;
        } else if (compactParts > 0 && wideParts <= 0) {
          compactBytes = baseBytes;
        } else {
          // Allocate the reconciled parent-part residual using the exact
          // bytes_on_disk ratio of Wide vs Compact active parts. Keep one side as
          // the arithmetic remainder so the four categories sum exactly to the
          // table's bytes_on_disk footprint rather than merely approximately.
          wideBytes = baseBytes * (rawWide / rawBase);
          compactBytes = baseBytes - wideBytes;
        }
      }

      const rawItems = [
        ["Wide", wideBytes, "wide"],
        ["Compact", compactBytes, "compact"],
        ["Projections", projectionBytes, "projection"],
        ["Indexes", indexBytes, "index"],
      ];
      return {
        known: true,
        footprint,
        items: rawItems.map(([label, bytes, variant]) => ({
          label,
          bytes,
          variant,
          percent: (bytes / footprint) * 100,
        })),
      };
    }

    function buildStorageComposition(detail, { embedded = false } = {}) {
      const composition = storageComposition(detail);
      const wrap = node("div", `explorerStorageComposition explorerStorageComposition--stacked${embedded ? " is-embedded" : ""}`);
      const bar = node("div", `explorerStorageStackedBar${composition.known ? "" : " is-unknown"}`);

      if (composition.known) {
        let consumed = 0;
        const visible = composition.items.filter((item) => item.percent > 0);
        visible.forEach((item, index) => {
          const width = index === visible.length - 1
            ? Math.max(0, 100 - consumed)
            : Math.max(0, Math.min(item.percent, 100 - consumed));
          const segment = node("div", `explorerStorageStackedBar__segment explorerStorageStackedBar__segment--${item.variant}`);
          segment.style.width = `${width}%`;
          segment.title = `${item.label}: ${percentText(item.percent)} \u00b7 ${format.bytes(item.bytes)}`;
          bar.appendChild(segment);
          consumed += width;
        });
      } else {
        bar.appendChild(node("span", "explorerStorageStackedBar__unknown", "unknown"));
      }
      wrap.appendChild(bar);

      const legend = node("div", "explorerStorageCompositionLegend");
      const legendItems = composition.known
        ? composition.items.filter((item) => Number(item.bytes) > 0)
        : [];
      for (const item of legendItems) {
        const entry = node("div", "explorerStorageCompositionLegend__item");
        entry.append(
          node("i", `explorerStorageCompositionLegend__swatch explorerStorageCompositionLegend__swatch--${item.variant}`),
          node("span", "explorerStorageCompositionLegend__label", item.label),
          node("span", "explorerStorageCompositionLegend__percent",
            item.percent == null || item.bytes == null
              ? "unknown"
              : `${percentText(item.percent)} \u00b7 ${format.bytes(item.bytes)}`),
        );
        if (item.bytes != null) entry.title = `${item.label}: ${percentText(item.percent)} \u00b7 ${format.bytes(item.bytes)}`;
        legend.appendChild(entry);
      }
      if (legendItems.length) wrap.appendChild(legend);
      return wrap;
    }

    function renderStorageCompositionCard(container, detail) {
      const tableBytes = summaryFootprintBytes(detail.summary || {});
      const card = node("div", "explorerStorageCompositionCard");
      const head = node("div", "explorerStorageCompositionCard__head");
      head.append(
        node("span", "explorerStorageCompositionCard__label", "Table storage"),
        node("span", "explorerStorageCompositionCard__bytes", tableBytes == null ? "unknown" : format.bytes(tableBytes)),
      );
      card.append(head, buildStorageComposition(detail, { embedded: true }));
      container.appendChild(card);
    }

    function renderDisks(body, detail) {
      const disks = detail.storage || [];
      const max = columnMax(disks, (disk) => disk.bytes);
      // Log-family engines own no parts: no Parts column for them.
      const parts = isMergeTreeSummary(detail.summary);
      body.appendChild(staticTable({
        className: "explorerTable--disks",
        items: disks,
        specs: [
          { label: "Disk", value: (disk) => disk.disk || "unknown disk", cellClass: "explorerCell--code" },
          { label: "Path", value: (disk) => disk.path || "", cellClass: "explorerCell--path explorerCell--code" },
          {
            label: "Size", type: "UInt64", numeric: true, value: (disk) => optionalNumber(disk.bytes),
            render: (td, disk) => gaugeCell(td, disk.bytes, max, disk.bytes == null ? DASH : format.bytes(disk.bytes)),
          },
          { label: "Rows", type: "UInt64", numeric: true, value: (disk) => optionalNumber(disk.rows) },
          parts && { label: "Parts", type: "UInt64", numeric: true, value: (disk) => optionalNumber(disk.parts) },
          {
            label: "Free", type: "UInt64", numeric: true, head: "Free space on the disk", value: (disk) => optionalNumber(disk.free_space),
            render: (td, disk) => numericCell(td, disk.free_space == null ? DASH : format.bytes(disk.free_space)),
          },
          {
            label: "Capacity", type: "UInt64", numeric: true, value: (disk) => optionalNumber(disk.total_space),
            render: (td, disk) => numericCell(td, disk.total_space == null ? DASH : format.bytes(disk.total_space)),
          },
        ].filter(Boolean),
      }));
    }

    function renderParts(body, detail) {
      const parts = detail.parts || [];
      const max = columnMax(parts, (part) => part.bytes);
      body.appendChild(staticTable({
        className: "explorerTable--parts",
        items: parts,
        specs: [
          { label: "Part", value: (part) => part.name, cellClass: "explorerCell--code explorerCell--part" },
          { label: "Partition", value: (part) => part.partition, cellClass: "explorerCell--code explorerCell--partition" },
          { label: "Disk", value: (part) => part.disk, cellClass: "explorerCell--code explorerCell--disk" },
          { label: "Rows", type: "UInt64", numeric: true, value: (part) => optionalNumber(part.rows) },
          {
            label: "Bytes", type: "UInt64", numeric: true, head: "Bytes on disk", value: (part) => optionalNumber(part.bytes),
            render: (td, part) => gaugeCell(td, part.bytes, max, format.bytes(part.bytes)),
          },
          { label: "Marks", type: "UInt64", numeric: true, value: (part) => optionalNumber(part.marks) },
          { label: "Files", type: "UInt64", numeric: true, value: (part) => optionalNumber(part.files) },
          { label: "Level", type: "UInt64", numeric: true, head: "Merge level (0: never merged)", value: (part) => optionalNumber(part.level) },
          {
            label: "Age", type: "UInt64", numeric: true, head: "Time since the part was written", value: (part) => optionalNumber(part.age_seconds),
            render: (td, part) => { numericCell(td, format.duration.fromSeconds(part.age_seconds)); td.title = `${format.count(part.age_seconds)} s`; },
          },
          {
            label: "State", value: (part) => (part.active ? "active" : "inactive"),
            render: (td, part) => td.appendChild(node("span", `explorerBadge explorerBadge--${part.active ? "active" : "inactive"}`, part.active ? "active" : "inactive")),
          },
        ],
      }));
    }

    function renderPartitions(body, detail) {
      const partitions = detail.partitions || [];
      const max = columnMax(partitions, (partition) => partition.bytes);
      body.appendChild(staticTable({
        className: "explorerTable--partitions",
        items: partitions,
        specs: [
          { label: "Partition", value: (p) => p.partition, cellClass: "explorerCell--code" },
          { label: "Rows", type: "UInt64", numeric: true, value: (p) => optionalNumber(p.rows) },
          {
            label: "Bytes", type: "UInt64", numeric: true, value: (p) => optionalNumber(p.bytes),
            render: (td, p) => gaugeCell(td, p.bytes, max, format.bytes(p.bytes)),
          },
          { label: "Parts", type: "UInt64", numeric: true, value: (p) => optionalNumber(p.parts) },
        ],
      }));
    }

    function structureItems(detail, prefix) {
      const tableFootprint = summaryFootprintBytes(detail.summary || {});
      return (detail.indexes_and_projections || [])
        .filter((item) => String(item.kind || "").startsWith(prefix))
        .map((item) => {
          const compressed = optionalNumber(item.compressed_bytes);
          return {
            name: item.name || DASH,
            type: String(item.kind || "").slice(prefix.length) || "unknown",
            expression: item.expression || "",
            compressed,
            uncompressed: optionalNumber(item.uncompressed_bytes),
            percent: compressed == null ? null : percentValue(compressed, tableFootprint),
          };
        });
    }

    function renderStructures(body, items, kind) {
      const max = columnMax(items, (item) => item.compressed);
      const specs = [
        { label: kind === "indexes" ? "Index" : "Projection", value: (item) => item.name, cellClass: "explorerCell--code" },
        { label: "Type", value: (item) => item.type },
      ];
      if (items.some((item) => item.expression)) specs.push({ label: "Expression", value: (item) => item.expression, cellClass: "explorerCell--code explorerCell--expr" });
      specs.push(
        {
          label: "Compressed", type: "Float64", numeric: true, value: (item) => item.compressed,
          render: (td, item) => { td.classList.add("explorerStorageGaugeCell"); gaugeCell(td, item.compressed, max, item.compressed == null ? DASH : format.bytes(item.compressed)); },
        },
        {
          label: "Uncompressed", type: "Float64", numeric: true, value: (item) => item.uncompressed,
          render: (td, item) => numericCell(td, item.uncompressed == null ? DASH : format.bytes(item.uncompressed)),
        },
        {
          label: "% table", type: "Float64", numeric: true, value: (item) => item.percent,
          render: (td, item) => { td.classList.add("explorerStoragePercentCell"); numericCell(td, item.percent == null ? DASH : percentText(item.percent)); },
        },
      );
      body.appendChild(staticTable({ className: `explorerStorageResultTable--${kind}`, items, specs }));
    }

    function renderStorageTab(container, detail) {
      const s = detail.summary || {};
      if (isMergeTreeSummary(s)) renderStorageCompositionCard(container, detail);
      const disks = detail.storage || [];
      const parts = detail.parts || [];
      const partitions = detail.partitions || [];
      const indexes = structureItems(detail, "index:");
      const projections = structureItems(detail, "projection:");
      const mergeTree = isMergeTreeSummary(s);
      const activeParts = parts.filter((part) => part.active).length;
      renderSections(container, [
        {
          id: "disks", title: isLogFamilySummary(s) ? "Disks (storage medium)" : "Disks", count: disks.length, hasData: disks.length > 0,
          emptyText: sectionUnavailable("storage") ? "Disk metadata unavailable" : "No local disk-backed storage",
          render: (body) => renderDisks(body, detail),
        },
        mergeTree && {
          id: "parts", title: "Parts", count: parts.length, hasData: parts.length > 0,
          note: parts.length !== activeParts ? `${format.count(activeParts)} active` : "",
          emptyText: sectionUnavailable("parts") ? "Part metadata unavailable" : "No parts",
          render: (body) => renderParts(body, detail),
        },
        mergeTree && {
          id: "partitions", title: "Partitions", count: partitions.length, hasData: partitions.length > 0,
          emptyText: sectionUnavailable("partitions") ? "Partition metadata unavailable" : "No partitions",
          render: (body) => renderPartitions(body, detail),
        },
        mergeTree && {
          id: "indexes", title: "Skipping indexes", count: indexes.length, hasData: indexes.length > 0,
          emptyText: "No skipping indexes",
          render: (body) => renderStructures(body, indexes, "indexes"),
        },
        mergeTree && {
          id: "projections", title: "Projections", count: projections.length, hasData: projections.length > 0,
          emptyText: "No projections",
          render: (body) => renderStructures(body, projections, "projections"),
        },
      ]);
    }

    // ---- Operations tab -------------------------------------------------------

    function ingestionState(summary) {
      const client = summary.client_ingress || {};
      const physical = summary.physical_ingress || {};
      const keys = ["rows_per_second_1m", "rows_per_second_5m", "rows_per_second_1h", "bytes_per_second_1m", "bytes_per_second_5m", "bytes_per_second_1h"];
      const values = [...keys.map((key) => optionalNumber(client[key])), ...keys.map((key) => optionalNumber(physical[key]))];
      if (values.every((value) => value == null)) return "unavailable";
      return values.some((value) => value != null && value > 0) ? "active" : "idle";
    }

    function renderIngestion(body, detail) {
      const s = detail.summary || {};
      const windows = [["1 min", "1m"], ["5 min", "5m"], ["1 h", "1h"]];
      const sources = [
        ["Client", s.client_ingress || {}, "Finished INSERT queries (system.query_log)"],
        ["Persisted", s.physical_ingress || {}, "New parts written (system.part_log); Buffer forwarding and MV output are not folded in"],
      ];
      const table = node("table", "explorerIngestionTable");
      const head = node("tr");
      head.appendChild(node("th", "", ""));
      for (const [label] of windows) head.appendChild(node("th", "", label));
      const thead = node("thead");
      thead.appendChild(head);
      const tbody = node("tbody");
      for (const [label, rate, title] of sources) {
        const tr = node("tr");
        const th = node("th", "", label);
        th.scope = "row";
        th.title = title;
        tr.appendChild(th);
        for (const [, suffix] of windows) {
          const td = node("td");
          td.append(
            node("div", "explorerIngestionTable__rows", format.rate(rate[`rows_per_second_${suffix}`], "rows")),
            node("div", "explorerIngestionTable__bytes", format.bytesRate(rate[`bytes_per_second_${suffix}`])),
          );
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.append(thead, tbody);
      body.appendChild(table);
      const client = s.client_ingress || {};
      const physical = s.physical_ingress || {};
      const facts = [
        client.rows_total_1h != null ? `1 h client total ${format.count(client.rows_total_1h)} rows \u00b7 ${format.bytes(client.bytes_total_1h)}` : "",
        physical.rows_total_1h != null ? `1 h persisted total ${format.count(physical.rows_total_1h)} rows \u00b7 ${format.bytes(physical.bytes_total_1h)}` : "",
        physical.new_parts_per_minute != null ? `${format.count(physical.new_parts_per_minute)} new parts in the last minute` : "",
        client.last_event_time ? `last client write ${ui.serverTime(client.last_event_time).text}` : "",
        physical.last_event_time ? `last persisted write ${ui.serverTime(physical.last_event_time).text}` : "",
      ].filter(Boolean);
      if (facts.length) body.appendChild(node("div", "explorerSection__facts", facts.join(" \u00b7 ")));
    }

    function keyValueGrid(items) {
      const grid = node("dl", "explorerKeyValues");
      for (const [label, value, { code = false, title = "" } = {}] of items) {
        if (value == null || value === "") continue;
        const dt = node("dt", "", label);
        const dd = node("dd", code ? "is-code" : "", value);
        if (title || String(value).length > 32) dd.title = title || String(value);
        grid.append(dt, dd);
      }
      return grid;
    }

    function renderReplication(body, detail) {
      const r = detail.summary?.replication || {};
      body.appendChild(keyValueGrid([
        ["This replica", r.replica_name || DASH, { code: true }],
        ["Active replicas", `${format.count(r.active_replicas)}/${format.count(r.total_replicas)}`],
        ["Queue", `${format.count(r.queue_size)} (${format.count(r.inserts_in_queue)} inserts \u00b7 ${format.count(r.merges_in_queue)} merges)`],
        ["Absolute delay", `${format.count(r.absolute_delay_seconds)} s`],
        ["Log entries to fetch", r.log_lag == null ? null : format.count(r.log_lag)],
        ["Leader", r.is_leader == null ? null : (r.is_leader ? "yes" : "no")],
        ["Read-only", r.readonly ? "yes" : "no"],
        ["Keeper session", r.session_expired ? "expired" : "ok"],
        ["Last queue update", r.last_queue_update || null],
        ["Keeper path", r.zookeeper_path || DASH, { code: true }],
      ]));
      if ((r.replicas || []).length) {
        const list = node("div", "explorerAboutTile__replicas explorerReplicaList");
        for (const replica of r.replicas) {
          const chip = node("span", "explorerReplicaChip");
          const dot = node("i", `explorerHealthDot explorerHealthDot--${replica.active ? "healthy" : "error"}`);
          dot.setAttribute("aria-hidden", "true");
          chip.append(dot, node("span", "", `${replica.name}${replica.name === r.replica_name ? " (this)" : ""} \u00b7 ${replica.active ? "active" : "inactive"}`));
          list.appendChild(chip);
        }
        body.appendChild(list);
      }
    }

    function renderReplicationQueue(body, detail) {
      body.appendChild(staticTable({
        className: "explorerTable--replicationQueue",
        items: detail.replication_queue || [],
        specs: [
          { label: "Type", value: (q) => q.type },
          { label: "Created", value: (q) => q.create_time, render: (td, q) => timeCell(td, q.create_time) },
          { label: "Source replica", value: (q) => q.source_replica || "", cellClass: "explorerCell--code" },
          { label: "Part", value: (q) => q.new_part_name || "", cellClass: "explorerCell--code" },
          { label: "Tries", type: "UInt64", numeric: true, value: (q) => optionalNumber(q.num_tries) },
          { label: "Last attempt", value: (q) => q.last_attempt_time || "", render: (td, q) => timeCell(td, q.last_attempt_time) },
          { label: "Last exception", value: (q) => q.last_exception || "", cellClass: "explorerCell--message" },
        ],
      }));
    }

    function renderMerges(body, detail) {
      body.appendChild(staticTable({
        className: "explorerStorageResultTable--merges",
        items: detail.merges || [],
        specs: [
          { label: "Result part", value: (m) => m.result_part_name || m.partition || "merge", cellClass: "explorerCell--code" },
          { label: "Partition", value: (m) => m.partition || "", cellClass: "explorerCell--code" },
          {
            label: "Elapsed", type: "Float64", numeric: true, value: (m) => Number(m.elapsed_seconds || 0),
            render: (td, m) => numericCell(td, format.duration.fromSeconds(Number(m.elapsed_seconds || 0))),
          },
          {
            label: "Progress", type: "Float64", numeric: true, value: (m) => Math.max(0, Math.min(100, Number(m.progress || 0) * 100)),
            render: (td, m, value) => gaugeCell(td, value, 100, format.percent(Number(value || 0) / 100)),
          },
          { label: "Parts", type: "UInt64", numeric: true, value: (m) => optionalNumber(m.num_parts) },
          { label: "Rows read", type: "UInt64", numeric: true, value: (m) => optionalNumber(m.rows_read) },
          { label: "Bytes read", type: "UInt64", numeric: true, value: (m) => optionalNumber(m.bytes_read), render: (td, m) => numericCell(td, format.bytes(m.bytes_read)) },
          { label: "Memory", type: "UInt64", numeric: true, value: (m) => optionalNumber(m.memory_usage), render: (td, m) => numericCell(td, format.bytes(m.memory_usage)) },
        ],
      }));
    }

    function renderMutations(body, detail) {
      const mutations = (detail.mutations || []).slice().sort((a, b) => Number(!!a.done) - Number(!!b.done));
      body.appendChild(staticTable({
        className: "explorerTable--mutations",
        items: mutations,
        specs: [
          { label: "Mutation", value: (m) => m.mutation_id, cellClass: "explorerCell--code" },
          { label: "Created", value: (m) => m.create_time, render: (td, m) => timeCell(td, m.create_time) },
          {
            label: "State", value: (m) => (m.done ? "done" : "pending"),
            render: (td, m) => td.appendChild(node("span", `explorerBadge explorerBadge--${m.done ? "inactive" : "pending"}`, m.done ? "done" : "pending")),
          },
          { label: "Parts to do", type: "UInt64", numeric: true, value: (m) => optionalNumber(m.parts_to_do) },
          { label: "Command", value: (m) => m.command, cellClass: "explorerCell--code explorerCell--expr" },
          { label: "Last failure", value: (m) => m.latest_fail_reason || "", cellClass: "explorerCell--message" },
        ],
      }));
    }

    function renderDistributionQueue(body, detail) {
      body.appendChild(staticTable({
        className: "explorerTable--distributionQueue",
        items: detail.distribution_queue || [],
        specs: [
          { label: "Data path", value: (q) => q.data_path || "", cellClass: "explorerCell--code explorerCell--path" },
          { label: "Blocked", value: (q) => (q.blocked ? "yes" : "no") },
          { label: "Errors", type: "UInt64", numeric: true, value: (q) => optionalNumber(q.error_count) },
          { label: "Files", type: "UInt64", numeric: true, value: (q) => optionalNumber(q.data_files) },
          { label: "Compressed", type: "UInt64", numeric: true, value: (q) => optionalNumber(q.data_compressed_bytes), render: (td, q) => numericCell(td, format.bytes(q.data_compressed_bytes)) },
          { label: "Broken files", type: "UInt64", numeric: true, value: (q) => optionalNumber(q.broken_data_files) },
          { label: "Last error", value: (q) => q.last_exception || "", cellClass: "explorerCell--message" },
        ],
      }));
    }

    function renderCluster(body, detail) {
      body.appendChild(staticTable({
        className: "explorerTable--cluster",
        items: detail.topology || [],
        specs: [
          { label: "Shard", type: "UInt64", numeric: true, value: (n) => optionalNumber(n.shard_num) },
          { label: "Replica", type: "UInt64", numeric: true, value: (n) => optionalNumber(n.replica_num) },
          { label: "Host", value: (n) => n.host_name || "", cellClass: "explorerCell--code" },
          { label: "Address", value: (n) => n.host_address ? `${n.host_address}:${n.port}` : "", cellClass: "explorerCell--code" },
          { label: "Local", value: (n) => (n.is_local ? "yes" : "no") },
          { label: "Errors", type: "UInt64", numeric: true, value: (n) => optionalNumber(n.errors_count) },
          { label: "Slowdowns", type: "UInt64", numeric: true, value: (n) => optionalNumber(n.slowdowns_count) },
        ],
      }));
    }

    function renderOperationsTab(container, detail) {
      renderSections(container, operationSections(detail));
    }

    function operationSections(detail) {
      const s = detail.summary || {};
      const r = s.replication || {};
      const merges = detail.merges || [];
      const mutations = detail.mutations || [];
      const pending = mutations.filter((m) => !m.done).length;
      const queue = detail.replication_queue || [];
      const mergeTree = isMergeTreeSummary(s);
      const distributed = isDistributedSummary(s);
      const ingestion = ingestionState(s);
      return [
        r.available && {
          id: "replication", title: "Replication", hasData: true, note: `${format.count(r.active_replicas)}/${format.count(r.total_replicas)} active`,
          render: (body) => renderReplication(body, detail),
        },
        r.available && {
          id: "replication_queue", title: "Replication queue", count: queue.length, hasData: queue.length > 0,
          emptyText: sectionUnavailable("replication_queue") ? "Replication queue unavailable" : "Replication queue empty",
          render: (body) => renderReplicationQueue(body, detail),
        },
        mergeTree && {
          id: "merges", title: "Active merges", count: merges.length, hasData: merges.length > 0,
          emptyText: sectionUnavailable("merges") ? "Merge metadata unavailable" : "No active merges",
          render: (body) => renderMerges(body, detail),
        },
        mergeTree && {
          id: "mutations", title: "Mutations", count: mutations.length, hasData: mutations.length > 0, note: pending ? `${format.count(pending)} pending` : "",
          emptyText: sectionUnavailable("mutations") ? "Mutation metadata unavailable" : "No mutations",
          render: (body) => renderMutations(body, detail),
        },
        !distributed && {
          id: "ingestion", title: "Ingestion", hasData: ingestion === "active",
          emptyText: ingestion === "unavailable" ? "Write activity unavailable (query_log / part_log)" : "No writes in the last 1 h",
          render: (body) => renderIngestion(body, detail),
        },
        distributed && {
          id: "distribution_queue", title: "Distribution queue", count: (detail.distribution_queue || []).length,
          hasData: (detail.distribution_queue || []).length > 0,
          emptyText: sectionUnavailable("distribution_queue") ? "Distribution queue unavailable" : "Distribution queue empty",
          render: (body) => renderDistributionQueue(body, detail),
        },
        distributed && {
          id: "cluster", title: detail.distributed?.cluster ? `Cluster ${detail.distributed.cluster}` : "Cluster",
          count: (detail.topology || []).length, hasData: (detail.topology || []).length > 0,
          emptyText: sectionUnavailable("topology") ? "Cluster topology unavailable" : "No cluster members resolved",
          render: (body) => renderCluster(body, detail),
        },
      ].filter(Boolean);
    }

    // ---- Lineage tab ----------------------------------------------------------

    function renderLineageTab(container, detail) {
      const deps = visibleDependencies(detail);
      const s = detail.summary || {};
      const toolbar = node("div", "explorerLineageToolbar");
      toolbar.appendChild(node("span", "explorerLineageToolbar__note", "Only objects readable by the runner are listed."));
      const open = node("button", "button button--small", "Open lineage graph");
      open.type = "button";
      open.addEventListener("click", () => {
        setMode("graph");
        graph?.focusTable?.(s.database, s.name);
        syncExplorerUrl("push");
      });
      toolbar.appendChild(open);
      container.appendChild(toolbar);
      if (!deps.length) {
        container.appendChild(emptyNote(sectionUnavailable("dependencies") ? "Dependency metadata unavailable." : "No visible dependencies."));
        return;
      }
      // Both directions always render so the layout keeps its shape when one
      // side is empty.
      const matrix = node("div", "explorerDependencyMatrix explorerLineage");
      for (const relation of ["upstream", "downstream"]) {
        const items = deps
          .filter((dep) => String(dep.relation || "").toLowerCase() === relation)
          .slice()
          .sort((a, b) => `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`, undefined, { numeric: true, sensitivity: "base" }));
        const group = node("section", "explorerDependencyGroup explorerLineage__group");
        group.dataset.relation = relation;
        const title = node("h4", "explorerLineage__title", relation === "upstream" ? "Upstream" : "Downstream");
        title.appendChild(node("span", "explorerSection__count", format.count(items.length)));
        group.appendChild(title);
        const list = node("div", "explorerLineage__list");
        if (!items.length) list.appendChild(emptyNote(relation === "upstream" ? "Nothing feeds this object." : "Nothing reads from this object."));
        for (const dep of items) list.appendChild(dependencyChip(dep, s.database, { cluster: detail.distributed?.cluster || "" }));
        group.appendChild(list);
        matrix.appendChild(group);
      }
      container.appendChild(matrix);
    }

    // ---- Preview tab ----------------------------------------------------------

    function previewLimit() {
      const current = Number(model.previewLimit);
      if (PREVIEW_LIMITS.includes(current)) return current;
      let stored = 100;
      try { stored = Number(localStorage.getItem(PREVIEW_LIMIT_KEY)) || 100; } catch { stored = 100; }
      model.previewLimit = PREVIEW_LIMITS.includes(stored) ? stored : 100;
      return model.previewLimit;
    }

    function setPreviewLimit(limit) {
      model.previewLimit = limit;
      try { localStorage.setItem(PREVIEW_LIMIT_KEY, String(limit)); } catch { /* per-viewer convenience only */ }
      model.preview = null;
      renderTabContent();
    }

    async function loadPreview() {
      if (model.previewLoading || model.preview) return;
      const detail = model.detail;
      if (!detail) return;
      const s = detail.summary || {};
      const key = model.selectedKey;
      const limit = previewLimit();
      model.previewLoading = true;
      renderTabContent();
      let result;
      try {
        result = await api.getExplorerTableData(state.selectedHostId, s.database, s.name, limit);
      } catch (e) {
        result = { error: e };
      } finally {
        model.previewLoading = false;
      }
      // A late answer for another table or limit is dropped.
      if (model.selectedKey !== key || model.detail?.summary?.name !== s.name) return;
      if (result && !result.error) result.requested_limit = limit;
      if (limit === previewLimit()) model.preview = result;
      if (model.tab === "Preview") renderTabContent();
    }

    function openSqlInQuery(sql) {
      const text = String(sql || "");
      // Explorer and Query are separate HTML documents. Persist the requested SQL
      // in the same session draft consumed by Query before crossing documents,
      // otherwise the textarea does not exist yet and the statement is lost.
      try {
        sessionStorage.setItem("chdash.editor.draft.v2", text);
      } catch {
        null;
      }
      if (dom.queryTextArea) {
        util.replaceTextAreaValue(dom.queryTextArea, text);
        setWorkspace("query");
        return;
      }
      window.location.assign(appRoute("/query"));
    }

    function aggregatePreviewColumn(column) {
      if (!column) return false;
      if (column.finalized_for_preview === true) return true;
      return /^AggregateFunction\s*\(/i.test(String(column.type || "").trim());
    }

    function buildPreviewSelectSql(detail) {
      const s = detail?.summary || {};
      const previewByName = new Map(
        (model.preview?.columns || []).map((column) => [String(column?.name || ""), column]),
      );
      const columns = (detail?.columns || []).filter((column) => column?.is_subcolumn !== true);
      const projection = columns.map((column) => {
        const name = String(column?.name || "");
        const quoted = quoteIdent(name);
        const previewColumn = previewByName.get(name);
        return aggregatePreviewColumn(previewColumn || column)
          ? `finalizeAggregation(${quoted}) AS ${quoted}`
          : quoted;
      });
      return `SELECT ${projection.length ? projection.join(", ") : "*"}\nFROM ${quoteIdent(s.database)}.${quoteIdent(s.name)}\nLIMIT ${previewLimit()}`;
    }

    async function openFormattedSqlInQuery(sql) {
      const formatted = await api.formatSqls(state.selectedHostId, [String(sql || "")]);
      if (!Array.isArray(formatted) || !formatted.length || !String(formatted[0] || "").trim()) {
        throw new Error("Formatter returned an empty query.");
      }
      openSqlInQuery(formatted[0]);
    }

    function appendFinalizePreviewInfo(th) {
      const text = "finalizeAggregation() used so Explorer can display the value of a single row";
      th.classList.add("has-finalize-info");
      const info = node("span", "explorerFinalizeInfo");
      info.tabIndex = 0;
      info.setAttribute("aria-label", text);
      info.addEventListener("click", (event) => event.stopPropagation());
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 416.979 416.979");
      icon.setAttribute("aria-hidden", "true");
      icon.classList.add("explorerFinalizeInfo__icon");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M356.004 61.156C274.634-20.314 142.627-20.395 61.156 60.974c-81.47 81.371-81.552 213.379-.181 294.85 81.369 81.47 213.378 81.551 294.849.181 81.469-81.369 81.551-213.379.18-294.849zM237.6 340.786c0 3.217-2.607 5.822-5.822 5.822h-46.576c-3.215 0-5.822-2.605-5.822-5.822V167.885c0-3.217 2.607-5.822 5.822-5.822h46.576c3.215 0 5.822 2.604 5.822 5.822v172.901zM208.49 137.901c-18.618 0-33.766-15.146-33.766-33.765 0-18.617 15.147-33.766 33.766-33.766 18.619 0 33.766 15.148 33.766 33.766 0 18.619-15.149 33.765-33.766 33.765z");
      icon.appendChild(path);
      info.append(icon, node("div", "explorerFinalizeInfo__tooltip", text));
      th.appendChild(info);
    }

    function persistFlattenTuple(enabled) {
      state.runOptFlattenTuple = enabled !== false;
      storage?.saveRunOptions?.({
        autoFormat: state.runOptAutoFormat,
        multiQuery: state.runOptMultiQuery,
        executionStats: state.runOptExecutionStats,
        flattenTuple: state.runOptFlattenTuple,
      });
      ui?.applyRunOptionsUi?.();
      window.dispatchEvent(new CustomEvent("chdash:flatten-tuple-change", { detail: { enabled: state.runOptFlattenTuple } }));
    }

    function createDataSettingsControl() {
      const root = node("div", "themeSelect explorerDataSettings");
      const button = node("button", "themeSelect__button editorAutocompleteControl__button explorerDataSettings__button");
      button.type = "button";
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-label", "Data display settings");
      button.title = "Data display settings";
      button.appendChild(node("span", "editorAutocompleteControl__gear"));

      const menu = node("div", "themeSelect__menu explorerDataSettings__menu");
      menu.setAttribute("role", "menu");
      menu.tabIndex = -1;
      menu.hidden = true;
      const option = node("button", "runMenu__opt");
      option.type = "button";
      option.setAttribute("role", "menuitemcheckbox");
      const check = node("span", "runMenu__optCheck");
      check.setAttribute("aria-hidden", "true");
      option.append(check, node("span", "runMenu__optText", "Flatten tuple"));
      const sync = () => option.setAttribute("aria-checked", String(state.runOptFlattenTuple !== false));
      sync();
      menu.appendChild(option);
      root.append(button, menu);

      // An ns.menu menu (app_ui_menu.js) in a portal: the card re-renders
      // and clips; the list opens fixed under the gear, right-aligned.
      const settings = ns.menu?.bind(button, menu, { root, portal: true, portalAlign: "end", closeOnSelect: true });

      option.addEventListener("click", () => {
        persistFlattenTuple(!(state.runOptFlattenTuple !== false));
        sync();
        settings?.close({ immediate: true, focus: false });
        renderTabContent();
      });
      return root;
    }

    // Preview cells are query results: every value stays as the API sent it
    // (decision 45: no grouping, no compact numbers, no reformatted dates),
    // like the Query result table; only a data NULL takes the NULL token.
    function previewCellText(value) {
      if (value == null) return "NULL";
      if (typeof value === "object") {
        try { return JSON.stringify(value); } catch { return String(value); }
      }
      return String(value);
    }

    function renderPreviewToolbar(container, detail) {
      const toolbar = node("div", "explorerDataToolbar explorerPreviewToolbar");
      const info = node("div", "explorerPreviewToolbar__info");
      const limit = previewLimit();
      const rows = Array.isArray(model.preview?.rows) ? model.preview.rows.length : null;
      const total = optionalNumber(detail.summary?.rows);
      const count = node("span", "explorerPreviewToolbar__count", rows == null ? `LIMIT ${limit}` : `${format.countLabel(rows, "row")} (LIMIT ${limit})`);
      info.appendChild(count);
      if (total != null && rows != null) info.appendChild(node("span", "explorerPreviewToolbar__total", `of ${format.count(total)} in the table`));
      // The row limit: the shared segmented control (app_ui_segmented.js).
      const limits = node("div", "explorerPreviewLimits");
      ns.segmented?.render(limits, PREVIEW_LIMITS.map((value) => ({ value, label: String(value), title: `Preview the first ${value} rows` })), { attr: "limit", value: limit, size: "compact", label: "Preview row limit" });
      ns.segmented?.bind(limits, { attr: "limit", onChange: (value) => { if (Number(value) !== previewLimit()) setPreviewLimit(Number(value)); return false; } });
      info.appendChild(limits);

      const open = node("button", "button button--small", "Open in Query");
      open.type = "button";
      open.addEventListener("click", async () => {
        if (open.disabled) return;
        open.disabled = true;
        try {
          await openFormattedSqlInQuery(buildPreviewSelectSql(detail));
        } catch (error) {
          setError(error);
          open.disabled = false;
        }
      });
      const actions = node("div", "explorerDataToolbar__actions");
      actions.append(open, createDataSettingsControl());
      toolbar.append(info, actions);
      container.appendChild(toolbar);
    }

    function renderTransposedPreview(container, columns, types, row, previewColumns, sourceIndexes) {
      const items = columns.map((name, index) => ({ name, type: types[index] || "", value: row[index], source: previewColumns[sourceIndexes?.[index] ?? index] }));
      container.appendChild(staticTable({
        className: "explorerResultTable--preview explorerPreviewTable explorerPreviewTable--transposed",
        items,
        specs: [
          { label: "Column", value: (item) => item.name, cellClass: "explorerColumns__name" },
          { label: "Type", value: (item) => item.type, render: (td, item) => { td.classList.add("explorerColumns__type"); td.textContent = item.type || DASH; td.title = item.type; } },
          {
            label: "Value",
            value: (item) => previewCellText(item.value),
            render: (td, item) => {
              td.classList.add("explorerPreviewTable__value");
              if (item.value == null) {
                td.classList.add("is-null");
                // The shared NULL token of the result tables (ns.format.nullToken()).
                if (ns.results?.setNullCell) ns.results.setNullCell(td);
                else td.textContent = "NULL";
                return;
              }
              const text = previewCellText(item.value);
              td.textContent = text;
              if (text.length > 24) td.title = previewCellText(item.value);
            },
          },
        ],
      }));
    }

    function renderPreviewTab(container, detail) {
      renderPreviewToolbar(container, detail);
      if (model.previewLoading) return container.appendChild(emptyNote("Loading preview\u2026"));
      if (!model.preview) {
        container.appendChild(emptyNote("Loading preview\u2026"));
        setTimeout(loadPreview, 0);
        return;
      }
      if (model.preview.error) return container.appendChild(emptyNote(model.preview.error.message || "Preview failed."));
      const previewColumns = Array.isArray(model.preview.columns) ? model.preview.columns : [];
      const sourceColumns = previewColumns.map((c) => c.name);
      const sourceRows = Array.isArray(model.preview.rows) ? model.preview.rows : [];
      if (!sourceRows.length) return container.appendChild(emptyNote("The table returned no rows."));
      // AggregateFunction preview values are finalized/stringified server-side so
      // clickhouse-cpp never has to decode aggregate states. If every returned
      // finalized value is numeric, expose a numeric presentation type to the
      // shared result table so Explorer gets the same background gauges as Query.
      const sourceTypes = previewColumns.map((c, columnIndex) => {
        if (!aggregatePreviewColumn(c)) return c.type;
        const values = sourceRows.map((row) => Array.isArray(row) ? row[columnIndex] : null).filter((value) => value != null && String(value).trim() !== "");
        return values.length && values.every((value) => Number.isFinite(Number(value))) ? "Float64" : c.type;
      });
      const projected = ns.results?.flattenTupleTableData?.(sourceColumns, sourceTypes, sourceRows, state.runOptFlattenTuple !== false)
        || { columns: sourceColumns, types: sourceTypes, rows: sourceRows, sourceColumnIndexes: sourceColumns.map((_, index) => index) };
      if (projected.rows.length === 1) {
        renderTransposedPreview(container, projected.columns, projected.types, projected.rows[0], previewColumns, projected.sourceColumnIndexes);
        return;
      }
      const table = ns.results?.createStaticResultTable?.({
        columns: projected.columns,
        types: projected.types,
        rows: projected.rows,
        className: "explorerTable explorerResultTable--preview explorerPreviewTable",
        rowDetails: true,
        decorateHeader: (th, headCtx) => {
          const sourceIndex = projected.sourceColumnIndexes?.[headCtx.columnIndex] ?? headCtx.columnIndex;
          // Type sub-header drawn by CSS from data-type, so the header text
          // stays the column name (row details, copy and tests read it).
          const type = projected.types[headCtx.columnIndex] || "";
          if (type) th.dataset.type = type;
          if (aggregatePreviewColumn(previewColumns[sourceIndex])) appendFinalizePreviewInfo(th);
        },
      });
      if (!table) throw new Error("Shared result table component is unavailable.");
      container.appendChild(table);
    }

    // ---- DDL tab --------------------------------------------------------------

    function renderDdl(container, detail) {
      if (!detail.ddl) return container.appendChild(unavailableMessage("DDL"));
      const ddl = String(detail.formatted_ddl || detail.ddl);
      if (detail.ddl_format_error) container.appendChild(emptyNote(`Formatter unavailable: ${detail.ddl_format_error}`));

      // Render CREATE with the same editor primitives as Query: identical gutter,
      // syntax overlay, token colors and copy control. Explorer only overrides
      // sizing because this surface is read-only and must grow with the DDL.
      const wrap = node("div", "editorWrap explorerDdlWrap");
      const gutter = node("pre", "editorGutter explorerDdlGutter");
      const lineCount = Math.max(1, ddl.split("\n").length);
      gutter.textContent = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");

      const copy = node("button", "editorCopyButton explorerDdlCopy");
      copy.type = "button";
      copy.setAttribute("aria-label", "Copy CREATE statement");
      copy.title = "Copy CREATE statement";
      copy.appendChild(node("span", "editorCopyButton__icon"));
      copy.addEventListener("click", async () => {
        await util.copyTextToClipboard(ddl);
        copy.classList.add("is-copied");
        setTimeout(() => copy.classList.remove("is-copied"), 1000);
      });
      const pre = node("pre", "editorHighlight explorerDdl");
      renderHighlightedCode(pre, ddl);
      wrap.append(gutter, pre, copy);
      container.appendChild(wrap);
    }

    // ---- tab body -------------------------------------------------------------

    function renderTabContent() {
      const container = dom.explorerDetailContent;
      if (!container) return;
      destroyDatabaseTreemap();
      clear(container);
      const detail = model.detail;
      if (!detail) return;
      const card = node("div", "explorerCard");
      const main = node("div", "explorerCard__main");
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

    // Tree hook: health dot of a replicated table (catalog "replicated" / "health").
    function replicaHealthDot(table) {
      if (!table?.replicated) return null;
      const state = healthState(table);
      const dot = node("i", `explorerHealthDot explorerHealthDot--${state} explorerTreeHealthDot`);
      dot.title = state === "healthy" ? "Replicated: local replica healthy" : `Replicated: ${healthLabel(table).toLowerCase()} (local replica)`;
      return dot;
    }

    return { renderDetailHeader, renderTabs, renderTabContent, availableTabs, replicaHealthDot };
  }

  ns.explorerDetail = { create };
})();
