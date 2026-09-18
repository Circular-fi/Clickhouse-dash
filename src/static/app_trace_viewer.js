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

  function normalizeOperationName(value) {
    return String(value || "span").replace(/(?:_\d+)+$/g, "") || String(value || "span");
  }

  function normalizeSpan(raw, index) {
    const traceId = String(raw?.trace_id || "");
    const spanId = String(raw?.span_id || "");
    const rawSegments = Array.isArray(raw?.segments) && raw.segments.length
      ? raw.segments
      : [{ start_time_us: raw?.start_time_us, finish_time_us: raw?.finish_time_us }];
    const segments = rawSegments
      .map((segment) => {
        const start = Number(segment?.start_time_us) || 0;
        const finish = Number(segment?.finish_time_us) || 0;
        return { start, finish, duration: Math.max(0, finish - start) };
      })
      .filter((segment) => segment.start > 0 && segment.finish >= segment.start);
    if (!spanId || !segments.length) return null;
    const start = Math.min(...segments.map((segment) => segment.start));
    const finish = Math.max(...segments.map((segment) => segment.finish));
    const duration = segments.reduce((sum, segment) => sum + segment.duration, 0);
    const rawOperation = String(raw?.operation_name || "span");
    return {
      raw,
      index,
      key: `${traceId}\0${spanId}`,
      traceId,
      spanId,
      parentSpanId: String(raw?.parent_span_id || ""),
      operation: normalizeOperationName(rawOperation),
      rawOperation,
      host: String(raw?.hostname || ""),
      start,
      finish,
      duration,
      segments,
      compactLeafGroup: raw?.compact_leaf_group === true,
      mergedCount: 1,
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

  function mergeIntervals(segments) {
    const sorted = segments.map((segment) => ({
      start: Number(segment.start) || 0,
      finish: Number(segment.finish) || 0,
    })).filter((segment) => segment.start > 0 && segment.finish >= segment.start)
      .sort((a, b) => a.start - b.start || a.finish - b.finish);
    const merged = [];
    for (const segment of sorted) {
      const last = merged[merged.length - 1];
      if (last && segment.start <= last.finish) last.finish = Math.max(last.finish, segment.finish);
      else merged.push({ ...segment });
    }
    return merged.map((segment) => ({
      ...segment,
      duration: Math.max(0, segment.finish - segment.start),
    }));
  }

  function mergeSiblingInstances(children, parent = null) {
    const groups = new Map();
    for (const child of children.slice().sort(stableCompare)) {
      child.operation = normalizeOperationName(child.operation);
      const key = `${child.traceId}\0${child.operation}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(child);
    }

    const result = [];
    for (const siblings of groups.values()) {
      const first = siblings[0];
      let node = first;
      if (siblings.length > 1) {
        const segments = mergeIntervals(siblings.flatMap((span) => span.segments));
        const mergedChildren = siblings.flatMap((span) => span.children);
        const hosts = new Set(siblings.map((span) => span.host).filter(Boolean));
        node = {
          ...first,
          key: `${first.traceId}\0__merged__\0${parent?.key || "root"}\0${first.operation}`,
          spanId: `__merged_${first.index}`,
          parentSpanId: parent?.spanId || "",
          host: hosts.size === 1 ? hosts.values().next().value : "",
          start: Math.min(...segments.map((segment) => segment.start)),
          finish: Math.max(...segments.map((segment) => segment.finish)),
          duration: segments.reduce((sum, segment) => sum + segment.duration, 0),
          segments,
          compactLeafGroup: mergedChildren.length === 0,
          mergedCount: siblings.reduce((sum, span) => sum + (Number(span.mergedCount) || 1), 0),
          children: [],
          parent,
        };
        node.children = mergeSiblingInstances(mergedChildren, node);
      } else {
        node.parent = parent;
        node.children = mergeSiblingInstances(node.children, node);
      }
      result.push(node);
    }
    return result.sort(stableCompare);
  }

  function operationFamily(name) {
    return normalizeOperationName(name)
      .replace(/(?:[_ .-](?:thread|worker|port|stream|lane)?\d+)+$/gi, "")
      .replace(/\d+/g, "#")
      .toLowerCase();
  }

  function buildModel(rawSpans, nativeAttemptIds = []) {
    const sourceSpans = (Array.isArray(rawSpans) ? rawSpans : [])
      .map(normalizeSpan)
      .filter(Boolean);
    const byKey = new Map(sourceSpans.map((span) => [span.key, span]));

    const roots = [];
    for (const span of sourceSpans) {
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
    for (const span of sourceSpans) span.children.sort(stableCompare);
    roots.sort(stableCompare);

    // Spans occasionally reference a parent outside the retained/truncated set.
    // Keep every disconnected component, then merge sibling instance suffixes
    // recursively so Foo_0/Foo_1 under the same logical parent become one Foo.
    const orderedRoots = [];
    const seenRoots = new Set();
    for (const root of roots) {
      if (!seenRoots.has(root.key)) {
        orderedRoots.push(root);
        seenRoots.add(root.key);
      }
    }
    for (const span of sourceSpans.slice().sort(stableCompare)) {
      if (!span.parent && !seenRoots.has(span.key)) {
        orderedRoots.push(span);
        seenRoots.add(span.key);
      }
    }

    const mergedRoots = mergeSiblingInstances(orderedRoots, null);
    const spans = [];
    const collect = (span) => {
      spans.push(span);
      for (const child of span.children) collect(child);
    };
    for (const root of mergedRoots) collect(root);

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
    for (const root of mergedRoots) setDepthAndCounts(root, 0);

    const byTrace = new Map();
    for (const span of spans) {
      if (!byTrace.has(span.traceId)) byTrace.set(span.traceId, []);
      byTrace.get(span.traceId).push(span);
    }

    const attemptIds = Array.from(new Set((Array.isArray(nativeAttemptIds) ? nativeAttemptIds : []).map(String).filter(Boolean)));
    // Compact trace transport deliberately omits query/thread attributes. Map
    // attempts by trace order instead: one ClickHouse attempt normally owns one
    // trace, and this keeps coloring stable without bloating every span row.
    const orderedTraceIds = Array.from(byTrace.entries())
      .sort((a, b) => {
        const aa = Math.min(...a[1].map((span) => span.start));
        const bb = Math.min(...b[1].map((span) => span.start));
        return aa - bb || a[0].localeCompare(b[0]);
      })
      .map(([traceId]) => traceId);
    const traceAttempt = new Map(orderedTraceIds.map((traceId, index) => [traceId, index]));
    for (const span of spans) span.attempt = traceAttempt.get(span.traceId) || 0;

    const allAttemptIds = attemptIds.slice();
    while (allAttemptIds.length < orderedTraceIds.length) allAttemptIds.push("");
    if (!allAttemptIds.length && spans.length) allAttemptIds.push("");

    const start = spans.length ? Math.min(...spans.map((span) => span.start)) : 0;
    const finish = spans.length ? Math.max(...spans.map((span) => span.finish)) : 0;
    return {
      spans,
      roots: mergedRoots,
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
    // buildModel already promotes every genuinely disconnected component to a
    // root. Do not revisit descendants that were intentionally hidden by a
    // collapsed ancestor, otherwise every folded child is incorrectly counted
    // as a standalone visible row.
    for (const root of model.roots) visit(root);
    return rows;
  }

  const INITIAL_VISIBLE_SPAN_LIMIT = 50;

  function initialCollapsedForSpanLimit(model, limit = INITIAL_VISIBLE_SPAN_LIMIT) {
    const maxVisible = Math.max(1, Number(limit) || INITIAL_VISIBLE_SPAN_LIMIT);
    const collapsed = new Set(branchKeys(model));
    const maxDepth = Math.max(0, ...model.spans.map((span) => Number(span.depth) || 0));

    // Commit complete breadth levels only. This is calculated before any DOM
    // rows are mounted so the first paint already reflects the intended open
    // depths instead of briefly rendering everything folded.
    for (let depth = 0; depth <= maxDepth; depth += 1) {
      const candidates = model.spans
        .filter((span) => span.children.length && span.depth === depth)
        .filter((span) => {
          let parent = span.parent;
          while (parent) {
            if (collapsed.has(parent.key)) return false;
            parent = parent.parent;
          }
          return true;
        })
        .slice()
        .sort(stableCompare);
      if (!candidates.length) continue;

      const beforeDepth = new Set(collapsed);
      for (const span of candidates) collapsed.delete(span.key);
      if (visibleRows(model, collapsed).length <= maxVisible) continue;
      collapsed.clear();
      for (const key of beforeDepth) collapsed.add(key);
      break;
    }
    return collapsed;
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
    // Compute the initial fold state before rendering. Complete depths are
    // opened breadth-first while the visible span count remains <= 50.
    const collapsed = initialCollapsedForSpanLimit(model);
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
      destroy() {
        container.replaceChildren();
      },
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
      notice.textContent = options.processorSummaryOverlay
        ? `Detailed calls exceed the span limit. Structure is preserved and processor activity is filled from the full time-bucketed OTel summary${Number(options.processorSummaryBucketUs) > 0 ? ` (${durationLabel(options.processorSummaryBucketUs)} buckets)` : ""}.`
        : "Trace truncated at the configured span limit; shallower depths are preserved first.";
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
      if (span.mergedCount > 1) {
        operation.title = `${span.mergedCount.toLocaleString()} sibling spans merged after removing trailing _<number> instance suffixes.`;
      }
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
      const renderSegments = Array.isArray(span.segments) && span.segments.length
        ? span.segments
        : [{ start: span.start, finish: span.finish, duration: span.duration }];
      const spanOffset = span.start - model.start;
      const spanWidth = span.duration / model.window;
      if (renderSegments.length > 96) {
        // Dense compact leaf rows stay a single DOM element even when they
        // contain thousands of disjoint time intervals.
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "traceViewer__segmentSvg");
        svg.setAttribute("viewBox", "0 0 1000 20");
        svg.setAttribute("preserveAspectRatio", "none");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("class", "traceViewer__segmentPath");
        const minWidthPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        minWidthPath.setAttribute("class", "traceViewer__segmentMinWidth");
        minWidthPath.setAttribute("vector-effect", "non-scaling-stroke");
        const commands = [];
        const minWidthCommands = [];
        for (const segment of renderSegments) {
          const x1 = Math.max(0, Math.min(1000, (segment.start - model.start) / model.window * 1000));
          const x2 = Math.max(x1, Math.min(1000, (segment.finish - model.start) / model.window * 1000));
          commands.push(`M${x1.toFixed(2)} 6H${x2.toFixed(2)}V14H${x1.toFixed(2)}Z`);
          // The filled interval can become sub-pixel after the 4K LOD timeline is
          // projected into a narrower viewport. Keep one non-scaling 1px marker
          // at its start so every event remains visible on the actual screen.
          minWidthCommands.push(`M${x1.toFixed(2)} 6V14`);
        }
        path.setAttribute("d", commands.join(""));
        minWidthPath.setAttribute("d", minWidthCommands.join(""));
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = `${span.operation} · ${renderSegments.length.toLocaleString()} intervals · ${durationLabel(span.duration)} total · +${durationLabel(spanOffset)} · ${(spanWidth * 100).toFixed(2)}% window`;
        svg.append(title, path, minWidthPath);
        timeline.appendChild(svg);
      } else {
        for (const segment of renderSegments) {
          const bar = document.createElement("span");
          bar.className = "traceViewer__bar";
          const left = Math.max(0, Math.min(100, (segment.start - model.start) / model.window * 100));
          const width = Math.max(0.12, Math.min(100 - left, segment.duration / model.window * 100));
          bar.style.left = `${left}%`;
          bar.style.width = `${width}%`;
          bar.title = `${span.operation} · ${durationLabel(segment.duration)} · +${durationLabel(segment.start - model.start)}`;
          if (renderSegments.length === 1) {
            const label = document.createElement("span");
            label.className = `traceViewer__barLabel${left >= 50 ? " is-before" : " is-after"}`;
            label.textContent = durationLabel(segment.duration);
            bar.appendChild(label);
          }
          timeline.appendChild(bar);
        }
      }
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

  ns.traceViewer = { render, durationLabel, buildModel, initialCollapsedForSpanLimit };
})();
