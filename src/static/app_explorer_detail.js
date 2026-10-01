(() => {
  "use strict";

  // Explorer table detail: header, tabs and every tab body of a selected
  // object. app_explorer.js (tree, routing, selection) creates it once with
  // its model and shared helpers and delegates renderDetailHeader /
  // renderTabs / renderTabContent to it.
  const ns = window.ChDash;
  if (!ns) return;

  function create(ctx) {
    const { dom, state, api, util, ui, storage } = ns;
    const graph = ns.explorerGraph;
    const {
      model, node, clear, appRoute, setError, fmtInt,
      fmtBytes, fmtStorageBytes, fmtRate, fmtPercent, quoteIdent, humanEngine,
      healthLabel, summaryFootprintBytes, summaryRowsLabel, isViewLikeSummary, isMergeTreeSummary, isDictionarySummary,
      isDistributedSummary, isLogFamilySummary, isResidentMemorySummary, renderHighlightedCode, destroyDatabaseTreemap, selectTable,
      setMode, setWorkspace, syncExplorerUrl,
    } = ctx;

    function visibleDependencies(detail) {
      return (detail?.dependencies || []).filter((d) => !/^_?row$/i.test(String(d.table || "")));
    }

    function isEmptyRowSummary(summary) {
      return optionalNumber(summary?.rows) === 0;
    }

    function availableTabs(detail) {
      if (isViewLikeSummary(detail?.summary)) return ["Overview"];
      const summary = detail?.summary || {};
      // An empty table has nothing useful to preview or inspect physically. Keep
      // Overview for identity/lineage/DDL, but do not expose empty Data/Storage
      // surfaces or their zero-value breakdowns.
      if (isEmptyRowSummary(summary)) return ["Overview"];
      const tabs = ["Overview", "Data"];
      const hasStorage = isMergeTreeSummary(summary) || isDistributedSummary(summary) || isLogFamilySummary(summary);
      if (hasStorage) tabs.push("Storage");
      else if (!isDictionarySummary(summary)) tabs.push("Operations");
      return tabs;
    }
    function summaryCard(label, value, sub) {
      const card = node("div", "explorerSummaryCard");
      card.append(node("div", "explorerSummaryCard__label", label), node("div", "explorerSummaryCard__value", value));
      if (sub) card.appendChild(node("div", "explorerSummaryCard__sub", sub));
      return card;
    }

    function renderDetailHeader() {
      const detail = model.detail;
      if (!detail) return;
      const s = detail.summary || {};
      if (dom.explorerEmptyState) dom.explorerEmptyState.hidden = true;
      if (dom.explorerDetail) dom.explorerDetail.hidden = false;
      if (dom.explorerDetailName) dom.explorerDetailName.textContent = `${s.database || ""}.${s.name || ""}`;
      if (dom.explorerDetailMeta) {
        const viewLike = isViewLikeSummary(s);
        const partCount = Number(s.active_parts || 0);
        const partitionCount = Number(s.partitions || 0);
        const footprint = summaryFootprintBytes(s);
        const stats = [
          humanEngine(s.engine),
          detail.metric_scope || "local-replica",
          s.health ? healthLabel(s).toLowerCase() : null,
          !viewLike ? summaryRowsLabel(s) : null,
          !viewLike && footprint != null ? (isResidentMemorySummary(s) ? `${fmtBytes(footprint)} RAM` : `${fmtBytes(footprint)} on disk`) : null,
          !viewLike && partCount > 0 ? `${fmtInt(partCount)} part${partCount === 1 ? "" : "s"}` : null,
          !viewLike && partitionCount > 0 ? `${fmtInt(partitionCount)} partition${partitionCount === 1 ? "" : "s"}` : null,
          !viewLike && s.client_ingress?.rows_per_second_1m != null ? `${fmtRate(s.client_ingress.rows_per_second_1m, "rows/s")} in` : null,
        ].filter(Boolean);
        dom.explorerDetailMeta.textContent = stats.join(" · ");
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
      if (dom.explorerSummaryCards) {
        dom.explorerSummaryCards.hidden = true;
        dom.explorerSummaryCards.replaceChildren();
      }
    }

    function renderTabs() {
      if (!dom.explorerDetailTabs) return;
      const tabs = availableTabs(model.detail);
      if (!tabs.includes(model.tab)) {
        model.tab = "Overview";
        // A deep link to a tab this object does not have (e.g. /operations on a
        // MergeTree table) falls back to Overview; keep the address bar in sync
        // once the real detail is known instead of leaving the stale tab path.
        if (model.detail && !model.detail._loading) syncExplorerUrl("replace");
      }
      if (tabs.length <= 1) {
        dom.explorerDetailTabs.hidden = true;
        dom.explorerDetailTabs.replaceChildren();
        return;
      }
      dom.explorerDetailTabs.hidden = false;
      const buttons = [];
      for (const label of tabs) {
        const button = node("button", `explorerDetailTab${model.tab === label ? " is-active" : ""}`, label);
        button.type = "button";
        button.role = "tab";
        button.setAttribute("aria-selected", String(model.tab === label));
        button.addEventListener("click", () => {
          model.tab = label;
          renderTabs();
          renderTabContent();
          syncExplorerUrl("push");
        });
        buttons.push(button);
      }
      dom.explorerDetailTabs.replaceChildren(...buttons);
    }

    function dataTable(headers, rows, classes = "") {
      const wrap = node("div", `explorerDataTableWrap ${classes}`.trim());
      const table = node("table", "explorerDataTable");
      const thead = document.createElement("thead");
      const trh = document.createElement("tr");
      for (const header of headers) trh.appendChild(node("th", "", header));
      thead.appendChild(trh);
      const tbody = document.createElement("tbody");
      for (const values of rows) {
        const tr = document.createElement("tr");
        for (const value of values) tr.appendChild(node("td", "", value == null ? "\u2014" : value));
        tbody.appendChild(tr);
      }
      table.append(thead, tbody);
      wrap.appendChild(table);
      return wrap;
    }

    function sectionUnavailable(name) {
      const unavailable = new Set(model.detail?.unavailable_sections || []);
      return unavailable.has(name);
    }

    function unavailableMessage(label) {
      return node("div", "explorerUnavailable", `${label} is unavailable on this server or is not enabled.`);
    }

    function extractTableTtl(detail) {
      const ddl = String(detail?.formatted_ddl || detail?.ddl || "");
      if (!ddl) return "";
      const match = ddl.match(/(?:^|\n)TTL\s+([\s\S]*?)(?=\n(?:SETTINGS|COMMENT|AS\s+SELECT|POPULATE|EMPTY\s+AS)\b|;?\s*$)/i);
      return match ? String(match[1] || "").trim().replace(/\s+/g, " ") : "";
    }

    function formatStructuredType(type) {
      const text = String(type || "").trim();
      if (!text) return "\u2014";
      if (!/\n/.test(text) && !/(Tuple\(|Array\(Tuple\(|Map\(|Enum(?:8|16)\()/.test(text)) return text;
      let depth = 0;
      let out = "";
      const indent = () => "    ".repeat(Math.max(0, depth));
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        out += ch;
        if (ch === "(") {
          depth += 1;
          const ahead = text.slice(i + 1);
          if (/^\s*(?:[A-Za-z_`]|Tuple\(|Map\(|Array\()/u.test(ahead)) out += `\n${indent()}`;
        } else if (ch === ",") {
          out += `\n${indent()}`;
        } else if (ch === ")") {
          depth = Math.max(0, depth - 1);
          out = out.replace(/\n\s*\)$/, `\n${indent()})`);
        }
      }
      return out.replace(/\n{3,}/g, "\n\n");
    }

    function percentValue(value, total) {
      const v = Number(value);
      const t = Number(total);
      if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return null;
      return Math.max(0, Math.min(100, (v / t) * 100));
    }
    function percentBar(value, { title = "", variant = "default", unknownText = "unknown" } = {}) {
      const pct = value == null ? Number.NaN : Number(value);
      const wrap = node("div", `explorerPercentBar explorerPercentBar--${variant}`);
      if (title) wrap.title = title;
      if (!Number.isFinite(pct)) {
        wrap.classList.add("is-unknown");
        wrap.appendChild(node("span", "explorerPercentBar__text", unknownText));
        return wrap;
      }
      const bounded = Math.max(0, Math.min(100, pct));
      const fill = node("div", "explorerPercentBar__fill");
      fill.style.width = `${bounded}%`;
      wrap.append(fill, node("span", "explorerPercentBar__text", fmtPercent(pct)));
      return wrap;
    }

    function simpleRows(items) {
      const list = node("div", "explorerSimpleList");
      for (const [label, value] of items) {
        if (value == null || value === "" || value === "\u2014" || value === "unknown engine") continue;
        const row = node("div", "explorerSimpleRow");
        row.append(node("span", "explorerSimpleRow__label", label), node("code", "explorerSimpleRow__value", value));
        list.appendChild(row);
      }
      return list;
    }

    function optionalNumber(value) {
      if (value == null || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }

    function renderTableFootprint(container, detail) {
      const s = detail.summary || {};
      const tableBytes = summaryFootprintBytes(s);
      const dbBytes = optionalNumber(detail?.footprint_scope?.database_bytes);
      const allBytes = optionalNumber(detail?.footprint_scope?.clickhouse_bytes);
      const list = node("div", "explorerShareList explorerShareList--footprint");

      const scopeMeter = (label, part, total, variant) => {
        const pct = part == null ? null : percentValue(part, total);
        const row = node("div", `explorerScopeMeter explorerScopeMeter--${variant}`);
        const head = node("div", "explorerScopeMeter__head");
        head.append(
          node("span", "explorerScopeMeter__label", label),
          node("code", "explorerScopeMeter__percent", pct == null ? "unknown" : fmtPercent(pct)),
          node("code", "explorerScopeMeter__bytes", part == null || total == null
            ? "unknown"
            : `${fmtStorageBytes(part)} / ${fmtStorageBytes(total)}`),
        );
        const track = node("div", "explorerScopeMeter__track");
        if (pct == null) {
          track.classList.add("is-unknown");
        } else {
          const fill = node("div", "explorerScopeMeter__fill");
          fill.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
          track.appendChild(fill);
        }
        row.append(head, track);
        return row;
      };

      const scopeCard = node("div", "explorerScopeMeters");
      scopeCard.append(
        scopeMeter("Table / Database", tableBytes, dbBytes, "database"),
        scopeMeter("Table / ClickHouse", tableBytes, allBytes, "clickhouse"),
      );
      list.appendChild(scopeCard);

      if (isMergeTreeSummary(s)) {
        const composition = node("div", "explorerStorageCompositionCard");
        const head = node("div", "explorerStorageCompositionCard__head");
        head.append(
          node("span", "explorerStorageCompositionCard__label", "Table storage"),
          node("code", "explorerStorageCompositionCard__bytes", tableBytes == null ? "unknown" : fmtStorageBytes(tableBytes)),
        );
        composition.append(head, buildStorageComposition(detail, { embedded: true }));
        list.appendChild(composition);
      }

      container.appendChild(list);
    }

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
          segment.title = `${item.label}: ${fmtPercent(item.percent)} · ${fmtStorageBytes(item.bytes)}`;
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
          node("code", "explorerStorageCompositionLegend__percent",
            item.percent == null || item.bytes == null
              ? "unknown"
              : `${fmtPercent(item.percent)} · ${fmtStorageBytes(item.bytes)}`),
        );
        if (item.bytes != null) entry.title = `${item.label}: ${fmtPercent(item.percent)} · ${fmtStorageBytes(item.bytes)}`;
        legend.appendChild(entry);
      }
      if (legendItems.length) wrap.appendChild(legend);
      return wrap;
    }

    function renderStorageComposition(container, detail) {
      container.appendChild(buildStorageComposition(detail));
    }

    function renderOverview(container, detail) {
      const s = detail.summary || {};
      if (detail?._loading) container.appendChild(node("div", "explorerFootnote", "Loading detailed metadata\u2026"));
      const viewLike = isViewLikeSummary(s);
      const resident = isResidentMemorySummary(s);
      const empty = isEmptyRowSummary(s);
      if (!empty && !resident && !viewLike) {
        renderTableFootprint(container, detail);
      }

      const deps = visibleDependencies(detail);
      if (deps.length) renderDependencies(container, detail);
      if (viewLike || resident || empty) {
        if (detail.ddl) renderDdl(container, detail);
        return;
      }

      if (detail.ddl) renderDdl(container, detail);
    }

    function isImplementationSubcolumn(column) {
      if (!column?.is_subcolumn) return false;
      return /(?:^|\.)(?:size|size\d+)$/i.test(String(column.name || ""));
    }

    function renderStorageMetricTable(container, title, group, rows, firstLabel, options = {}) {
      if (!rows.length) {
        container.appendChild(node("div", "explorerEmptySection", `No ${title.toLowerCase()} metadata.`));
        return;
      }

      const compressedMax = Math.max(0, ...rows.map((item) => optionalNumber(item.compressed) || 0));
      const uncompressedMax = Math.max(0, ...rows.map((item) => optionalNumber(item.uncompressed) || 0));
      const applyGauge = (td, value, max, text) => {
        td.classList.add("resultTable__gaugeCell", "resultTable__numeric", "explorerStorageGaugeCell");
        const n = optionalNumber(value);
        const fill = n == null || max <= 0 ? 0 : Math.max(0, Math.min(100, (Math.abs(n) / max) * 100));
        td.style.setProperty("--gaugeFill", `${fill}%`);
        td.textContent = text;
      };

      // Reuse the exact Query results table component. Explorer contributes only
      // display adapters for byte values and the percentage bar; sorting,
      // headers, row indexes, typography and table geometry remain shared.
      const tableRows = rows.map((item) => {
        const displayName = String(item.name || "\u2014");
        const row = [
          displayName,
          item.codec && item.codec !== "unknown" ? item.codec : "-",
          item.compressed,
          item.uncompressed,
          item.percent,
        ];
        row.__explorerStorageItem = item;
        return row;
      });
      const tupleExpanded = options.tupleExpanded instanceof Set ? options.tupleExpanded : null;
      let table = null;
      table = ns.results?.createStaticResultTable?.({
        columns: [firstLabel, group === "columns" ? "Codec" : "Type", "Compressed", "Uncompressed", "% table"],
        types: ["String", "String", "Float64", "Float64", "Float64"],
        rows: tableRows,
        className: `explorerResultTable explorerStorageResultTable explorerStorageResultTable--${group}`,
        indexSortable: false,
        rowIndexValue: (row) => row?.__explorerStorageItem?.position ?? "",
        decorateRow: (tr, ctx) => {
          const item = ctx.row?.__explorerStorageItem || null;
          if (item?.tuple_parent) {
            tr.dataset.tupleParent = item.tuple_parent;
            tr.classList.add("explorerStorageTupleChild");
            tr.hidden = !(tupleExpanded?.has(item.tuple_parent));
            const indexCell = tr.querySelector(".resultTable__rowIndex");
            if (indexCell) {
              indexCell.textContent = "";
              indexCell.setAttribute("aria-hidden", "true");
            }
          }
        },
        renderCell: (td, ctx) => {
          const item = ctx.row?.__explorerStorageItem || null;
          if (ctx.columnIndex === 0) {
            td.textContent = "";
            if (item?.tuple_root && tupleExpanded) {
              const toggle = node("button", "explorerTreeDatabaseToggle explorerStorageTupleToggle", tupleExpanded.has(item.tuple_root) ? "\u2304" : "\u203a");
              toggle.type = "button";
              toggle.setAttribute("aria-expanded", String(tupleExpanded.has(item.tuple_root)));
              toggle.setAttribute("aria-label", `${tupleExpanded.has(item.tuple_root) ? "Collapse" : "Expand"} ${item.tuple_root}`);
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
              td.append(toggle, node("span", "explorerStorageTupleName", String(ctx.value ?? "\u2014")));
            } else {
              const label = node("span", item?.tuple_parent ? "explorerStorageTupleName explorerStorageTupleName--child" : "explorerStorageTupleName", String(ctx.value ?? "\u2014"));
              td.appendChild(label);
            }
            if (item?.title) td.title = item.title;
            return true;
          }
          if (ctx.columnIndex === 2) {
            applyGauge(td, ctx.value, compressedMax, ctx.value == null ? "-" : fmtStorageBytes(ctx.value));
            return true;
          }
          if (ctx.columnIndex === 3) {
            applyGauge(td, ctx.value, uncompressedMax, ctx.value == null ? "-" : fmtStorageBytes(ctx.value));
            return true;
          }
          if (ctx.columnIndex === 4) {
            td.classList.add("explorerStoragePercentCell");
            applyGauge(td, ctx.value, 100, ctx.value == null ? "-" : fmtPercent(ctx.value));
            return true;
          }
          return false;
        },
      });
      if (!table) throw new Error("Shared result table component is unavailable.");
      container.appendChild(table);
    }

    function renderColumns(container, detail) {
      if (sectionUnavailable("columns")) container.appendChild(unavailableMessage("Column metadata"));

      const tableFootprint = summaryFootprintBytes(detail.summary || {});
      const observedDefaults = (detail.default_compression_codecs || []).map((value) => String(value || "").trim()).filter(Boolean);
      const defaultCodec = !isMergeTreeSummary(detail.summary)
        ? "-"
        : observedDefaults.length === 1
          ? `${observedDefaults[0]} (default)`
          : observedDefaults.length > 1
            ? `${observedDefaults.join(" / ")} (part defaults)`
            : "DEFAULT";
      const allColumns = Array.isArray(detail.columns) ? detail.columns : [];
      const visibleColumns = allColumns.filter((column) => !isImplementationSubcolumn(column));
      // A storage Tuple hierarchy is not limited to a top-level Tuple(...).
      // Array(Tuple(...)) and deeper Array wrappers expose the same named physical
      // subcolumns and should use the same disclosure control.
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

      const tupleExpanded = new Set();
      let topLevelColumnPosition = 0;
      const columnRows = [];
      for (const c of visibleColumns) {
        const compressed = optionalNumber(c.compressed_bytes);
        const uncompressed = optionalNumber(c.uncompressed_bytes);
        const name = String(c.name || "\u2014");
        const tupleParent = c.is_subcolumn
          ? (tupleRoots.find((root) => name.startsWith(`${root}.`)) || null)
          : null;
        const tupleRoot = tupleRoots.includes(name) ? name : null;
        const displayPosition = c.is_subcolumn ? null : ++topLevelColumnPosition;
        columnRows.push({
          position: displayPosition,
          name,
          title: c.type || "",
          codec: c.codec || defaultCodec,
          compressed,
          uncompressed,
          percent: compressed == null ? null : percentValue(compressed, tableFootprint),
          is_subcolumn: !!c.is_subcolumn,
          tuple_root: tupleRoot,
          tuple_parent: tupleParent,
        });

        // size0/sizeN are real on-disk Array offset streams. They were previously
        // hidden, which made the expanded children appear not to add up to their
        // parent (especially in uncompressed bytes, where UInt64 offsets are
        // large but compress extremely well). Keep the implementation names out
        // of the UI, but account for their bytes as one explicit physical child.
        if (tupleRoot) {
          const implementation = implementationByRoot.get(tupleRoot) || [];
          if (implementation.length) {
            const compressedValues = implementation.map((item) => optionalNumber(item.compressed_bytes)).filter((value) => value != null);
            const uncompressedValues = implementation.map((item) => optionalNumber(item.uncompressed_bytes)).filter((value) => value != null);
            const implementationCompressed = compressedValues.length ? compressedValues.reduce((sum, value) => sum + value, 0) : null;
            const implementationUncompressed = uncompressedValues.length ? uncompressedValues.reduce((sum, value) => sum + value, 0) : null;
            columnRows.push({
              position: null,
              name: `${tupleRoot}.[offsets]`,
              title: `Physical Array offset stream${implementation.length === 1 ? "" : "s"}: ${implementation.map((item) => item.name).join(", ")}`,
              codec: c.codec || defaultCodec,
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
      renderStorageMetricTable(container, "Columns", "columns", columnRows, "Column", { tupleExpanded });

      const structures = (detail.indexes_and_projections || []).map((item, position) => {
        const compressed = optionalNumber(item.compressed_bytes);
        const uncompressed = optionalNumber(item.uncompressed_bytes);
        const kind = String(item.kind || "");
        return {
          position,
          name: item.name || "\u2014",
          title: item.expression || "",
          kind,
          codec: kind.startsWith("index:") ? kind.slice(6) : kind.startsWith("projection:") ? kind.slice(11) : (kind || "unknown"),
          compressed,
          uncompressed,
          percent: compressed == null ? null : percentValue(compressed, tableFootprint),
        };
      });
      const indexes = structures.filter((item) => String(item.kind || "").startsWith("index:"));
      const projections = structures.filter((item) => String(item.kind || "").startsWith("projection:"));
      renderStorageMetricTable(container, "Indexes", "indexes", indexes, "Index", { structure: true });
      renderStorageMetricTable(container, "Projections", "projections", projections, "Projection", { structure: true });

      const storage = detail.column_storage || {};
      const compactParts = Number(storage.compact_parts || 0);
      if (sectionUnavailable("wide_column_sizes")) {
        container.appendChild(node("div", "explorerFootnote", "Wide per-column storage counters are unavailable on this server; unknown is shown instead of fabricating 0%."));
      } else if (sectionUnavailable("wide_subcolumn_sizes")) {
        container.appendChild(node("div", "explorerFootnote", "Tuple subcolumn names are available, but this server does not expose per-subcolumn Wide byte counters."));
      }
    }

    function metricBars(items, { valueFormatter = (value) => String(value), variant = "default" } = {}) {
      const wrap = node("div", `explorerMetricBars explorerMetricBars--${variant}`);
      const known = items.map((item) => optionalNumber(item.value)).filter((value) => value != null && value >= 0);
      const max = known.length ? Math.max(...known) : 0;
      for (const item of items) {
        const value = optionalNumber(item.value);
        const row = node("div", "explorerMetricBars__row");
        const label = node("div", "explorerMetricBars__label", item.label || "\u2014");
        if (item.title) label.title = item.title;
        const track = node("div", "explorerMetricBars__track");
        if (value == null) {
          track.classList.add("is-unknown");
        } else {
          const fill = node("div", "explorerMetricBars__fill");
          fill.style.width = `${max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0}%`;
          track.appendChild(fill);
        }
        const formatted = value == null ? "unknown" : valueFormatter(value);
        const valueEl = node("code", "explorerMetricBars__value", formatted);
        const meta = item.meta ? node("span", "explorerMetricBars__meta", item.meta) : null;
        row.append(label, track, valueEl);
        if (meta) row.appendChild(meta);
        wrap.appendChild(row);
      }
      return wrap;
    }

    function renderStorage(container, detail) {
      const s = detail.summary || {};
      const meta = node("div", "explorerStorageMetaLine");
      const values = [
        [isLogFamilySummary(s) ? "Storage medium" : "Storage policy", isLogFamilySummary(s) ? "Disk" : (s.storage_policy || "default")],
        ["On disk", summaryFootprintBytes(s) == null ? "unknown" : fmtBytes(summaryFootprintBytes(s))],
        ["Data compressed", s.compressed_bytes == null ? "unknown" : fmtBytes(s.compressed_bytes)],
        ["Data uncompressed", s.uncompressed_bytes == null ? "unknown" : fmtBytes(s.uncompressed_bytes)],
      ];
      for (const [label, value] of values) {
        const cell = node("div", "explorerStorageMetaLine__item");
        cell.append(node("span", "explorerStorageMetaLine__label", label), node("code", "explorerStorageMetaLine__value", value));
        meta.appendChild(cell);
      }
      container.appendChild(meta);

      container.appendChild(node("h3", "explorerSectionTitle", "Disk distribution"));
      const storageRows = detail.storage || [];
      if (!storageRows.length && sectionUnavailable("storage")) {
        container.appendChild(unavailableMessage("Storage metadata"));
      } else if (!storageRows.length) {
        container.appendChild(node("div", "explorerEmptySection", "No local disk-backed storage was resolved."));
      } else {
        container.appendChild(metricBars(storageRows.map((disk) => ({
          label: disk.disk || "unknown disk",
          value: disk.bytes,
          title: disk.path || "",
          meta: [
            disk.rows == null ? null : `${fmtInt(disk.rows)} rows`,
            `${fmtInt(disk.parts)} part${Number(disk.parts) === 1 ? "" : "s"}`,
            disk.free_space == null ? null : `${fmtBytes(disk.free_space)} free`,
            disk.total_space == null ? null : `${fmtBytes(disk.total_space)} capacity`,
          ].filter(Boolean).join(" · "),
        })), { valueFormatter: fmtBytes, variant: "storage" }));
      }
    }

    function renderIngestionCharts(container, detail) {
      const s = detail.summary || {};
      const client = s.client_ingress || {};
      const physical = s.physical_ingress || {};
      const windows = [
        ["1m", "rows_per_second_1m", "bytes_per_second_1m"],
        ["5m", "rows_per_second_5m", "bytes_per_second_5m"],
        ["1h", "rows_per_second_1h", "bytes_per_second_1h"],
      ];
      const grid = node("div", "explorerActivityCharts");
      const rowsCard = node("section", "explorerActivityChart");
      rowsCard.appendChild(node("h4", "explorerActivityChart__title", "Rows / second"));
      rowsCard.appendChild(metricBars(windows.flatMap(([window, rowKey]) => [
        { label: `Client · ${window}`, value: client[rowKey] },
        { label: `Persisted · ${window}`, value: physical[rowKey] },
      ]), { valueFormatter: (value) => `${value.toFixed(value < 10 ? 2 : 1)}`, variant: "ingestion" }));
      const bytesCard = node("section", "explorerActivityChart");
      bytesCard.appendChild(node("h4", "explorerActivityChart__title", "Bytes / second"));
      bytesCard.appendChild(metricBars(windows.flatMap(([window, , bytesKey]) => [
        { label: `Client · ${window}`, value: client[bytesKey] },
        { label: `Persisted · ${window}`, value: physical[bytesKey] },
      ]), { valueFormatter: (value) => fmtBytes(value), variant: "ingestion" }));
      grid.append(rowsCard, bytesCard);
      container.appendChild(grid);
      container.appendChild(node("div", "explorerFootnote", "Client ingress comes from query_log; persisted writes come from part_log. Buffer forwarding and Materialized View output are not folded into client ingress."));
    }

    function renderMergeProgress(container, detail) {
      const merges = detail.merges || [];
      if (!merges.length) {
        container.appendChild(node("div", "explorerEmptySection", sectionUnavailable("merges") ? "Merge metadata unavailable." : "No active merges."));
        return;
      }
      const rows = merges.map((merge) => [
        merge.result_part_name || merge.partition || "merge",
        merge.partition || "\u2014",
        Number(merge.elapsed_seconds || 0),
        Math.max(0, Math.min(100, Number(merge.progress || 0) * 100)),
        Number(merge.num_parts || 0),
        Number(merge.rows_read || 0),
        Number(merge.bytes_read || 0),
        Number(merge.memory_usage || 0),
      ]);
      const table = ns.results?.createStaticResultTable?.({
        columns: ["Result part", "Partition", "Elapsed", "Progress", "Parts", "Rows read", "Bytes read", "Memory"],
        types: ["String", "String", "Float64", "Float64", "UInt64", "UInt64", "UInt64", "UInt64"],
        rows,
        className: "explorerResultTable explorerStorageResultTable explorerStorageResultTable--merges",
        renderCell: (td, ctx) => {
          if (ctx.columnIndex === 2) { td.textContent = util.formatSeconds(Number(ctx.value || 0)); return true; }
          if (ctx.columnIndex === 3) {
            td.classList.add("resultTable__gaugeCell", "resultTable__numeric", "explorerStorageGaugeCell");
            td.style.setProperty("--gaugeFill", `${Math.max(0, Math.min(100, Number(ctx.value || 0)))}%`);
            td.textContent = `${Number(ctx.value || 0).toFixed(2)}%`;
            return true;
          }
          if (ctx.columnIndex === 6 || ctx.columnIndex === 7) { td.textContent = fmtStorageBytes(ctx.value); return true; }
          return false;
        },
      });
      if (!table) throw new Error("Shared result table component is unavailable.");
      container.appendChild(table);
    }

    function renderTopology(container, detail) {
      const s = detail.summary || {};
      const r = s.replication || {};
      container.appendChild(simpleRows([
        ["Engine", s.engine],
        ["Engine definition", s.engine_full],
        ["Replica", r.available ? r.replica_name : "\u2014"],
        ["Active replicas", r.available ? `${r.active_replicas}/${r.total_replicas}` : "\u2014"],
        ["Replication queue", r.available ? fmtInt(r.queue_size) : "\u2014"],
        ["Absolute delay", r.available ? `${fmtInt(r.absolute_delay_seconds)}s` : "\u2014"],
        ["Coordination path", r.available ? r.zookeeper_path : "\u2014"],
      ]));
      const topology = detail.topology || [];
      if (topology.length) {
        container.appendChild(dataTable(
          ["Cluster", "Shard", "Replica", "Host", "Address", "Port", "Local", "Errors", "Slowdowns", "Recovery"],
          topology.map((n) => [
            n.cluster, fmtInt(n.shard_num), fmtInt(n.replica_num), n.host_name || "\u2014", n.host_address || "\u2014",
            fmtInt(n.port), n.is_local ? "yes" : "no", fmtInt(n.errors_count), fmtInt(n.slowdowns_count),
            `${fmtInt(n.estimated_recovery_time)}s`,
          ]),
          "explorerDataTableWrap--wide",
        ));
      } else if (s.engine === "Distributed" && sectionUnavailable("topology")) {
        container.appendChild(unavailableMessage("Distributed cluster topology"));
      }
      const distributionQueue = detail.distribution_queue || [];
      if (s.engine === "Distributed") {
        container.appendChild(node("h3", "explorerSectionTitle", "Distribution queue"));
        if (distributionQueue.length) {
          container.appendChild(dataTable(
            ["Data path", "Blocked", "Errors", "Files", "Compressed", "Broken files", "Broken bytes", "Last error time", "Last exception"],
            distributionQueue.map((q) => [q.data_path || "\u2014", q.blocked ? "yes" : "no", fmtInt(q.error_count), fmtInt(q.data_files), fmtBytes(q.data_compressed_bytes), fmtInt(q.broken_data_files), fmtBytes(q.broken_data_compressed_bytes), q.last_exception_time || "\u2014", q.last_exception || "\u2014"]),
            "explorerDataTableWrap--wide",
          ));
        } else if (sectionUnavailable("distribution_queue")) {
          container.appendChild(unavailableMessage("Distribution queue"));
        } else {
          container.appendChild(node("div", "explorerEmptySection", "Distribution queue is empty."));
        }
      }
      container.appendChild(node("div", "explorerFootnote", topology.length
        ? "Distributed topology is resolved from the cluster named by the engine and system.clusters. Physical per-table bytes remain explicitly scoped instead of being inferred from replica counts."
        : "For replicated local tables the List view shows only topology that can be established from local system metadata; it does not invent a shard mapping."));
    }

    function renderIngestion(container, detail) {
      const s = detail.summary || {};
      const client = s.client_ingress || {};
      const physical = s.physical_ingress || {};
      container.appendChild(simpleRows([
        ["Client ingress · rows/s · 1m", fmtRate(client.rows_per_second_1m, "rows/s")],
        ["Client ingress · rows/s · 5m", fmtRate(client.rows_per_second_5m, "rows/s")],
        ["Client ingress · rows/s · 1h", fmtRate(client.rows_per_second_1h, "rows/s")],
        ["Client ingress · bytes/s · 1m", fmtRate(client.bytes_per_second_1m, "bytes/s")],
        ["Client ingress · total · 1h", client.rows_total_1h == null && client.bytes_total_1h == null ? "\u2014" : `${fmtInt(client.rows_total_1h)} rows · ${fmtBytes(client.bytes_total_1h)}`],
        ["Physical writes · rows/s · 1m", fmtRate(physical.rows_per_second_1m, "rows/s")],
        ["Physical writes · rows/s · 5m", fmtRate(physical.rows_per_second_5m, "rows/s")],
        ["Physical writes · bytes/s · 1m", fmtRate(physical.bytes_per_second_1m, "bytes/s")],
        ["Physical writes · total · 1h", physical.rows_total_1h == null && physical.bytes_total_1h == null ? "\u2014" : `${fmtInt(physical.rows_total_1h)} rows · ${fmtBytes(physical.bytes_total_1h)}`],
        ["New parts / minute", fmtInt(physical.new_parts_per_minute)],
        ["Last client write", client.last_event_time || "\u2014"],
        ["Last physical write", physical.last_event_time || "\u2014"],
      ]));
      container.appendChild(node("div", "explorerFootnote", "Client ingress and physical persisted writes are intentionally separate. MV output and Buffer forwarding are not merged into either label."));
    }

    function renderDependencies(container, detail) {
      const deps = visibleDependencies(detail);
      if (!deps.length) {
        container.appendChild(node("div", "explorerEmptySection", sectionUnavailable("dependencies") ? "Dependency metadata unavailable." : "No visible dependencies."));
        return;
      }

      // Ordinary Views, Materialized Views and tables use the exact same lineage
      // presentation. Always render both directions so the layout does not change
      // shape merely because one object currently has only upstream or downstream
      // relations.
      const matrix = node("div", "explorerDependencyMatrix");
      for (const relation of ["upstream", "downstream"]) {
        const items = deps
          .filter((dep) => String(dep.relation || "").toLowerCase() === relation)
          .slice()
          .sort((a, b) => `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`, undefined, { numeric: true, sensitivity: "base" }));
        const group = node("section", "explorerDependencyGroup");
        group.appendChild(node("h4", "explorerDependencyGroup__title", relation === "upstream" ? "Upstream" : "Downstream"));
        const list = node("div", "explorerDependencyList");
        if (!items.length) {
          list.appendChild(node("div", "explorerDependencyEmpty", "\u2014"));
        } else {
          for (const dep of items) {
            const button = node("button", "explorerDependencyItem");
            button.type = "button";
            const qualified = `${dep.database || "\u2014"}.${dep.table || "\u2014"}`;
            const label = node("code", "explorerDependencyItem__qualified", qualified);
            label.title = `${dep.database || ""}.${dep.table || ""}`;
            button.appendChild(label);
            button.addEventListener("click", () => void selectTable(dep.database, dep.table));
            list.appendChild(button);
          }
        }
        group.appendChild(list);
        matrix.appendChild(group);
      }
      container.appendChild(matrix);
    }

    function renderParts(container, detail) {
      const rows = (detail.parts || []).map((p) => [
        p.name, p.partition, p.disk, Number(p.rows || 0), Number(p.bytes || 0), Number(p.marks || 0), Number(p.files || 0), Number(p.level || 0),
        Number(p.age_seconds || 0), p.active ? "active" : "inactive",
      ]);
      if (!rows.length && sectionUnavailable("parts")) return container.appendChild(unavailableMessage("Parts metadata"));
      if (!rows.length) return container.appendChild(node("div", "explorerEmptySection", "No parts."));
      const table = ns.results?.createStaticResultTable?.({
        columns: ["Part", "Partition", "Disk", "Rows", "Bytes", "Marks", "Files", "Level", "Age", "State"],
        types: ["String", "String", "String", "UInt64", "UInt64", "UInt64", "UInt64", "UInt64", "Float64", "String"],
        rows,
        className: "explorerResultTable explorerStorageResultTable explorerStorageResultTable--parts",
        renderCell: (td, ctx) => {
          if (ctx.columnIndex === 4) { td.textContent = fmtStorageBytes(ctx.value); return true; }
          if (ctx.columnIndex === 8) { td.textContent = util.formatSeconds(Number(ctx.value || 0)); return true; }
          return false;
        },
      });
      if (!table) throw new Error("Shared result table component is unavailable.");
      container.appendChild(table);
    }

    function renderPartitions(container, detail) {
      const rows = (detail.partitions || []).map((p) => [p.partition, Number(p.rows || 0), Number(p.bytes || 0), Number(p.parts || 0)]);
      if (!rows.length && sectionUnavailable("partitions")) return container.appendChild(unavailableMessage("Partition metadata"));
      if (!rows.length) return container.appendChild(node("div", "explorerEmptySection", "No partitions."));
      const table = ns.results?.createStaticResultTable?.({
        columns: ["Partition", "Rows", "Bytes", "Parts"],
        types: ["String", "UInt64", "UInt64", "UInt64"],
        rows,
        className: "explorerResultTable explorerStorageResultTable explorerStorageResultTable--partitions",
        renderCell: (td, ctx) => {
          if (ctx.columnIndex === 2) { td.textContent = fmtStorageBytes(ctx.value); return true; }
          return false;
        },
      });
      if (!table) throw new Error("Shared result table component is unavailable.");
      container.appendChild(table);
    }

    function renderIndexes(container, detail) {
      const rows = (detail.indexes_and_projections || []).map((p) => [p.name, p.kind, p.expression || "\u2014", p.compressed_bytes == null ? "\u2014" : fmtBytes(p.compressed_bytes)]);
      if (!rows.length) container.appendChild(node("div", "explorerEmptySection", "No visible data-skipping indexes or projections were returned."));
      else container.appendChild(dataTable(["Name", "Kind", "Expression", "Compressed"], rows));
    }

    function renderReplication(container, detail) {
      const r = detail.summary?.replication || {};
      if (!r.available) {
        container.appendChild(node("div", "explorerEmptySection", "This object does not expose replicated-table state on the selected server."));
        return;
      }
      container.appendChild(simpleRows([
        ["Replica", r.replica_name || "\u2014"],
        ["Active replicas", `${fmtInt(r.active_replicas)}/${fmtInt(r.total_replicas)}`],
        ["Queue size", fmtInt(r.queue_size)],
        ["Absolute delay", `${fmtInt(r.absolute_delay_seconds)}s`],
        ["Read-only", r.readonly ? "yes" : "no"],
        ["Session expired", r.session_expired ? "yes" : "no"],
        ["Coordination path", r.zookeeper_path || "\u2014"],
      ]));
      const queue = detail.replication_queue || [];
      if (queue.length) {
        container.appendChild(dataTable(
          ["Type", "Created", "Source replica", "Part", "Tries", "Last attempt", "Last exception"],
          queue.map((q) => [q.type, q.create_time, q.source_replica || "\u2014", q.new_part_name || "\u2014", fmtInt(q.num_tries), q.last_attempt_time || "\u2014", q.last_exception || "\u2014"]),
          "explorerDataTableWrap--wide",
        ));
      } else if (sectionUnavailable("replication_queue")) {
        container.appendChild(unavailableMessage("Replication queue"));
      } else {
        container.appendChild(node("div", "explorerEmptySection", "Replication queue is empty."));
      }
    }

    function renderMergesMutations(container, detail) {
      const merges = detail.merges || [];
      const mutations = detail.mutations || [];
      container.appendChild(node("h3", "explorerSectionTitle", "Active merges"));
      if (merges.length) {
        container.appendChild(dataTable(["Partition", "Result part", "Elapsed", "Progress", "Parts", "Rows read", "Bytes read", "Memory"], merges.map((m) => [
          m.partition, m.result_part_name, util.formatSeconds(m.elapsed_seconds), `${(Number(m.progress || 0) * 100).toFixed(1)}%`,
          fmtInt(m.num_parts), fmtInt(m.rows_read), fmtBytes(m.bytes_read), fmtBytes(m.memory_usage),
        ]), "explorerDataTableWrap--wide"));
      } else container.appendChild(node("div", "explorerEmptySection", sectionUnavailable("merges") ? "Merge metadata unavailable." : "No active merges."));

      container.appendChild(node("h3", "explorerSectionTitle", "Mutations"));
      if (mutations.length) {
        container.appendChild(dataTable(["Mutation", "Created", "State", "Parts to do", "Command", "Last failure"], mutations.map((m) => [
          m.mutation_id, m.create_time, m.done ? "done" : "pending", fmtInt(m.parts_to_do), m.command, m.latest_fail_reason || "\u2014",
        ]), "explorerDataTableWrap--wide"));
      } else container.appendChild(node("div", "explorerEmptySection", sectionUnavailable("mutations") ? "Mutation metadata unavailable." : "No mutations."));
    }

    function sectionTitle(text) { return node("h3", "explorerSectionTitle", text); }

    function renderSchema(container, detail) {
      // Kept as a compatibility target for old /schema URLs. The current UI
      // intentionally merges Overview + Schema so CREATE is always visible.
      renderOverview(container, detail);
    }

    function renderLineage(container, detail) {
      const toolbar = node("div", "explorerSectionToolbar");
      const text = node("div", "explorerFootnote", "Only dependencies visible through the runner ACL are exposed.");
      const open = node("button", "button button--small", "Open lineage graph");
      open.type = "button";
      open.addEventListener("click", () => {
        setMode("graph");
        graph?.focusTable?.(detail.summary?.database, detail.summary?.name);
      });
      toolbar.append(text, open);
      container.appendChild(toolbar);
      renderDependencies(container, detail);
    }

    function renderStorageCombined(container, detail) {
      renderStorage(container, detail);

      if (isMergeTreeSummary(detail.summary)) {
        renderColumns(container, detail);
      }

      container.appendChild(sectionTitle("Ingestion activity"));
      renderIngestionCharts(container, detail);

      // Log-family tables are disk-backed but do not own MergeTree parts, merges,
      // mutations or partitions. Stop after their real storage + ingestion
      // surfaces instead of showing empty MergeTree-only sections.
      if (isLogFamilySummary(detail.summary)) return;

      container.appendChild(sectionTitle("Merge activity"));
      renderMergeProgress(container, detail);
      const mutations = detail.mutations || [];
      if (mutations.length) {
        container.appendChild(sectionTitle("Mutations"));
        container.appendChild(dataTable(["Mutation", "Created", "State", "Parts to do", "Command", "Last failure"], mutations.map((m) => [
          m.mutation_id, m.create_time, m.done ? "done" : "pending", fmtInt(m.parts_to_do), m.command, m.latest_fail_reason || "\u2014",
        ]), "explorerDataTableWrap--wide"));
      } else if (sectionUnavailable("mutations")) {
        container.appendChild(unavailableMessage("Mutation metadata"));
      }

      if (detail.summary?.engine === "Distributed" || (detail.topology || []).length) {
        container.appendChild(sectionTitle("Topology"));
        renderTopology(container, detail);
      }
      if (detail.summary?.replication?.available || (detail.replication_queue || []).length) {
        container.appendChild(sectionTitle("Replication"));
        renderReplication(container, detail);
      }
      const hasParts = (detail.parts || []).length || !sectionUnavailable("parts");
      if (hasParts) { container.appendChild(sectionTitle("Parts")); renderParts(container, detail); }
      const hasPartitions = (detail.partitions || []).length || !sectionUnavailable("partitions");
      if (hasPartitions) { container.appendChild(sectionTitle("Partitions")); renderPartitions(container, detail); }
    }

    function renderOperations(container, detail) {
      container.appendChild(sectionTitle("Ingestion activity"));
      renderIngestionCharts(container, detail);
      if (detail.summary?.replication?.available || (detail.replication_queue || []).length) {
        container.appendChild(sectionTitle("Replication"));
        renderReplication(container, detail);
      }
      container.appendChild(sectionTitle("Merge activity"));
      renderMergeProgress(container, detail);
      const mutations = detail.mutations || [];
      if (mutations.length) {
        container.appendChild(sectionTitle("Mutations"));
        container.appendChild(dataTable(["Mutation", "Created", "State", "Parts to do", "Command", "Last failure"], mutations.map((m) => [
          m.mutation_id, m.create_time, m.done ? "done" : "pending", fmtInt(m.parts_to_do), m.command, m.latest_fail_reason || "\u2014",
        ]), "explorerDataTableWrap--wide"));
      }
    }

    async function loadPreview() {
      if (model.previewLoading || model.preview) return;
      const detail = model.detail;
      if (!detail) return;
      const s = detail.summary || {};
      model.previewLoading = true;
      renderTabContent();
      try {
        model.preview = await api.getExplorerTableData(state.selectedHostId, s.database, s.name, 100);
      } catch (e) {
        model.preview = { error: e };
      } finally {
        model.previewLoading = false;
        if (model.tab === "Data") renderTabContent();
      }
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
      return `SELECT ${projection.length ? projection.join(", ") : "*"}\nFROM ${quoteIdent(s.database)}.${quoteIdent(s.name)}\nLIMIT 100`;
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

      let open = false;
      const positionMenu = () => {
        if (!open) return;
        const rect = button.getBoundingClientRect();
        menu.style.position = "fixed";
        menu.style.left = "auto";
        menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
        menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4)}px`;
      };
      const onOutsideClick = (event) => {
        const target = event.target;
        if (target instanceof Node && (root.contains(target) || menu.contains(target))) return;
        close();
      };
      const onEscape = (event) => {
        if (event.key === "Escape") close();
      };
      const close = () => {
        if (!open) return;
        open = false;
        root.classList.remove("themeSelect--open");
        menu.classList.remove("is-open");
        button.setAttribute("aria-expanded", "false");
        document.removeEventListener("click", onOutsideClick);
        document.removeEventListener("keydown", onEscape);
        window.removeEventListener("resize", positionMenu);
        window.removeEventListener("scroll", positionMenu, true);
        menu.hidden = true;
        menu.style.removeProperty("position");
        menu.style.removeProperty("left");
        menu.style.removeProperty("right");
        menu.style.removeProperty("top");
        if (menu.parentNode !== root) root.appendChild(menu);
      };
      const openMenu = () => {
        if (open) return;
        open = true;
        document.body.appendChild(menu);
        menu.hidden = false;
        button.setAttribute("aria-expanded", "true");
        positionMenu();
        requestAnimationFrame(() => {
          if (!open) return;
          root.classList.add("themeSelect--open");
          menu.classList.add("is-open");
        });
        document.addEventListener("click", onOutsideClick);
        document.addEventListener("keydown", onEscape);
        window.addEventListener("resize", positionMenu, { passive: true });
        window.addEventListener("scroll", positionMenu, { passive: true, capture: true });
      };

      option.addEventListener("click", (event) => {
        event.stopPropagation();
        persistFlattenTuple(!(state.runOptFlattenTuple !== false));
        sync();
        close();
        renderTabContent();
      });
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (open) close();
        else openMenu();
      });
      return root;
    }

    function renderData(container, detail) {
      const toolbar = node("div", "explorerDataToolbar");
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
      toolbar.append(actions);
      container.appendChild(toolbar);

      if (model.previewLoading) return container.appendChild(node("div", "explorerEmptySection", "Loading preview\u2026"));
      if (!model.preview) {
        container.appendChild(node("div", "explorerEmptySection", "Preview not loaded."));
        setTimeout(loadPreview, 0);
        return;
      }
      if (model.preview.error) return container.appendChild(node("div", "explorerUnavailable", model.preview.error.message || "Preview failed."));
      const previewColumns = Array.isArray(model.preview.columns) ? model.preview.columns : [];
      const sourceColumns = previewColumns.map((c) => c.name);
      const sourceRows = Array.isArray(model.preview.rows) ? model.preview.rows : [];
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
      const table = ns.results?.createStaticResultTable?.({
        columns: projected.columns,
        types: projected.types,
        rows: projected.rows,
        className: "explorerResultTable explorerResultTable--preview",
        rowDetails: true,
        decorateHeader: (th, ctx) => {
          const sourceIndex = projected.sourceColumnIndexes?.[ctx.columnIndex] ?? ctx.columnIndex;
          if (aggregatePreviewColumn(previewColumns[sourceIndex])) appendFinalizePreviewInfo(th);
        },
      });
      if (!table) throw new Error("Shared result table component is unavailable.");
      container.appendChild(table);
    }

    function renderDdl(container, detail) {
      if (!detail.ddl) return container.appendChild(unavailableMessage("DDL"));
      const ddl = String(detail.formatted_ddl || detail.ddl);
      if (detail.ddl_format_error) container.appendChild(node("div", "explorerFootnote", `Formatter unavailable: ${detail.ddl_format_error}`));

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

    function renderTabContent() {
      const container = dom.explorerDetailContent;
      if (!container) return;
      destroyDatabaseTreemap();
      clear(container);
      const detail = model.detail;
      if (!detail) return;
      if (detail._loading && model.tab !== "Overview") {
        container.appendChild(node("div", "explorerEmptySection", "Loading detailed metadata\u2026"));
        return;
      }

      switch (model.tab) {
        case "Overview": renderOverview(container, detail); break;
        case "Schema": renderSchema(container, detail); break;
        case "Data": renderData(container, detail); break;
        case "Lineage": renderLineage(container, detail); break;
        case "Storage": renderStorageCombined(container, detail); break;
        case "Operations": renderOperations(container, detail); break;
        default: renderOverview(container, detail); break;
      }
    }

    return { renderDetailHeader, renderTabs, renderTabContent };
  }

  ns.explorerDetail = { create };
})();
