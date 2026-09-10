(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const ATTEMPT_COLORS = [
    "#7aa2f7",
    "#bb9af7",
    "#7dcfff",
    "#9ece6a",
    "#e0af68",
    "#f7768e",
    "#73daca",
    "#ff9e64",
  ];

  function durationLabel(us) {
    const value = Math.max(0, Number(us) || 0);
    if (value < 1000) return `${Math.round(value)}µs`;
    const ms = value / 1000;
    if (ms < 10) return `${ms.toFixed(2)}ms`;
    if (ms < 100) return `${ms.toFixed(1)}ms`;
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const seconds = ms / 1000;
    return seconds < 10 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
  }

  function normalizeSpan(raw, index) {
    const start = Number(raw?.start_time_us) || 0;
    const finish = Number(raw?.finish_time_us) || 0;
    const traceId = String(raw?.trace_id || "");
    const spanId = String(raw?.span_id || "");
    if (!spanId || start <= 0 || finish < start) return null;
    return {
      raw,
      index,
      key: `${traceId}\0${spanId}`,
      traceId,
      spanId,
      parentSpanId: String(raw?.parent_span_id || ""),
      operation: String(raw?.operation_name || "span"),
      host: String(raw?.hostname || ""),
      queryId: String(raw?.query_id || ""),
      threadId: String(raw?.thread_id || raw?.thread_number || ""),
      start,
      finish,
      duration: Math.max(0, finish - start),
      depth: 0,
      children: [],
      parent: null,
      descendantCount: 0,
      attempt: 0,
    };
  }

  function stableCompare(a, b) {
    return a.start - b.start || a.finish - b.finish || a.operation.localeCompare(b.operation) || a.spanId.localeCompare(b.spanId);
  }

  function operationFamily(name) {
    return String(name || "")
      .replace(/(?:[_ .-](?:thread|worker|port|stream|lane)?\d+)+$/gi, "")
      .replace(/\d+/g, "#")
      .toLowerCase();
  }

  function buildModel(rawSpans, nativeAttemptIds = []) {
    const spans = (Array.isArray(rawSpans) ? rawSpans : [])
      .map(normalizeSpan)
      .filter(Boolean);
    const byKey = new Map(spans.map((span) => [span.key, span]));
    const byTrace = new Map();
    for (const span of spans) {
      if (!byTrace.has(span.traceId)) byTrace.set(span.traceId, []);
      byTrace.get(span.traceId).push(span);
    }

    const roots = [];
    for (const span of spans) {
      const parentKey = span.parentSpanId && span.parentSpanId !== "0"
        ? `${span.traceId}\0${span.parentSpanId}`
        : "";
      const parent = parentKey ? byKey.get(parentKey) : null;
      if (parent && parent !== span) {
        span.parent = parent;
        parent.children.push(span);
      } else {
        roots.push(span);
      }
    }
    for (const span of spans) span.children.sort(stableCompare);
    roots.sort(stableCompare);

    // Spans occasionally reference a parent outside the retained/truncated set.
    // Walk every disconnected component once so those spans remain visible.
    const orderedRoots = [];
    const seenRoots = new Set();
    for (const root of roots) {
      if (!seenRoots.has(root.key)) {
        orderedRoots.push(root);
        seenRoots.add(root.key);
      }
    }
    for (const span of spans.slice().sort(stableCompare)) {
      if (!span.parent && !seenRoots.has(span.key)) {
        orderedRoots.push(span);
        seenRoots.add(span.key);
      }
    }

    const seen = new Set();
    const setDepthAndCounts = (span, depth) => {
      if (!span || seen.has(span.key)) return 0;
      seen.add(span.key);
      span.depth = depth;
      let descendants = 0;
      for (const child of span.children) descendants += 1 + setDepthAndCounts(child, depth + 1);
      span.descendantCount = descendants;
      return descendants;
    };
    for (const root of orderedRoots) setDepthAndCounts(root, 0);

    const attemptIds = Array.from(new Set((Array.isArray(nativeAttemptIds) ? nativeAttemptIds : []).map(String).filter(Boolean)));
    const attemptIndex = new Map(attemptIds.map((id, index) => [id, index]));
    const traceAttempt = new Map();
    for (const [traceId, traceSpans] of byTrace) {
      const known = traceSpans
        .filter((span) => attemptIndex.has(span.queryId))
        .sort(stableCompare)[0];
      if (known) traceAttempt.set(traceId, attemptIndex.get(known.queryId));
    }
    let nextAttempt = attemptIds.length;
    const unknownQueryAttempts = new Map();
    for (const span of spans) {
      if (attemptIndex.has(span.queryId)) span.attempt = attemptIndex.get(span.queryId);
      else if (traceAttempt.has(span.traceId)) span.attempt = traceAttempt.get(span.traceId);
      else if (span.queryId) {
        if (!unknownQueryAttempts.has(span.queryId)) unknownQueryAttempts.set(span.queryId, nextAttempt++);
        span.attempt = unknownQueryAttempts.get(span.queryId);
      } else span.attempt = 0;
    }

    const allAttemptIds = attemptIds.slice();
    for (const [queryId, index] of unknownQueryAttempts) allAttemptIds[index] = queryId;
    if (!allAttemptIds.length && spans.length) allAttemptIds.push("");

    const start = spans.length ? Math.min(...spans.map((span) => span.start)) : 0;
    const finish = spans.length ? Math.max(...spans.map((span) => span.finish)) : 0;
    return {
      spans,
      roots: orderedRoots,
      start,
      finish,
      window: Math.max(1, finish - start),
      attemptIds: allAttemptIds,
    };
  }

  function shouldCollapseByDefault(span) {
    if (!span || span.depth === 0 || span.children.length < 4) return false;
    const families = new Map();
    for (const child of span.children) {
      const family = operationFamily(child.operation);
      families.set(family, (families.get(family) || 0) + 1);
    }
    const dominant = Math.max(0, ...families.values());
    if (span.children.length >= 8) return true;
    if (span.children.length >= 4 && dominant / span.children.length >= 0.75) return true;
    return span.depth >= 3 && span.descendantCount >= 20;
  }

  function branchKeys(model) {
    return model.spans.filter((span) => span.children.length).map((span) => span.key);
  }

  function visibleRows(model, collapsed) {
    const rows = [];
    const seen = new Set();
    const visit = (span) => {
      if (!span || seen.has(span.key)) return;
      seen.add(span.key);
      rows.push(span);
      if (collapsed.has(span.key)) return;
      for (const child of span.children) visit(child);
    };
    for (const root of model.roots) visit(root);
    for (const span of model.spans.slice().sort(stableCompare)) visit(span);
    return rows;
  }

  function addTicks(parent, windowUs, withLabels) {
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      const tick = document.createElement("span");
      tick.className = "traceViewer__tick";
      tick.style.left = `${ratio * 100}%`;
      if (withLabels) {
        const label = document.createElement("b");
        label.textContent = durationLabel(windowUs * ratio);
        tick.appendChild(label);
      }
      parent.appendChild(tick);
    }
  }

  function render(container, options = {}) {
    if (!container) return null;
    const model = buildModel(options.spans, options.attemptIds);
    const collapsed = new Set();
    for (const span of model.spans) if (shouldCollapseByDefault(span)) collapsed.add(span.key);
    const maxRows = Math.max(100, Math.min(10000, Number(options.maxRows) || 3000));
    let columnWidthPx = null;
    const rowByKey = new Map();
    const toggleByKey = new Map();
    const foldedByKey = new Map();
    const mounted = visibleRows(model, new Set()).slice(0, maxRows);

    const rowHidden = (span) => {
      let parent = span?.parent || null;
      while (parent) {
        if (collapsed.has(parent.key)) return true;
        parent = parent.parent;
      }
      return false;
    };

    const syncBranchUi = (span) => {
      const toggle = toggleByKey.get(span.key);
      if (toggle) {
        const closed = collapsed.has(span.key);
        toggle.setAttribute("aria-expanded", String(!closed));
        toggle.setAttribute("aria-label", closed ? "Expand children" : "Collapse children");
        toggle.textContent = closed ? "›" : "⌄";
      }
      const folded = foldedByKey.get(span.key);
      if (folded) folded.hidden = !(collapsed.has(span.key) && span.descendantCount);
    };

    const syncSubtree = (span) => {
      syncBranchUi(span);
      for (const child of span.children) {
        const row = rowByKey.get(child.key);
        if (row) row.hidden = rowHidden(child);
        syncSubtree(child);
      }
    };

    const syncAll = () => {
      for (const span of mounted) {
        const row = rowByKey.get(span.key);
        if (row) row.hidden = rowHidden(span);
        syncBranchUi(span);
      }
    };

    const controller = {
      model,
      collapsed,
      expandAll() { collapsed.clear(); syncAll(); },
      collapseAll() {
        for (const key of branchKeys(model)) collapsed.add(key);
        syncAll();
      },
      destroy() { container.replaceChildren(); },
    };

    container.replaceChildren();
    container.classList.add("traceViewerHost");
    if (!model.spans.length) {
      const empty = document.createElement("div");
      empty.className = "traceViewer__empty";
      empty.textContent = options.emptyText || "No trace spans are available.";
      container.appendChild(empty);
      return controller;
    }

    const shell = document.createElement("section");
    shell.className = "traceViewer";

    if (options.truncated) {
      const notice = document.createElement("div");
      notice.className = "traceViewer__notice";
      notice.textContent = "Trace truncated at the configured span limit.";
      shell.appendChild(notice);
    }

    if (model.attemptIds.length > 1) {
      const legend = document.createElement("div");
      legend.className = "traceViewer__attempts";
      model.attemptIds.forEach((id, index) => {
        const item = document.createElement("span");
        item.className = "traceViewer__attempt";
        item.style.setProperty("--trace-attempt-color", ATTEMPT_COLORS[index % ATTEMPT_COLORS.length]);
        const swatch = document.createElement("i");
        const text = document.createElement("span");
        text.textContent = `Attempt ${index + 1}`;
        if (id) item.title = id;
        item.append(swatch, text);
        legend.appendChild(item);
      });
      shell.appendChild(legend);
    }

    const table = document.createElement("div");
    table.className = "traceViewer__table";
    const head = document.createElement("div");
    head.className = "traceViewer__head";
    const nameHead = document.createElement("div");
    nameHead.className = "traceViewer__nameHead";
    nameHead.textContent = "Operation";
    const columnResize = document.createElement("div");
    columnResize.className = "traceViewer__columnResize";
    columnResize.setAttribute("role", "separator");
    columnResize.setAttribute("aria-orientation", "vertical");
    columnResize.setAttribute("aria-label", "Resize operation column");
    columnResize.tabIndex = 0;
    nameHead.appendChild(columnResize);
    const timelineHead = document.createElement("div");
    timelineHead.className = "traceViewer__timeline traceViewer__timeline--head";
    addTicks(timelineHead, model.window, true);
    head.append(nameHead, timelineHead);

    const scroll = document.createElement("div");
    scroll.className = "traceViewer__scroll";
    scroll.appendChild(head);

    if (columnWidthPx != null) shell.style.setProperty("--trace-name-column", `${columnWidthPx}px`);
    const setColumnWidth = (next) => {
      const tableRect = table.getBoundingClientRect();
      const min = Math.min(220, Math.max(150, tableRect.width * 0.22));
      const max = Math.max(min, tableRect.width - Math.max(180, tableRect.width * 0.22));
      columnWidthPx = Math.round(Math.max(min, Math.min(max, next)));
      shell.style.setProperty("--trace-name-column", `${columnWidthPx}px`);
      columnResize.setAttribute("aria-valuenow", String(columnWidthPx));
    };
    const widthFromPointer = (clientX) => {
      const rect = head.getBoundingClientRect();
      return clientX - rect.left;
    };
    columnResize.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      columnResize.setPointerCapture?.(event.pointerId);
      columnResize.classList.add("is-dragging");
      setColumnWidth(widthFromPointer(event.clientX));
    });
    columnResize.addEventListener("pointermove", (event) => {
      if (!columnResize.hasPointerCapture?.(event.pointerId)) return;
      setColumnWidth(widthFromPointer(event.clientX));
    });
    const endResize = (event) => {
      if (columnResize.hasPointerCapture?.(event.pointerId)) columnResize.releasePointerCapture?.(event.pointerId);
      columnResize.classList.remove("is-dragging");
    };
    columnResize.addEventListener("pointerup", endResize);
    columnResize.addEventListener("pointercancel", endResize);
    columnResize.addEventListener("dblclick", () => {
      columnWidthPx = null;
      shell.style.removeProperty("--trace-name-column");
      columnResize.removeAttribute("aria-valuenow");
    });
    columnResize.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const current = columnWidthPx ?? nameHead.getBoundingClientRect().width;
      setColumnWidth(current + (event.key === "ArrowRight" ? 16 : -16));
    });

    const body = document.createElement("div");
    body.className = "traceViewer__body";
    const fragment = document.createDocumentFragment();
    for (const span of mounted) {
      const row = document.createElement("div");
      row.className = "traceViewer__row";
      row.dataset.spanId = span.spanId;
      row.dataset.traceId = span.traceId;
      row.style.setProperty("--trace-attempt-color", ATTEMPT_COLORS[span.attempt % ATTEMPT_COLORS.length]);
      row.hidden = rowHidden(span);
      rowByKey.set(span.key, row);

      const identity = document.createElement("div");
      identity.className = "traceViewer__identity";
      const guides = document.createElement("span");
      guides.className = "traceViewer__guides";
      guides.style.width = `${Math.min(220, span.depth * 12)}px`;
      identity.appendChild(guides);

      if (span.children.length) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "traceViewer__toggle";
        toggleByKey.set(span.key, toggle);
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          if (collapsed.has(span.key)) collapsed.delete(span.key);
          else collapsed.add(span.key);
          syncBranchUi(span);
          for (const child of span.children) {
            const childRow = rowByKey.get(child.key);
            if (childRow) childRow.hidden = rowHidden(child);
            syncSubtree(child);
          }
        });
        identity.appendChild(toggle);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "traceViewer__toggle traceViewer__toggle--blank";
        identity.appendChild(spacer);
      }

      const name = document.createElement("div");
      name.className = "traceViewer__name";
      const service = document.createElement("span");
      service.className = "traceViewer__serviceMarker";
      service.title = span.host || "ClickHouse";
      service.setAttribute("aria-label", `Service ${span.host || "ClickHouse"}`);
      const operation = document.createElement("span");
      operation.className = "traceViewer__operation";
      operation.textContent = span.operation;
      name.append(service, operation);
      if (span.children.length && span.descendantCount) {
        const folded = document.createElement("span");
        folded.className = "traceViewer__foldedCount";
        folded.textContent = `+${span.descendantCount}`;
        foldedByKey.set(span.key, folded);
        name.appendChild(folded);
      }
      identity.appendChild(name);

      const timeline = document.createElement("div");
      timeline.className = "traceViewer__timeline";
      const bar = document.createElement("span");
      bar.className = "traceViewer__bar";
      const left = Math.max(0, Math.min(100, (span.start - model.start) / model.window * 100));
      const width = Math.max(0.12, Math.min(100 - left, span.duration / model.window * 100));
      bar.style.left = `${left}%`;
      bar.style.width = `${width}%`;
      bar.title = `${span.operation} · ${durationLabel(span.duration)} · +${durationLabel(span.start - model.start)}`;
      const label = document.createElement("span");
      label.className = `traceViewer__barLabel${left >= 50 ? " is-before" : " is-after"}`;
      label.textContent = durationLabel(span.duration);
      bar.appendChild(label);
      timeline.appendChild(bar);
      row.append(identity, timeline);
      fragment.appendChild(row);
    }
    body.appendChild(fragment);
    scroll.appendChild(body);
    table.appendChild(scroll);
    shell.appendChild(table);

    if (model.spans.length > maxRows) {
      const limit = document.createElement("div");
      limit.className = "traceViewer__rowLimit";
      limit.textContent = `Showing the first ${maxRows.toLocaleString()} spans of ${model.spans.length.toLocaleString()}.`;
      shell.appendChild(limit);
    }

    container.appendChild(shell);
    syncAll();
    return controller;
  }

  ns.traceViewer = { render, durationLabel, buildModel };
})();
