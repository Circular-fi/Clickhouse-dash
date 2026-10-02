(() => {
  "use strict";

  // Storage treemap shared by the Explorer database detail and the System
  // section. The grouping rules and the squarified layout are a port of the
  // S3-Browser folder treemap so both products read the same way:
  //
  // - one absolute threshold (ceil(1%) of the displayed root) is applied at
  //   every level; smaller siblings are merged into one "Others" node;
  // - a folder level with a single real child is contracted into that child;
  // - a sole "Others" child is dropped because the parent already carries the
  //   exact totals;
  // - "Others" is drawn as a proportional bottom strip that is only grown to
  //   the minimum height needed for its label.
  //
  // ChDash node kinds: "server" (root), "database" (folder), "table" and
  // "partition" (leaves) and "other" (grouped siblings). Grouping runs in the browser because the
  // visible scope (system databases on/off, databases vs databases + tables)
  // is a view option, and the same rules must also apply to the per-database
  // catalog that is already loaded for the sidebar.

  const ns = window.ChDash;
  if (!ns) return;

  const treemapMaximumRectangles = 1000;
  const treemapMaximumDepth = 5;
  const treemapGapPixels = 2;
  const treemapOtherInlineMinimumHeightPixels = 26;
  const treemapOtherStackedMinimumHeightPixels = 34;
  const treemapOtherInlineMinimumWidthPixels = 180;
  const treemapMinimumRegularPixels = 30;
  const treemapFolderHeaderPixels = 26;
  const treemapBranchInsetPixels = 2;

  // util.escapeHtml is the one escaper (null prints as ""); counts and shares
  // come from ns.format, colours from ns.palette (docs/ui-foundations.md).
  const { format, palette } = ns;
  const esc = (value) => ns.util.escapeHtml(value ?? "");

  function nodeBytes(node) {
    const value = Number(node?.bytes || 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function isFolderKind(kind) {
    return kind === "server" || kind === "database";
  }

  function treemapThreshold(totalBytes) {
    const total = Math.max(0, Math.floor(Number(totalBytes || 0)));
    if (!(total > 0)) return 0;
    // Ceiling division keeps objects that are exactly one percent visible and
    // matches the integer threshold used by the S3-Browser backend.
    return Math.floor((total + 99) / 100);
  }

  function compareNodes(left, right) {
    return nodeBytes(right) - nodeBytes(left) || String(left.name || "").localeCompare(String(right.name || ""));
  }

  function materializeTreemap(node, threshold) {
    const result = { ...node };
    delete result.children;
    if (!isFolderKind(node?.kind)) return result;

    const children = (Array.isArray(node.children) ? node.children : [])
      .filter((child) => child && nodeBytes(child) > 0)
      .sort(compareNodes);

    let listedBytes = 0;
    let listedCount = 0;
    for (const child of children) {
      listedBytes += nodeBytes(child);
      listedCount += Math.max(0, Number(child.count || 0));
    }
    // Parent aggregates are exact. Anything they contain beyond the listed
    // children (for example tables bounded out by the backend) belongs to
    // Others rather than silently disappearing from the area.
    let otherBytes = Math.max(0, nodeBytes(result) - listedBytes);
    let otherCount = Math.max(0, Number(result.count || 0) - listedCount);
    let otherMembers = otherCount;
    let otherMemberKind = "table";
    const visible = [];
    for (const child of children) {
      if (threshold === 0 || nodeBytes(child) >= threshold) {
        visible.push(materializeTreemap(child, threshold));
        continue;
      }
      otherBytes += nodeBytes(child);
      otherCount += Math.max(0, Number(child.count || 0));
      otherMembers += 1;
      otherMemberKind = child.kind === "database" ? "database" : "table";
    }
    if (otherBytes > 0 || otherCount > 0) {
      visible.push({
        name: "Others",
        path: result.path || "",
        parentName: result.name || "",
        bytes: otherBytes,
        count: otherCount,
        members: otherMembers,
        memberKind: otherMemberKind,
        kind: "other",
      });
    }
    visible.sort(compareNodes);

    // Contract every folder chain that does not introduce a real branch so a
    // lone database never renders as a redundant wrapper around its tables.
    while (visible.length === 1) {
      const only = visible[0];
      if (isFolderKind(only.kind) && Array.isArray(only.children) && only.children.length > 0) {
        visible.splice(0, 1, ...only.children);
        continue;
      }
      if (only.kind !== "other") {
        // Preserve the only meaningful object and its click target instead of
        // replacing it with an otherwise uninformative root rectangle.
        const identity = { ...only };
        delete identity.children;
        return { ...identity, bytes: result.bytes, count: result.count };
      }
      // A sole Others node adds no information: the parent already carries
      // the exact byte and object totals.
      visible.length = 0;
    }
    result.children = visible;
    return result;
  }

  function buildTreemap(root) {
    const threshold = treemapThreshold(nodeBytes(root));
    return { threshold, tree: materializeTreemap(root, threshold) };
  }

  function treemapChildren(node) {
    return Array.isArray(node?.children)
      ? node.children.filter((child) => nodeBytes(child) > 0)
      : [];
  }

  function treemapRootNodes(tree) {
    const children = treemapChildren(tree);
    if (children.length) return children;
    return tree && nodeBytes(tree) > 0 ? [tree] : [];
  }

  function treemapOtherReadableHeight(width) {
    return width >= treemapOtherInlineMinimumWidthPixels
      ? treemapOtherInlineMinimumHeightPixels
      : treemapOtherStackedMinimumHeightPixels;
  }

  function treemapWorstAspectRatio(row, side) {
    if (!row.length || !(side > 0)) return Number.POSITIVE_INFINITY;
    const areas = row.map((item) => Math.max(0, Number(item.area || 0))).filter((area) => area > 0);
    if (!areas.length) return Number.POSITIVE_INFINITY;
    const sum = areas.reduce((total, area) => total + area, 0);
    const maximum = Math.max(...areas);
    const minimum = Math.min(...areas);
    const sideSquared = side * side;
    const sumSquared = sum * sum;
    return Math.max(
      sideSquared * maximum / Math.max(Number.EPSILON, sumSquared),
      sumSquared / Math.max(Number.EPSILON, sideSquared * minimum),
    );
  }

  function layoutTreemapRow(row, bounds) {
    const rectangles = [];
    const totalArea = row.reduce((sum, item) => sum + Math.max(0, Number(item.area || 0)), 0);
    if (!(totalArea > 0) || !(bounds.width > 0) || !(bounds.height > 0)) return { rectangles, remaining: bounds };

    if (bounds.width >= bounds.height) {
      const rowWidth = Math.min(bounds.width, totalArea / bounds.height);
      let cursorY = bounds.y;
      row.forEach((item, index) => {
        const itemHeight = index === row.length - 1
          ? Math.max(0, bounds.y + bounds.height - cursorY)
          : Math.max(0, item.area / Math.max(Number.EPSILON, rowWidth));
        rectangles.push({ node: item.node, x: bounds.x, y: cursorY, width: rowWidth, height: itemHeight });
        cursorY += itemHeight;
      });
      return {
        rectangles,
        remaining: { x: bounds.x + rowWidth, y: bounds.y, width: Math.max(0, bounds.width - rowWidth), height: bounds.height },
      };
    }

    const rowHeight = Math.min(bounds.height, totalArea / bounds.width);
    let cursorX = bounds.x;
    row.forEach((item, index) => {
      const itemWidth = index === row.length - 1
        ? Math.max(0, bounds.x + bounds.width - cursorX)
        : Math.max(0, item.area / Math.max(Number.EPSILON, rowHeight));
      rectangles.push({ node: item.node, x: cursorX, y: bounds.y, width: itemWidth, height: rowHeight });
      cursorX += itemWidth;
    });
    return {
      rectangles,
      remaining: { x: bounds.x, y: bounds.y + rowHeight, width: bounds.width, height: Math.max(0, bounds.height - rowHeight) },
    };
  }

  function squarifyTreemapNodes(nodes, x, y, width, height) {
    const visible = Array.from(nodes || []).filter((node) => nodeBytes(node) > 0).sort(compareNodes);
    const totalBytes = visible.reduce((sum, node) => sum + nodeBytes(node), 0);
    const totalArea = Math.max(0, width) * Math.max(0, height);
    if (!visible.length || !(totalBytes > 0) || !(totalArea > 0)) return [];

    const remainingItems = visible.map((node) => ({ node, area: nodeBytes(node) / totalBytes * totalArea }));
    let bounds = { x, y, width, height };
    let row = [];
    const rectangles = [];

    while (remainingItems.length && bounds.width > 0 && bounds.height > 0) {
      const candidate = remainingItems[0];
      const side = Math.min(bounds.width, bounds.height);
      if (!row.length || treemapWorstAspectRatio([...row, candidate], side) <= treemapWorstAspectRatio(row, side)) {
        row.push(remainingItems.shift());
        continue;
      }
      const result = layoutTreemapRow(row, bounds);
      rectangles.push(...result.rectangles);
      bounds = result.remaining;
      row = [];
    }
    if (row.length && bounds.width > 0 && bounds.height > 0) {
      rectangles.push(...layoutTreemapRow(row, bounds).rectangles);
    }
    return rectangles;
  }

  function layoutTreemapNodes(nodes, x, y, width, height) {
    const visible = Array.from(nodes || []).filter((node) => nodeBytes(node) > 0);
    if (!visible.length || !(width > 0) || !(height > 0)) return [];

    const otherNodes = visible.filter((node) => String(node?.kind || "") === "other");
    const regularNodes = visible.filter((node) => String(node?.kind || "") !== "other");
    if (!otherNodes.length || !regularNodes.length) return squarifyTreemapNodes(visible, x, y, width, height);

    const totalBytes = visible.reduce((sum, node) => sum + nodeBytes(node), 0);
    const otherBytes = otherNodes.reduce((sum, node) => sum + nodeBytes(node), 0);
    const share = otherBytes / Math.max(Number.EPSILON, totalBytes);
    const rectangles = [];

    // Others stays proportional to its exact byte share. It only receives the
    // smallest horizontal strip required to keep its label readable. The
    // minimum is always clamped below the room reserved for regular nodes, so
    // a tiny aggregate can never consume most of its parent rectangle.
    const naturalHeight = height * share;
    const maximumHeight = Math.max(0, height - Math.min(treemapMinimumRegularPixels, height));
    if (!(maximumHeight > 0)) return squarifyTreemapNodes(visible, x, y, width, height);
    const readableMinimum = Math.min(treemapOtherReadableHeight(width), maximumHeight);
    const stripHeight = Math.min(maximumHeight, Math.max(naturalHeight, readableMinimum));
    const regularHeight = Math.max(0, height - stripHeight);
    rectangles.push(...squarifyTreemapNodes(regularNodes, x, y, width, regularHeight));
    rectangles.push(...squarifyTreemapNodes(otherNodes, x, y + regularHeight, width, stripHeight));
    return rectangles;
  }

  // Engine families, not individual tables, carry the colour: the treemap then
  // also answers "where do MergeTree / aggregated / log tables live". Every
  // leaf is a table, so the families take categorical series slots (themed
  // --qchart-N tokens) rather than the object-kind colours.
  const ENGINE_FAMILIES = [
    { key: "aggregated", label: "Aggregating / Summing", slot: 6, test: (engine) => /aggregating|summing/.test(engine) },
    { key: "dedup", label: "Replacing / Collapsing", slot: 3, test: (engine) => /replacing|collapsing|coalescing/.test(engine) },
    { key: "mergetree", label: "MergeTree", slot: 0, test: (engine) => engine.includes("mergetree") },
    { key: "log", label: "Log family", slot: 2, test: (engine) => ["tinylog", "stripelog", "log"].includes(engine) },
  ];
  const OTHER_ENGINE_FAMILY = { key: "other-engine", label: "Other engines", slot: -1 };

  function hashName(value) {
    const normalized = String(value || "").trim().toLowerCase();
    let hash = 0;
    for (let index = 0; index < normalized.length; index += 1) hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
    return Math.abs(hash);
  }

  // step -1 / 0 / 1: the family colour mixed a little toward the surface or
  // the text colour, so the step reads in both themes.
  function familyColor(family, step = 0) {
    const base = palette.categorical(family.slot);
    if (!step) return base;
    return `color-mix(in srgb, ${base} 82%, ${step < 0 ? "var(--panelBg)" : "var(--text)"})`;
  }

  function engineFamily(engine) {
    const key = String(engine || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const family = ENGINE_FAMILIES.find((candidate) => candidate.test(key)) || OTHER_ENGINE_FAMILY;
    return { ...family, color: familyColor(family) };
  }

  // Adjacent tables of the same engine family would otherwise merge into one
  // flat block; a small deterministic lightness step keeps them separable
  // without inventing a meaning that the legend cannot explain.
  function tableColor(engine, name) {
    const family = engineFamily(engine);
    return familyColor(family, [-1, 0, 1][hashName(name) % 3]);
  }

  // A database keeps one categorical slot, picked from its name.
  function databaseColor(name) {
    return palette.categorical(hashName(name));
  }

  function nodeMetaLabel(node) {
    if (node.kind === "table" || node.kind === "partition") {
      const rows = node.rows == null || node.rows === "" || !Number.isFinite(Number(node.rows)) ? "" : format.compact(node.rows);
      return rows ? `${rows} ${Number(node.rows) === 1 ? "row" : "rows"}` : (node.engine || "");
    }
    if (node.kind === "other") {
      return node.memberKind === "database"
        ? format.countLabel(node.members, "database", "databases")
        : format.countLabel(node.members, "table", "tables");
    }
    return format.countLabel(node.count, "table", "tables");
  }

  function layoutTreemapGroup(nodes, x, y, width, height, depth, output, context) {
    if (output.length >= treemapMaximumRectangles || width < 1 || height < 1) return;
    const rectangles = layoutTreemapNodes(nodes, x, y, width, height);
    for (const rectangle of rectangles) {
      if (output.length >= treemapMaximumRectangles) break;
      collectTreemapRectangles(rectangle.node, rectangle.x, rectangle.y, rectangle.width, rectangle.height, depth, output, context);
    }
  }

  function collectTreemapRectangles(node, x, y, width, height, depth, output, context) {
    if (output.length >= treemapMaximumRectangles || width < 1 || height < 1 || nodeBytes(node) <= 0) return;
    const gap = Math.min(treemapGapPixels, width * 0.04, height * 0.04);
    const drawX = x + gap / 2;
    const drawY = y + gap / 2;
    const drawWidth = Math.max(0, width - gap);
    const drawHeight = Math.max(0, height - gap);
    if (drawWidth < 1 || drawHeight < 1) return;

    const children = treemapChildren(node);
    const declaredKind = String(node.kind || "");
    const isFolder = isFolderKind(declaredKind);
    // A tall, narrow database (for example `system` next to a huge
    // database) still opens as a branch: its tables are drawn under its
    // header band instead of being hidden in a terminal tile.
    const isBranch = isFolder
      && children.length > 0
      && depth < treemapMaximumDepth
      && (drawWidth >= 80 || (drawWidth >= 36 && drawHeight >= 160))
      && drawHeight >= 84;
    const isLeaf = declaredKind === "table" || declaredKind === "partition";
    const kind = declaredKind === "other" ? "other" : (isLeaf ? declaredKind : "database");
    const styleKind = kind === "partition" ? "table" : kind;
    const color = isLeaf ? tableColor(node.engine, node.name) : databaseColor(node.name);
    const sizeLabel = context.formatBytes(nodeBytes(node));
    const metaLabel = nodeMetaLabel(node);
    const titlePath = kind === "other"
      ? (node.path ? `${node.path} - Others` : "Others")
      : (kind === "partition" ? `${node.path || ""} partition ${node.name || ""}` : (node.path || node.name || ""));
    const title = `${titlePath}\n${sizeLabel} · ${metaLabel}`;

    // Every expanded database owns a header. If the rectangle cannot reserve
    // a readable header and child area, it is rendered as a terminal tile
    // instead of drawing an unnamed container around its tables.
    const header = isBranch ? Math.min(treemapFolderHeaderPixels, Math.max(0, drawHeight - 30)) : 0;
    const labelName = node.name || (kind === "database" ? "Database" : "Unnamed");
    const label = `<span class="explorerTreemap__label"><span class="explorerTreemap__name">${esc(labelName)}</span><span class="explorerTreemap__details"><span class="explorerTreemap__size">${esc(sizeLabel)}</span><span class="explorerTreemap__meta">${esc(metaLabel)}</span></span></span>`;
    const branchClass = isBranch ? " is-branch has-header" : " is-terminal";
    const actionable = kind === "table" || declaredKind === "database";
    const role = actionable ? "button" : "img";
    const headerValue = header > 0 ? `${header.toFixed(2)}px` : "100%";
    output.push(`<div class="explorerTreemap__node is-${styleKind}${branchClass}" tabindex="0" role="${role}" aria-label="${esc(title.replace(/\n/g, ", "))}" data-kind="${kind}" data-name="${esc(node.name || "")}" data-path="${esc(actionable ? (node.path || "") : "")}" data-scope="${esc(kind === "other" ? (node.path || "") : "")}" data-database="${esc(node.database || "")}" data-table="${esc(node.table || "")}" data-engine="${esc(node.engine || "")}" data-depth="${depth}" data-header-height="${header}" data-size="${nodeBytes(node)}" data-count="${Math.max(0, Number(node.count || 0))}" data-rows="${node.rows == null ? "" : Math.max(0, Number(node.rows || 0))}" data-meta="${esc(metaLabel)}" style="left:${drawX.toFixed(2)}px;top:${drawY.toFixed(2)}px;width:${drawWidth.toFixed(2)}px;height:${drawHeight.toFixed(2)}px;z-index:${depth};--treemap-color:${color};--treemap-header:${headerValue}">${label}</div>`);
    if (!isBranch || output.length >= treemapMaximumRectangles) return;

    const inset = Math.min(treemapBranchInsetPixels, drawWidth / 4, drawHeight / 4);
    const innerX = drawX + inset;
    const innerY = drawY + header + inset;
    const innerWidth = Math.max(0, drawWidth - inset * 2);
    const innerHeight = Math.max(0, drawHeight - header - inset * 2);
    layoutTreemapGroup(children, innerX, innerY, innerWidth, innerHeight, depth + 1, output, context);
  }

  function fitTreemapLabels(map) {
    if (!map) return;
    map.querySelectorAll(".explorerTreemap__node").forEach((node) => {
      const label = node.querySelector(".explorerTreemap__label");
      if (!label) return;
      const meta = label.querySelector(".explorerTreemap__meta");
      const rect = node.getBoundingClientRect();
      const headerHeight = Math.max(0, Number(node.dataset.headerHeight || 0));
      const labelHeight = node.classList.contains("is-branch") && headerHeight > 0 ? headerHeight : rect.height;
      const isOther = node.dataset.kind === "other";
      const isFolder = node.dataset.kind === "database";
      const isBranch = node.classList.contains("is-branch");

      label.style.maxHeight = `${Math.max(0, labelHeight)}px`;
      label.classList.remove("is-hidden", "is-compact", "is-tiny", "is-other-compact", "is-other-inline", "is-vertical", "is-single-line");
      node.classList.remove("is-sliver");
      if (meta) meta.hidden = false;

      // Others always keeps its name, exact size, and member count. The
      // layout reserves enough space; compact mode only reduces typography.
      if (isOther) {
        if (rect.width >= treemapOtherInlineMinimumWidthPixels && labelHeight < 38) {
          label.classList.add("is-other-inline");
        } else if (rect.width < 150 || labelHeight < 58) {
          label.classList.add("is-other-compact");
        }
        return;
      }

      // A database rectangle is never rendered without its name. Small
      // databases use compact typography rather than hiding the label.
      if (isFolder) {
        if (rect.width < 40 && labelHeight >= 48) {
          label.classList.add("is-vertical");
          if (meta) meta.hidden = true;
          return;
        }
        if (rect.width < 82 || labelHeight < 38) label.classList.add("is-tiny");
        else if (rect.width < 140 || labelHeight < 52) label.classList.add("is-compact");
        if (meta && (rect.width < 220 || labelHeight < 70 || isBranch)) meta.hidden = true;
        return;
      }

      // Slivers keep a label whenever one line fits, rotated for tall
      // narrow rectangles; anything smaller gets a visible edge mark so a
      // 1% table never reads as part of its neighbour.
      if (rect.width < 40 || labelHeight < 24) {
        if (rect.width >= 12 && labelHeight >= 48) {
          label.classList.add("is-vertical");
          if (meta) meta.hidden = true;
          return;
        }
        if (rect.width >= 60 && labelHeight >= 13) {
          label.classList.add("is-tiny", "is-single-line");
          if (meta) meta.hidden = true;
          return;
        }
        label.classList.add("is-hidden");
        node.classList.add("is-sliver");
        return;
      }
      if (rect.width < 82 || labelHeight < 38) {
        label.classList.add("is-tiny");
        if (meta) meta.hidden = true;
        return;
      }
      if (rect.width < 140 || labelHeight < 52) {
        label.classList.add("is-compact");
        if (meta) meta.hidden = true;
        return;
      }
      if (rect.width < 220 || labelHeight < 70) {
        if (meta) meta.hidden = true;
      }
    });
  }

  function renderTreemap(map, nodes, context) {
    if (!map) return;
    const bounds = map.getBoundingClientRect();
    const width = Math.max(0, Math.floor(bounds.width));
    const height = Math.max(0, Math.floor(bounds.height));
    if (!(width > 0) || !(height > 0)) return;
    if (map.dataset.layoutWidth === String(width) && map.dataset.layoutHeight === String(height) && map.dataset.layoutReady === "1") {
      fitTreemapLabels(map);
      return;
    }

    const output = [];
    layoutTreemapGroup(nodes, 0, 0, width, height, 1, output, context);
    map.innerHTML = output.join("") || `<div class="explorerTreemap__empty">${esc(context.emptyText)}</div>`;
    map.dataset.layoutWidth = String(width);
    map.dataset.layoutHeight = String(height);
    map.dataset.layoutReady = "1";
    map.classList.remove("is-layout-pending");
    map.setAttribute("aria-busy", "false");
    fitTreemapLabels(map);
  }

  function engineLegend(nodes) {
    const families = new Map();
    const visit = (node) => {
      if (!node) return;
      if (node.kind === "table" || node.kind === "partition") {
        const family = engineFamily(node.engine);
        families.set(family.key, family);
      }
      for (const child of Array.isArray(node.children) ? node.children : []) visit(child);
    };
    for (const node of nodes || []) visit(node);
    const order = [...ENGINE_FAMILIES.map((family) => family.key), "other-engine"];
    return [...families.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }

  // Mount a treemap in `host`. The host owns the map surface and the tooltip;
  // the returned controller lets callers swap the tree without leaking
  // observers when the Explorer detail pane is re-rendered.
  function mount(host, options = {}) {
    if (!host) return null;
    const context = {
      formatBytes: typeof options.formatBytes === "function" ? options.formatBytes : format.bytes,
      emptyText: options.emptyText || "No on-disk data.",
    };
    let nodes = [];
    let rootBytes = 0;
    let rootName = "";
    host.classList.add("explorerTreemapPanel");
    const map = document.createElement("div");
    map.className = "explorerTreemap is-layout-pending";
    map.setAttribute("role", "group");
    map.setAttribute("aria-label", options.ariaLabel || "Storage size treemap");
    map.setAttribute("aria-busy", "true");
    const tooltip = document.createElement("div");
    tooltip.className = "explorerTreemap__tooltip";
    tooltip.setAttribute("data-treemap-tooltip", "");
    tooltip.setAttribute("role", "status");
    tooltip.hidden = true;
    tooltip.append(document.createElement("strong"), document.createElement("span"));
    host.replaceChildren(map, tooltip);

    let hoveredNode = null;
    const hideTooltip = () => { tooltip.hidden = true; };
    const clearHover = () => {
      hoveredNode?.classList.remove("is-hovered");
      hoveredNode = null;
      hideTooltip();
    };
    const placeTooltip = (node, clientX, clientY) => {
      if (!node) {
        hideTooltip();
        return;
      }
      const nameHost = tooltip.querySelector("strong");
      const metaHost = tooltip.querySelector("span");
      const kind = node.dataset.kind;
      const size = Number(node.dataset.size || 0);
      const share = rootBytes > 0 ? size / rootBytes * 100 : 0;
      const shareText = `${format.percent(share / 100)}${rootName ? ` of ${rootName}` : ""}`;
      const name = kind === "other"
        ? (node.dataset.scope ? `Others in ${node.dataset.scope}` : "Others")
        : kind === "partition"
          ? `Partition ${node.dataset.name}`
          : (kind === "table" && node.dataset.database ? `${node.dataset.database}.${node.dataset.name}` : (node.dataset.name || "Database"));
      const bits = [context.formatBytes(size), node.dataset.meta];
      if (kind === "table" && node.dataset.engine) bits.push(node.dataset.engine);
      if (kind === "other" && Number(node.dataset.count || 0) > 0) bits.push(format.countLabel(node.dataset.count, "table", "tables"));
      bits.push(shareText);
      if (nameHost) nameHost.textContent = name;
      if (metaHost) metaHost.textContent = [...new Set(bits.filter(Boolean))].join(" · ");
      tooltip.hidden = false;

      const panelRect = host.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const anchorX = Number.isFinite(clientX) ? clientX : nodeRect.left + Math.min(nodeRect.width, 24);
      const anchorY = Number.isFinite(clientY) ? clientY : nodeRect.top + Math.min(nodeRect.height, 24);
      const maximumLeft = Math.max(8, panelRect.width - tooltipRect.width - 8);
      const maximumTop = Math.max(8, panelRect.height - tooltipRect.height - 8);
      const left = Math.min(maximumLeft, Math.max(8, anchorX - panelRect.left + 12));
      const top = Math.min(maximumTop, Math.max(8, anchorY - panelRect.top + 12));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };
    const updateHover = (node, clientX, clientY) => {
      if (hoveredNode !== node) {
        hoveredNode?.classList.remove("is-hovered");
        hoveredNode = node || null;
        hoveredNode?.classList.add("is-hovered");
      }
      placeTooltip(node, clientX, clientY);
    };

    let renderPending = false;
    const scheduleRender = () => {
      if (renderPending) return;
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        if (!map.isConnected) return;
        renderTreemap(map, nodes, context);
      });
    };

    const activate = (node) => {
      if (!node || node.dataset.kind === "other" || !node.dataset.path) return;
      clearHover();
      options.onOpen?.({
        kind: node.dataset.kind,
        database: node.dataset.database || "",
        table: node.dataset.table || "",
        name: node.dataset.name || "",
      });
    };

    map.addEventListener("pointermove", (event) => {
      const node = event.target.closest(".explorerTreemap__node");
      updateHover(node, event.clientX, event.clientY);
    });
    map.addEventListener("pointerleave", clearHover);
    map.addEventListener("focusin", (event) => updateHover(event.target.closest(".explorerTreemap__node")));
    map.addEventListener("focusout", (event) => {
      if (!map.contains(event.relatedTarget)) clearHover();
    });
    map.addEventListener("click", (event) => {
      const node = event.target.closest(".explorerTreemap__node[data-path]");
      if (!node || !node.dataset.path) return;
      event.stopPropagation();
      activate(node);
    });
    map.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const node = event.target.closest(".explorerTreemap__node[data-path]");
      if (!node || !node.dataset.path) return;
      event.preventDefault();
      activate(node);
    });

    let resizeObserver = null;
    let resizeHandler = null;
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(scheduleRender);
      resizeObserver.observe(map);
    } else {
      resizeHandler = scheduleRender;
      window.addEventListener("resize", resizeHandler, { passive: true });
    }

    const controller = {
      element: host,
      map,
      setTree(tree, { name = "" } = {}) {
        nodes = treemapRootNodes(tree);
        rootBytes = nodeBytes(tree);
        rootName = name;
        clearHover();
        delete map.dataset.layoutReady;
        scheduleRender();
      },
      destroy() {
        resizeObserver?.disconnect();
        if (resizeHandler) window.removeEventListener("resize", resizeHandler);
        resizeObserver = null;
        resizeHandler = null;
      },
    };
    return controller;
  }

  ns.explorerTreemap = {
    mount,
    buildTreemap,
    materializeTreemap,
    treemapThreshold,
    treemapRootNodes,
    engineFamily,
    engineLegend,
  };
})();
