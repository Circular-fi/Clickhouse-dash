(() => {
  "use strict";
  // Shared canvas graph kit (ns.graphKit): one look and one interaction model
  // for every node / edge graph (Explorer lineage and storage graph, Traces
  // service map, trace detail Trace Graph). It owns the view transform (pan,
  // zoom, fit into the area the chrome leaves free, one wheel factor
  // and zoom range), the DPR-correct canvas and its rAF-coalesced redraws, the
  // dot-grid background, card / halo / edge / label drawing, the orthogonal
  // edge router and the layered layout it routes, collision-free edge labels,
  // the minimap, keyboard access (focusable canvas, arrows between nodes,
  // Enter, + - 0, Escape, a live region naming the focused node), touch pan
  // and pinch zoom, and the DOM helpers of the shared chrome (foldable
  // legend, side-panel shell). The canvas is the only view of every graph,
  // on phones too. Colours come from the --graph-* tokens of style.css
  // ("Graph kit" block), never from literals.
  const ns = window.ChDash;
  if (!ns) return;

  const FONT = "Arial, Helvetica, sans-serif";
  const ZOOM_STEP = 1.22;
  const WHEEL_SPEED = 0.0012;
  const MAX_SCALE = 3.2;
  const MIN_SCALE = 0.02;
  const GRID_SPACING = 22;
  const MOBILE_QUERY = "(max-width: 720px)";

  // ------------------------------------------------------------------ theme

  // Canvas colours are resolved from CSS custom properties. getComputedStyle()
  // per node / edge made every frame pay hundreds of style lookups, so values
  // are cached until the theme can have changed: any attribute change on the
  // root element (data-theme, class) or an OS colour-scheme switch.
  const themeCache = { colors: new Map(), light: null, signature: "" };
  const themeListeners = new Set();
  const colorSchemeQuery = window.matchMedia?.("(prefers-color-scheme: light)") || null;

  function invalidateTheme() {
    themeCache.colors.clear();
    themeCache.light = null;
    gridPatternCache.key = "";
  }

  function themeChanged() {
    invalidateTheme();
    const signature = `${document.documentElement?.dataset?.theme || ""}\u0000${isLight() ? 1 : 0}`;
    if (signature === themeCache.signature) return;
    themeCache.signature = signature;
    for (const listener of themeListeners) {
      try { listener(); } catch (error) { console.error(error); }
    }
  }

  colorSchemeQuery?.addEventListener?.("change", themeChanged);
  if (typeof MutationObserver === "function" && document.documentElement) {
    new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true });
  }

  function cssVar(name) {
    let value = themeCache.colors.get(name);
    if (value === undefined) {
      value = typeof getComputedStyle === "function" && document.documentElement
        ? getComputedStyle(document.documentElement).getPropertyValue(name).trim()
        : "";
      themeCache.colors.set(name, value);
    }
    return value;
  }

  function isLight() {
    if (themeCache.light !== null) return themeCache.light;
    const explicit = String(document.documentElement?.dataset?.theme || "");
    let light;
    if (explicit === "light") light = true;
    else if (explicit === "dark") light = false;
    else light = !!colorSchemeQuery?.matches;
    themeCache.light = light;
    return light;
  }

  // Roles read by the renderers; the tokens are defined for both themes in
  // the "Graph kit" block of style.css.
  const ROLE_TOKENS = {
    bg: "--graph-bg",
    grid: "--graph-grid",
    text: "--graph-text",
    muted: "--graph-muted",
    accentText: "--graph-accent-text",
    halo: "--graph-halo",
    edge: "--graph-edge",
    edgeMuted: "--graph-edge-muted",
    border: "--graph-node-border",
    nodeBg: "--graph-node-bg",
    disabledBg: "--graph-disabled-bg",
    groupBg: "--graph-group-bg",
    bandBg: "--graph-band-bg",
    labelBg: "--graph-label-bg",
    warn: "--graph-warn",
    error: "--graph-error",
    minimapBg: "--graph-minimap-bg",
    minimapView: "--graph-minimap-view",
    minimapViewFill: "--graph-minimap-view-fill",
  };

  function color(role) {
    return cssVar(ROLE_TOKENS[role] || ROLE_TOKENS.text);
  }

  // A CSS var() reference to a custom property (the Traces service colours),
  // resolved for canvas.
  function resolveColor(value) {
    const text = String(value || "");
    const match = /^var\((--[A-Za-z0-9_-]+)\)$/.exec(text);
    return match ? cssVar(match[1]) : text;
  }

  // Any CSS colour as [r, g, b, a] (0..255, alpha 0..1): a 1x1 canvas
  // normalises the syntax ("#abc", "rgba(...)", names) to "#rrggbb" or
  // "rgba(r, g, b, a)". Cached per text.
  const parsedColors = new Map();
  let colorProbe = null;
  function parseColor(value) {
    const text = String(value || "").trim();
    let rgba = parsedColors.get(text);
    if (rgba) return rgba;
    if (!colorProbe && typeof document.createElement === "function") colorProbe = document.createElement("canvas").getContext?.("2d") || null;
    let normal = text;
    if (colorProbe) {
      colorProbe.fillStyle = "#000000";
      colorProbe.fillStyle = text;
      normal = String(colorProbe.fillStyle);
    }
    const hex = /^#([0-9a-f]{6})$/i.exec(normal);
    if (hex) {
      const n = parseInt(hex[1], 16);
      rgba = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    } else {
      const parts = (normal.match(/[\d.]+/g) || []).map(Number);
      rgba = parts.length >= 3 ? [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1] : [0, 0, 0, 1];
    }
    if (parsedColors.size > 500) parsedColors.clear();
    parsedColors.set(text, rgba);
    return rgba;
  }

  // Canvas twin of color-mix(in srgb, b t, a): `t` of colour `b` over `a`.
  function mixColor(a, b, t) {
    const x = parseColor(a);
    const y = parseColor(b);
    const k = Math.max(0, Math.min(1, Number(t) || 0));
    const channel = (i) => Math.round(x[i] + (y[i] - x[i]) * k);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
  }

  // Alpha of objects outside the focused neighbourhood: faint but legible.
  function dimAlpha() {
    return isLight() ? 0.34 : 0.26;
  }

  // Media queries are created once: matchMedia() per call (per edge and per
  // frame for the reduced-motion check) showed up in frame profiles.
  const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
  const mobileQuery = window.matchMedia?.(MOBILE_QUERY) || null;

  function reducedMotion() {
    return !!reducedMotionQuery?.matches;
  }

  function mobileLayout() {
    return !!mobileQuery?.matches;
  }

  // ----------------------------------------------------------------- canvas

  function canvasSize(canvas) {
    if (!canvas) return { width: 0, height: 0, dpr: 1 };
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { width: rect.width, height: rect.height, dpr };
  }

  function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, width, height, radius);
    else ctx.rect(x, y, width, height);
  }

  // Truncated texts per font, text and width: cards redraw on every hover and
  // pan frame, and the binary search measures the text up to log2(n) times.
  // Callers that set the font pass it (reading ctx.font back serializes it).
  const ellipsisCache = new Map();
  function ellipsis(ctx, value, maxWidth, font = ctx.font) {
    const text = String(value || "");
    if (!text) return text;
    let byText = ellipsisCache.get(font);
    if (!byText) { byText = new Map(); ellipsisCache.set(font, byText); }
    const cached = byText.get(text);
    if (cached && cached.width === maxWidth) return cached.result;
    let result = text;
    if (ctx.measureText(text).width > maxWidth) {
      let low = 0;
      let high = text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (ctx.measureText(`${text.slice(0, mid)}\u2026`).width <= maxWidth) low = mid;
        else high = mid - 1;
      }
      result = `${text.slice(0, low)}\u2026`;
    }
    if (byText.size > 6000) byText.clear();
    byText.set(text, { width: maxWidth, result });
    return result;
  }

  // The dot grid of the graph background: one dot per GRID_SPACING CSS pixels,
  // a pattern tile in device pixels moved with the pan offset.
  const gridPatternCache = { key: "", pattern: null };
  function gridPattern(ctx, dpr) {
    const key = `${dpr}\u0000${color("grid")}`;
    if (gridPatternCache.key === key) return gridPatternCache.pattern;
    gridPatternCache.key = key;
    gridPatternCache.pattern = null;
    if (typeof document.createElement !== "function") return null;
    const tile = document.createElement("canvas");
    const size = Math.round(GRID_SPACING * dpr);
    tile.width = size;
    tile.height = size;
    const tileCtx = tile.getContext?.("2d");
    if (!tileCtx || typeof ctx.createPattern !== "function") return null;
    tileCtx.fillStyle = color("grid");
    tileCtx.beginPath();
    tileCtx.arc(size / 2, size / 2, Math.max(1, dpr), 0, Math.PI * 2);
    tileCtx.fill();
    gridPatternCache.pattern = ctx.createPattern(tile, "repeat");
    return gridPatternCache.pattern;
  }

  function drawBackground(ctx, view, width, height, dpr) {
    ctx.fillStyle = color("bg");
    ctx.fillRect(0, 0, width, height);
    const pattern = gridPattern(ctx, dpr);
    if (!pattern) return;
    const shift = (value) => ((value % GRID_SPACING) + GRID_SPACING) % GRID_SPACING - GRID_SPACING / 2;
    if (typeof pattern.setTransform === "function" && typeof DOMMatrix === "function") {
      pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, shift(view.offsetX || 0), shift(view.offsetY || 0)]));
    }
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
  }

  // ------------------------------------------------------------------ cards

  // Outer translucent ring + crisp inner stroke: visible on white without
  // relying on a blur that the light theme washes out.
  function drawHalo(ctx, item, radius, dashed) {
    ctx.save();
    roundRect(ctx, item.x - 6, item.y - 6, item.width + 12, item.height + 12, radius + 6);
    ctx.strokeStyle = color("halo");
    ctx.globalAlpha = isLight() ? 0.22 : 0.28;
    ctx.lineWidth = 6;
    ctx.stroke();
    roundRect(ctx, item.x - 3, item.y - 3, item.width + 6, item.height + 6, radius + 3);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.6;
    if (!isLight()) {
      ctx.shadowColor = color("halo");
      ctx.shadowBlur = 12;
    }
    if (dashed) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.restore();
  }

  const fontCache = new Map();
  function fontOf(weight, size) {
    const key = weight * 1000 + size;
    let font = fontCache.get(key);
    if (!font) { font = `${weight} ${size}px ${FONT}`; fontCache.set(key, font); }
    return font;
  }

  // One card: rounded rectangle, optional left colour strip, status dot and
  // right-aligned badge on the title row, then text rows at fixed offsets.
  //   card = { radius, fill, border, borderWidth, dashed, alpha, halo, haloDashed,
  //            strip, status: "warn" | "error", statusAlpha, badge,
  //            rows: [{ text, size, weight, color, y, fit }] }
  // The first row is the title: it stops before the status dot and badge.
  function drawCard(ctx, item, card) {
    const radius = card.radius ?? 10;
    ctx.save();
    if (card.alpha != null) ctx.globalAlpha = card.alpha;
    if (card.halo) drawHalo(ctx, item, radius, !!card.haloDashed);
    roundRect(ctx, item.x, item.y, item.width, item.height, radius);
    ctx.fillStyle = card.fill || color("nodeBg");
    ctx.fill();
    if (card.strip) {
      ctx.save();
      ctx.clip();
      ctx.fillStyle = card.strip;
      ctx.fillRect(item.x, item.y, 5, item.height);
      ctx.restore();
      roundRect(ctx, item.x, item.y, item.width, item.height, radius);
    }
    ctx.strokeStyle = card.border || color("border");
    ctx.lineWidth = card.borderWidth ?? 1.2;
    if (card.dashed) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const pad = card.pad ?? (card.strip ? 15 : 12);
    let rightEdge = item.x + item.width - 12;
    if (card.status) {
      ctx.save();
      ctx.globalAlpha *= card.statusAlpha ?? 1;
      ctx.fillStyle = card.status === "error" ? color("error") : color("warn");
      ctx.beginPath();
      ctx.arc(rightEdge - 4, item.y + 17, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      rightEdge -= 14;
    }
    if (card.badge) {
      ctx.font = `600 12px ${FONT}`;
      ctx.fillStyle = color("muted");
      ctx.textAlign = "right";
      ctx.fillText(card.badge, rightEdge, item.y + 22);
      ctx.textAlign = "left";
      rightEdge -= ctx.measureText(card.badge).width + 8;
    }
    const rows = card.rows || [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row || !row.text) continue;
      ctx.fillStyle = row.color || (index === 0 ? color("text") : color("muted"));
      const font = fontOf(row.weight || (index === 0 ? 600 : 400), row.size || 12);
      ctx.font = font;
      const limit = index === 0 && row.fit !== "full" ? rightEdge - item.x - pad : item.width - pad - 12;
      ctx.fillText(ellipsis(ctx, row.text, limit, font), item.x + pad, item.y + row.y);
    }
    ctx.restore();
  }

  // Below the readable scale a card keeps only its title, drawn larger so it
  // stays legible while zooming out; below that, cards are plain blocks.
  function compactTitleSize(scale) {
    const value = Math.max(0.01, Number(scale) || 1);
    const size = Math.min(26, Math.max(14, 12 / value));
    return size * value >= 7 ? size : 0;
  }

  // ------------------------------------------------------------------ edges

  // Dash patterns by edge kind (world units, scaled with the zoom).
  const DASH = {
    solid: [],
    dashed: [7, 7],
    message: [7, 5],
    dotted: [2, 4],
    dashdot: [2, 4, 7, 4],
    route: [3, 5],
    lifecycle: [6, 4],
    refresh: [12, 5, 2, 5],
  };

  function polylineMetric(points) {
    const segments = [];
    let total = 0;
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      segments.push({ a, b, length, start: total });
      total += length;
    }
    return { segments, total: Math.max(total, 0.0001) };
  }

  // Point (and direction) at fraction t of a polyline's length.
  function routePoint(points, t) {
    const metric = polylineMetric(points);
    const distance = Math.max(0, Math.min(1, t)) * metric.total;
    let segment = metric.segments[metric.segments.length - 1];
    for (const candidate of metric.segments) {
      if (distance <= candidate.start + candidate.length) { segment = candidate; break; }
    }
    if (!segment) return { x: 0, y: 0, angle: 0 };
    const local = segment.length > 0 ? Math.max(0, Math.min(1, (distance - segment.start) / segment.length)) : 0;
    return {
      x: segment.a.x + (segment.b.x - segment.a.x) * local,
      y: segment.a.y + (segment.b.y - segment.a.y) * local,
      angle: Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x),
    };
  }

  function tracePolyline(ctx, points) {
    if (!points.length) return;
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  }

  function strokePolyline(ctx, points) {
    ctx.beginPath();
    tracePolyline(ctx, points);
    ctx.stroke();
  }

  // Filled arrow head at the end of a polyline, along its last segment.
  function drawArrowHead(ctx, points, size = 8) {
    if (!Array.isArray(points) || points.length < 2) return;
    const tip = points[points.length - 1];
    const near = routePoint(points, 0.985);
    const angle = near.angle;
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - size * Math.cos(angle - 0.5), tip.y - size * Math.sin(angle - 0.5));
    ctx.lineTo(tip.x - size * Math.cos(angle + 0.5), tip.y - size * Math.sin(angle + 0.5));
    ctx.closePath();
    ctx.fill();
  }

  function distanceToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function distanceToPolyline(point, points) {
    let best = Infinity;
    for (let i = 1; i < points.length; i += 1) best = Math.min(best, distanceToSegment(point, points[i - 1], points[i]));
    return best;
  }

  function pointInRect(point, rect, padding = 0) {
    return point.x >= rect.x - padding && point.x <= rect.x + rect.width + padding
      && point.y >= rect.y - padding && point.y <= rect.y + rect.height + padding;
  }

  function rectsOverlap(a, b, padding = 14) {
    return !(
      a.x + a.width + padding <= b.x ||
      b.x + b.width + padding <= a.x ||
      a.y + a.height + padding <= b.y ||
      b.y + b.height + padding <= a.y
    );
  }

  // --------------------------------------------------------- layered layout

  // Layered (Sugiyama-style) left-to-right layout: longest-path levels from
  // the sources, barycentre sweeps and adjacent transpositions against edge
  // crossings, then (rowGrid) one global row grid: a node can stay on the
  // exact row of its parent / child even when another column has a different
  // number of nodes, which keeps orthogonal routes straight.
  //   options = { nodes, edges, size(node) -> { width, height }, compare(a, b),
  //               queueCompare(a, b), weight(edge), rowGrid, rowPitch, xGap,
  //               yGap, minColumnWidth, origin, breakCycles }
  // Returns { positions: Map(id -> { x, y, width, height, node, lineageRow }),
  // level: Map(id -> column), backEdges: Set(edge id) }.
  function layered(options) {
    const nodes = options.nodes || [];
    const size = options.size;
    const compare = options.compare || ((a, b) => String(a.id).localeCompare(String(b.id)));
    const queueCompare = options.queueCompare || compare;
    const weightOf = options.weight || (() => 1);
    const xGap = options.xGap ?? 92;
    const yGap = options.yGap ?? 34;
    const origin = options.origin ?? 70;
    const minColumnWidth = options.minColumnWidth ?? 0;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const backEdges = options.breakCycles ? cycleBackEdges(nodes, options.edges || []) : new Set();
    const edges = backEdges.size ? (options.edges || []).filter((edge) => !backEdges.has(edge.id)) : (options.edges || []);
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const next = new Map(nodes.map((node) => [node.id, []]));

    for (const edge of edges) {
      if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue;
      indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
      next.get(edge.from)?.push(edge.to);
    }

    const queue = nodes.filter((node) => (indegree.get(node.id) || 0) === 0).sort(queueCompare).map((node) => node.id);
    const level = new Map(nodes.map((node) => [node.id, 0]));
    const processed = new Set();
    for (let qi = 0; qi < queue.length; qi += 1) {
      const id = queue[qi];
      processed.add(id);
      const base = level.get(id) || 0;
      for (const target of next.get(id) || []) {
        level.set(target, Math.max(level.get(target) || 0, base + 1));
        indegree.set(target, (indegree.get(target) || 0) - 1);
        if ((indegree.get(target) || 0) === 0) queue.push(target);
      }
    }

    // Cycles are valid for some view/topology combinations. Keep them visible
    // by placing remaining nodes after their strongest known predecessor.
    for (const node of nodes) {
      if (processed.has(node.id)) continue;
      let best = 0;
      for (const edge of edges) {
        if (edge.to === node.id) best = Math.max(best, (level.get(edge.from) || 0) + 1);
      }
      level.set(node.id, best);
    }

    const columns = new Map();
    for (const node of nodes) {
      const l = level.get(node.id) || 0;
      if (!columns.has(l)) columns.set(l, []);
      columns.get(l).push(node);
    }
    for (const group of columns.values()) group.sort(compare);

    // Crossing minimization: perform a few Sugiyama-style barycentric sweeps
    // after topological layering. This keeps the deterministic layout while
    // placing nodes close to their connected neighbours instead of purely
    // alphabetically, which dramatically reduces crossing edges.
    const levels = [...columns.keys()].sort((a, b) => a - b);
    const predecessors = new Map(nodes.map((node) => [node.id, []]));
    const successors = new Map(nodes.map((node) => [node.id, []]));
    for (const edge of edges) {
      if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
      predecessors.get(edge.to)?.push(edge.from);
      successors.get(edge.from)?.push(edge.to);
    }
    const orderForLevel = (levelNumber) => {
      const map = new Map();
      (columns.get(levelNumber) || []).forEach((node, index) => map.set(node.id, index));
      return map;
    };
    const barySort = (group, neighborIds, neighborOrder) => {
      const decorated = group.map((node, index) => {
        const values = (neighborIds.get(node.id) || []).map((id) => neighborOrder.get(id)).filter((value) => Number.isFinite(value));
        const bary = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
        return { node, index, bary };
      });
      decorated.sort((a, b) => {
        if (a.bary != null && b.bary != null && a.bary !== b.bary) return a.bary - b.bary;
        if (a.bary != null && b.bary == null) return -1;
        if (a.bary == null && b.bary != null) return 1;
        const stable = compare(a.node, b.node);
        return stable || a.index - b.index;
      });
      group.splice(0, group.length, ...decorated.map((item) => item.node));
    };
    for (let sweep = 0; sweep < 4; sweep += 1) {
      for (let i = 1; i < levels.length; i += 1) {
        barySort(columns.get(levels[i]) || [], predecessors, orderForLevel(levels[i - 1]));
      }
      for (let i = levels.length - 2; i >= 0; i -= 1) {
        barySort(columns.get(levels[i]) || [], successors, orderForLevel(levels[i + 1]));
      }
    }

    // Adjacent transposition after barycentric sweeps. Re-scoring every
    // crossing twice per adjacent swap is O(swaps x E^2) and froze the tab for
    // a minute on a 2k-node catalog. Swapping neighbours u,v of one layer only
    // flips the crossing state of edge pairs (u-edge, v-edge) that share the
    // same adjacent layer, so after - before is exactly
    //   #(p_u < p_v) - #(p_u > p_v)
    // over those pairs (p = far endpoint position).
    const swapLevelById = new Map();
    for (const [l, group] of columns.entries()) for (const node of group) swapLevelById.set(node.id, l);
    const swapPosById = new Map();
    for (const group of columns.values()) group.forEach((node, index) => swapPosById.set(node.id, index));
    const swapNeighbors = new Map();
    for (const edge of edges) {
      const fromLevel = swapLevelById.get(edge.from);
      const toLevel = swapLevelById.get(edge.to);
      if (!Number.isFinite(fromLevel) || !Number.isFinite(toLevel) || Math.abs(fromLevel - toLevel) !== 1) continue;
      if (!swapNeighbors.has(edge.from)) swapNeighbors.set(edge.from, []);
      if (!swapNeighbors.has(edge.to)) swapNeighbors.set(edge.to, []);
      swapNeighbors.get(edge.from).push({ id: edge.to, level: toLevel });
      swapNeighbors.get(edge.to).push({ id: edge.from, level: fromLevel });
    }
    const swapDelta = (leftId, rightId) => {
      const left = swapNeighbors.get(leftId);
      const right = swapNeighbors.get(rightId);
      if (!left || !right) return 0;
      let delta = 0;
      for (const a of left) {
        const pa = swapPosById.get(a.id);
        for (const b of right) {
          if (a.level !== b.level) continue;
          const pb = swapPosById.get(b.id);
          if (pa < pb) delta += 1;
          else if (pa > pb) delta -= 1;
        }
      }
      return delta;
    };
    for (let pass = 0; pass < 4; pass += 1) {
      let improved = false;
      for (const l of levels) {
        const group = columns.get(l) || [];
        for (let i = 0; i + 1 < group.length; i += 1) {
          if (swapDelta(group[i].id, group[i + 1].id) < 0) {
            improved = true;
            [group[i], group[i + 1]] = [group[i + 1], group[i]];
            swapPosById.set(group[i].id, i);
            swapPosById.set(group[i + 1].id, i + 1);
          }
        }
      }
      if (!improved) break;
    }

    const positions = new Map();
    const rowGrid = !!options.rowGrid;
    const lineageRowPitch = rowGrid ? options.rowPitch : null;
    const lineageRows = new Map();
    if (rowGrid && levels.length) {
      const maxColumnSize = Math.max(1, ...levels.map((l) => (columns.get(l) || []).length));
      // One spare lane gives fan-in/fan-out branches room to remain separated
      // without making small graphs excessively tall.
      const rowCount = Math.max(1, maxColumnSize + (maxColumnSize >= 3 ? 1 : 0));
      for (const l of levels) {
        const group = columns.get(l) || [];
        if (!group.length) continue;
        group.forEach((node, index) => {
          const row = group.length === 1 ? Math.floor((rowCount - 1) / 2)
            : Math.round(index * (rowCount - 1) / Math.max(1, group.length - 1));
          lineageRows.set(node.id, row);
        });
      }

      const weightedIdeal = (nodeId) => {
        let weighted = 0;
        let total = 0;
        for (const edge of edges) {
          let other = null;
          if (edge.from === nodeId) other = edge.to;
          else if (edge.to === nodeId) other = edge.from;
          if (!other || !lineageRows.has(other)) continue;
          const weight = weightOf(edge);
          weighted += lineageRows.get(other) * weight;
          total += weight;
        }
        return total > 0 ? weighted / total : lineageRows.get(nodeId) ?? 0;
      };

      // Minimum-cost monotone assignment of a column to unique row slots. The
      // group order is preserved, so row optimization cannot re-introduce the
      // crossings already removed by the Sugiyama ordering pass.
      const assignRows = (group) => {
        const n = group.length;
        if (!n) return;
        const slots = Math.max(rowCount, n);
        const ideals = group.map((node) => weightedIdeal(node.id));
        const inf = 1e18;
        // Typed rows: a 2k-node column allocates n x slots cells per sweep.
        const dp = Array.from({ length: n }, () => new Float64Array(slots).fill(inf));
        const prev = Array.from({ length: n }, () => new Int32Array(slots).fill(-1));
        for (let row = 0; row < slots; row += 1) {
          if (slots - row < n) break;
          dp[0][row] = (row - ideals[0]) ** 2;
        }
        for (let i = 1; i < n; i += 1) {
          // Running prefix minimum of dp[i - 1][i - 1 .. row - 1]: a strict <
          // keeps the lowest predecessor on ties.
          let bestCost = inf;
          let bestPrev = -1;
          for (let row = i; row < slots; row += 1) {
            const pr = row - 1;
            if (dp[i - 1][pr] < bestCost) { bestCost = dp[i - 1][pr]; bestPrev = pr; }
            if (slots - row < n - i) continue;
            if (bestPrev < 0) continue;
            dp[i][row] = bestCost + (row - ideals[i]) ** 2;
            prev[i][row] = bestPrev;
          }
        }
        let endRow = 0;
        let endCost = inf;
        for (let row = n - 1; row < slots; row += 1) {
          if (dp[n - 1][row] < endCost) { endCost = dp[n - 1][row]; endRow = row; }
        }
        const assigned = Array(n).fill(0);
        for (let i = n - 1, row = endRow; i >= 0; i -= 1) {
          assigned[i] = row;
          row = i > 0 ? prev[i][row] : -1;
        }
        group.forEach((node, index) => lineageRows.set(node.id, assigned[index]));
      };

      for (let sweep = 0; sweep < 6; sweep += 1) {
        for (const l of levels) assignRows(columns.get(l) || []);
        for (let i = levels.length - 1; i >= 0; i -= 1) assignRows(columns.get(levels[i]) || []);
      }
    }

    let x = origin;
    for (const l of levels) {
      const group = columns.get(l) || [];
      let maxWidth = minColumnWidth;
      for (let row = 0; row < group.length; row += 1) {
        const node = group[row];
        const box = size(node);
        maxWidth = Math.max(maxWidth, box.width);
        const gridRow = rowGrid ? (lineageRows.get(node.id) ?? row) : row;
        const y = rowGrid ? origin + gridRow * lineageRowPitch : (() => {
          let packed = origin;
          for (let i = 0; i < row; i += 1) packed += size(group[i]).height + yGap;
          return packed;
        })();
        positions.set(node.id, { x, y, width: box.width, height: box.height, node, lineageRow: gridRow });
      }
      x += maxWidth + xGap;
    }
    return { positions, level, backEdges };
  }

  // Back edges of an iterative DFS from the sources (input order): removing
  // them leaves a DAG whose longest paths give the columns.
  function cycleBackEdges(nodes, edges) {
    const index = new Map(nodes.map((node, i) => [node.id, i]));
    const out = nodes.map(() => []);
    const hasIn = new Uint8Array(nodes.length);
    for (const edge of edges) {
      const s = index.get(edge.from);
      const t = index.get(edge.to);
      if (s == null || t == null || s === t) continue;
      out[s].push({ t, id: edge.id });
      hasIn[t] = 1;
    }
    const state = new Uint8Array(nodes.length);
    const back = new Set();
    const visit = (root) => {
      const stack = [[root, 0]];
      state[root] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [v, at] = top;
        if (at < out[v].length) {
          top[1] += 1;
          const { t, id } = out[v][at];
          if (state[t] === 1) { back.add(id); continue; }
          if (state[t] === 0) { state[t] = 1; stack.push([t, 0]); }
        } else {
          state[v] = 2;
          stack.pop();
        }
      }
    };
    for (let i = 0; i < nodes.length; i += 1) if (!hasIn[i] && !state[i]) visit(i);
    for (let i = 0; i < nodes.length; i += 1) if (!state[i]) visit(i);
    return back;
  }

  // ------------------------------------------------------ orthogonal router

  // Every node exposes one output port (right edge, at a stable offset from
  // the top of the card) and one input port (left edge, same offset). Using a
  // top-based anchor keeps sibling rows literally horizontal when the cards
  // share a row. A very small fan zone is allowed immediately outside those
  // ports because several orthogonal edges cannot leave one point without
  // sharing a few pixels. After that fan zone, every route owns its lane:
  // overlaps are forbidden and crossings are expensive.
  const LINEAGE_NODE_PORT_TOP_OFFSET = 36;
  const ROUTE_GRID_POINT_BUDGET = 40000;

  function nodePort(item, side = "right") {
    const y = item.y + Math.min(Math.max(18, LINEAGE_NODE_PORT_TOP_OFFSET), Math.max(18, item.height - 18));
    return { x: side === "left" ? item.x : item.x + item.width, y };
  }

  function pointInsideItem(point, item, padding = 8) {
    return point.x > item.x - padding && point.x < item.x + item.width + padding
      && point.y > item.y - padding && point.y < item.y + item.height + padding;
  }

  function segmentHitsItem(a, b, item, padding = 12) {
    const left = item.x - padding;
    const right = item.x + item.width + padding;
    const top = item.y - padding;
    const bottom = item.y + item.height + padding;
    if (Math.abs(a.x - b.x) < 0.001) {
      if (a.x <= left || a.x >= right) return false;
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      return hi > top && lo < bottom;
    }
    if (Math.abs(a.y - b.y) < 0.001) {
      if (a.y <= top || a.y >= bottom) return false;
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      return hi > left && lo < right;
    }
    return false;
  }

  function compressOrthogonalRoute(points) {
    if (!Array.isArray(points) || points.length <= 2) return points || [];
    const out = [points[0]];
    for (let i = 1; i + 1 < points.length; i += 1) {
      const a = out[out.length - 1];
      const b = points[i];
      const c = points[i + 1];
      const vertical = Math.abs(a.x - b.x) < 0.001 && Math.abs(b.x - c.x) < 0.001;
      const horizontal = Math.abs(a.y - b.y) < 0.001 && Math.abs(b.y - c.y) < 0.001;
      if (!vertical && !horizontal) out.push(b);
    }
    out.push(points[points.length - 1]);
    return out;
  }

  function orthogonalSegmentConflict(a, b, c, d) {
    const aVertical = Math.abs(a.x - b.x) < 0.001;
    const cVertical = Math.abs(c.x - d.x) < 0.001;
    const between = (value, x, y, strict = false) => strict
      ? value > Math.min(x, y) + 0.001 && value < Math.max(x, y) - 0.001
      : value >= Math.min(x, y) - 0.001 && value <= Math.max(x, y) + 0.001;

    if (aVertical !== cVertical) {
      const verticalA = aVertical ? a : c;
      const verticalB = aVertical ? b : d;
      const horizontalA = aVertical ? c : a;
      const horizontalB = aVertical ? d : b;
      const x = verticalA.x;
      const y = horizontalA.y;
      // Crossings at a route endpoint are normal fan-in/fan-out, not a visual
      // crossing in the middle of the graph.
      if (between(x, horizontalA.x, horizontalB.x, true) && between(y, verticalA.y, verticalB.y, true)) {
        return { crossings: 1, overlap: 0 };
      }
      return { crossings: 0, overlap: 0 };
    }

    if (aVertical) {
      if (Math.abs(a.x - c.x) > 0.001) return { crossings: 0, overlap: 0 };
      const overlap = Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
      return { crossings: 0, overlap };
    }
    if (Math.abs(a.y - c.y) > 0.001) return { crossings: 0, overlap: 0 };
    const overlap = Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
    return { crossings: 0, overlap };
  }

  function routeSegmentMeta(points, edge) {
    const segments = [];
    const count = Math.max(0, points.length - 1);
    for (let i = 0; i < count; i += 1) {
      segments.push({
        a: points[i],
        b: points[i + 1],
        edgeId: edge.id,
        from: edge.from,
        to: edge.to,
        index: i,
        count,
        // Only the first/last segment belongs to the unavoidable shared port
        // fan, so long pieces of unrelated routes can never lie on top of
        // each other.
        sourceFan: i === 0,
        targetFan: i === count - 1,
      });
    }
    return segments;
  }

  // Scratch arrays of the indexed router grid, reused across edges (a grid
  // has at most ROUTE_GRID_POINT_BUDGET points) and reset over the used part.
  const gridScratch = { size: 0 };
  function gridBuffers(total) {
    if (gridScratch.size < total) {
      const size = Math.max(total, Math.min(ROUTE_GRID_POINT_BUDGET, gridScratch.size * 2));
      gridScratch.size = size;
      gridScratch.blocked = new Uint8Array(size);
      gridScratch.left = new Int32Array(size);
      gridScratch.right = new Int32Array(size);
      gridScratch.up = new Int32Array(size);
      gridScratch.down = new Int32Array(size);
      gridScratch.best = new Float64Array(size * 3);
      gridScratch.previous = new Int32Array(size * 3);
    }
    gridScratch.blocked.fill(0, 0, total);
    gridScratch.left.fill(-1, 0, total);
    gridScratch.right.fill(-1, 0, total);
    gridScratch.up.fill(-1, 0, total);
    gridScratch.down.fill(-1, 0, total);
    gridScratch.best.fill(Infinity, 0, total * 3);
    gridScratch.previous.fill(-1, 0, total * 3);
    return gridScratch;
  }

  function routeBendCount(points) {
    let bends = 0;
    for (let i = 1; i + 1 < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const c = points[i + 1];
      const firstVertical = Math.abs(a.x - b.x) < 0.001;
      const secondVertical = Math.abs(b.x - c.x) < 0.001;
      if (firstVertical !== secondVertical) bends += 1;
    }
    return bends;
  }

  // Buckets routed segments by y so an A* step only examines segments whose
  // vertical extent can touch it. near() returns them in their original order:
  // skipped segments are exactly those segmentsApart() would reject (they add
  // 0), so routeConflictPenalty() sums the same terms in the same order.
  function createSegmentYIndex(segments, minY, maxY) {
    const margin = 0.02;
    if (segments.length <= 32 || !(maxY > minY)) {
      return { near: () => segments };
    }
    const bucketCount = Math.min(512, Math.max(1, Math.ceil(segments.length / 8)));
    const bucketHeight = (maxY - minY) / bucketCount;
    const bucketOf = (y) => Math.max(0, Math.min(bucketCount - 1, Math.floor((y - minY) / bucketHeight)));
    const buckets = Array.from({ length: bucketCount }, () => []);
    segments.forEach((segment, index) => {
      const lo = bucketOf(Math.min(segment.a.y, segment.b.y) - margin);
      const hi = bucketOf(Math.max(segment.a.y, segment.b.y) + margin);
      for (let bucket = lo; bucket <= hi; bucket += 1) buckets[bucket].push(index);
    });
    return {
      near(a, b) {
        const lo = bucketOf(Math.min(a.y, b.y) - margin);
        const hi = bucketOf(Math.max(a.y, b.y) + margin);
        if (lo === hi) return buckets[lo].map((index) => segments[index]);
        const seen = new Set();
        for (let bucket = lo; bucket <= hi; bucket += 1) for (const index of buckets[bucket]) seen.add(index);
        return [...seen].sort((x, y) => x - y).map((index) => segments[index]);
      },
    };
  }

  // Min-heap on (f = cost + heuristic, insertion order): pops exactly the
  // element a stable sort of the whole queue would put first, in O(log n).
  function createRouteQueue() {
    const heap = [];
    let serial = 0;
    const less = (a, b) => a.f < b.f || (a.f === b.f && a.seq < b.seq);
    return {
      size: () => heap.length,
      push(value, f) {
        heap.push({ value, f, seq: serial++ });
        let i = heap.length - 1;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (!less(heap[i], heap[parent])) break;
          [heap[i], heap[parent]] = [heap[parent], heap[i]];
          i = parent;
        }
      },
      pop() {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            const left = 2 * i + 1;
            const right = left + 1;
            let smallest = i;
            if (left < heap.length && less(heap[left], heap[smallest])) smallest = left;
            if (right < heap.length && less(heap[right], heap[smallest])) smallest = right;
            if (smallest === i) break;
            [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
            i = smallest;
          }
        }
        return top.value;
      },
    };
  }

  function assembleOrthogonalRoute(sourcePort, sourceFan, body, targetFan, targetPort) {
    // Preserve sourceFan/targetFan as explicit anchors even when collinear.
    // Conflict detection can then exempt only the tiny shared port fan instead
    // of accidentally exempting a long merged segment.
    const route = [sourcePort, sourceFan];
    for (const point of body.slice(1, -1)) {
      const previousPoint = route[route.length - 1];
      if (!previousPoint || Math.abs(previousPoint.x - point.x) > 0.001 || Math.abs(previousPoint.y - point.y) > 0.001) route.push(point);
    }
    const previousPoint = route[route.length - 1];
    if (!previousPoint || Math.abs(previousPoint.x - targetFan.x) > 0.001 || Math.abs(previousPoint.y - targetFan.y) > 0.001) route.push(targetFan);
    route.push(targetPort);
    return route;
  }

  // Bounding boxes of routed polylines, keyed by the (immutable) points array.
  // orthogonalSegmentConflict() can only report a crossing or an overlap when
  // two segments touch within its 0.001 tolerance, so pairs of routes whose
  // boxes are further apart contribute exactly 0 and can be skipped.
  const routeBoxCache = new WeakMap();
  function routeBox(points) {
    let box = routeBoxCache.get(points);
    if (box) return box;
    box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const point of points) {
      if (point.x < box.minX) box.minX = point.x;
      if (point.x > box.maxX) box.maxX = point.x;
      if (point.y < box.minY) box.minY = point.y;
      if (point.y > box.maxY) box.maxY = point.y;
    }
    routeBoxCache.set(points, box);
    return box;
  }

  function routeBoxesApart(a, b) {
    const margin = 0.01;
    return a.maxX + margin < b.minX || b.maxX + margin < a.minX || a.maxY + margin < b.minY || b.maxY + margin < a.minY;
  }

  function segmentsApart(a, b, c, d) {
    const margin = 0.01;
    return Math.max(a.x, b.x) + margin < Math.min(c.x, d.x) || Math.max(c.x, d.x) + margin < Math.min(a.x, b.x)
      || Math.max(a.y, b.y) + margin < Math.min(c.y, d.y) || Math.max(c.y, d.y) + margin < Math.min(a.y, b.y);
  }

  // Orthogonal routes for `edges` between the cards of `items`
  // (Map id -> { x, y, width, height, lineageRow }), each from the source's
  // right port to the target's left port. options.isSecondary(edge) marks
  // dependency-like edges: routed after the data-flow edges and preferring the
  // lanes between card rows. Returns Map(edge id -> { points, a, b }).
  function routeEdges(items, edges, options = {}) {
    const isSecondary = options.isSecondary || (() => false);
    const itemList = [...items.entries()];

    // Global row lanes, shared by every edge of this run.
    const rowYByIndex = new Map();
    for (const [, item] of itemList) {
      if (!Number.isFinite(item.lineageRow)) continue;
      if (!rowYByIndex.has(item.lineageRow)) rowYByIndex.set(item.lineageRow, nodePort(item, "right").y);
    }
    const rowYs = [...rowYByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, y]) => y);
    const betweenRowYs = [];
    for (let i = 0; i + 1 < rowYs.length; i += 1) betweenRowYs.push((rowYs[i] + rowYs[i + 1]) / 2);

    function routePortMaps(list) {
      const outgoing = new Map();
      const incoming = new Map();
      for (const edge of list) {
        if (!items.has(edge.from) || !items.has(edge.to)) continue;
        if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
        if (!incoming.has(edge.to)) incoming.set(edge.to, []);
        outgoing.get(edge.from).push(edge);
        incoming.get(edge.to).push(edge);
      }

      const ports = new Map();
      const FAN_BASE = 18;
      const FAN_STEP = 8;
      const FAN_MAX = 58;
      const edgePortY = (id, side) => {
        const item = items.get(id);
        return item ? nodePort(item, side).y : 0;
      };

      // Farthest destinations on the same vertical side turn first (closest to
      // the source). Their vertical lane therefore sits inside shorter routes
      // instead of cutting across them. Above/below branches may reuse the same
      // rank because they immediately travel in opposite directions.
      const fanRanks = (group, anchorY, otherId, otherSide) => {
        const buckets = { up: [], flat: [], down: [] };
        for (const edge of group) {
          const delta = edgePortY(otherId(edge), otherSide) - anchorY;
          const side = delta < -1 ? "up" : (delta > 1 ? "down" : "flat");
          buckets[side].push({ edge, distance: Math.abs(delta) });
        }
        buckets.up.sort((a, b) => b.distance - a.distance || String(a.edge.id).localeCompare(String(b.edge.id)));
        buckets.down.sort((a, b) => b.distance - a.distance || String(a.edge.id).localeCompare(String(b.edge.id)));
        buckets.flat.sort((a, b) => String(a.edge.id).localeCompare(String(b.edge.id)));
        const rank = new Map();
        for (const bucket of [buckets.up, buckets.down]) bucket.forEach((entry, index) => rank.set(entry.edge.id, index));
        const nonFlatMax = Math.max(buckets.up.length, buckets.down.length);
        buckets.flat.forEach((entry, index) => rank.set(entry.edge.id, nonFlatMax + index));
        return rank;
      };

      for (const [id, group] of outgoing) {
        const item = items.get(id);
        if (!item) continue;
        const port = nodePort(item, "right");
        const ranks = fanRanks(group, port.y, (edge) => edge.to, "left");
        for (const edge of group) {
          const current = ports.get(edge.id) || {};
          const rank = ranks.get(edge.id) || 0;
          const offset = Math.min(FAN_MAX, FAN_BASE + rank * FAN_STEP);
          current.a = port;
          current.aFan = { x: port.x + offset, y: port.y };
          current.aFanLimit = port.x + FAN_MAX + 2;
          ports.set(edge.id, current);
        }
      }

      for (const [id, group] of incoming) {
        const item = items.get(id);
        if (!item) continue;
        const port = nodePort(item, "left");
        const ranks = fanRanks(group, port.y, (edge) => edge.from, "right");
        for (const edge of group) {
          const current = ports.get(edge.id) || {};
          const rank = ranks.get(edge.id) || 0;
          const offset = Math.min(FAN_MAX, FAN_BASE + rank * FAN_STEP);
          current.b = port;
          current.bFan = { x: port.x - offset, y: port.y };
          current.bFanLimit = port.x - FAN_MAX - 2;
          ports.set(edge.id, current);
        }
      }
      return ports;
    }

    function sharedPortOverlapAllowed(a, b, currentEdge, segment) {
      if (!currentEdge || !segment) return false;
      const horizontal = Math.abs(a.y - b.y) < 0.001 && Math.abs(segment.a.y - segment.b.y) < 0.001;
      if (!horizontal) return false;

      if (segment.from === currentEdge.from) {
        const item = items.get(currentEdge.from);
        if (item) {
          const portX = item.x + item.width;
          const portY = nodePort(item, "right").y;
          const limit = portX + 62;
          const sameY = Math.abs(a.y - portY) < 0.001 && Math.abs(segment.a.y - portY) < 0.001;
          const inside = Math.max(a.x, b.x, segment.a.x, segment.b.x) <= limit + 0.001
            && Math.min(a.x, b.x, segment.a.x, segment.b.x) >= portX - 0.001;
          if (sameY && inside) return true;
        }
      }

      if (segment.to === currentEdge.to) {
        const item = items.get(currentEdge.to);
        if (item) {
          const portX = item.x;
          const portY = nodePort(item, "left").y;
          const limit = portX - 62;
          const sameY = Math.abs(a.y - portY) < 0.001 && Math.abs(segment.a.y - portY) < 0.001;
          const inside = Math.min(a.x, b.x, segment.a.x, segment.b.x) >= limit - 0.001
            && Math.max(a.x, b.x, segment.a.x, segment.b.x) <= portX + 0.001;
          if (sameY && inside) return true;
        }
      }
      return false;
    }

    function routeConflictPenalty(a, b, usedSegments, currentEdge = null) {
      let penalty = 0;
      for (const segment of usedSegments) {
        // Disjoint segments cannot cross or overlap (see routeBox()).
        if (segmentsApart(a, b, segment.a, segment.b)) continue;
        const conflict = orthogonalSegmentConflict(a, b, segment.a, segment.b);
        if (conflict.overlap > 0.5 && !sharedPortOverlapAllowed(a, b, currentEdge, segment)) {
          // Outside the tiny source/target fan, two routes must never share a
          // visible segment. Make overlap several orders of magnitude more
          // expensive than either a crossing or one extra bend.
          penalty += 1_000_000_000 + conflict.overlap * 100_000;
        }
        if (conflict.crossings) penalty += conflict.crossings * 28_000;
      }
      return penalty;
    }

    function orthogonalRouteForEdge(edge, start, end, usedSegments, port = {}) {
      const sourcePort = port.a || start;
      const targetPort = port.b || end;
      const sourceFan = port.aFan || { x: sourcePort.x + 18, y: sourcePort.y };
      const targetFan = port.bFan || { x: targetPort.x - 18, y: targetPort.y };
      const direction = targetFan.x >= sourceFan.x ? 1 : -1;

      // Keep routing local to the two endpoints: only obstacles intersecting
      // this edge's corridor participate in its sparse grid, so a route never
      // takes a giant detour around unrelated rows.
      const horizontalPad = 48;
      const verticalPad = Math.max(78, Math.min(138, 72 + Math.abs(targetFan.y - sourceFan.y) * 0.12));
      const localLeft = Math.min(sourceFan.x, targetFan.x) - horizontalPad;
      const localRight = Math.max(sourceFan.x, targetFan.x) + horizontalPad;
      const localTop = Math.min(sourceFan.y, targetFan.y) - verticalPad;
      const localBottom = Math.max(sourceFan.y, targetFan.y) + verticalPad;
      const obstacles = [];
      for (const [id, item] of itemList) {
        if (id === edge.from || id === edge.to) continue;
        const right = item.x + item.width;
        const bottom = item.y + item.height;
        if (right >= localLeft && item.x <= localRight && bottom >= localTop && item.y <= localBottom) obstacles.push(item);
      }

      const padding = 14;
      const xs = [sourceFan.x, targetFan.x, sourceFan.x + direction * 18, targetFan.x - direction * 18, localLeft, localRight];
      const ys = [sourceFan.y, targetFan.y, localTop, localBottom];

      // Route on the same global row grid used by the node layout. Horizontal
      // segments may occupy a node-row lane or a dedicated lane exactly between
      // rows. Secondary (dependency) edges prefer inter-row lanes so their
      // dashed paths do not weave through the data-flow corridors.
      for (const y of [...rowYs, ...betweenRowYs]) {
        if (y >= localTop - 0.001 && y <= localBottom + 0.001) ys.push(y);
      }
      const secondary = isSecondary(edge);
      const preferredHorizontalYs = secondary && betweenRowYs.length ? betweenRowYs : rowYs;
      // Distance to the nearest preferred lane, by binary search over the sorted
      // lanes and memoized per y. It is evaluated on every horizontal A* step.
      const sortedLaneYs = preferredHorizontalYs.slice().sort((a, b) => a - b);
      const lanePenaltyFactor = secondary ? 1.35 : 0.55;
      const lanePenaltyByY = new Map();
      const horizontalLanePenalty = (y) => {
        if (!sortedLaneYs.length) return 0;
        const cached = lanePenaltyByY.get(y);
        if (cached !== undefined) return cached;
        let lo = 0;
        let hi = sortedLaneYs.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sortedLaneYs[mid] < y) lo = mid + 1;
          else hi = mid;
        }
        let nearest = Infinity;
        if (lo < sortedLaneYs.length) nearest = Math.abs(sortedLaneYs[lo] - y);
        if (lo > 0) nearest = Math.min(nearest, Math.abs(sortedLaneYs[lo - 1] - y));
        const penalty = nearest * lanePenaltyFactor;
        lanePenaltyByY.set(y, penalty);
        return penalty;
      };

      for (const item of obstacles) {
        xs.push(item.x - padding, item.x + item.width + padding);
        ys.push(item.y - padding, item.y + item.height + padding);
      }
      // Existing routes expose neighbouring lanes only when they intersect this
      // local corridor. This prevents far-away edges from distorting the path.
      for (const segment of usedSegments) {
        const minSegX = Math.min(segment.a.x, segment.b.x);
        const maxSegX = Math.max(segment.a.x, segment.b.x);
        const minSegY = Math.min(segment.a.y, segment.b.y);
        const maxSegY = Math.max(segment.a.y, segment.b.y);
        if (maxSegX < localLeft || minSegX > localRight || maxSegY < localTop || minSegY > localBottom) continue;
        if (Math.abs(segment.a.x - segment.b.x) < 0.001) xs.push(segment.a.x - 10, segment.a.x + 10);
        if (Math.abs(segment.a.y - segment.b.y) < 0.001) ys.push(segment.a.y - 10, segment.a.y + 10);
      }

      const uniqueSorted = (values) => values.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
        .filter((value, index, arr) => index === 0 || Math.abs(value - arr[index - 1]) > 0.01);
      const gridX = uniqueSorted(xs);
      const gridY = uniqueSorted(ys);
      // The sparse grid is |xs| x |ys| points. On very large lineage graphs a
      // single corridor can span thousands of rows (millions of points) and
      // freeze the tab for minutes. Past this budget the edge gets a plain
      // orthogonal H-V-H route; ordinary graphs stay far below it.
      if (gridX.length * gridY.length > ROUTE_GRID_POINT_BUDGET) {
        const midX = sourceFan.x + (targetFan.x - sourceFan.x) / 2;
        return assembleOrthogonalRoute(sourcePort, sourceFan, compressOrthogonalRoute([
          sourceFan,
          { x: midX, y: sourceFan.y },
          { x: midX, y: targetFan.y },
          targetFan,
        ]), targetFan, targetPort);
      }
      // Every grid point lies inside [gridX] x [gridY], so a routed segment whose
      // box is apart from that rectangle is apart from every candidate step and
      // contributes exactly 0 in routeConflictPenalty(). Filter once per edge.
      const gridCornerA = { x: gridX[0], y: gridY[0] };
      const gridCornerB = { x: gridX[gridX.length - 1], y: gridY[gridY.length - 1] };
      const corridorSegments = usedSegments.filter((segment) => !segmentsApart(gridCornerA, gridCornerB, segment.a, segment.b));
      const corridorSegmentIndex = createSegmentYIndex(corridorSegments, gridCornerA.y, gridCornerB.y);

      const clearSegment = (a, b) => !obstacles.some((item) => segmentHitsItem(a, b, item, padding));
      const verticalDelta = targetFan.y - sourceFan.y;
      const verticalDirection = verticalDelta < -0.001 ? -1 : (verticalDelta > 0.001 ? 1 : 0);
      // Same-row links are the only case allowed to move away from the target row
      // and then come back: that detour is necessary when a card blocks the
      // straight horizontal channel. For up/down links the vertical coordinate
      // is strictly monotone from source row to destination row.
      const sameRowNeedsDetour = verticalDirection === 0 && !clearSegment(sourceFan, targetFan);

      // One A* relaxation: the cost of moving from `currentPoint` to
      // `nextPoint` in direction `dir` ("H" / "V"), or null when the move is
      // not allowed.
      const stepCost = (currentCost, currentDir, currentPoint, nextPoint, dir, length) => {
        const dx = nextPoint.x - currentPoint.x;
        const dy = nextPoint.y - currentPoint.y;
        // Left-to-right DAG links never backtrack horizontally. Backward graph
        // edges use the mirrored rule. This removes rectangular loops that can
        // only make a route longer and harder to read.
        if (direction > 0 && dx < -0.001) return null;
        if (direction < 0 && dx > 0.001) return null;
        if (dir === "V") {
          if (verticalDirection < 0) {
            if (dy > 0.001 || nextPoint.y < targetFan.y - 0.001) return null;
          } else if (verticalDirection > 0) {
            if (dy < -0.001 || nextPoint.y > targetFan.y + 0.001) return null;
          } else if (!sameRowNeedsDetour && Math.abs(dy) > 0.001) {
            return null;
          }
        }
        // Angles are deliberately expensive: for a clean DAG a short route
        // with 2 bends is preferable to a maze of small detours.
        const bend = currentDir !== "N" && currentDir !== dir ? 220 : 0;
        const conflict = routeConflictPenalty(currentPoint, nextPoint, corridorSegmentIndex.near(currentPoint, nextPoint), edge);
        const reverse = dir === "H" && direction * (nextPoint.x - currentPoint.x) < -0.001 ? 1400 : 0;
        const boundary = nextPoint.x < localLeft - 0.01 || nextPoint.x > localRight + 0.01
          || nextPoint.y < localTop - 0.01 || nextPoint.y > localBottom + 0.01 ? 20_000 : 0;
        const lane = dir === "H" ? horizontalLanePenalty(nextPoint.y) : 0;
        return currentCost + length + bend + conflict + reverse + boundary + lane;
      };
      const heuristic = (point) => Math.abs(point.x - targetFan.x) + Math.abs(point.y - targetFan.y);

      const ixStart = gridX.indexOf(sourceFan.x);
      const iyStart = gridY.indexOf(sourceFan.y);
      const ixEnd = gridX.indexOf(targetFan.x);
      const iyEnd = gridY.indexOf(targetFan.y);
      let found;
      if (ixStart >= 0 && iyStart >= 0 && ixEnd >= 0 && iyEnd >= 0) {
        found = searchIndexedGrid();
      } else {
        found = searchKeyedGrid();
      }

      // The sparse grid as typed arrays: point id = ix * |gridY| + iy, the
      // obstacles marked per covered cell, each lane's consecutive free points
      // linked when no card cuts the segment between them. Same points, the
      // same neighbour order (left, right, up, down) and the same A* as
      // searchKeyedGrid(), without string keys, per-point obstacle scans or
      // per-lane sorts (they made the router take seconds on 500-edge graphs).
      function searchIndexedGrid() {
        const NX = gridX.length;
        const NY = gridY.length;
        const total = NX * NY;
        const buffers = gridBuffers(total);
        const blocked = buffers.blocked;
        const inner = padding - 0.5;
        const firstAbove = (values, limit) => {
          let lo = 0;
          let hi = values.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[mid] <= limit) lo = mid + 1;
            else hi = mid;
          }
          return lo;
        };
        const firstAtLeast = (values, limit) => {
          let lo = 0;
          let hi = values.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[mid] < limit) lo = mid + 1;
            else hi = mid;
          }
          return lo;
        };
        for (const item of obstacles) {
          // pointInsideItem(point, item, padding - 0.5): strict inequalities.
          const x0 = firstAbove(gridX, item.x - inner);
          const x1 = firstAtLeast(gridX, item.x + item.width + inner) - 1;
          const y0 = firstAbove(gridY, item.y - inner);
          const y1 = firstAtLeast(gridY, item.y + item.height + inner) - 1;
          for (let ix = x0; ix <= x1; ix += 1) {
            const base = ix * NY;
            for (let iy = y0; iy <= y1; iy += 1) blocked[base + iy] = 1;
          }
        }
        const start = ixStart * NY + iyStart;
        const end = ixEnd * NY + iyEnd;
        blocked[start] = 0;
        blocked[end] = 0;

        const { left, right, up, down } = buffers;
        // segmentHitsItem(a, b, item, padding) for a horizontal segment.
        for (let iy = 0; iy < NY; iy += 1) {
          const y = gridY[iy];
          const cutting = obstacles.filter((item) => !(y <= item.y - padding || y >= item.y + item.height + padding));
          let previousIx = -1;
          for (let ix = 0; ix < NX; ix += 1) {
            const id = ix * NY + iy;
            if (blocked[id]) continue;
            if (previousIx >= 0) {
              const lo = gridX[previousIx];
              const hi = gridX[ix];
              let clear = true;
              for (const item of cutting) {
                if (hi > item.x - padding && lo < item.x + item.width + padding) { clear = false; break; }
              }
              if (clear) {
                const previousId = previousIx * NY + iy;
                right[previousId] = id;
                left[id] = previousId;
              }
            }
            previousIx = ix;
          }
        }
        // ... and for a vertical one.
        for (let ix = 0; ix < NX; ix += 1) {
          const x = gridX[ix];
          const cutting = obstacles.filter((item) => !(x <= item.x - padding || x >= item.x + item.width + padding));
          const base = ix * NY;
          let previousIy = -1;
          for (let iy = 0; iy < NY; iy += 1) {
            const id = base + iy;
            if (blocked[id]) continue;
            if (previousIy >= 0) {
              const lo = gridY[previousIy];
              const hi = gridY[iy];
              let clear = true;
              for (const item of cutting) {
                if (hi > item.y - padding && lo < item.y + item.height + padding) { clear = false; break; }
              }
              if (clear) {
                down[base + previousIy] = id;
                up[id] = base + previousIy;
              }
            }
            previousIy = iy;
          }
        }

        const pointOf = (id) => ({ x: gridX[(id / NY) | 0], y: gridY[id % NY] });
        // States: id * 3 + direction (0 = none yet, 1 = H, 2 = V).
        const DIRS = ["N", "H", "V"];
        const { best, previous } = buffers;
        best[start * 3] = 0;
        const queue = createRouteQueue();
        queue.push({ s: start * 3, cost: 0 }, 0 + heuristic(pointOf(start)));
        let finalState = -1;
        while (queue.size()) {
          const current = queue.pop();
          if (current.cost !== best[current.s]) continue;
          const id = (current.s / 3) | 0;
          if (id === end) { finalState = current.s; break; }
          const currentDir = DIRS[current.s % 3];
          const currentPoint = pointOf(id);
          for (let k = 0; k < 4; k += 1) {
            const nextId = k === 0 ? left[id] : k === 1 ? right[id] : k === 2 ? up[id] : down[id];
            if (nextId < 0) continue;
            const dir = k < 2 ? "H" : "V";
            const nextPoint = pointOf(nextId);
            const length = Math.abs(currentPoint.x - nextPoint.x) + Math.abs(currentPoint.y - nextPoint.y);
            const cost = stepCost(current.cost, currentDir, currentPoint, nextPoint, dir, length);
            if (cost === null) continue;
            const nextState = nextId * 3 + (k < 2 ? 1 : 2);
            if (cost + 0.001 >= best[nextState]) continue;
            best[nextState] = cost;
            previous[nextState] = current.s;
            queue.push({ s: nextState, cost }, cost + heuristic(nextPoint));
          }
        }
        if (finalState < 0) return null;
        const body = [];
        for (let s = finalState; s >= 0; s = previous[s]) body.push(pointOf((s / 3) | 0));
        body.reverse();
        return compressOrthogonalRoute(body);
      }

      // The reference implementation (string-keyed points), used when a fan
      // point is not exactly on the deduplicated grid.
      function searchKeyedGrid() {
      const pointKey = (x, y) => `${x}\u0000${y}`;
      const points = new Map();
      for (const x of gridX) {
        for (const y of gridY) {
          const point = { x, y };
          if (obstacles.some((item) => pointInsideItem(point, item, padding - 0.5))) continue;
          points.set(pointKey(x, y), point);
        }
      }
      points.set(pointKey(sourceFan.x, sourceFan.y), sourceFan);
      points.set(pointKey(targetFan.x, targetFan.y), targetFan);
      const adjacency = new Map([...points.keys()].map((key) => [key, []]));
      const connectLine = (keys, horizontal) => {
        keys.sort((ka, kb) => {
          const a = points.get(ka);
          const b = points.get(kb);
          return horizontal ? a.x - b.x : a.y - b.y;
        });
        for (let i = 0; i + 1 < keys.length; i += 1) {
          const aKey = keys[i];
          const bKey = keys[i + 1];
          const a = points.get(aKey);
          const b = points.get(bKey);
          if (!clearSegment(a, b)) continue;
          const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
          const dir = horizontal ? "H" : "V";
          adjacency.get(aKey).push({ key: bKey, length, dir });
          adjacency.get(bKey).push({ key: aKey, length, dir });
        }
      };
      // Bucket the grid once per axis; connectLine() sorts each lane by
      // coordinate, so bucket order cannot change the result.
      const keysByY = new Map();
      const keysByX = new Map();
      for (const [key, point] of points) {
        if (!keysByY.has(point.y)) keysByY.set(point.y, []);
        keysByY.get(point.y).push(key);
        if (!keysByX.has(point.x)) keysByX.set(point.x, []);
        keysByX.get(point.x).push(key);
      }
      for (const y of gridY) connectLine((keysByY.get(y) || []).slice(), true);
      for (const x of gridX) connectLine((keysByX.get(x) || []).slice(), false);

      const startKey = pointKey(sourceFan.x, sourceFan.y);
      const endKey = pointKey(targetFan.x, targetFan.y);
      const best = new Map([[`${startKey}\u0000N`, 0]]);
      const previous = new Map();
      let finalState = null;
      const queue = createRouteQueue();
      const pushState = (state) => queue.push(state, state.cost + heuristic(points.get(state.key)));
      pushState({ key: startKey, dir: "N", cost: 0 });

      while (queue.size()) {
        const current = queue.pop();
        const stateKey = `${current.key}\u0000${current.dir}`;
        if (current.cost !== best.get(stateKey)) continue;
        if (current.key === endKey) { finalState = current; break; }
        const currentPoint = points.get(current.key);
        for (const next of adjacency.get(current.key) || []) {
          const nextPoint = points.get(next.key);
          const cost = stepCost(current.cost, current.dir, currentPoint, nextPoint, next.dir, next.length);
          if (cost === null) continue;
          const nextStateKey = `${next.key}\u0000${next.dir}`;
          if (cost + 0.001 >= (best.get(nextStateKey) ?? Infinity)) continue;
          best.set(nextStateKey, cost);
          previous.set(nextStateKey, stateKey);
          pushState({ key: next.key, dir: next.dir, cost });
        }
      }
      if (!finalState) return null;
      const body = [];
      let stateKey = `${finalState.key}\u0000${finalState.dir}`;
      while (stateKey) {
        const split = stateKey.lastIndexOf("\u0000");
        const key = stateKey.slice(0, split);
        body.push(points.get(key));
        stateKey = previous.get(stateKey) || null;
      }
      body.reverse();
      return compressOrthogonalRoute(body);
      }

      let body = found;
      if (!body) {
        const score = (route) => polylineMetric(route).total
          + routeBendCount(route) * 220
          + route.slice(0, -1).reduce((sum, point, index) => sum + routeConflictPenalty(point, route[index + 1], usedSegments, edge), 0);
        if (verticalDirection !== 0) {
          // Preserve the source->destination vertical direction even in the
          // fallback. Try simple H-V-H lanes on the existing sparse grid; a link
          // going upward can therefore never dip down and vice versa.
          const minX = Math.min(sourceFan.x, targetFan.x) - 0.001;
          const maxX = Math.max(sourceFan.x, targetFan.x) + 0.001;
          const candidateXs = gridX.filter((x) => x >= minX && x <= maxX)
            .sort((a, b) => Math.abs(a - (sourceFan.x + targetFan.x) / 2) - Math.abs(b - (sourceFan.x + targetFan.x) / 2));
          const candidates = candidateXs.map((laneX) => compressOrthogonalRoute([
            sourceFan,
            { x: laneX, y: sourceFan.y },
            { x: laneX, y: targetFan.y },
            targetFan,
          ])).filter((route) => route.slice(0, -1).every((point, index) => clearSegment(point, route[index + 1])));
          candidates.sort((a, b) => score(a) - score(b));
          body = candidates[0] || compressOrthogonalRoute([
            sourceFan,
            { x: sourceFan.x + direction * 18, y: sourceFan.y },
            { x: sourceFan.x + direction * 18, y: targetFan.y },
            targetFan,
          ]);
        } else {
          // Same-row obstacle exception: a short top/bottom detour is allowed,
          // because remaining on the row would pass through another node.
          const fallbackTop = Math.min(localTop, ...obstacles.map((item) => item.y - padding - 24));
          const fallbackBottom = Math.max(localBottom, ...obstacles.map((item) => item.y + item.height + padding + 24));
          const candidates = [fallbackTop, fallbackBottom].map((channelY) => compressOrthogonalRoute([
            sourceFan,
            { x: sourceFan.x + direction * 18, y: sourceFan.y },
            { x: sourceFan.x + direction * 18, y: channelY },
            { x: targetFan.x - direction * 18, y: channelY },
            { x: targetFan.x - direction * 18, y: targetFan.y },
            targetFan,
          ])).filter((route) => route.slice(0, -1).every((point, index) => clearSegment(point, route[index + 1])));
          candidates.sort((a, b) => score(a) - score(b));
          body = candidates[0] || compressOrthogonalRoute([
            sourceFan,
            { x: sourceFan.x + direction * 18, y: sourceFan.y },
            { x: sourceFan.x + direction * 18, y: fallbackTop },
            { x: targetFan.x - direction * 18, y: fallbackTop },
            { x: targetFan.x - direction * 18, y: targetFan.y },
            targetFan,
          ]);
        }
      }

      return assembleOrthogonalRoute(sourcePort, sourceFan, body, targetFan, targetPort);
    }

    function routePairConflictScore(routeA, edgeA, routeB, edgeB) {
      let score = 0;
      if (routeBoxesApart(routeBox(routeA), routeBox(routeB))) return score;
      const segmentsA = routeSegmentMeta(routeA, edgeA);
      const segmentsB = routeSegmentMeta(routeB, edgeB);
      for (const a of segmentsA) {
        for (const b of segmentsB) {
          if (segmentsApart(a.a, a.b, b.a, b.b)) continue;
          const conflict = orthogonalSegmentConflict(a.a, a.b, b.a, b.b);
          const sharedFan = sharedPortOverlapAllowed(a.a, a.b, edgeA, b)
            || sharedPortOverlapAllowed(b.a, b.b, edgeB, a);
          if (conflict.crossings) score += conflict.crossings * 28_000;
          if (conflict.overlap > 0.5 && !sharedFan) score += 1_000_000_000 + conflict.overlap * 100_000;
        }
      }
      return score;
    }

    function routeSetScore(routes, edgesById) {
      const entries = [...routes.entries()];
      let score = 0;
      for (let i = 0; i < entries.length; i += 1) {
        const [idA, routeA] = entries[i];
        const edgeA = edgesById.get(idA);
        if (!edgeA) continue;
        // Prefer the simplest readable geometry once overlap/crossing safety is
        // satisfied. A bend is intentionally much more expensive than a modest
        // length difference, so the router does not create rectangular detours.
        score += polylineMetric(routeA.points).total * 0.02;
        score += routeBendCount(routeA.points) * 180;
        for (let j = i + 1; j < entries.length; j += 1) {
          const [idB, routeB] = entries[j];
          const edgeB = edgesById.get(idB);
          if (!edgeB) continue;
          score += routePairConflictScore(routeA.points, edgeA, routeB.points, edgeB);
        }
      }
      return score;
    }

    function buildRouteCandidate(ordered, ports) {
      const usedSegments = [];
      const routes = new Map();
      for (const edge of ordered) {
        const from = items.get(edge.from);
        const to = items.get(edge.to);
        if (!from || !to) continue;
        const port = ports.get(edge.id) || {};
        const a = port.a || nodePort(from, "right");
        const b = port.b || nodePort(to, "left");
        const points = orthogonalRouteForEdge(edge, a, b, usedSegments, port);
        routes.set(edge.id, { points, a, b });
        usedSegments.push(...routeSegmentMeta(points, edge));
      }
      return routes;
    }

    function improveRouteCandidate(initialRoutes, list, ports, edgesById) {
      let routes = initialRoutes;
      let score = routeSetScore(routes, edgesById);
      // Rip-up/reroute the most conflicted edge against the rest of the already
      // accepted graph. Four bounded passes are enough to resolve most local
      // order artefacts while keeping graphs deterministic and cheap.
      for (let pass = 0; pass < 4; pass += 1) {
        const conflictByEdge = new Map(list.map((edge) => [edge.id, 0]));
        const entries = [...routes.entries()];
        for (let i = 0; i < entries.length; i += 1) {
          const [idA, routeA] = entries[i];
          const edgeA = edgesById.get(idA);
          if (!edgeA) continue;
          for (let j = i + 1; j < entries.length; j += 1) {
            const [idB, routeB] = entries[j];
            const edgeB = edgesById.get(idB);
            if (!edgeB) continue;
            const conflict = routePairConflictScore(routeA.points, edgeA, routeB.points, edgeB);
            if (!conflict) continue;
            conflictByEdge.set(idA, (conflictByEdge.get(idA) || 0) + conflict);
            conflictByEdge.set(idB, (conflictByEdge.get(idB) || 0) + conflict);
          }
        }
        const conflicted = list.slice().sort((a, b) => (conflictByEdge.get(b.id) || 0) - (conflictByEdge.get(a.id) || 0) || String(a.id).localeCompare(String(b.id)));
        let improved = false;
        for (const edge of conflicted.slice(0, 8)) {
          if (!(conflictByEdge.get(edge.id) > 0)) break;
          const from = items.get(edge.from);
          const to = items.get(edge.to);
          if (!from || !to) continue;
          const usedSegments = [];
          for (const [otherId, otherRoute] of routes) {
            if (otherId === edge.id) continue;
            const otherEdge = edgesById.get(otherId);
            if (!otherEdge) continue;
            usedSegments.push(...routeSegmentMeta(otherRoute.points, otherEdge));
          }
          const port = ports.get(edge.id) || {};
          const a = port.a || nodePort(from, "right");
          const b = port.b || nodePort(to, "left");
          const points = orthogonalRouteForEdge(edge, a, b, usedSegments, port);
          const candidate = new Map(routes);
          candidate.set(edge.id, { points, a, b });
          const candidateScore = routeSetScore(candidate, edgesById);
          if (candidateScore + 0.001 < score) {
            routes = candidate;
            score = candidateScore;
            improved = true;
            break;
          }
        }
        if (!improved) break;
      }
      return routes;
    }

    const ports = routePortMaps(edges);
    const edgesById = new Map(edges.map((edge) => [edge.id, edge]));
    const baseCompare = (a, b) => {
      const aSecondary = isSecondary(a) ? 1 : 0;
      const bSecondary = isSecondary(b) ? 1 : 0;
      if (aSecondary !== bSecondary) return aSecondary - bSecondary;
      const af = items.get(a.from);
      const bf = items.get(b.from);
      const at = items.get(a.to);
      const bt = items.get(b.to);
      return (af?.x ?? 0) - (bf?.x ?? 0)
        || (af?.y ?? 0) - (bf?.y ?? 0)
        // Fan-out follows target vertical order: low destinations are routed
        // after high destinations and leave through the lower fan lane.
        || ((at?.y ?? 0) + (at?.height ?? 0) / 2) - ((bt?.y ?? 0) + (bt?.height ?? 0) / 2)
        || String(a.id).localeCompare(String(b.id));
    };
    const base = edges.slice().sort(baseCompare);
    const verticalFirst = edges.slice().sort((a, b) => {
      const af = items.get(a.from);
      const at = items.get(a.to);
      const bf = items.get(b.from);
      const bt = items.get(b.to);
      const aSpan = Math.abs(((at?.y ?? 0) + (at?.height ?? 0) / 2) - ((af?.y ?? 0) + (af?.height ?? 0) / 2));
      const bSpan = Math.abs(((bt?.y ?? 0) + (bt?.height ?? 0) / 2) - ((bf?.y ?? 0) + (bf?.height ?? 0) / 2));
      return bSpan - aSpan || baseCompare(a, b);
    });

    // Routing is path-dependent because every accepted edge reserves channels.
    // Evaluate two deterministic orders (normal fan order and long-span first)
    // and keep the globally cleaner result, then rip up and reroute.
    const candidates = [buildRouteCandidate(base, ports)];
    if (edges.length > 1 && edges.length <= 90) candidates.push(buildRouteCandidate(verticalFirst, ports));
    candidates.sort((a, b) => routeSetScore(a, edgesById) - routeSetScore(b, edgesById));
    const bestRoutes = candidates[0] || new Map();
    return improveRouteCandidate(bestRoutes, edges, ports, edgesById);
  }

  // ------------------------------------------------------------ edge labels

  // Label positions to try, best first:
  //   1. on the line: the middle of each horizontal run (the gaps between
  //      columns), longest first, with its thirds on long runs; then the
  //      middle (and thirds) of each vertical run;
  //   2. on the line, densely: every 14 px along every segment;
  //   3. beside the line: those points shifted just above / below a
  //      horizontal segment, or left / right of a vertical one;
  //   4. the middle of the route.
  // Dense layouts (sub-columns 28 px apart) still find a free spot for most
  // labels without covering a card or another label.
  function labelAnchors(points, labelHeight = 18, labelWidth = 40) {
    if (!Array.isArray(points) || points.length < 2) return [];
    const runs = [];
    const verticals = [];
    const dense = [];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const horizontal = Math.abs(a.y - b.y) <= 0.5;
      const vertical = Math.abs(a.x - b.x) <= 0.5;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (horizontal && length >= 36) {
        runs.push({ length, x: (a.x + b.x) / 2, y: a.y });
        // Long runs also offer their thirds, so siblings sharing the first
        // part of a fan do not all compete for the same middle.
        if (length >= 150) {
          runs.push({ length: length - 1, x: a.x + (b.x - a.x) * 0.72, y: a.y });
          runs.push({ length: length - 2, x: a.x + (b.x - a.x) * 0.28, y: a.y });
        }
      } else if (vertical && length >= labelHeight + 16) {
        verticals.push({ length, x: a.x, y: (a.y + b.y) / 2 });
        if (length >= 120) {
          verticals.push({ length: length - 1, x: a.x, y: a.y + (b.y - a.y) * 0.3 });
          verticals.push({ length: length - 2, x: a.x, y: a.y + (b.y - a.y) * 0.7 });
        }
      }
      if ((horizontal || vertical) && length >= 12) {
        for (let at = 6; at <= length - 6; at += 14) {
          const t = at / length;
          dense.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, horizontal });
        }
      }
    }
    runs.sort((p, q) => q.length - p.length);
    verticals.sort((p, q) => q.length - p.length);
    const dy = labelHeight / 2 + 3;
    const dx = labelWidth / 2 + 3;
    const beside = [];
    for (const run of runs) beside.push({ x: run.x, y: run.y - dy }, { x: run.x, y: run.y + dy });
    for (const run of verticals) beside.push({ x: run.x + dx, y: run.y }, { x: run.x - dx, y: run.y });
    for (const point of dense) {
      if (point.horizontal) beside.push({ x: point.x, y: point.y - dy }, { x: point.x, y: point.y + dy });
      else beside.push({ x: point.x + dx, y: point.y }, { x: point.x - dx, y: point.y });
    }
    return [...runs, ...verticals, ...dense, ...beside, routePoint(points, 0.5)];
  }

  // Spatial hash of rectangles for the label placement.
  function createRectIndex(cell = 160) {
    const cells = new Map();
    const keysOf = (rect) => {
      const keys = [];
      const x0 = Math.floor(rect.x / cell);
      const x1 = Math.floor((rect.x + rect.width) / cell);
      const y0 = Math.floor(rect.y / cell);
      const y1 = Math.floor((rect.y + rect.height) / cell);
      for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) keys.push(`${x}:${y}`);
      return keys;
    };
    return {
      add(rect) {
        for (const key of keysOf(rect)) {
          let list = cells.get(key);
          if (!list) { list = []; cells.set(key, list); }
          list.push(rect);
        }
      },
      hits(rect, padding) {
        const probe = { x: rect.x - padding, y: rect.y - padding, width: rect.width + padding * 2, height: rect.height + padding * 2 };
        for (const key of keysOf(probe)) {
          for (const other of cells.get(key) || []) if (rectsOverlap(rect, other, padding)) return true;
        }
        return false;
      },
    };
  }

  // Places every label once per layout, in priority order, at the first
  // anchor that covers neither a card nor another label. The placement never
  // depends on hover or selection (a highlighted label is only drawn in its
  // highlight style where it was placed), so labels never jump nor overlap.
  //   requests = [{ key, text, width, height = 18, points }]
  // Returns { placed: Map(key -> rect), dropped: [key] }.
  function placeLabels(requests, obstacles) {
    const cards = createRectIndex();
    for (const rect of obstacles) cards.add(rect);
    const labels = createRectIndex();
    const placed = new Map();
    const dropped = [];
    for (const request of requests) {
      const width = request.width;
      const height = request.height || 18;
      const boxOf = (anchor) => ({ x: anchor.x - width / 2, y: anchor.y - height / 2, width, height });
      let rect = null;
      for (const anchor of labelAnchors(request.points, height, width)) {
        const box = boxOf(anchor);
        if (cards.hits(box, 2) || labels.hits(box, 3)) continue;
        rect = box;
        break;
      }
      if (!rect) { dropped.push(request.key); continue; }
      labels.add(rect);
      placed.set(request.key, rect);
    }
    return { placed, dropped };
  }

  function drawLabel(ctx, rect, text, { highlighted = false, alpha = 1, textColor = null } = {}) {
    ctx.save();
    ctx.globalAlpha = alpha;
    roundRect(ctx, rect.x, rect.y, rect.width, rect.height, rect.height / 2);
    ctx.fillStyle = color("labelBg");
    ctx.fill();
    ctx.strokeStyle = highlighted ? color("halo") : color("border");
    ctx.lineWidth = highlighted ? 1.4 : 0.9;
    ctx.stroke();
    ctx.fillStyle = textColor || (highlighted ? color("accentText") : color("muted"));
    ctx.textAlign = "center";
    ctx.fillText(text, rect.x + rect.width / 2, rect.y + rect.height / 2 + 4.5);
    ctx.textAlign = "left";
    ctx.restore();
  }

  // ---------------------------------------------------------------- minimap

  // Is any part of a card outside the viewport? One pixel is enough to make
  // the minimap useful.
  function anyClipped(rects, view, width, height) {
    if (!width || !height || !(view.scale > 0)) return false;
    const epsilon = 0.5;
    for (const item of rects) {
      const left = item.x * view.scale + view.offsetX;
      const top = item.y * view.scale + view.offsetY;
      const right = (item.x + item.width) * view.scale + view.offsetX;
      const bottom = (item.y + item.height) * view.scale + view.offsetY;
      if (left < -epsilon || top < -epsilon || right > width + epsilon || bottom > height + epsilon) return true;
    }
    return false;
  }

  // The whole graph in the corner: routed edges with their dash pattern,
  // cards, and the viewport rectangle.
  //   options = { bounds, nodes: [{ x, y, width, height, alpha }],
  //               edges: [{ points, dash, width, color }], view, width, height }
  function drawMinimap(canvas, options) {
    const ctx = canvas?.getContext?.("2d");
    const bounds = options.bounds;
    if (!ctx || !bounds) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color("minimapBg");
    ctx.fillRect(0, 0, width, height);
    const scale = Math.min((width - 12) / bounds.width, (height - 12) / bounds.height);
    const ox = 6 - bounds.x * scale;
    const oy = 6 - bounds.y * scale;
    ctx.save();
    ctx.globalAlpha = 0.48;
    for (const edge of options.edges || []) {
      const points = edge.points;
      if (!Array.isArray(points) || points.length < 2) continue;
      const mapped = points.map((point) => ({ x: ox + point.x * scale, y: oy + point.y * scale }));
      ctx.strokeStyle = edge.color || color("edge");
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = Math.max(0.7, Math.min(1.4, edge.width || 1));
      ctx.setLineDash((edge.dash || []).map((value) => Math.max(1, value * Math.max(0.25, scale))));
      strokePolyline(ctx, mapped);
      ctx.setLineDash([]);
      const tip = mapped[mapped.length - 1];
      const near = mapped[mapped.length - 2];
      const angle = Math.atan2(tip.y - near.y, tip.x - near.x);
      const arrow = 3;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - arrow * Math.cos(angle - 0.55), tip.y - arrow * Math.sin(angle - 0.55));
      ctx.lineTo(tip.x - arrow * Math.cos(angle + 0.55), tip.y - arrow * Math.sin(angle + 0.55));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = color("muted");
    for (const item of options.nodes || []) {
      ctx.globalAlpha = item.alpha ?? 0.62;
      ctx.fillRect(ox + item.x * scale, oy + item.y * scale, Math.max(2, item.width * scale), Math.max(2, item.height * scale));
    }
    ctx.globalAlpha = 1;
    const view = options.view;
    if (view && view.scale > 0) {
      const x = ox + (-view.offsetX / view.scale) * scale;
      const y = oy + (-view.offsetY / view.scale) * scale;
      const w = (options.width / view.scale) * scale;
      const h = (options.height / view.scale) * scale;
      ctx.fillStyle = color("minimapViewFill");
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = color("minimapView");
      ctx.lineWidth = isLight() ? 1.6 : 1;
      ctx.strokeRect(x, y, w, h);
    }
  }

  // ------------------------------------------------------------- the view

  // The part of a graph canvas its own chrome leaves free, in CSS pixels from
  // the canvas' top-left corner: below the toolbar groups, above the legend /
  // status dock, and beside an open side panel (left of it on desktop, above
  // the bottom sheet on phones). Fit and recentring aim at this area, so
  // cards and edge labels do not land under the chrome. The bands span the
  // whole width: the dock sits in a corner, where a centred graph would
  // otherwise reach it, and its band also clears the minimap's corner (the
  // minimap only shows once the graph is clipped, so a fit never needs it).
  const SAFE_GAP = 8;
  function safeArea(canvas, { panel = null } = {}) {
    const rect = canvas?.getBoundingClientRect?.();
    if (!rect || !rect.width || !rect.height) return { x: 0, y: 0, width: rect?.width || 0, height: rect?.height || 0 };
    const pane = canvas.parentElement;
    const shown = (node) => !!node && !node.hidden && node.getClientRects().length > 0;
    let top = 0;
    let bottom = rect.height;
    let right = rect.width;
    const bar = pane?.querySelector(":scope > .graphKitBar");
    for (const group of bar?.children || []) {
      if (shown(group)) top = Math.max(top, group.getBoundingClientRect().bottom - rect.top + SAFE_GAP);
    }
    const dock = pane?.querySelector(":scope > .graphKitDock");
    if (shown(dock)) {
      const box = dock.getBoundingClientRect();
      if (box.height > 0) bottom = Math.min(bottom, box.top - rect.top - SAFE_GAP);
    }
    if (panel && panel.width && panel.height) {
      if (mobileLayout()) bottom = Math.min(bottom, panel.top - rect.top);
      else right = Math.min(right, panel.left - rect.left);
    }
    // A tiny canvas keeps a usable area (the chrome then overlaps).
    top = Math.min(Math.max(0, top), rect.height * 0.4);
    bottom = Math.max(bottom, top + Math.min(80, rect.height - top));
    right = Math.max(right, Math.min(rect.width, 120));
    return { x: 0, y: top, width: right, height: bottom - top };
  }

  // Fit transform of a world box into a width x height viewport, or into
  // `area` (a safeArea() rectangle) when given.
  function fitTransform(bounds, width, height, { maxScale = 1.35, minScale = MIN_SCALE, margin = 0.92, area = null } = {}) {
    if (!bounds || !width || !height) return null;
    const box = area && area.width > 0 && area.height > 0 ? area : { x: 0, y: 0, width, height };
    const scale = Math.max(minScale, Math.min(maxScale, Math.min(box.width / bounds.width, box.height / bounds.height) * margin));
    return {
      scale,
      offsetX: box.x + box.width / 2 - (bounds.x + bounds.width / 2) * scale,
      offsetY: box.y + box.height / 2 - (bounds.y + bounds.height / 2) * scale,
    };
  }

  // Keeps at least a margin of the graph inside the viewport.
  function clampView(view, bounds, width, height) {
    if (!bounds || !width || !height || !(view.scale > 0)) return;
    const marginX = Math.min(72, Math.max(24, width * 0.18));
    const marginY = Math.min(72, Math.max(24, height * 0.18));
    const minX = marginX - (bounds.x + bounds.width) * view.scale;
    const maxX = width - marginX - bounds.x * view.scale;
    const minY = marginY - (bounds.y + bounds.height) * view.scale;
    const maxY = height - marginY - bounds.y * view.scale;
    view.offsetX = Math.max(Math.min(minX, maxX), Math.min(Math.max(minX, maxX), view.offsetX));
    view.offsetY = Math.max(Math.min(minY, maxY), Math.min(Math.max(minY, maxY), view.offsetY));
  }

  const KEY_DIRECTIONS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  // Pan / zoom / keyboard / hover / click controller of one graph canvas.
  //   options = {
  //     canvas, view: { scale, offsetX, offsetY } (mutated in place),
  //     active() -> bool, draw(ctx, frame) -> keep animating?,
  //     bounds() -> world box, minScale() -> number, fit(),
  //     hit(clientX, clientY) -> target { key, type, disabled } | null,
  //     onHover(target), onClick(target, event),
  //     nodes() -> [{ id, x, y, width, height }] (keyboard order),
  //     target(id) -> the hover target of a node, describe(id) -> text,
  //     onActivate(id), onEscape() -> handled?, onViewChange(kind),
  //     panelRect() -> DOMRect of an open side panel or null,
  //     toolbar: { zoomIn, zoomOut, fit }, onResize(), clamp: bool }
  function mount(options) {
    const canvas = options.canvas;
    const view = options.view;
    const control = { frame: 0, drag: null, pinch: null, hovered: null, keyboardId: null, animation: 0 };
    const live = document.createElement("p");
    live.className = "srOnly";
    live.setAttribute("aria-live", "polite");
    canvas.parentElement?.append(live);
    canvas.classList.add("graphKit__canvas");

    const active = () => (options.active ? options.active() : true);
    const size = () => canvasSize(canvas);
    const minScale = () => Math.max(MIN_SCALE * 0.5, Number(options.minScale?.()) || MIN_SCALE);
    const clamp = () => {
      if (options.clamp === false) return;
      const { width, height } = canvas.getBoundingClientRect();
      clampView(view, options.bounds?.(), width, height);
    };

    function draw(now = performance.now()) {
      control.frame = 0;
      if (!active()) return;
      const { width, height, dpr } = size();
      if (!width || !height) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      drawBackground(ctx, view, width, height, dpr);
      const animate = options.draw(ctx, { width, height, dpr, now, keyboardId: control.keyboardId });
      if (animate && active() && !control.frame) control.frame = requestAnimationFrame(draw);
    }

    function scheduleDraw() {
      if (!active() || control.frame) return;
      control.frame = requestAnimationFrame(draw);
    }

    function cancel() {
      if (control.frame) cancelAnimationFrame(control.frame);
      control.frame = 0;
      stopAnimation();
    }

    function drawNow() {
      if (control.frame) cancelAnimationFrame(control.frame);
      control.frame = 0;
      draw(performance.now());
    }

    function changed(kind) {
      options.onViewChange?.(kind);
      scheduleDraw();
    }

    function zoomAt(factor, px, py) {
      stopAnimation();
      const before = { x: (px - view.offsetX) / view.scale, y: (py - view.offsetY) / view.scale };
      view.scale = Math.max(minScale(), Math.min(MAX_SCALE, view.scale * factor));
      view.offsetX = px - before.x * view.scale;
      view.offsetY = py - before.y * view.scale;
      clamp();
      changed("zoom");
    }

    function zoomBy(factor) {
      const rect = canvas.getBoundingClientRect();
      zoomAt(factor, rect.width / 2, rect.height / 2);
    }

    function stopAnimation() {
      if (control.animation) cancelAnimationFrame(control.animation);
      control.animation = 0;
    }

    // Pans so that a world box sits in the middle of the free area: the canvas
    // minus its chrome (toolbar, legend / status dock; see safeArea) and an open
    // side panel (on the right on desktop, a bottom sheet on phones). Eased
    // over 220 ms unless reduced motion is preferred.
    function centerOn(box, { animate = true } = {}) {
      if (!box) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const free = safeArea(canvas, { panel: options.panelRect?.() || null });
      const target = {
        offsetX: free.x + free.width / 2 - (box.x + box.width / 2) * view.scale,
        offsetY: free.y + free.height / 2 - (box.y + box.height / 2) * view.scale,
      };
      const saved = { offsetX: view.offsetX, offsetY: view.offsetY };
      view.offsetX = target.offsetX;
      view.offsetY = target.offsetY;
      clamp();
      target.offsetX = view.offsetX;
      target.offsetY = view.offsetY;
      stopAnimation();
      if (!animate || reducedMotion() || Math.hypot(target.offsetX - saved.offsetX, target.offsetY - saved.offsetY) < 2) {
        changed("center");
        return;
      }
      view.offsetX = saved.offsetX;
      view.offsetY = saved.offsetY;
      const started = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - started) / 220);
        const eased = 1 - (1 - t) ** 3;
        view.offsetX = saved.offsetX + (target.offsetX - saved.offsetX) * eased;
        view.offsetY = saved.offsetY + (target.offsetY - saved.offsetY) * eased;
        control.animation = t < 1 ? requestAnimationFrame(step) : 0;
        changed("center");
      };
      control.animation = requestAnimationFrame(step);
    }

    function boxOnScreen(box, padding = 18) {
      const rect = canvas.getBoundingClientRect();
      const left = box.x * view.scale + view.offsetX;
      const top = box.y * view.scale + view.offsetY;
      return left >= padding && top >= padding
        && left + box.width * view.scale <= rect.width - padding
        && top + box.height * view.scale <= rect.height - padding;
    }

    function setCursor(target) {
      canvas.classList.toggle("is-clickable", !control.drag && !!target && !target.disabled);
      canvas.classList.toggle("is-disabled", !control.drag && !!target && !!target.disabled);
    }

    function setHover(target) {
      const key = target?.key ?? null;
      const previous = control.hovered?.key ?? null;
      control.hovered = target || null;
      setCursor(target);
      if (key === previous) return;
      options.onHover?.(target || null);
      scheduleDraw();
    }

    // Arrow keys: the nearest node in that direction (angle-weighted), or the
    // node nearest to the viewport centre when none has the keyboard yet.
    function moveKeyboard(dx, dy) {
      const nodes = options.nodes?.() || [];
      if (!nodes.length) return;
      const centre = (node) => ({ x: node.x + node.width / 2, y: node.y + node.height / 2 });
      const current = nodes.find((node) => node.id === control.keyboardId) || null;
      // The first arrow lands on the selected node (or the one nearest to the
      // viewport centre); the next ones move.
      let next = current ? null : nodes.find((node) => node.id === options.selectedId?.()) || null;
      if (next) {
        focusNode(next.id);
        return;
      }
      if (!current) {
        const rect = canvas.getBoundingClientRect();
        const world = { x: (rect.width / 2 - view.offsetX) / view.scale, y: (rect.height / 2 - view.offsetY) / view.scale };
        let best = Infinity;
        for (const node of nodes) {
          const c = centre(node);
          const distance = Math.hypot(c.x - world.x, c.y - world.y);
          if (distance < best) { best = distance; next = node; }
        }
      } else {
        const from = centre(current);
        let best = Infinity;
        for (const node of nodes) {
          if (node === current) continue;
          const c = centre(node);
          const along = (c.x - from.x) * dx + (c.y - from.y) * dy;
          if (along <= 1) continue;
          const across = Math.abs((c.x - from.x) * dy - (c.y - from.y) * dx);
          const score = along + across * 2.5;
          if (score < best) { best = score; next = node; }
        }
        if (!next) return;
      }
      if (!next) return;
      focusNode(next.id);
    }

    function focusNode(id) {
      const node = (options.nodes?.() || []).find((candidate) => candidate.id === id);
      if (!node) return;
      control.keyboardId = id;
      setHover(options.target?.(id) || null);
      if (!boxOnScreen(node)) centerOn(node);
      live.textContent = options.describe?.(id) || "";
      scheduleDraw();
    }

    canvas.tabIndex = 0;
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * WHEEL_SPEED), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });

    // One pointer pans (a mouse drag or a finger), two fingers pinch-zoom
    // around their midpoint and pan with it; a tap or click that did not move
    // selects. A finger may wander a few pixels during a tap.
    const pointers = new Map();
    const pinchOf = () => {
      const [a, b] = [...pointers.values()];
      const rect = canvas.getBoundingClientRect();
      return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
    };
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      stopAnimation();
      try { canvas.setPointerCapture?.(event.pointerId); } catch (_) { /* a pointer the browser no longer tracks */ }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        control.pinch = pinchOf();
        if (control.drag) control.drag.moved = true;
        return;
      }
      if (pointers.size > 2) return;
      control.drag = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, slop: event.pointerType === "touch" ? 8 : 2 };
      canvas.classList.remove("is-clickable", "is-disabled");
      canvas.classList.add("is-dragging");
    });
    canvas.addEventListener("pointermove", (event) => {
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (control.pinch && pointers.size >= 2) {
        const next = pinchOf();
        view.offsetX += next.x - control.pinch.x;
        view.offsetY += next.y - control.pinch.y;
        zoomAt(next.distance / control.pinch.distance, next.x, next.y);
        control.pinch = next;
        return;
      }
      if (control.drag) {
        const dx = event.clientX - control.drag.x;
        const dy = event.clientY - control.drag.y;
        if (Math.hypot(event.clientX - control.drag.startX, event.clientY - control.drag.startY) > control.drag.slop) control.drag.moved = true;
        if (!control.drag.moved) return;
        view.offsetX += dx;
        view.offsetY += dy;
        clamp();
        control.drag.x = event.clientX;
        control.drag.y = event.clientY;
        changed("pan");
        return;
      }
      setHover(options.hit?.(event.clientX, event.clientY) || null);
    });
    const endDrag = (event) => {
      pointers.delete(event.pointerId);
      try { canvas.releasePointerCapture?.(event.pointerId); } catch (_) { /* already released */ }
      if (control.pinch) {
        if (pointers.size >= 2) { control.pinch = pinchOf(); return; }
        control.pinch = null;
        // The finger left on the canvas goes on panning from where it is.
        const [rest] = [...pointers.values()];
        if (rest && control.drag) { control.drag.x = rest.x; control.drag.y = rest.y; }
        if (rest) return;
      }
      const drag = control.drag;
      if (!drag || pointers.size) return;
      control.drag = null;
      canvas.classList.remove("is-dragging");
      const target = options.hit?.(event.clientX, event.clientY) || null;
      setCursor(target);
      if (drag.moved || event.type === "pointercancel") return;
      control.keyboardId = null;
      options.onClick?.(target, event);
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => {
      if (!control.drag && !control.keyboardId) setHover(null);
    });
    canvas.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const direction = KEY_DIRECTIONS[event.key];
      if (direction) moveKeyboard(direction[0], direction[1]);
      else if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
      else if (event.key === "-" || event.key === "_") zoomBy(1 / ZOOM_STEP);
      else if (event.key === "0") options.fit?.();
      else if ((event.key === "Enter" || event.key === " ") && control.keyboardId) options.onActivate?.(control.keyboardId);
      else if (event.key === "Escape") {
        // Escape closes the panel first, then leaves the keyboard focus.
        if (options.onEscape?.()) {
          // handled
        } else if (control.keyboardId) {
          control.keyboardId = null;
          setHover(null);
        } else return;
      } else return;
      event.preventDefault();
    });
    canvas.addEventListener("blur", () => {
      if (!control.keyboardId) return;
      control.keyboardId = null;
      setHover(null);
    });

    // The legend folds away from its button in the status line: the fit and
    // the recentring then reclaim its corner.
    legendToggle(canvas.parentElement, () => {
      options.onResize?.();
      scheduleDraw();
    });

    const toolbar = options.toolbar || {};
    toolbar.zoomIn?.addEventListener("click", () => zoomBy(ZOOM_STEP));
    toolbar.zoomOut?.addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
    toolbar.fit?.addEventListener("click", () => options.fit?.());

    if (typeof ResizeObserver === "function") {
      // ResizeObserver already runs once per frame; the redraw itself waits for
      // the next animation frame so resizes coalesce with other changes.
      new ResizeObserver(() => {
        if (!active()) return;
        size();
        options.onResize?.();
        scheduleDraw();
      }).observe(canvas);
    }

    return {
      scheduleDraw,
      drawNow,
      cancel,
      zoomBy,
      zoomAt,
      centerOn,
      focusNode,
      boxOnScreen,
      clamp,
      hovered: () => control.hovered,
      animating: () => !!control.animation,
      keyboardId: () => control.keyboardId,
      clearKeyboard() { control.keyboardId = null; },
      size,
    };
  }

  // ------------------------------------------------------------ DOM chrome

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  // Show / hide button of a pane's legend, at the start of its status line.
  // One preference for every graph, kept per viewer (storage is optional):
  // "hidden" folds every legend, "shown" keeps them open; without one, a fit
  // folds the legend when the graph does not fit beside it (see
  // foldLegendToFit) and opens it again once the room is back.
  const LEGEND_STORAGE_KEY = "chdash.graphLegend";
  let legendSerial = 0;
  const legendControls = new WeakMap();
  function legendPreference() {
    try { return localStorage.getItem(LEGEND_STORAGE_KEY) || ""; } catch (_) { return ""; }
  }
  function legendToggle(pane, onToggle) {
    const dock = pane?.querySelector?.(":scope > .graphKitDock");
    const legend = dock?.querySelector(".graphKitLegend");
    const status = dock?.querySelector(".graphKitStatus");
    if (!legend || !status || status.querySelector(".graphKitLegendToggle")) return null;
    if (!legend.id) legend.id = `graphKitLegend${(legendSerial += 1)}`;
    const button = el("button", "graphKitLegendToggle");
    button.type = "button";
    button.setAttribute("aria-controls", legend.id);
    button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h2M6.5 4h7M2.5 8h2M6.5 8h7M2.5 12h2M6.5 12h4"/></svg>';
    const preference = legendPreference();
    const control = {
      // The viewer chose (this session or a stored preference): no auto fold.
      chosen: !!preference,
      auto: false,
      collapsed: () => dock.classList.contains("is-legend-collapsed"),
      apply(collapsed) {
        dock.classList.toggle("is-legend-collapsed", collapsed);
        button.setAttribute("aria-expanded", String(!collapsed));
        const label = collapsed ? "Show the legend" : "Hide the legend";
        button.setAttribute("aria-label", label);
        button.title = label;
      },
    };
    control.apply(preference === "hidden");
    button.addEventListener("click", () => {
      const collapsed = !control.collapsed();
      control.apply(collapsed);
      control.chosen = true;
      control.auto = false;
      try { localStorage.setItem(LEGEND_STORAGE_KEY, collapsed ? "hidden" : "shown"); } catch (_) { /* storage is optional */ }
      onToggle?.();
    });
    status.prepend(button);
    legendControls.set(dock, control);
    return button;
  }

  // Called by a fit before it measures safeArea(): without a viewer's
  // choice, the legend stays open while the whole graph fits the free area
  // at `readableScale` with it, and folds otherwise (the graph needs the
  // room, or is larger than the view and the minimap takes over); it opens
  // again once the graph fits with it. Returns whether the legend is folded.
  function foldLegendToFit(canvas, bounds, { readableScale = 1, margin = 0.92 } = {}) {
    const dock = canvas?.parentElement?.querySelector(":scope > .graphKitDock");
    const control = dock ? legendControls.get(dock) : null;
    if (!control || !bounds || control.chosen) return !!control?.collapsed();
    const fits = () => {
      const area = safeArea(canvas);
      return area.width > 0 && area.height > 0
        && Math.min(area.width / bounds.width, area.height / bounds.height) * margin >= readableScale - 1e-9;
    };
    control.apply(false);
    control.auto = !fits();
    control.apply(control.auto);
    return control.auto;
  }

  // Side-panel header: eyebrow (kind), title, subtitle and the close button.
  function panelHeader({ eyebrow, title, subtitle, dot, onClose, closeLabel = "Close details" }) {
    const header = el("header", "graphKitPanel__head");
    const titles = el("div", "graphKitPanel__titles");
    if (eyebrow) titles.append(el("span", "graphKitPanel__eyebrow", eyebrow));
    const heading = el("h2", "graphKitPanel__title");
    if (dot) {
      const swatch = el("span", "graphKitPanel__dot");
      swatch.style.background = dot;
      heading.append(swatch);
    }
    if (title instanceof Node) heading.append(title);
    else heading.append(document.createTextNode(String(title ?? "")));
    titles.append(heading);
    if (subtitle) titles.append(el("span", "graphKitPanel__subtitle", subtitle));
    const close = el("button", "closeCross graphKitPanel__close", "×");
    close.type = "button";
    close.setAttribute("aria-label", closeLabel);
    close.title = closeLabel;
    close.addEventListener("click", onClose);
    header.append(titles, close);
    return header;
  }

  function panelSection(title) {
    const section = el("section", "graphKitPanel__section");
    if (title) section.append(el("h3", "graphKitPanel__sectionTitle", title));
    return section;
  }

  function panelFacts(pairs) {
    const list = el("dl", "graphKitPanel__facts");
    for (const [label, value] of pairs) {
      if (value == null || value === "") continue;
      list.append(el("dt", null, label), el("dd", null, value));
    }
    return list;
  }

  ns.graphKit = {
    FONT,
    ZOOM_STEP,
    WHEEL_SPEED,
    MAX_SCALE,
    MIN_SCALE,
    GRID_SPACING,
    MOBILE_QUERY,
    DASH,
    LINEAGE_NODE_PORT_TOP_OFFSET,
    ROUTE_GRID_POINT_BUDGET,
    theme: { cssVar, color, resolveColor, isLight, invalidate: invalidateTheme, onChange: (fn) => themeListeners.add(fn) },
    color,
    parseColor,
    mixColor,
    dimAlpha,
    reducedMotion,
    mobileLayout,
    canvasSize,
    roundRect,
    ellipsis,
    drawBackground,
    drawHalo,
    drawCard,
    compactTitleSize,
    polylineMetric,
    routePoint,
    tracePolyline,
    strokePolyline,
    drawArrowHead,
    distanceToSegment,
    distanceToPolyline,
    pointInRect,
    rectsOverlap,
    layered,
    nodePort,
    routeEdges,
    labelAnchors,
    placeLabels,
    drawLabel,
    anyClipped,
    drawMinimap,
    safeArea,
    fitTransform,
    clampView,
    mount,
    el,
    legendToggle,
    foldLegendToFit,
    panelHeader,
    panelSection,
    panelFacts,
  };
})();
